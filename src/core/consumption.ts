// JEV-060 slice 1, T3 -- pure functions over the data T1 (turn-usage
// records) and T2 (quota.json) already write, plus the four consumption
// recommendation triggers the board renders. No `$`, no fs, no clock read
// (every function here takes an already-parsed input and, where "now"
// matters, an explicit instant): same discipline as gate_stats.ts and
// ab_report.ts. The worker-side aggregator (T4, adapters/orca/
// read-consumption.mjs) does the actual file I/O and hands the parsed rows
// to aggregateTurnUsage()/parseQuota() below.
//
// Every number here is either a real count or a ratio/mean of real,
// actually-recorded fields. A `null` numeric field on a turn-usage record
// (see hooks/index.ts's recordTurnUsage) means the underlying usage object
// never reported that figure -- it is excluded from every sum and average
// it would otherwise feed, never coerced to 0. A window or model with no
// qualifying data reads back as `null`, never a fabricated zero; only an
// honest count (e.g. `stepCount: 0`) is ever a real zero.

import { isRecord } from "../guards.ts";

// ---------------------------------------------------------------------------
// Turn-usage aggregation
// ---------------------------------------------------------------------------

/** One line already parsed out of a `turn-usage-YYYY-MM-DDTHH.jsonl` file -- see hooks/index.ts's recordTurnUsage for the writer. */
export interface TurnUsageRecord {
  readonly at: string;
  readonly agent: "main" | "subagent";
  readonly model: string;
  readonly effort: string | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly stopReason: string;
  readonly account: string;
  /** JEVADV-63: the project this turn ran in, resolved from the session's cached OrcaContext (see src/core/project_name.ts); null when not yet known this session, or absent on an old record (the read side defaults it to null -- never throws). */
  readonly project: string | null;
}

/**
 * A model's shares of its OWN total tokens (input+output+cacheRead+
 * cacheWrite), not a share of the whole window's traffic -- "74% Sonnet,
 * 57% Opus" in the brief's own numbers is exactly this reading: each
 * model's cache-re-read share is relative to that model's own usage, not to
 * a cross-model total that would make the two percentages incomparable
 * (a rarely-used model could otherwise read as "0.4% of all tokens" instead
 * of the "70% cache re-read" that is the actually actionable figure).
 *
 * Each share's denominator sums only the fields that were actually reported
 * (a null field contributes nothing to any sum, per this module's header);
 * `null` when that model has no non-null numeric field at all in the
 * window, never a fabricated 0.
 *
 * There are four shares -- `inputShare`, `outputShare`, `cacheReadShare`,
 * `cacheWriteShare` -- one per numeric field on `TurnUsageRecord`. Together
 * they account for the model's own total, so when the model has any data
 * `inputShare + outputShare + cacheReadShare + cacheWriteShare` sums to ~1
 * (each `null` share treated as contributing 0 to that sum).
 */
export interface ModelUsageShare {
  readonly model: string;
  readonly stepCount: number;
  readonly inputShare: number | null;
  readonly cacheReadShare: number | null;
  readonly cacheWriteShare: number | null;
  readonly outputShare: number | null;
}

export interface TurnUsageWindowSummary {
  readonly stepCount: number;
  readonly byModel: readonly ModelUsageShare[];
  /**
   * Mean of `cacheRead` over `agent === "main"` steps whose cacheRead is
   * not null -- scoped to main only because the brief's own long-session
   * recommendation is phrased as "average context per MAIN step" (a
   * subagent's own context window is a different, much smaller thing, and
   * mixing the two would understate exactly the number that trigger reads).
   * `null` when there is no such step.
   */
  readonly avgMainStepContextReread: number | null;
  /**
   * Subagent's null-safe token total (input+output+cacheRead+cacheWrite,
   * each summed excluding nulls) divided by the grand null-safe total
   * across every step in the window, main and subagent alike. `null` when
   * the grand total is 0 (no numeric data at all in the window).
   */
  readonly subagentShare: number | null;
  /**
   * 0.6.7 T6: the main conversation and its subagents counted apart, as
   * real totals: how many steps each ran and the null-safe token total
   * (input+output+cacheRead+cacheWrite) of those steps. `tokens` is null
   * when none of that side's steps reported a figure -- never a made-up 0.
   */
  readonly byAgent: Readonly<Record<"main" | "subagent", AgentTokens>>;
}

export interface AgentTokens {
  readonly stepCount: number;
  readonly tokens: number | null;
}

export interface TurnUsageAggregation {
  readonly last24h: TurnUsageWindowSummary;
  readonly last7d: TurnUsageWindowSummary;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LAST_24H_MS = DAY_MS;
const LAST_7D_MS = 7 * DAY_MS;

function atMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Sums only the non-null values, returning `{sum, count}` so a caller can tell "summed to 0" apart from "nothing to sum". */
function sumNonNull(values: readonly (number | null)[]): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    sum += value;
    count += 1;
  }
  return { sum, count };
}

