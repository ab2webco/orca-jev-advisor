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
import { ROUTER_TIERS, collapseTier, modelRank } from "./model_router_accounts.ts";
import type { ModelPrices, ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { TIER_EFFORT, activeGuards, exactModelId, shiftForPressure } from "./model_router_decide.ts";
import type { GuardContext, QuotaBand, RouterDecision, SessionEffort, TierJudgment, TurnActivity } from "./model_router_decide.ts";

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

// ---------------------------------------------------------------------------
// §6.1 the previous turn's compact activity
// ---------------------------------------------------------------------------

/** The part of a `$.session.messages()` row this summary reads. */
export interface ActivityMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolUses: readonly { readonly tool: string; readonly input: Readonly<Record<string, unknown>>; readonly text?: string; readonly isError?: true }[];
  readonly toolResults?: readonly { readonly isError?: boolean }[];
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_COMMAND = /\b(npm (run )?test|npx (jest|vitest|playwright test)|jest|vitest|pytest|go test|cargo test|node --test|bun test|deno test|phpunit|rspec)\b/;
const TEST_FAILED = /✖|\bFAIL\b|\b[1-9]\d* (failing|failed|failures?)\b|\bfail [1-9]/;

function isRealPrompt(message: ActivityMessage): boolean {
  return message.role === "user" && message.text.trim().length > 0 && (message.toolResults === undefined || message.toolResults.length === 0);
}

/**
 * What the assistant did between the last two real prompts: tool calls,
 * edits, tests run and failed, errors. `mentions` (edited paths and
 * commands) is read only by the local sensitive-topic guard, never sent.
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
  for (const message of range) {
    for (const result of message.toolResults ?? []) if (result.isError === true) errors += 1;
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
}

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
}

export type StageReason = "jev-failed" | "same" | "upgrade" | "low-confidence" | "floor-restore" | "held-by-guard" | "prices-unknown" | "hysteresis" | "break-even" | "downgrade";

export interface StageDecision extends Omit<RouterDecision, "reason"> {
  readonly reason: StageReason;
  /** The lower tier waiting on hysteresis after this turn; null when none. */
  readonly pending: PendingLower | null;
  readonly breakEven: BreakEven | null;
}

export function decideStage(input: StageDecisionInput): StageDecision {
  const current = input.currentModel;
  const stay = { current, model: current, effort: input.currentEffort, changed: false, breakEven: null } as const;
  // Guards first, Jev or not: a Jev failure is itself a guard (confidence
  // null counts as low), so it can never keep the session below its own
  // model (§6.2, review finding 1).
  const guards = activeGuards(input.guards);
  const currentRank = modelRank(input.tiers, current);
  const configuredRank = modelRank(input.tiers, input.configuredModel);
  const belowFloor = guards.length > 0 && currentRank !== null && configuredRank !== null && currentRank < configuredRank;
  const floorGuard = guards.includes("previous-failure") ? "previous-failure" : (guards[0] ?? null);
  if (input.jev === null) {
    if (belowFloor) {
      return { ...stay, tier: null, confidence: null, proposed: null, model: input.configuredModel, effort: input.configuredEffort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null };
    }
    return { ...stay, tier: null, confidence: null, proposed: null, reason: "jev-failed", guard: null, pending: input.pending };
  }
  const tier = collapseTier(input.tiers, shiftForPressure(input.jev.tier, input.band, guards, input.guards.activity));
  const target = input.tiers[tier];
  const targetEffort = target.supportsEffort ? TIER_EFFORT[tier] : null;
  const base = { tier, confidence: input.jev.confidence, proposed: target.modelId };
  const proposedRank = modelRank(input.tiers, target.modelId);

  // Below the session's own model while any guard holds: restore at least
  // the session's own, whatever Jev's confidence (§6.2 "never below the
  // configured model"; §6.4 "a guard requires it" -- the previous turn
  // failing on the weaker model is the named case, so it is the one named).
  // The session's own effort goes back exactly as it sent it (`max` too).
  if (belowFloor) {
    const toTarget = proposedRank !== null && configuredRank !== null && proposedRank > configuredRank;
    const model = toTarget ? exactModelId(target.modelId, input.configuredModel) : input.configuredModel;
    const effort = toTarget ? targetEffort : input.configuredEffort;
    return { ...base, current, model, effort, changed: true, reason: "floor-restore", guard: floorGuard, pending: null, breakEven: null };
  }
  if (currentRank === null || proposedRank === null || proposedRank === currentRank) {
    return { ...stay, ...base, reason: "same", guard: null, pending: null };
  }
  if (proposedRank > currentRank) {
    if (input.jev.confidence < 0.7) return { ...stay, ...base, reason: "low-confidence", guard: null, pending: null };
    const model = exactModelId(target.modelId, input.configuredModel);
    const effort = model === input.configuredModel ? input.configuredEffort ?? targetEffort : targetEffort;
    return { ...base, current, model, effort, changed: true, reason: "upgrade", guard: null, pending: null, breakEven: null };
  }

  // Downgrade.
  if (guards.length > 0) return { ...stay, ...base, reason: "held-by-guard", guard: guards[0] ?? null, pending: null };
  const pending: PendingLower = { tier, turns: input.pending !== null && input.pending.tier === tier ? input.pending.turns + 1 : 1 };
  const currentTier = ROUTER_TIERS[currentRank] ?? "complex";
  const prices = { current: input.tiers[currentTier].prices, proposed: target.prices };
  if (prices.current === null || prices.proposed === null) return { ...stay, ...base, reason: "prices-unknown", guard: null, pending };
  if (pending.turns < hysteresisTurns(input.band)) return { ...stay, ...base, reason: "hysteresis", guard: null, pending };
  const result =
    input.usage === null
      ? null
      : breakEven({ contextTokens: input.usage.contextTokens, avgOutput: input.usage.avgOutput, current: prices.current, proposed: prices.proposed, medianStepsPerTurn: input.usage.medianStepsPerTurn });
  if (result === null || !result.worthIt) return { ...stay, ...base, reason: "break-even", guard: null, pending, breakEven: result };
  // Back down to the session's own model: its exact id (a `[1m]` suffix
  // included) and its own effort, so nothing is rewritten any more (N1).
  const model = exactModelId(target.modelId, input.configuredModel);
  const effort = model === input.configuredModel ? input.configuredEffort : targetEffort;
  return { ...base, current, model, effort, changed: true, reason: "downgrade", guard: null, pending: null, breakEven: result };
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
 * the session's own and the work since the last prompt failed, or touches a
 * sensitive topic, restore the session's own model and effort. Otherwise
 * null: keep the sticky choice.
 */
export function decideEngineTurn(input: EngineTurnInput): StageDecision | null {
  const guards = activeGuards({ destinationKind: null, policyHit: false, text: input.text, activity: input.activity, confidence: 1 }).filter(
    (guard) => guard === "previous-failure" || guard === "sensitive-topic",
  );
  const currentRank = modelRank(input.tiers, input.currentModel);
  const configuredRank = modelRank(input.tiers, input.configuredModel);
  if (guards.length === 0 || currentRank === null || configuredRank === null || currentRank >= configuredRank) return null;
  const guard = guards.includes("previous-failure") ? "previous-failure" : (guards[0] ?? null);
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
  };
}
