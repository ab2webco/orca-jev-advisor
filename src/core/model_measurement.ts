// ---------------------------------------------------------------------------
// The model reclassification measurement log.
//
// Same discipline as skill_measurement.ts and gate_measurement.ts: an
// append-only JSONL file (`<cacheDir>/model-reclassifications.jsonl`,
// MODEL_MEASUREMENT_FILE), one line per event, correlated by `id` (the
// Agent tool_use_id) rather than written as a single joined row, because
// the two halves of a decision arrive from different hooks at different
// times -- PreToolUse knows what Jev recommended the instant it answers;
// what the subagent actually ran on (`resolvedModel`, usage, duration) is
// only known later, from PostToolUse, which may fire moments after, much
// later, or (a crashed or killed subagent) never.
//
// NEVER stored here: the task's prompt or description text. Either can
// carry a secret or private project detail, exactly the reasoning
// gate_measurement.ts already applies to shell commands. Only
// `subagentType` and `promptChars` (a count, not the text) are kept.
//
// Pure data shaping only, like the rest of src/core: no fs, no clock, no
// randomness -- the caller supplies `id`/`at` and does the actual append.
// ---------------------------------------------------------------------------

import { isBoolean, isNumber, isNumberOrNull, isRecord, isString, isStringOrNull } from "../guards.ts";
import type { ModelEntry } from "./model_catalog.ts";
import type { ModelRewriteReason } from "./model_decisions.ts";
import { resolveRequestedEntry, type ComplexityReading } from "./model_decisions.ts";
import {
  DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS,
  evaluateModSkillsReadiness,
  type ModSkillsReadiness,
  type ModSkillsReadinessThresholds,
} from "./mod_skills_readiness.ts";

export const MODEL_MEASUREMENT_FILE = "model-reclassifications.jsonl";

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

/** `"jev"`: Jev answered. `"none"`: the hook gave up before or without a Jev answer -- see ModelFailOpenReason. */
export type ModelDecisionSource = "jev" | "none";

/**
 * Why a decision fell back to `source: "none"` (always failing open on the
 * tool call itself -- this bucket exists only so that fallback stops being
 * silent, same reasoning as GateSource's `"none"` in gate_measurement.ts):
 *   - "empty-ladder": the person's catalog has no available, ranked entry to choose from.
 *   - "no-key": no Jev API key is configured.
 *   - "jev-unreachable": the network call to Jev failed or timed out.
 *   - "auth-rejected": Jev's API rejected the configured key.
 *   - "unparseable-answer": Jev answered, but not with a usable `score` answer.
 *   - "invalid-input": the Agent tool_input itself did not parse (parseAgentToolInput returned null).
 */
export type ModelFailOpenReason = "empty-ladder" | "no-key" | "jev-unreachable" | "auth-rejected" | "unparseable-answer" | "invalid-input";

/** The recommended entry, as recorded -- just enough to compare against the catalog later without re-resolving through a live catalog fetch. */
export interface ModelDecisionRecommended {
  readonly id: string;
  readonly agentModel: string;
  readonly rank: number | null;
}

export interface ModelDecisionRecord {
  readonly type: "model-decision";
  /** The Agent tool_use_id -- the join key with ModelOutcomeRecord. */
  readonly id: string;
  readonly at: string;
  readonly mode: "measurement" | "active";
  readonly source: ModelDecisionSource;
  /** Non-null exactly when source is "none"; null when Jev actually answered. */
  readonly failOpen: ModelFailOpenReason | null;
  readonly subagentType: string | null;
  readonly promptChars: number;
  readonly requestedModel: string | null;
  /** Null for a "none" row, or when Jev answered but interpretModelAnswer could not read a recommendation from it. */
  readonly recommended: ModelDecisionRecommended | null;
  readonly score: number | null;
  readonly confidence: number | null;
  /** Whether the tool call was actually rewritten to the recommendation. Always false for a "none" row. */
  readonly applied: boolean;
  readonly rewriteReason: ModelRewriteReason | null;
  readonly ladderSize: number;
  /** Time spent waiting on Jev; null when no Jev call was made (a "none" row that never reached the network). */
  readonly latencyMs: number | null;
  /** The PreToolUse payload's `permission_mode`, when it carried one. */
  readonly permissionMode: string | null;
  /** decisions.ts's four-tier complexity reading, asked in the same Jev call.
   *  Measurement only: it never decides the model (see model_decisions.ts). */
  readonly complexity: ComplexityReading | null;
}

export interface ModelOutcomeRecord {
  readonly type: "model-outcome";
  /** The Agent tool_use_id -- the join key with ModelDecisionRecord. */
  readonly id: string;
  readonly at: string;
  readonly status: string | null;
  readonly resolvedModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number | null;
}

export type ModelMeasurementRecord = ModelDecisionRecord | ModelOutcomeRecord;

