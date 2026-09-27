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
import { baseModelId, collapseTier, modelRank, ROUTER_TIERS } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { redactSecretsForJev } from "./secret_redaction.ts";

export type RouterEffort = "low" | "medium" | "high" | "xhigh";

/** An effort as the SESSION sends it: the router's four levels, or the person's own `max` or numeric budget, which the router carries through untouched and never lowers. */
export type SessionEffort = RouterEffort | "max" | number;

/** §4: the effort each tier asks for, where the model takes one. */
export const TIER_EFFORT: Readonly<Record<RouterTier, RouterEffort>> = {
  simple: "low",
  standard: "medium",
  complex: "high",
  frontier: "xhigh",
};

export type DestinationKind = "client-site" | "service" | "project" | "support";
export type QuotaBand = "normal" | "economy" | "strong-economy";

/** A compact summary of the previous turn (§6.1): counts only, plus the short text the sensitive-topic guard reads (edited paths, commands). */
export interface TurnActivity {
  readonly toolCalls: number;
  readonly filesEdited: number;
  readonly testsRun: number;
  readonly testsFailed: number;
  readonly errors: number;
  /** Never sent to Jev: only the local sensitive-topic guard reads it. */
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

/** The Jev state: the prompt redacted FIRST and cut second, so a cut can never leave half a secret unredacted. */
export function buildTierState(input: TierStateInput): JsonValue {
  const prompt = redactSecretsForJev(input.promptText).text.slice(0, PROMPT_CHARS);
  const activity = input.activity;
  return {
    prompt,
    previous_turn:
      activity === null
        ? null
        : { tool_calls: activity.toolCalls, files_edited: activity.filesEdited, tests_run: activity.testsRun, tests_failed: activity.testsFailed, errors: activity.errors },
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
        "A coding assistant is about to work on `prompt`, the person's latest request, in Spanish or English (`previous_turn` summarises what the assistant did on the turn before, when there was one). Real prompts are short: judge the work the prompt implies, not how much it says about itself. Choose the least demanding tier of model that still does this work at full quality. When in doubt between two tiers, choose the stronger one.",
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

export function mentionsSensitiveTopic(text: string): boolean {
  const folded = foldText(text);
  if (/\bapi[\s_-]?keys?\b/.test(folded)) return true;
  return folded.split(/[^a-z0-9]+/).some((word) => SENSITIVE_SET.has(word));
}

export type RouterGuard = "client-site" | "policy" | "sensitive-topic" | "previous-failure" | "low-confidence";

export interface GuardContext {
  readonly destinationKind: DestinationKind | null;
  /** The destination matches a `requires_human` / `prohibits` policy. */
  readonly policyHit: boolean;
  readonly text: string;
  readonly activity: TurnActivity | null;
  /** Jev's confidence; null (no answer) counts as low. */
  readonly confidence: number | null;
}

export function activeGuards(context: GuardContext): readonly RouterGuard[] {
  const guards: RouterGuard[] = [];
  if (context.destinationKind === "client-site") guards.push("client-site");
  if (context.policyHit) guards.push("policy");
  if (mentionsSensitiveTopic(context.text) || (context.activity !== null && mentionsSensitiveTopic(context.activity.mentions))) guards.push("sensitive-topic");
  if (context.activity !== null && (context.activity.errors > 0 || context.activity.testsFailed > 0)) guards.push("previous-failure");
  if (context.confidence === null || context.confidence < CONFIDENCE_FLOOR) guards.push("low-confidence");
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
}

/** The session's exact id (a `[1m]` context suffix included) when `targetId` is the same base model, else `targetId`. */
export function exactModelId(targetId: string, sessionModel: string): string {
  return baseModelId(sessionModel) === targetId ? sessionModel : targetId;
}

/** A `max` or numeric effort is the person's own choice: the router never lowers it on the same model. */
export function isPersonEffort(effort: SessionEffort | null): boolean {
  return effort === "max" || typeof effort === "number";
}

export function decideStart(input: StartDecisionInput): RouterDecision {
  const current = input.configuredModel;
  const unchanged = { current, model: current, effort: input.configuredEffort, changed: false } as const;
  if (input.jev === null) {
    return { ...unchanged, tier: null, confidence: null, proposed: null, reason: "jev-failed", guard: null };
  }
  const guards = activeGuards(input.guards);
  const tier = collapseTier(input.tiers, shiftForPressure(input.jev.tier, input.band ?? "normal", guards, null));
  const target = input.tiers[tier];
  const currentRank = modelRank(input.tiers, current);
  const proposedRank = modelRank(input.tiers, target.modelId);
  const isUpgrade = currentRank !== null && proposedRank !== null && proposedRank > currentRank;
  const base = { tier, confidence: input.jev.confidence, proposed: target.modelId };
  // Under any guard only a strict upgrade passes: a downgrade, a model the
  // floor cannot compare, and a same-rank effort change all keep the
  // session's own model AND effort (§6.2, review finding 2).
  if (!isUpgrade && guards.length > 0) {
    return { ...unchanged, ...base, reason: "held-by-guard", guard: guards[0] ?? null };
  }
  const model = exactModelId(target.modelId, current);
  const sameModel = model === current;
  const effort = sameModel && isPersonEffort(input.configuredEffort) ? input.configuredEffort : target.supportsEffort ? TIER_EFFORT[tier] : null;
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
  readonly breakEven?: { readonly contextTokens: number; readonly switchCost: number; readonly stepSaving: number; readonly expectedSteps: number } | null;
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
  };
}
