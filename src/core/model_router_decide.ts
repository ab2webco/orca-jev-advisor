// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §6): the rules
// that turn Jev's tier judgment into a model and an effort.
//
//   §6.1 the Jev question -- one Choice over the four tiers, built from the
//        turn's redacted prompt and a compact summary of the previous turn;
//   §6.2 the quality guards -- evaluated AFTER Jev, they never let a
//        decision go below the session's configured model;
//   §6.3 the session-start decision (point A).
//
// Jev decides what the work needs; the guards decide what it may never
// lose. A Jev failure is never a decision: it changes nothing.
//
// Pure: no I/O, no clock. The hooks module gathers the inputs.
// ---------------------------------------------------------------------------

import { getChoiceAnswer } from "./jev.ts";
import type { Answer, JsonValue, Question } from "./jev.ts";
import { baseModelId, collapseTier, modelRank, ROUTER_TIERS, tierOfModel } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { redactSecretsForJev } from "./secret_redaction.ts";

export type RouterEffort = "low" | "medium" | "high" | "xhigh";

/** An effort as the SESSION sends it: the router's four levels, or the person's own `max` or numeric budget, which the router carries through untouched and never lowers. */
export type SessionEffort = RouterEffort | "max" | number;

/** An effort a tier may ask for: the router's four levels, or `max` when the person sets a tier to it (0.6.2 E3). */
export type TierEffort = RouterEffort | "max";

export type TierEffortMap = Readonly<Record<RouterTier, TierEffort>>;

/** Weakest to strongest; a numeric budget has no place on it. */
export const EFFORT_LEVELS: readonly TierEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Where an effort sits on EFFORT_LEVELS, or null for none or a numeric budget (not comparable). */
export function effortRank(effort: SessionEffort | null | undefined): number | null {
  if (typeof effort !== "string") return null;
  const rank = EFFORT_LEVELS.indexOf(effort);
  return rank === -1 ? null : rank;
}

/**
 * §4: the effort each tier asks for, where the model takes one. The default
 * the person's per-tier setting overrides (0.6.2 E3). 0.6.16 T1: simple is
 * medium, not low -- half the turns that edited were rated simple
 * (odd/research/phase-effort.md §2) and low has never been measured on work
 * that edits. Since no default is low, a `low` in the per-tier map is always
 * the person's own, and it is sent as they set it.
 */
export const TIER_EFFORT: Readonly<Record<RouterTier, RouterEffort>> = {
  simple: "medium",
  standard: "medium",
  complex: "high",
  frontier: "xhigh",
};

export type DestinationKind = "client-site" | "service" | "project" | "support";
export type QuotaBand = "normal" | "economy" | "strong-economy";

/** Where the quota band's figures came from: the live status-line reading, the Orca mirror, both (one window each), or nothing usable. */
export type QuotaSource = "live" | "live+mirror" | "mirror" | "none";

/** A compact summary of the previous turn (§6.1): counts only, plus the short text the topic flags read (edited paths, commands). */
export interface TurnActivity {
  readonly toolCalls: number;
  readonly filesEdited: number;
  readonly testsRun: number;
  readonly testsFailed: number;
  readonly errors: number;
  /** Never sent to Jev as text: only the topic flags (fixed category names) are derived from it. */
  readonly mentions: string;
}

// ---------------------------------------------------------------------------
// §6.1 the Jev question
// ---------------------------------------------------------------------------

export const PROMPT_CHARS = 2000;

export interface TierStateInput {
  readonly promptText: string;
  readonly activity: TurnActivity | null;
  readonly destinationKind: DestinationKind | null;
  readonly quotaBand: QuotaBand;
}

/**
 * The Jev state: the prompt redacted FIRST and cut second, so a cut can never
 * leave half a secret unredacted. 0.6.2 F9: a failing previous turn and a
 * sensitive topic are facts Jev weighs (`previous_turn.failed`,
 * `topic_flags`: fixed category names only, never prompt words), not vetoes.
 */