function modelShareFor(model: string, steps: readonly TurnUsageRecord[]): ModelUsageShare {
  const input = sumNonNull(steps.map((s) => s.input));
  const output = sumNonNull(steps.map((s) => s.output));
  const cacheRead = sumNonNull(steps.map((s) => s.cacheRead));
  const cacheWrite = sumNonNull(steps.map((s) => s.cacheWrite));
  const total = input.sum + output.sum + cacheRead.sum + cacheWrite.sum;
  const hasAnyData = input.count + output.count + cacheRead.count + cacheWrite.count > 0;
  const share = (fieldSum: number): number | null => (hasAnyData && total > 0 ? fieldSum / total : null);
  return {
    model,
    stepCount: steps.length,
    inputShare: share(input.sum),
    cacheReadShare: share(cacheRead.sum),
    cacheWriteShare: share(cacheWrite.sum),
    outputShare: share(output.sum),
  };
}

function stepTotalTokens(step: TurnUsageRecord): { sum: number; hasData: boolean } {
  const fields = [step.input, step.output, step.cacheRead, step.cacheWrite];
  const { sum, count } = sumNonNull(fields);
  return { sum, hasData: count > 0 };
}

function summarizeWindow(steps: readonly TurnUsageRecord[]): TurnUsageWindowSummary {
  const byModelMap = new Map<string, TurnUsageRecord[]>();
  for (const step of steps) {
    const forModel = byModelMap.get(step.model) ?? [];
    forModel.push(step);
    byModelMap.set(step.model, forModel);
  }
  const byModel = [...byModelMap.entries()]
    .map(([model, modelSteps]) => modelShareFor(model, modelSteps))
    .sort((a, b) => b.stepCount - a.stepCount || a.model.localeCompare(b.model));

  const mainContextReads = steps.filter((s) => s.agent === "main" && s.cacheRead !== null).map((s) => s.cacheRead as number);
  const avgMainStepContextReread = mainContextReads.length > 0 ? mainContextReads.reduce((a, b) => a + b, 0) / mainContextReads.length : null;

  let subagentTotal = 0;
  let grandTotal = 0;
  let anyData = false;
  const agentSteps = { main: 0, subagent: 0 };
  const agentTokens: Record<"main" | "subagent", number | null> = { main: null, subagent: null };
  for (const step of steps) {
    agentSteps[step.agent] += 1;
    const { sum, hasData } = stepTotalTokens(step);
    if (!hasData) continue;
    anyData = true;
    grandTotal += sum;
    agentTokens[step.agent] = (agentTokens[step.agent] ?? 0) + sum;
    if (step.agent === "subagent") subagentTotal += sum;
  }
  const subagentShare = anyData && grandTotal > 0 ? subagentTotal / grandTotal : null;
  const byAgent = {
    main: { stepCount: agentSteps.main, tokens: agentTokens.main },
    subagent: { stepCount: agentSteps.subagent, tokens: agentTokens.subagent },
  };

  return { stepCount: steps.length, byModel, avgMainStepContextReread, subagentShare, byAgent };
}

/**
 * Folds already-parsed turn-usage records into the 24h and 7d windows the
 * board needs. Pure: `nowMs` is a parameter (never `Date.now()`), so the
 * same input always yields the same output. Records are filtered by their
 * own `at` relative to `nowMs`; a record whose `at` fails to parse is
 * dropped from both windows (it cannot honestly be placed in either).
 */
export function aggregateTurnUsage(records: readonly TurnUsageRecord[], nowMs: number): TurnUsageAggregation {
  const withMs = records
    .map((record) => ({ record, ms: atMs(record.at) }))
    .filter((entry): entry is { record: TurnUsageRecord; ms: number } => entry.ms !== null);

  const windowSteps = (spanMs: number): TurnUsageRecord[] => {
    const sinceMs = nowMs - spanMs;
    return withMs.filter((entry) => entry.ms >= sinceMs).map((entry) => entry.record);
  };

  return {
    last24h: summarizeWindow(windowSteps(LAST_24H_MS)),
    last7d: summarizeWindow(windowSteps(LAST_7D_MS)),
  };
}

// ---------------------------------------------------------------------------
// Quota parsing
// ---------------------------------------------------------------------------

export interface QuotaAccountFableWeekly {
  readonly usedPercent: number | null;
  readonly resetsAt: number | null;
}

export interface QuotaAccount {
  readonly id: string;
  readonly status: string | null;
  readonly sessionUsedPercent: number | null;
  readonly weeklyUsedPercent: number | null;
  readonly resetsAt: number | null;
  /** Present only when the source object actually had one -- see main.mjs's accountQuotaEntry, the writer this mirrors on the read side. Never fabricated as null-but-present. */
  readonly fableWeekly?: QuotaAccountFableWeekly;
}

