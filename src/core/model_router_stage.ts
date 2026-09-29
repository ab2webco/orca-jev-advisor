// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §6.4-§6.5): the
// stage change (point C) -- whether a new turn's work justifies leaving the
// sticky model.
//
// A switch mid-session is never free: the prompt cache is per model and per
// effort (§2), so the whole context is written again. An UPGRADE pays that
// gladly (quality first); a DOWNGRADE must earn it twice over -- the same
// lower tier on consecutive turns (hysteresis) AND a saving over the
// expected remaining steps that beats the rewrite by 20% (break-even).
//
// Pure: no I/O, no clock (the caller passes `nowMs`).
// ---------------------------------------------------------------------------

import type { QuotaAccount } from "./consumption.ts";
import { ROUTER_TIERS, baseModelId, collapseTier, modelRank } from "./model_router_accounts.ts";
import type { ModelPrices, ResolvedTierModel, ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { TIER_EFFORT, activeGuards, effortRank, exactModelId, guardedEffort, isPersonEffort, shiftForPressure, tierEffortOn } from "./model_router_decide.ts";
import type { GuardContext, QuotaBand, RouterDecision, RouterGuard, SessionEffort, TierEffort, TierEffortMap, TierJudgment, TurnActivity } from "./model_router_decide.ts";

export { shiftForPressure };

// ---------------------------------------------------------------------------
// §6.5 quota pressure
// ---------------------------------------------------------------------------

const STALE_QUOTA_MS = 30 * 60_000;

/** The band for this account's weekly usage; a missing, unknown or stale (> 30 min) quota is normal. */
export function quotaBandOf(quota: QuotaAccount | null, checkedAt: string | null, nowMs: number): QuotaBand {
  if (quota === null || quota.weeklyUsedPercent === null || checkedAt === null) return "normal";
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs) || nowMs - checkedMs > STALE_QUOTA_MS) return "normal";
  if (quota.weeklyUsedPercent >= 95) return "strong-economy";
  if (quota.weeklyUsedPercent >= 80) return "economy";
  return "normal";
}