export function buildTierState(input: TierStateInput): JsonValue {
  const prompt = redactSecretsForJev(input.promptText).text.slice(0, PROMPT_CHARS);
  const activity = input.activity;
  return {
    prompt,
    previous_turn:
      activity === null
        ? null
        : {
            tool_calls: activity.toolCalls,
            files_edited: activity.filesEdited,
            tests_run: activity.testsRun,
            tests_failed: activity.testsFailed,
            errors: activity.errors,
            failed: activity.testsFailed > 0 || activity.errors > 0,
          },
    topic_flags: [...topicFlags(`${input.promptText}\n${activity?.mentions ?? ""}`)],
    destination_kind: input.destinationKind ?? "unknown",
    quota_pressure: input.quotaBand,
  };
}

// Real prompts are short and often Spanish: each tier is defined by the work
// it implies, with short examples of how people actually ask for it (review
// round 2: prompts that spell out their own difficulty measured 12/12, but
// the short ones in live sessions drew 0.37-0.52 confidence).
const TIER_CRITERIA: Readonly<Record<RouterTier, string>> = {
  simple:
    'Simple: a greeting, a quick question, running one command, reading or summarising something. Nothing is designed or changed. Examples: "hola, ¿qué hora es?", "run git status", "lee el README y resúmelo", "what does this function return?", "¿en qué rama estoy?".',
  standard:
    'Standard: a clear, bounded change or routine task: small features, renames, tests, fixes whose cause is known. Examples: "renombra userId a accountId en el módulo", "add a --json flag to the export command", "write tests for parseDate", "agrega validación al formulario", "arregla el typo del header".',
  complex:
    'Complex: work that needs design or investigation first: debugging across modules, a cause that is unknown, architecture of one system, code or security review. Examples: "diseña la caché entre el API y los workers", "why does checkout double-charge sometimes?", "review this PR for security issues", "el build falla solo en CI, averigua por qué".',
  frontier:
    'Frontier: formal or research-grade reasoning: proofs, hard algorithms, correctness under concurrency or failure, the hardest cross-system architecture calls. Examples: "prove this algorithm terminates", "encuentra la complejidad óptima de esto", "design a CRDT for collaborative text", "demuestra que el protocolo sobrevive particiones de red".',
};

export function buildTierQuestions(): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const tier of ROUTER_TIERS) criteria[tier] = TIER_CRITERIA[tier];
  return {
    tier: {
      type: "choice",
      instructions:
        "A coding assistant is about to work on `prompt`, the person's latest request, in Spanish or English (`previous_turn` summarises what the assistant did on the turn before, when there was one). Real prompts are short: judge the work the prompt implies, not how much it says about itself. Choose the least demanding tier of model that still does this work at full quality. When in doubt between two tiers, choose the stronger one. Weigh two facts: `previous_turn.failed` true means a test or a tool failed on the turn before, so the work may need a stronger model; `topic_flags` name sensitive areas the request touches (deploys, credentials, production, ...): they are hints, not rules.",
      criteria,
    },
  };
}

export interface TierJudgment {
  readonly tier: RouterTier;
  readonly confidence: number;
}

function isRouterTier(value: string): value is RouterTier {
  return (ROUTER_TIERS as readonly string[]).includes(value);
}

/** The tier and Jev's confidence, or null for anything malformed: a failure, never a guess. */
export function interpretTier(answers: Record<string, Answer>): TierJudgment | null {
  const answer = getChoiceAnswer(answers, "tier");
  if (answer === null || !isRouterTier(answer.choice)) return null;
  return { tier: answer.choice, confidence: answer.confidence };
}

// ---------------------------------------------------------------------------
// §6.2 quality guards
// ---------------------------------------------------------------------------

/**
 * The confidence under which Jev's tier holds the model. 0.6.11 T4 measured it
 * against the record (odd/tasks/release-0.6.11.md) and found no signal that
 * moves it, so it stays 0.7.
 */
export const CONFIDENCE_FLOOR = 0.7;

/**
 * Whole words (already lower-case and without accents) that make a turn
 * sensitive. English and Spanish: the owner works in both. "token" is
 * deliberately absent -- usage talk is full of tokens.
 */