/**
 * Reads a PostToolUse `tool_response` for the Agent tool
 * (https://code.claude.com/docs/en/hooks#agent) into an outcome record,
 * defensively: every field is read from where the docs say it lives, and
 * anything missing or the wrong type reads null -- never invented.
 *
 * The docs' "completed" variant carries `totalDurationMs` ("Wall-clock
 * duration of the subagent run") -- neither `durationMs` nor `duration_ms`
 * exists on the real payload, so those two names are never read. The
 * "async_launched" variant (a backgrounded subagent) carries no duration
 * or usage fields at all, since it returns before either exists; that
 * reads null here, exactly like a record written before this field
 * existed.
 */
export function buildModelOutcomeRecord(id: string, at: string, toolResponse: unknown): ModelOutcomeRecord {
  const response = isRecord(toolResponse) ? toolResponse : {};
  const usage = isRecord(response.usage) ? response.usage : {};
  const durationMs = isNumber(response.totalDurationMs) ? response.totalDurationMs : null;
  return {
    type: "model-outcome",
    id,
    at,
    status: isString(response.status) ? response.status : null,
    resolvedModel: isString(response.resolvedModel) ? response.resolvedModel : null,
    inputTokens: isNumber(usage.input_tokens) ? usage.input_tokens : null,
    outputTokens: isNumber(usage.output_tokens) ? usage.output_tokens : null,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Serialize / parse
// ---------------------------------------------------------------------------

/** One JSONL line, newline-terminated, ready to append. */
export function serializeModelRecord(record: ModelMeasurementRecord): string {
  return `${JSON.stringify(record)}\n`;
}

const DECISION_SOURCES: readonly ModelDecisionSource[] = ["jev", "none"];
const FAIL_OPEN_REASONS: readonly ModelFailOpenReason[] = [
  "empty-ladder",
  "no-key",
  "jev-unreachable",
  "auth-rejected",
  "unparseable-answer",
  "invalid-input",
];
const REWRITE_REASONS: readonly ModelRewriteReason[] = ["measurement", "not-ready", "permission-mode", "low-confidence", "same-model", "rewrite"];
const COMPLEXITY_TIERS: readonly string[] = ["trivial", "standard", "advanced", "critical"];

function isComplexityReading(value: unknown): value is ComplexityReading {
  return (
    isRecord(value) &&
    isString(value.tier) &&
    COMPLEXITY_TIERS.indexOf(value.tier) === value.tierIndex &&
    isNumber(value.score)
  );
}

function isModelDecisionSource(value: unknown): value is ModelDecisionSource {
  return DECISION_SOURCES.includes(value as ModelDecisionSource);
}

function isModelFailOpenReason(value: unknown): value is ModelFailOpenReason {
  return FAIL_OPEN_REASONS.includes(value as ModelFailOpenReason);
}

function isModelRewriteReason(value: unknown): value is ModelRewriteReason {
  return REWRITE_REASONS.includes(value as ModelRewriteReason);
}

function isModelDecisionRecommended(value: unknown): value is ModelDecisionRecommended {
  return isRecord(value) && isString(value.id) && isString(value.agentModel) && isNumberOrNull(value.rank);
}

function isModelDecisionRecord(value: unknown): value is ModelDecisionRecord {
  if (!isRecord(value) || value.type !== "model-decision") return false;
  return (
    isString(value.id) &&
    isString(value.at) &&
    (value.mode === "measurement" || value.mode === "active") &&
    isModelDecisionSource(value.source) &&
    (value.failOpen === null || isModelFailOpenReason(value.failOpen)) &&
    isStringOrNull(value.subagentType) &&
    isNumber(value.promptChars) &&
    isStringOrNull(value.requestedModel) &&
    (value.recommended === null || isModelDecisionRecommended(value.recommended)) &&
    isNumberOrNull(value.score) &&
    isNumberOrNull(value.confidence) &&
    isBoolean(value.applied) &&
    (value.rewriteReason === null || isModelRewriteReason(value.rewriteReason)) &&
    isNumber(value.ladderSize) &&
    isNumberOrNull(value.latencyMs) &&
    isStringOrNull(value.permissionMode) &&
    (value.complexity === null || isComplexityReading(value.complexity))
  );
}

function isModelOutcomeRecord(value: unknown): value is ModelOutcomeRecord {
  if (!isRecord(value) || value.type !== "model-outcome") return false;
  return (
    isString(value.id) &&
    isString(value.at) &&
    isStringOrNull(value.status) &&
    isStringOrNull(value.resolvedModel) &&
    isNumberOrNull(value.inputTokens) &&
    isNumberOrNull(value.outputTokens) &&
    isNumberOrNull(value.durationMs)
  );
}

/**
 * Reads `model-reclassifications.jsonl` back one line at a time, tolerantly
 * -- same discipline as gate_measurement.ts's parseGateDecisionRecords: a
 * blank line, invalid JSON, or a line of the wrong shape is skipped, never
 * thrown on. `source: "none"` is a VALID decision row, not a malformed one
 * -- a past defect in this repo (fixed for the gate's own log; guarded
 * against here with a regression test) discarded exactly this shape, which
 * meant a panel reading the log could only ever show zero unjudged
 * decisions, however many actually happened.
 */
export function parseModelRecord(line: string): ModelDecisionRecord | ModelOutcomeRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (isModelDecisionRecord(parsed)) return parsed;
  if (isModelOutcomeRecord(parsed)) return parsed;
  return null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ModelMeasurementSummary {
  /** Decision records, deduped by id (last write wins). */
  readonly decisions: number;
  /** Deduped decisions where Jev actually answered with a usable recommendation (source "jev", recommended non-null). */
  readonly judged: number;
  /** Deduped decisions that fell back to "none" (see ModelFailOpenReason). */
  readonly unjudged: number;
  /** Judged decisions whose requested model resolves to a RANKED catalog entry, and whose recommendation carries a rank. */
  readonly compared: number;
  /** Of `compared`: Jev recommended a larger model (lower rank number) than was requested. */
  readonly up: number;
  /** Of `compared`: Jev recommended a smaller model (higher rank number) than was requested. */
  readonly down: number;
  /** Of `compared`: Jev recommended exactly the requested model's rank. */
  readonly agree: number;
  /** agree / compared; null when `compared` is 0. */
  readonly agreementRate: number | null;
  /** Deduped decisions where the rewrite was actually applied. */
  readonly applied: number;
  /** Outcome records whose id matches a decision (deduped by id, last write wins, for the join below). */
  readonly outcomes: number;
  /** Judged decisions with a joined outcome whose resolvedModel is non-null. */
  readonly comparable: number;
  /** Of `comparable`: the outcome's resolvedModel equals the recommendation's id or agentModel. */
  readonly matches: number;
  /** matches / comparable; null when `comparable` is 0. */
  readonly matchRate: number | null;
  readonly readiness: ModSkillsReadiness;
}

/**
 * Aggregates the raw record log into the counts the readiness metric and
 * an advisor panel both need. All counts are real integers; an empty
 * `records` list yields zeros and nulls throughout, never `undefined`.
 */
export function summarizeModelMeasurements(
  records: readonly ModelMeasurementRecord[],
  catalog: readonly ModelEntry[],
  thresholds: ModSkillsReadinessThresholds = DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS,
): ModelMeasurementSummary {
  const decisionById = new Map<string, ModelDecisionRecord>();
  const outcomeRawById = new Map<string, ModelOutcomeRecord>();
  for (const record of records) {
    if (record.type === "model-decision") decisionById.set(record.id, record);
    else outcomeRawById.set(record.id, record);
  }
  const decisions = [...decisionById.values()];

  const judged = decisions.filter((decision) => decision.source === "jev" && decision.recommended !== null);
  const unjudged = decisions.filter((decision) => decision.source === "none");
  const appliedCount = decisions.filter((decision) => decision.applied).length;

  let compared = 0;
  let up = 0;
  let down = 0;
  let agree = 0;
  for (const decision of judged) {
    const requestedEntry = resolveRequestedEntry(decision.requestedModel, catalog);
    const recommendedRank = decision.recommended?.rank ?? null;
    if (requestedEntry === null || requestedEntry.rank === null || recommendedRank === null) continue;
    compared += 1;
    if (recommendedRank < requestedEntry.rank) up += 1;
    else if (recommendedRank > requestedEntry.rank) down += 1;
    else agree += 1;
  }
  const agreementRate = compared > 0 ? agree / compared : null;

  // Only outcomes that join to a known decision id count -- an outcome with
  // no matching decision is orphaned (its PreToolUse line was never
  // written, or was written to a different log) and tells this summary
  // nothing.
  const joinedOutcomeById = new Map<string, ModelOutcomeRecord>();
  for (const [id, record] of outcomeRawById) {
    if (decisionById.has(id)) joinedOutcomeById.set(id, record);
  }

  let comparable = 0;
  let matches = 0;
  for (const decision of judged) {
    // An applied decision means active mode already rewrote the request to
    // the recommendation, so the outcome's resolvedModel matching it proves
    // nothing about Jev's prediction -- it is circular, not a comparison.
    // Only a decision Jev merely measured (never applied) tells readiness
    // anything about match rate.
    if (decision.applied) continue;
    const outcome = joinedOutcomeById.get(decision.id);
    if (outcome === undefined || outcome.resolvedModel === null) continue;
    comparable += 1;
    const recommended = decision.recommended;
    if (recommended !== null && (outcome.resolvedModel === recommended.id || outcome.resolvedModel === recommended.agentModel)) {
      matches += 1;
    }
  }
  const matchRate = comparable > 0 ? matches / comparable : null;

  const readiness = evaluateModSkillsReadiness({ comparableCount: comparable, matchRate }, thresholds);

  return {
    decisions: decisions.length,
    judged: judged.length,
    unjudged: unjudged.length,
    compared,
    up,
    down,
    agree,
    agreementRate,
    applied: appliedCount,
    outcomes: joinedOutcomeById.size,
    comparable,
    matches,
    matchRate,
    readiness,
  };
}