/** Consecutive turns a lower tier must repeat before a downgrade (§6.4-§6.5). */
export function hysteresisTurns(band: QuotaBand): number {
  return band === "normal" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// §6.4 break-even
// ---------------------------------------------------------------------------

const PER_TOKEN = 1e-6;
const DEFAULT_EXPECTED_STEPS = 10;
const MIN_EXPECTED_STEPS = 5;
const BREAK_EVEN_MARGIN = 1.2;

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Median steps per turn × 3, never under 5; 10 before the session has a completed turn. */
export function expectedSteps(medianStepsPerTurn: number | null): number {
  if (medianStepsPerTurn === null) return DEFAULT_EXPECTED_STEPS;
  return Math.max(MIN_EXPECTED_STEPS, medianStepsPerTurn * 3);
}

export interface BreakEvenInput {
  /** The last main step's input + cacheRead + cacheWrite + output. */
  readonly contextTokens: number;
  readonly avgOutput: number;
  readonly current: ModelPrices | null;
  readonly proposed: ModelPrices | null;
  readonly medianStepsPerTurn: number | null;
}

export interface BreakEven {
  readonly contextTokens: number;
  readonly switchCost: number;
  readonly stepSaving: number;
  readonly expectedSteps: number;
  readonly worthIt: boolean;
}

/** null when either side's prices are unknown: no break-even, so no downgrade. */
export function breakEven(input: BreakEvenInput): BreakEven | null {
  if (input.current === null || input.proposed === null) return null;
  const switchCost = input.contextTokens * input.proposed.cacheWrite * PER_TOKEN;
  const stepSaving =
    input.contextTokens * (input.current.cacheRead - input.proposed.cacheRead) * PER_TOKEN + input.avgOutput * (input.current.output - input.proposed.output) * PER_TOKEN;
  const steps = expectedSteps(input.medianStepsPerTurn);
  return { contextTokens: input.contextTokens, switchCost, stepSaving, expectedSteps: steps, worthIt: stepSaving * steps > BREAK_EVEN_MARGIN * switchCost };
}

export interface EffortBreakEvenInput {
  readonly contextTokens: number;
  /** Median output per main step at the current effort and at the target, on this model. */
  readonly currentOutput: number;
  readonly targetOutput: number;
  readonly prices: ModelPrices;
  readonly medianStepsPerTurn: number | null;
}

/**
 * 0.6.2 E2: lowering the effort on the same model rewrites the whole
 * context too (the cache is per effort), and saves only on output:
 * (output at the current effort − output at the target) × the output price,
 * per step, against the rewrite at the cache-write price, by the same 20%
 * margin and expected-steps estimate a model downgrade uses.
 */
export function effortBreakEven(input: EffortBreakEvenInput): BreakEven {
  const switchCost = input.contextTokens * input.prices.cacheWrite * PER_TOKEN;
  const stepSaving = (input.currentOutput - input.targetOutput) * input.prices.output * PER_TOKEN;
  const steps = expectedSteps(input.medianStepsPerTurn);
  return { contextTokens: input.contextTokens, switchCost, stepSaving, expectedSteps: steps, worthIt: stepSaving * steps > BREAK_EVEN_MARGIN * switchCost };
}

// ---------------------------------------------------------------------------
// The context-window floor
// ---------------------------------------------------------------------------

/** The share of a model's window kept free: the context must stay within the rest. */
export const CONTEXT_WINDOW_MARGIN = 0.1;

/** Whether `contextTokens` stays within a model's window less the margin; an unknown window (a gateway) always fits. */
export function fitsContext(model: ResolvedTierModel, contextTokens: number): boolean {
  return model.contextWindow === null || contextTokens <= model.contextWindow * (1 - CONTEXT_WINDOW_MARGIN);
}

/** The weakest (collapsed) tier at or above `tier` whose model fits the context, or null when none does. */
export function contextFloorTier(tiers: ResolvedTiers, tier: RouterTier, contextTokens: number): RouterTier | null {
  const fitting = ROUTER_TIERS.slice(ROUTER_TIERS.indexOf(tier)).find((candidate) => fitsContext(tiers[candidate], contextTokens));
  return fitting === undefined ? null : collapseTier(tiers, fitting);
}

// ---------------------------------------------------------------------------
// §6.1 the previous turn's compact activity
// ---------------------------------------------------------------------------

/** The part of a `$.session.messages()` row this summary reads. `tool_use_id` links a result to the call it answers. */
export interface ActivityMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolUses: readonly { readonly tool_use_id?: string; readonly tool: string; readonly input: Readonly<Record<string, unknown>>; readonly text?: string; readonly isError?: true }[];
  readonly toolResults?: readonly { readonly tool_use_id?: string; readonly isError?: boolean }[];
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_COMMAND = /\b(npm (run )?test|npx (jest|vitest|playwright test)|jest|vitest|pytest|go test|cargo test|node --test|bun test|deno test|phpunit|rspec)\b/;
const TEST_FAILED = /✖|\bFAIL\b|\b[1-9]\d* (failing|failed|failures?)\b|\bfail [1-9]/;

// A read-only probe failing (an `ls` of a missing file, a `which` that finds
// nothing) is the model looking, not the work failing: its error must not
// hold an expensive model through the previous-failure guard. Self-contained
// on purpose -- the gate's own command reading is being rewritten elsewhere.
// Anything not clearly a probe is not one, so its error still counts.
const PROBE_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS"]);
/** `cd` too (0.6.2 F10): a failed cd is looking around, not the work failing. */
const PROBE_PROGRAMS: ReadonlySet<string> = new Set(["ls", "which", "type", "test", "[", "stat", "cat", "head", "tail", "wc", "file", "grep", "rg", "find", "pwd", "echo", "cd"]);
const PROBE_GIT: ReadonlySet<string> = new Set(["status", "log", "show", "diff", "rev-parse", "ls-files", "check-ignore"]);
/** `find` actions that delete, run a command or write a file. */
const FIND_ACTION = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
/** Runs another command inside this one, wherever it appears (quoted too). */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;
/** Redirects that write no file: to /dev/null, or one descriptor onto another. */
const HARMLESS_REDIRECT = /(?:\d+|&)?>>?\s*\/dev\/null\b|\d*>&\d+/g;

/**
 * The command's segments between `|`, `||`, `&&`, `&`, `;` and newlines, with
 * every quoted or escaped character masked, so an operator inside quotes
 * splits nothing and a quoted `>` is no redirect. `&` in `2>&1` or `&>` is
 * part of a redirect, not a separator.
 */
function commandSegments(command: string): readonly string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\") i += 1;
      current += "q";
    } else if (char === "'" || char === '"') {
      quote = char;
      current += "q";
    } else if (char === "\\") {
      i += 1;
      current += "q";
    } else if (char === "|" || char === ";" || char === "\n" || (char === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function isProbeSegment(segment: string): boolean {
  const bare = segment.replace(HARMLESS_REDIRECT, " ").trim();
  if (bare.includes(">")) return false;
  const words = bare.split(/\s+/);
  const [program, first] = words;
  if (words.length === 2 && first === "--version") return true;
  if (program === "command") return first === "-v";
  if (program === "git") return first !== undefined && (PROBE_GIT.has(first) || (first === "branch" && words[2] === "--list" && words.slice(3).every((word) => !word.startsWith("-"))));
  if (program === "find") return !words.some((word) => FIND_ACTION.test(word));
  return program !== undefined && PROBE_PROGRAMS.has(program);
}

/** A Read/Grep/Glob/LS call, or a Bash command whose every segment starts with a read-only program. */
function isReadOnlyProbe(use: ActivityMessage["toolUses"][number]): boolean {
  if (PROBE_TOOLS.has(use.tool)) return true;
  const command = use.tool === "Bash" && typeof use.input.command === "string" ? use.input.command : null;
  if (command === null || SUBSTITUTION.test(command)) return false;
  const segments = commandSegments(command);
  return segments.length > 0 && segments.every(isProbeSegment);
}

function isRealPrompt(message: ActivityMessage): boolean {
  return message.role === "user" && message.text.trim().length > 0 && (message.toolResults === undefined || message.toolResults.length === 0);
}

/**
 * What the assistant did between the last two real prompts: tool calls,
 * edits, tests run and failed, errors. `mentions` (edited paths and
 * commands) is read only locally, for the topic flags; never sent as text.
 * null when there is no previous turn.
 */
export function summarizePreviousTurn(messages: readonly ActivityMessage[]): TurnActivity | null {
  const prompts = realPromptIndexes(messages);
  if (prompts.length < 2) return null;
  return summarizeRange(messages.slice((prompts[prompts.length - 2] as number) + 1, prompts[prompts.length - 1] as number));
}

/**
 * What the assistant did after the LAST real prompt: the work a turn the
 * engine started by itself (a subagent finished) continues. Read only by the
 * local guards (round 3, N2), never sent to Jev. null with no real prompt.
 */
export function summarizeSinceLastPrompt(messages: readonly ActivityMessage[]): TurnActivity | null {
  const prompts = realPromptIndexes(messages);
  if (prompts.length === 0) return null;
  return summarizeRange(messages.slice((prompts[prompts.length - 1] as number) + 1));
}

function realPromptIndexes(messages: readonly ActivityMessage[]): readonly number[] {
  const prompts: number[] = [];
  messages.forEach((message, index) => {
    if (isRealPrompt(message)) prompts.push(index);
  });
  return prompts;
}

function summarizeRange(range: readonly ActivityMessage[]): TurnActivity {
  let toolCalls = 0;
  let filesEdited = 0;
  let testsRun = 0;
  let testsFailed = 0;
  let errors = 0;
  const mentions: string[] = [];
  // An error result counts unless it names a read-only probe's call; one
  // that names no call in this range still counts.
  const probes = new Set<string>();
  for (const message of range) for (const use of message.toolUses) if (use.tool_use_id !== undefined && isReadOnlyProbe(use)) probes.add(use.tool_use_id);
  for (const message of range) {
    for (const result of message.toolResults ?? []) if (result.isError === true && (result.tool_use_id === undefined || !probes.has(result.tool_use_id))) errors += 1;
    for (const use of message.toolUses) {
      toolCalls += 1;
      const path = typeof use.input.file_path === "string" ? use.input.file_path : null;
      const command = typeof use.input.command === "string" ? use.input.command : null;
      if (EDIT_TOOLS.has(use.tool)) {
        filesEdited += 1;
        if (path !== null) mentions.push(path);
      }
      if (command !== null) {
        mentions.push(command);
        if (TEST_COMMAND.test(command)) {
          testsRun += 1;
          if (use.isError === true || TEST_FAILED.test(use.text ?? "")) testsFailed += 1;
        }
      }
    }
  }
  return { toolCalls, filesEdited, testsRun, testsFailed, errors, mentions: mentions.join("\n") };
}

// ---------------------------------------------------------------------------
// §6.4 the stage decision (point C)
// ---------------------------------------------------------------------------

export interface PendingLower {
  readonly tier: RouterTier;
  readonly turns: number;
  /** Set when the lowering waiting is an effort on the same model (0.6.2 E2), not a model. */
  readonly effort?: TierEffort;
}

/** Median output tokens per main step at each effort, for the session's current model; an effort with too few real steps is absent (0.6.2 E2). */
export type EffortOutputs = Readonly<Partial<Record<TierEffort, number>>>;

export interface SessionUsage {
  readonly contextTokens: number;
  readonly avgOutput: number;
  readonly medianStepsPerTurn: number | null;
}

export interface StageDecisionInput {
  readonly tiers: ResolvedTiers;
  readonly jev: TierJudgment | null;
  /** The sticky model and effort (what the session runs on, or in measure mode would). */
  readonly currentModel: string;
  readonly currentEffort: SessionEffort | null;
  /** The session's own model and effort: the floor under a guard. */
  readonly configuredModel: string;
  readonly configuredEffort: SessionEffort | null;
  readonly guards: GuardContext;
  readonly band: QuotaBand;
  readonly pending: PendingLower | null;
  /** This session's usage so far; null before its first recorded step. */
  readonly usage: SessionUsage | null;
  /** The effort each tier asks for (0.6.2 E3); TIER_EFFORT when absent. */
  readonly tierEffort?: TierEffortMap;
  /** Real output medians per effort on the current model; null or absent: unknown, so no effort lowering (0.6.2 E2). */
  readonly effortOutput?: EffortOutputs | null;
}

export type StageReason =
  | "jev-failed"
  | "same"
  | "upgrade"
  | "low-confidence"
  | "floor-restore"
  | "held-by-guard"
  | "prices-unknown"
  | "hysteresis"
  | "break-even"
  | "downgrade"
  | "effort-raise"
  | "effort-lower"
  | "effort-hysteresis"
  | "effort-break-even"
  | "effort-unknown-savings";

export interface StageDecision extends Omit<RouterDecision, "reason"> {
  readonly reason: StageReason;
  /** The effort this decision aimed for when it weighed one (an upgrade, or a same-model effort change); null otherwise. */
  readonly effortTarget: SessionEffort | null;
  /** The lower tier waiting on hysteresis after this turn; null when none. */
  readonly pending: PendingLower | null;
  readonly breakEven: BreakEven | null;
}

/** 0.6.2 review finding 1: the session runs its own model at an effort below its own (a person's `max` or budget: any other value). */
function effortBelowOwn(input: StageDecisionInput): boolean {
  if (baseModelId(input.currentModel) !== baseModelId(input.configuredModel)) return false;
  if (isPersonEffort(input.configuredEffort)) return input.currentEffort !== input.configuredEffort;
  const own = effortRank(input.configuredEffort);
  if (own === null) return false;
  const current = effortRank(input.currentEffort);
  return current === null || current < own;
}

/** A decision the context-window floor shaped names it, unless another guard already explains it. */
function withContextGuard(decision: StageDecision, floored: boolean): StageDecision {
  return floored && decision.guard === null ? { ...decision, guard: "context-window" } : decision;
}

export function decideStage(input: StageDecisionInput): StageDecision {
  const current = input.currentModel;
  const stay = { current, model: current, effort: input.currentEffort, changed: false, breakEven: null, effortTarget: null } as const;
  // Guards first, Jev or not: a Jev failure is itself a guard (confidence
  // null counts as low), so it can never keep the session below its own
  // model (§6.2, review finding 1).
  const guards = activeGuards(input.guards);
  const currentRank = modelRank(input.tiers, current);
  const configuredRank = modelRank(input.tiers, input.configuredModel);
  const belowFloor = guards.length > 0 && currentRank !== null && configuredRank !== null && currentRank < configuredRank;
  const floorGuard = guards[0] ?? null;
  if (input.jev === null) {
    if (belowFloor) {
      return { ...stay, tier: null, confidence: null, proposed: null, model: input.configuredModel, effort: input.configuredEffort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null };
    }
    // A Jev failure is itself a guard: an effort lowered on the session's own
    // model comes back to its own too (review finding 1).
    if (guards.length > 0 && effortBelowOwn(input)) {
      return { ...stay, tier: null, confidence: null, proposed: null, effort: input.configuredEffort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null };
    }
    return { ...stay, tier: null, confidence: null, proposed: null, reason: "jev-failed", guard: null, pending: input.pending };
  }
  // The model comes from the collapsed tier; the effort from Jev's own
  // (shifted) tier, so frontier work on an account without Fable still runs
  // Opus at the frontier's effort (0.6.2 E1).
  const judged = shiftForPressure(input.jev.tier, input.band, guards, input.guards.activity);
  const judgedTier = collapseTier(input.tiers, judged);
  // The context-window floor: never a model the context would overflow.
  const context = input.usage?.contextTokens ?? null;
  const fitted = context === null ? judgedTier : contextFloorTier(input.tiers, judgedTier, context);
  const tier = fitted ?? judgedTier;
  const currentTier = currentRank === null ? null : (ROUTER_TIERS[currentRank] ?? null);
  const currentTooSmall = context !== null && currentTier !== null && !fitsContext(input.tiers[currentTier], context);
  const out = (decision: StageDecision): StageDecision =>
    withContextGuard(decision, tier !== judgedTier || (currentTooSmall && decision.changed));
  const target = input.tiers[tier];
  const targetEffort = target.supportsEffort ? (input.tierEffort ?? TIER_EFFORT)[judged] : null;
  const base = { tier: judgedTier, confidence: input.jev.confidence, proposed: target.modelId };
  const proposedRank = modelRank(input.tiers, target.modelId);

  // Below the session's own model while any guard holds: restore at least
  // the session's own, whatever Jev's confidence (§6.2 "never below the
  // configured model"; §6.4 "a guard requires it" -- the previous turn
  // failing on the weaker model is the named case, so it is the one named).
  // The session's own effort goes back exactly as it sent it (`max` too).
  if (belowFloor) {
    const toTarget = proposedRank !== null && configuredRank !== null && proposedRank > configuredRank;
    const model = toTarget ? exactModelId(target.modelId, input.configuredModel) : input.configuredModel;
    // The session's own effort, or the tier's when higher (0.6.2 F0).
    const effort = toTarget ? targetEffort : guardedEffort(input.configuredEffort, tierEffortOn(input.tiers, input.configuredModel, judged, input.tierEffort));
    return { ...base, current, model, effort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null, breakEven: null, effortTarget: null };
  }
  if (fitted === null) return { ...stay, ...base, reason: "held-by-guard", guard: "context-window", pending: null };
  if (currentRank === null || proposedRank === null) {
    return out({ ...stay, ...base, reason: "same", guard: null, pending: null });
  }
  if (proposedRank <= currentRank && guards.length > 0 && effortBelowOwn(input)) {
    // Review finding 1: under a guard, an effort lowered on the session's own
    // model comes back to its own (or the tier's, when higher).
    const effort = guardedEffort(input.configuredEffort, tierEffortOn(input.tiers, current, judged, input.tierEffort));
    return out({ ...stay, ...base, effort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null });
  }
  if (proposedRank === currentRank) return out(decideEffort(input, base, targetEffort, guards, currentRank));
  if (proposedRank > currentRank) {
    if (input.jev.confidence < 0.7 && !currentTooSmall) return out({ ...stay, ...base, reason: "low-confidence", guard: null, pending: null });
    // The tier's effort, even back on the session's own model (0.6.2 E1: a
    // sticky `xhigh` is the account's default, not what this work needs);
    // only a person's own `max` or numeric budget is kept, never lowered.
    const model = exactModelId(target.modelId, input.configuredModel);
    const own = model === input.configuredModel;
    // Under a guard, never below the session's own effort (0.6.2 F0).
    const effort = own && guards.length > 0 ? guardedEffort(input.configuredEffort, targetEffort) : own && isPersonEffort(input.configuredEffort) ? input.configuredEffort : targetEffort;
    return out({ ...base, current, model, effort, changed: true, reason: "upgrade", guard: null, pending: null, breakEven: null, effortTarget: effort });
  }

  // Downgrade. A guard holds the model; the effort may still rise to the
  // tier's (0.6.2 F0).
  if (guards.length > 0) {
    const effort = guardedEffort(input.currentEffort, tierEffortOn(input.tiers, current, judged, input.tierEffort));
    if (effort !== input.currentEffort) return out({ ...stay, ...base, effort, changed: true, reason: "effort-raise", guard: guards[0] ?? null, pending: null, effortTarget: effort });
    return out({ ...stay, ...base, reason: "held-by-guard", guard: guards[0] ?? null, pending: null });
  }
  const pending: PendingLower = { tier, turns: input.pending !== null && input.pending.tier === tier && input.pending.effort === undefined ? input.pending.turns + 1 : 1 };
  const prices = { current: input.tiers[currentTier ?? "complex"].prices, proposed: target.prices };
  if (prices.current === null || prices.proposed === null) return out({ ...stay, ...base, reason: "prices-unknown", guard: null, pending });
  if (pending.turns < hysteresisTurns(input.band)) return out({ ...stay, ...base, reason: "hysteresis", guard: null, pending });
  const result =
    input.usage === null
      ? null
      : breakEven({ contextTokens: input.usage.contextTokens, avgOutput: input.usage.avgOutput, current: prices.current, proposed: prices.proposed, medianStepsPerTurn: input.usage.medianStepsPerTurn });
  if (result === null || !result.worthIt) return out({ ...stay, ...base, reason: "break-even", guard: null, pending, breakEven: result });
  // Back down to the session's own model: its exact id (a `[1m]` suffix
  // included) and its own effort, so nothing is rewritten any more (N1).
  const model = exactModelId(target.modelId, input.configuredModel);
  const effort = model === input.configuredModel ? input.configuredEffort : targetEffort;
  return out({ ...base, current, model, effort, changed: true, reason: "downgrade", guard: null, pending: null, breakEven: result, effortTarget: null });
}

/**
 * 0.6.2 E2: Jev's tier resolves to the model the session already runs, so
 * only the effort can follow the work. A raise is quality: it applies at
 * once with confidence ≥ 0.70, and no guard blocks it. A lowering rewrites
 * the cache for an output-only saving, so it must earn it the way a model
 * downgrade does: no guard, the same lower effort on consecutive prompts,
 * and a break-even on the session's real output medians -- unknown ones
 * lower nothing. A person's `max` or numeric budget is never touched.
 */
function decideEffort(input: StageDecisionInput, base: Pick<StageDecision, "tier" | "confidence" | "proposed">, targetEffort: TierEffort | null, guards: readonly RouterGuard[], currentRank: number): StageDecision {
  const current = input.currentModel;
  const stay = { ...base, current, model: current, effort: input.currentEffort, changed: false, guard: null, breakEven: null } as const;
  const from = effortRank(input.currentEffort);
  const to = effortRank(targetEffort);
  // Only the person's own `max` or budget is protected; a `max` the router
  // chose follows the normal rules (review finding 3). No effort sent is the
  // API default, not a choice, so it can be raised (review nit 8).
  const personOwn = isPersonEffort(input.configuredEffort) && input.currentEffort === input.configuredEffort;
  if (targetEffort === null || to === null || personOwn || typeof input.currentEffort === "number" || from === to) {
    return { ...stay, reason: "same", pending: null, effortTarget: null };
  }
  if (from === null || to > from) {
    if ((input.jev?.confidence ?? 0) < 0.7) return { ...stay, reason: "low-confidence", pending: null, effortTarget: targetEffort };
    return { ...stay, effort: targetEffort, changed: true, reason: "effort-raise", pending: null, effortTarget: targetEffort };
  }
  if (guards.length > 0) return { ...stay, reason: "held-by-guard", guard: guards[0] ?? null, pending: null, effortTarget: targetEffort };
  const tier = base.tier ?? "complex";
  const pending: PendingLower = { tier, effort: targetEffort, turns: input.pending?.effort === targetEffort ? input.pending.turns + 1 : 1 };
  if (pending.turns < hysteresisTurns(input.band)) return { ...stay, reason: "effort-hysteresis", pending, effortTarget: targetEffort };
  const prices = input.tiers[ROUTER_TIERS[currentRank] ?? "complex"].prices;
  const currentOutput = typeof input.currentEffort === "string" ? input.effortOutput?.[input.currentEffort] : undefined;
  const targetOutput = input.effortOutput?.[targetEffort];
  if (prices === null || currentOutput === undefined || targetOutput === undefined) return { ...stay, reason: "effort-unknown-savings", pending, effortTarget: targetEffort };
  const result =
    input.usage === null
      ? null
      : effortBreakEven({ contextTokens: input.usage.contextTokens, currentOutput, targetOutput, prices, medianStepsPerTurn: input.usage.medianStepsPerTurn });
  if (result === null || !result.worthIt) return { ...stay, reason: "effort-break-even", pending, breakEven: result, effortTarget: targetEffort };
  return { ...stay, effort: targetEffort, changed: true, reason: "effort-lower", pending: null, breakEven: result, effortTarget: targetEffort };
}

// ---------------------------------------------------------------------------
// Round 3: which prompt a turn belongs to (N3), and the local floor on a
// turn the engine started by itself (N2)
// ---------------------------------------------------------------------------

/**
 * The identity of the last real prompt. `$.session.messages()` rows carry no
 * stable id (the declared `handle` is absent there), so the key is the
 * prompt's text, hashed (the text itself is never stored), plus its
 * position in the transcript. A count alone could be hidden by /compact.
 */
export interface PromptKey {
  readonly hash: string;
  readonly position: number;
}

/** FNV-1a over the text's UTF-16 code units, as 8 hex digits, plus its length: enough to tell two prompts apart, never enough to read one. */
function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
}

export function lastPromptKey(messages: readonly ActivityMessage[]): PromptKey | null {
  const prompts = realPromptIndexes(messages);
  if (prompts.length === 0) return null;
  const position = prompts[prompts.length - 1] as number;
  return { hash: textHash((messages[position] as ActivityMessage).text), position };
}

/**
 * Whether `current` is a prompt the router has not decided on yet. A
 * different text is new. The same text is new only further down the
 * transcript than before (the person repeated it); at the same or an
 * earlier position it is the same prompt, moved up by a /compact.
 */
export function isNewPrompt(stored: PromptKey | null, current: PromptKey | null): boolean {
  if (current === null) return false;
  if (stored === null) return true;
  return current.hash !== stored.hash || current.position > stored.position;
}

export interface EngineTurnInput {
  readonly tiers: ResolvedTiers;
  readonly currentModel: string;
  readonly configuredModel: string;
  readonly configuredEffort: SessionEffort | null;
  /** The last real prompt, which this engine-started turn continues. */
  readonly text: string;
  /** The work since that prompt (summarizeSinceLastPrompt). */
  readonly activity: TurnActivity | null;
}

/**
 * A turn the engine started by itself asks Jev nothing (review finding 4).
 * The local guards still cost nothing (N2): when the sticky model is below
 * the session's own and a hard guard holds (a pointer prompt: the only one
 * that needs no Jev answer), restore the session's own model and effort.
 * 0.6.2 F9/F11: a failed test, a sensitive topic or a client site no longer
 * restores by itself; Jev weighs them at the next person prompt. Otherwise
 * null: keep the sticky choice.
 */
export function decideEngineTurn(input: EngineTurnInput): StageDecision | null {
  const guards = activeGuards({ text: input.text, activity: input.activity, confidence: 1 });
  const currentRank = modelRank(input.tiers, input.currentModel);
  const configuredRank = modelRank(input.tiers, input.configuredModel);
  if (guards.length === 0 || currentRank === null || configuredRank === null || currentRank >= configuredRank) return null;
  const guard = guards[0] ?? null;
  return {
    tier: null,
    confidence: null,
    current: input.currentModel,
    proposed: null,
    model: input.configuredModel,
    effort: input.configuredEffort,
    changed: true,
    reason: "floor-restore",
    guard,
    pending: null,
    breakEven: null,
    effortTarget: null,
  };
}