export const SENSITIVE_WORDS: readonly string[] = [
  "security", "secure", "credential", "credentials", "secret", "secrets", "password", "passwords", "apikey",
  "release", "releases", "deploy", "deploys", "deployed", "deploying", "deployment", "deployments",
  "migration", "migrations", "migrate", "production", "prod",
  "seguridad", "credencial", "credenciales", "secreto", "secretos", "contrasena", "contrasenas",
  "lanzamiento", "despliegue", "despliegues", "desplegar", "despliega", "migracion", "migraciones", "migrar", "produccion",
];

const SENSITIVE_SET: ReadonlySet<string> = new Set(SENSITIVE_WORDS);

function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Each sensitive word's category: what Jev sees in `topic_flags`. */
const TOPIC_OF: Readonly<Record<string, string>> = {
  security: "security", secure: "security", seguridad: "security",
  credential: "credentials", credentials: "credentials", secret: "credentials", secrets: "credentials", password: "credentials", passwords: "credentials", apikey: "credentials",
  credencial: "credentials", credenciales: "credentials", secreto: "credentials", secretos: "credentials", contrasena: "credentials", contrasenas: "credentials",
  release: "release", releases: "release", lanzamiento: "release",
  deploy: "deploy", deploys: "deploy", deployed: "deploy", deploying: "deploy", deployment: "deploy", deployments: "deploy",
  despliegue: "deploy", despliegues: "deploy", desplegar: "deploy", despliega: "deploy",
  migration: "migration", migrations: "migration", migrate: "migration", migracion: "migration", migraciones: "migration", migrar: "migration",
  production: "production", prod: "production", produccion: "production",
};

/** The sensitive categories `text` touches, sorted: hints for Jev (0.6.2 F9). */
export function topicFlags(text: string): readonly string[] {
  const folded = foldText(text);
  const flags = new Set<string>();
  if (/\bapi[\s_-]?keys?\b/.test(folded)) flags.add("credentials");
  for (const word of folded.split(/[^a-z0-9]+/)) {
    const topic = TOPIC_OF[word];
    if (topic !== undefined) flags.add(topic);
  }
  return [...flags].sort();
}

export function mentionsSensitiveTopic(text: string): boolean {
  const folded = foldText(text);
  if (/\bapi[\s_-]?keys?\b/.test(folded)) return true;
  return folded.split(/[^a-z0-9]+/).some((word) => SENSITIVE_SET.has(word));
}

/**
 * 0.6.2 E6: a short prompt whose main content is a document or path to read
 * and act on ("Read /x/brief.md and do what it says", "lee ./plan.md y haz
 * lo que dice", a bare `brief.md` path). Jev judges the pointer, not the
 * work it points to, so it must not pick the model. A prompt that names a
 * file but asks for work ("arregla el bug en src/a.ts") is not one.
 */