export interface ParsedQuota {
  readonly accounts: readonly QuotaAccount[];
  readonly checkedAt: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseFableWeekly(value: unknown): QuotaAccountFableWeekly | undefined {
  if (!isRecord(value)) return undefined;
  return { usedPercent: numberOrNull(value.usedPercent), resetsAt: numberOrNull(value.resetsAt) };
}

/**
 * One raw parsed account object (from quota.json's `accounts` array) into
 * the board's tolerant shape, same discipline as main.mjs's own
 * accountQuotaEntry on the write side: a missing or wrong-typed field
 * degrades to `null` rather than throwing or being guessed at. An account
 * with no string `id` is dropped entirely by the caller -- it is this
 * mirror's own primary key, and a row the board cannot identify is not
 * worth rendering half-populated.
 */
function parseQuotaAccount(raw: unknown): QuotaAccount | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const fableWeekly = parseFableWeekly(raw.fableWeekly);
  return {
    id: raw.id,
    status: stringOrNull(raw.status),
    sessionUsedPercent: numberOrNull(raw.sessionUsedPercent),
    weeklyUsedPercent: numberOrNull(raw.weeklyUsedPercent),
    resetsAt: numberOrNull(raw.resetsAt),
    ...(fableWeekly !== undefined ? { fableWeekly } : {}),
  };
}

/**
 * Parses quota.json's already-JSON.parse'd content (or `null`/malformed)
 * into the board's normalized shape. Never throws: a missing file, a
 * non-object payload, or a non-array `accounts` all read as `{accounts:
 * [], checkedAt: null}` -- the honest "no quota mirror has run yet" state,
 * same tolerance style as accountQuotaEntry (T2) on the write side.
 */
export function parseQuota(raw: unknown): ParsedQuota {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) {
    return { accounts: [], checkedAt: null };
  }
  const accounts = raw.accounts.map(parseQuotaAccount).filter((account): account is QuotaAccount => account !== null);
  return { accounts, checkedAt: stringOrNull(raw.checkedAt) };
}

// ---------------------------------------------------------------------------
// Recommendation triggers -- four independent, narrow functions, each
// taking exactly the input it needs (never bundled into one god-function,
// per the brief). Each returns real numbers for the board to interpolate
// into its copy, never a bare boolean.
// ---------------------------------------------------------------------------

/** bytes/4 ≈ tokens, the brief's own stated estimate -- not a tokenizer, an approximation the board's copy must call an estimate. */
const BYTES_PER_TOKEN_ESTIMATE = 4;
export const CLAUDE_MD_TOKEN_THRESHOLD = 8000;

export interface ClaudeMdSizeTrigger {
  readonly estimatedTokens: number;
  readonly overThreshold: boolean;
}

/** `byteLength`: the global CLAUDE.md's content length in bytes, or `null` when the file does not exist -- which yields `null` here too, never a fabricated "0 tokens, not over". */
export function claudeMdSizeTrigger(byteLength: number | null): ClaudeMdSizeTrigger | null {
  if (byteLength === null) return null;
  const estimatedTokens = byteLength / BYTES_PER_TOKEN_ESTIMATE;
  return { estimatedTokens, overThreshold: estimatedTokens > CLAUDE_MD_TOKEN_THRESHOLD };
}

export interface McpServerCountTrigger {
  readonly count: number;
}

/**
 * `claudeJson`: the already-JSON.parse'd `.claude.json` (or `null`). Counts
 * the keys of its top-level `mcpServers` object; 0 when absent, malformed,
 * or the file itself is missing. This is the GLOBAL `~/.claude.json` only
 * -- there is no per-account `.claude.json` to sum across (each Orca-
 * managed account's own `CLAUDE_CONFIG_DIR` still resolves to the same
 * global file for this key; see orca_accounts.ts), so no such counting was
 * attempted here.
 */
export function mcpServerCountTrigger(claudeJson: unknown): McpServerCountTrigger {
  if (!isRecord(claudeJson) || !isRecord(claudeJson.mcpServers)) return { count: 0 };
  return { count: Object.keys(claudeJson.mcpServers).length };
}

export const LONG_SESSION_CONTEXT_THRESHOLD_TOKENS = 150000;

export interface LongSessionTrigger {
  readonly avgMainStepContextReread: number;
  readonly overThreshold: boolean;
}

/** `avgMainStepContextReread`: the 24h window's own {@link TurnUsageWindowSummary.avgMainStepContextReread}. `null` in, `null` out -- no main-step data yet is not "0, so not over". */
export function longSessionTrigger(avgMainStepContextReread: number | null): LongSessionTrigger | null {
  if (avgMainStepContextReread === null) return null;
  return { avgMainStepContextReread, overThreshold: avgMainStepContextReread > LONG_SESSION_CONTEXT_THRESHOLD_TOKENS };
}

export const SUBAGENT_SHARE_THRESHOLD = 0.4;

export interface SubagentShareTrigger {
  readonly subagentSharePercent: number;
  readonly overThreshold: boolean;
}

/** `subagentShare`: the 24h window's own {@link TurnUsageWindowSummary.subagentShare} (a 0..1 fraction). Reported as a 0..100 percent for the board's copy to interpolate directly (e.g. "47%"). `null` in, `null` out. */
export function subagentShareTrigger(subagentShare: number | null): SubagentShareTrigger | null {
  if (subagentShare === null) return null;
  return { subagentSharePercent: subagentShare * 100, overThreshold: subagentShare > SUBAGENT_SHARE_THRESHOLD };
}