const POINTER_MAX_CHARS = 400;
/** `/…`, `./…`, `../…`, `~/…`, or any token ending in .md/.txt; an escaped space (`Application\ Support`) stays inside the token. */
const POINTER_PATH = /(?:^|[\s(])(?:~\/|\.{1,2}\/|\/)\S+|[\w.\-/]+\.(?:md|txt)\b/i;
const POINTER_BARE = /^(?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.(?:md|txt)$/i;
/** A bare path inside quotes may hold spaces (`"/home/a/Application Support/b.md"`). */
const POINTER_BARE_QUOTED = /^(["'`])(?:~\/|\.{1,2}\/|\/)?[^"'`]+\.(?:md|txt)\1$/i;
/** Verbs that hand the work over to the document, clitic forms included (review finding 4). */
const POINTER_FOLLOW = /\b(?:follow|execute|implement|carry (?:it )?out|sigue|seguir|siga|sigan|ejecutar|cumplir|aplicar|implementar|(?:ejecuta|cumple|sigue|aplica|implementa)(?:lo|la|los|las)?)\b/;
const POINTER_ACT = /\bdo (?:what|as) (?:it|the file|the document|the doc) (?:says|asks|tells)\b|\bdo what\b.*\b(?:says|asks)\b|\bdo (?:it|that)\b|\bact on it\b|\binstructions?\b|\bhaz lo que (?:dice|pide|indica)\b|\bhazlo\b|\binstrucciones\b/;

export function isPointerPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= POINTER_MAX_CHARS) return false;
  if (POINTER_BARE_QUOTED.test(trimmed.replace(/[.,;:!?]+$/, ""))) return true;
  // Quotes and backticks around a path, and an escaped space inside one, are
  // not part of the shape.
  const plain = trimmed.replace(/\\ /g, "_").replace(/[`'"]/g, "").trim();
  if (POINTER_BARE.test(plain.replace(/[.,;:!?]+$/, ""))) return true;
  if (!POINTER_PATH.test(plain)) return false;
  // With a path present, handing the work over is enough: "do what X says",
  // "haz lo que dice X", "read X and implement it" (review finding 4).
  const folded = foldText(plain);
  return POINTER_FOLLOW.test(folded) || POINTER_ACT.test(folded);
}

/**
 * The hard guards: only where Jev cannot judge, its own low confidence (or
 * failure) and a pointer prompt. 0.6.2 F9: a failing previous turn and a
 * sensitive topic are facts in Jev's state (buildTierState). F11: a client
 * site and a scoped policy are no router guard either; client protection is
 * the Bash gate's, and the destination kind stays a fact in Jev's state.
 * `context-window` is not one activeGuards raises: the stage decision names
 * it when the context would overflow the window of Jev's model.
 */
export type RouterGuard = "low-confidence" | "pointer-prompt" | "context-window";

export interface GuardContext {
  readonly text: string;
  readonly activity: TurnActivity | null;
  /** Jev's confidence; null (no answer) counts as low. */
  readonly confidence: number | null;
}

export function activeGuards(context: GuardContext): readonly RouterGuard[] {
  const guards: RouterGuard[] = [];
  if (context.confidence === null || context.confidence < CONFIDENCE_FLOOR) guards.push("low-confidence");
  // Named first: on a pointer, Jev judged the pointer, so its tier and its
  // confidence are both symptoms of this one cause.
  if (isPointerPrompt(context.text)) guards.unshift("pointer-prompt");
  return guards;
}

/**
 * §6.3/§6.5 quota pressure, as the owner settled gap G4: only at strong
 * economy (weekly >= 95%) may `standard` work move down to `simple`, and
 * only when the previous turn was read-only and failure-free (no file
 * edited, no tool error, no failing test) and no guard holds. Economy
 * (80-94%) never shifts a tier; it only relaxes hysteresis. With no
 * previous turn (session start, a subagent) nothing shows the work is
 * read-only, so nothing shifts.
 */
export function shiftForPressure(tier: RouterTier, band: QuotaBand, guards: readonly RouterGuard[], previousTurn: TurnActivity | null): RouterTier {
  if (band !== "strong-economy" || tier !== "standard" || guards.length > 0 || previousTurn === null) return tier;
  const readOnly = previousTurn.filesEdited === 0 && previousTurn.errors === 0 && previousTurn.testsFailed === 0;
  return readOnly ? "simple" : tier;
}

// ---------------------------------------------------------------------------
// §6.3 session start (point A)
// ---------------------------------------------------------------------------

export type StartReason = "jev-failed" | "held-by-guard" | "same" | "switch";

export interface RouterDecision {
  /** The (collapsed) tier Jev chose; null when Jev failed. */
  readonly tier: RouterTier | null;
  readonly confidence: number | null;
  /** The model the session would run without the router. */
  readonly current: string;
  /** What the tier resolves to on this account, before the guards; null when Jev failed. */
  readonly proposed: string | null;
  /** What the session should run on. */
  readonly model: string;
  /** null = send no effort (the model takes none, or the session sent none). */
  readonly effort: SessionEffort | null;
  /** Whether `model`/`effort` differ from the session's own. */
  readonly changed: boolean;
  readonly reason: StartReason;
  /** The first guard that held the floor, when one did. */
  readonly guard: RouterGuard | null;
}

export interface StartDecisionInput {
  readonly tiers: ResolvedTiers;
  readonly jev: TierJudgment | null;
  readonly configuredModel: string;
  /** The session's own effort exactly as `turn.step` carried it (`max` and numbers included); null when absent. */
  readonly configuredEffort: SessionEffort | null;
  /** Everything the guards read; `confidence` is Jev's. */
  readonly guards: GuardContext;
  /** Quota pressure (§6.5); normal when absent. */
  readonly band?: QuotaBand;
  /** The effort each tier asks for (0.6.2 E3); TIER_EFFORT when absent. */
  readonly tierEffort?: TierEffortMap;
}

/** The session's exact id (a `[1m]` context suffix included) when `targetId` is the same base model, else `targetId`. */
export function exactModelId(targetId: string, sessionModel: string): string {
  return baseModelId(sessionModel) === targetId ? sessionModel : targetId;
}

/** A `max` or numeric effort is the person's own choice: the router never lowers it on the same model. */
export function isPersonEffort(effort: SessionEffort | null): boolean {
  return effort === "max" || typeof effort === "number";
}

/**
 * 0.6.2 F0: a guard may block lowering the model or the effort, never
 * raising the effort. Under one, the effort is the higher of the session's
 * own (`own`) and the tier's; a person's `max` or numeric budget is left
 * untouched, and none (the API default, not a choice) takes the tier's.
 */
export function guardedEffort(own: SessionEffort | null, tier: TierEffort | null): SessionEffort | null {
  if (isPersonEffort(own) || tier === null) return own;
  const ownRank = effortRank(own);
  const tierRank = effortRank(tier) as number;
  return ownRank === null || tierRank > ownRank ? tier : own;
}

/** The effort Jev's (shifted, uncollapsed) tier asks for on `modelId`, or null when that model takes none or the account does not know it. */
export function tierEffortOn(tiers: ResolvedTiers, modelId: string, judged: RouterTier, efforts: TierEffortMap | undefined): TierEffort | null {
  const tier = tierOfModel(tiers, modelId);
  return tier !== null && tiers[tier].supportsEffort ? (efforts ?? TIER_EFFORT)[judged] : null;
}

export function decideStart(input: StartDecisionInput): RouterDecision {
  const current = input.configuredModel;
  const unchanged = { current, model: current, effort: input.configuredEffort, changed: false } as const;
  if (input.jev === null) {
    return { ...unchanged, tier: null, confidence: null, proposed: null, reason: "jev-failed", guard: null };
  }
  const guards = activeGuards(input.guards);
  // The model from the collapsed tier, the effort from Jev's own (0.6.2 E1).
  const judged = shiftForPressure(input.jev.tier, input.band ?? "normal", guards, null);
  const tier = collapseTier(input.tiers, judged);
  const target = input.tiers[tier];
  const currentRank = modelRank(input.tiers, current);
  const proposedRank = modelRank(input.tiers, target.modelId);
  const isUpgrade = currentRank !== null && proposedRank !== null && proposedRank > currentRank;
  const base = { tier, confidence: input.jev.confidence, proposed: target.modelId };
  // Under any guard only a strict upgrade passes: a downgrade, a model the
  // floor cannot compare, and a same-rank change all keep the session's own
  // model (§6.2, review finding 2). Its effort may still rise to the tier's,
  // never fall (0.6.2 F0).
  if (!isUpgrade && guards.length > 0) {
    const effort = guardedEffort(input.configuredEffort, tierEffortOn(input.tiers, current, judged, input.tierEffort));
    if (effort !== input.configuredEffort) return { ...unchanged, ...base, effort, changed: true, reason: "switch", guard: guards[0] ?? null };
    return { ...unchanged, ...base, reason: "held-by-guard", guard: guards[0] ?? null };
  }
  const model = exactModelId(target.modelId, current);
  const sameModel = model === current;
  const effort = sameModel && isPersonEffort(input.configuredEffort) ? input.configuredEffort : target.supportsEffort ? (input.tierEffort ?? TIER_EFFORT)[judged] : null;
  const changed = model !== current || effort !== input.configuredEffort;
  return { ...base, current, model, effort, changed, reason: changed ? "switch" : "same", guard: null };
}

// ---------------------------------------------------------------------------
// The decision log (§7): one line per decision, hourly files like
// turn-usage. No prompt text, ever.
// ---------------------------------------------------------------------------

const NAMED_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];

/** `turn.step`'s effort as the router speaks it: the four named levels, else none (`max` and numeric budgets are the session's own, never the router's). */
export function toRouterEffort(effort: string | number | undefined): RouterEffort | null {
  return typeof effort === "string" && NAMED_EFFORTS.includes(effort) ? (effort as RouterEffort) : null;
}

/** `model-router-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function routerDecisionFileName(atIso: string): string {
  return `model-router-decisions-${atIso.slice(0, 13)}.jsonl`;
}

export type RouterPoint = "start" | "stage" | "subagent";

export interface RouterDecisionRecord {
  readonly at: string;
  readonly account: string;
  readonly point: RouterPoint;
  readonly tier: RouterTier | null;
  readonly confidence: number | null;
  readonly current: string;
  readonly proposed: string | null;
  readonly applied: boolean;
  readonly reason: string;
  readonly guard: RouterGuard | null;
  readonly contextTokens: number | null;
  readonly switchCost: number | null;
  readonly stepSaving: number | null;
  readonly expectedSteps: number | null;
  readonly quotaBand: QuotaBand;
  /** 0.6.11 T6: which reading fed `quotaBand` (live status-line figures, the Orca mirror, both, or none); null on a line written before this field or by a path that did not say. */
  readonly quotaSource: QuotaSource | null;
  /** JEV-061: the submitted prompt's `PromptOrigin` kind this decision answers, when known -- never its text. null for a subagent spawn (no submitted prompt) or when `prompt.submit` never stamped one for this turn. */
  readonly origin: string | null;
  /** JEV-061 slice 2: the subagent's own effort for its first step and after, when the router set a target at spawn; null otherwise (every other point, or a subagent with no explicit model/no guard/active-mode requirement unmet). 0.6.3 (JEVADV-63 R1): written from what that first step actually computed and sent -- unguarded, the tier's effort applies outright either direction; guarded, only a raise -- never the raw spawn-time target, so log and step can never diverge (see subagentStepEffort). */
  readonly effort: SessionEffort | null;
  /** JEVADV-63: the project this decision was made in, resolved from the session's cached OrcaContext (see src/core/project_name.ts); null when not yet known this session. */
  readonly project: string | null;
  /** 0.6.16 T1: the session, turn and (for a subagent) agent the decision was made for -- the same ids its turn-usage steps carry, so the two join without a time window; null when not known. */
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly agentId: string | null;
}

export interface RouterDecisionRecordInput {
  readonly at: string;
  readonly account: string;
  readonly point: RouterPoint;
  /** A start decision or a stage decision (whose reasons are wider). */
  readonly decision: Omit<RouterDecision, "reason"> & { readonly reason: string };
  /** Whether the decision was actually applied (active mode AND a change). */
  readonly applied: boolean;
  readonly quotaBand: QuotaBand;
  readonly quotaSource?: QuotaSource | null;
  readonly breakEven?: { readonly contextTokens: number; readonly switchCost: number; readonly stepSaving: number; readonly expectedSteps: number } | null;
  readonly origin?: string | null;
  readonly effort?: SessionEffort | null;
  /** JEVADV-63: null when not given -- an honest "not yet known" state, not a bug. */
  readonly project?: string | null;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly agentId?: string | null;
}

export function routerDecisionRecord(input: RouterDecisionRecordInput): RouterDecisionRecord {
  const breakEven = input.breakEven ?? null;
  return {
    at: input.at,
    account: input.account,
    point: input.point,
    tier: input.decision.tier,
    confidence: input.decision.confidence,
    current: input.decision.current,
    proposed: input.decision.proposed,
    applied: input.applied,
    reason: input.decision.reason,
    guard: input.decision.guard,
    contextTokens: breakEven?.contextTokens ?? null,
    switchCost: breakEven?.switchCost ?? null,
    stepSaving: breakEven?.stepSaving ?? null,
    expectedSteps: breakEven?.expectedSteps ?? null,
    quotaBand: input.quotaBand,
    quotaSource: input.quotaSource ?? null,
    origin: input.origin ?? null,
    effort: input.effort ?? null,
    project: input.project ?? null,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    agentId: input.agentId ?? null,
  };
}
