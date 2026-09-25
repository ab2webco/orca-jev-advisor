// ---------------------------------------------------------------------------
// Deciding which model a subagent task needs, and whether to act on it.
//
// A Claude Code PreToolUse hook on the `Agent` tool asks Jev which model, of
// the person's own available ladder (model_catalog.ts), a subagent task
// needs -- then, only in active mode and only when Jev is both ready and
// confident, rewrites the tool call to use it. Two documented facts about
// the mechanism shape everything here:
//
//   - PreToolUse may return `hookSpecificOutput.updatedInput`, which
//     REPLACES THE WHOLE `tool_input` and only takes effect together with
//     `permissionDecision: "allow"` -- so a rewrite must echo every original
//     field, not just `model`, or the orchestrator's other fields (prompt,
//     description, subagent_type, ...) are silently dropped.
//     https://code.claude.com/docs/en/hooks#pretooluse-decision-control
//   - The per-invocation `model` parameter is first in subagent model
//     resolution -- ahead of the subagent's own frontmatter and the
//     session default -- so setting it here is enough to steer the call.
//     https://code.claude.com/docs/en/sub-agents#choose-a-model
//
// This module builds the Jev `score` question and state from the tool
// input and the ladder, interprets the answer back into a ladder entry, and
// decides whether a rewrite is warranted. It performs no I/O and knows
// nothing about hooks, HTTP, or the measurement log (model_measurement.ts)
// -- pure, like the rest of src/core.
// ---------------------------------------------------------------------------

import { isRecord, isString } from "../guards.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { buildComplexityQuestion, scoreComplexity, type ComplexityTier } from "./decisions.ts";
import type { Answer, JsonValue, Question, ScoreQuestion } from "./jev.ts";

// ---------------------------------------------------------------------------
// The Agent tool's own input
// ---------------------------------------------------------------------------

export interface AgentToolInput {
  /** The original tool_input, untouched -- every field of it must survive a rewrite. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly description: string | null;
  readonly subagentType: string | null;
  readonly model: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/** An absent or non-string optional field reads as null; so does an explicit empty string. */
function readOptionalString(value: unknown): string | null {
  return isString(value) && value.length > 0 ? value : null;
}

/**
 * `null` unless `value` is a record carrying a non-empty string `prompt`.
 * `raw` keeps the exact object handed in, so a later rewrite
 * (buildUpdatedAgentInput) can echo fields this parser does not know about.
 */
export function parseAgentToolInput(value: unknown): AgentToolInput | null {
  if (!isRecord(value) || !isNonEmptyString(value.prompt)) return null;
  return {
    raw: value,
    prompt: value.prompt,
    description: readOptionalString(value.description),
    // The Agent tool's own input schema names this field `subagent_type`
    // (snake_case, unlike the rest of this parsed shape) -- reading
    // `subagentType` here would silently and permanently read null.
    subagentType: readOptionalString(value.subagent_type),
    model: readOptionalString(value.model),
  };
}

// ---------------------------------------------------------------------------
// The Jev question and state
// ---------------------------------------------------------------------------

export const MODEL_QUESTION_KEY = "model_tier";

/** A prompt this long tells Jev nothing more about the task; capped so the state stays bounded. */
export const MODEL_STATE_PROMPT_CHARS = 8000;

function levelText(entry: ModelEntry): string {
  return entry.summary !== undefined && entry.summary.length > 0 ? `${entry.label}: ${entry.summary}` : entry.label;
}

/**
 * `ladder` is availableLadder's output: ranked, available entries, largest
 * first. The question orders levels the other way, SMALLEST first (index 0
 * = the smallest available model), because a `score` question's criteria
 * are indexed low-to-high and the instructions ask Jev to pick the smallest
 * level that will do -- "smallest" has to be index 0 for that to be a
 * coherent instruction. Built only from the ladder handed in: a person
 * adding, removing, or reordering catalog entries changes this question
 * with no code change here.
 */
export function buildModelQuestion(ladder: readonly ModelEntry[]): ScoreQuestion | null {
  if (ladder.length === 0) return null;
  const smallestFirst = [...ladder].reverse();
  return {
    type: "score",
    instructions:
      "The state describes a subagent task about to run: its prompt, description, and subagent type. " +
      "Judge how capable a model that task actually needs to be done well. The levels below are the " +
      "models available to run it on, ordered from the smallest to the most capable. Choose the " +
      "smallest level that will still do the task well.",
    criteria: smallestFirst.map(levelText),
  };
}

/**
 * The state Jev sees for `buildModelQuestion`'s question: the task itself,
 * what was requested (so Jev can be told, not so it decides by matching
 * it), and the same smallest-first levels as the question's criteria, so a
 * legend index and a `levels[]` entry always line up positionally.
 */
export function buildModelState(input: AgentToolInput, ladder: readonly ModelEntry[]): JsonValue {
  const smallestFirst = [...ladder].reverse();
  const truncated = input.prompt.length > MODEL_STATE_PROMPT_CHARS;
  const prompt = truncated ? input.prompt.slice(0, MODEL_STATE_PROMPT_CHARS) : input.prompt;
  return {
    task: {
      description: input.description,
      subagentType: input.subagentType,
      prompt,
      promptTruncated: truncated,
    },
    requestedModel: input.model,
    levels: smallestFirst.map((entry, level) => ({
      level,
      label: entry.label,
      summary: entry.summary !== undefined && entry.summary.length > 0 ? entry.summary : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Interpreting Jev's answer back into a ladder entry
// ---------------------------------------------------------------------------

export interface ModelRecommendation {
  readonly entry: ModelEntry;
  readonly level: number;
  /** Jev's raw, possibly fractional score -- kept for the measurement record. */
  readonly score: number;
  readonly confidence: number;
}

/**
 * `null` when there is nothing to interpret: no answer, an answer of the
 * wrong question type, an empty ladder, or a non-finite score (the API is
 * not expected to send one, but this never trusts an unvalidated caller).
 * Otherwise the score is rounded to the nearest level and clamped into
 * range, then read off the same smallest-first ordering the question used.
 */
export function interpretModelAnswer(answer: Answer | undefined, ladder: readonly ModelEntry[]): ModelRecommendation | null {
  if (answer === undefined || answer.type !== "score" || ladder.length === 0 || !Number.isFinite(answer.score)) return null;
  const smallestFirst = [...ladder].reverse();
  const level = Math.min(smallestFirst.length - 1, Math.max(0, Math.round(answer.score)));
  const entry = smallestFirst[level];
  if (entry === undefined) return null;
  return { entry, level, score: answer.score, confidence: answer.confidence };
}

/** Matches `agentModel` first, then `id`, against a catalog; null for a null request or no match. */
export function resolveRequestedEntry(requested: string | null, catalog: readonly ModelEntry[]): ModelEntry | null {
  if (requested === null) return null;
  return catalog.find((entry) => entry.agentModel === requested) ?? catalog.find((entry) => entry.id === requested) ?? null;
}

// ---------------------------------------------------------------------------
// Whether to rewrite the tool call
// ---------------------------------------------------------------------------

/**
 * Jev's own confidence number for the recommendation; 0.7 is OUR starting
 * threshold for acting on it, not something Jev defines -- kept as one
 * named constant so it can be revisited from a single place once real
 * measurement-mode data exists to tune it from.
 */
export const DEFAULT_MODEL_REWRITE_CONFIDENCE = 0.7;

export type ModelRewriteReason = "measurement" | "not-ready" | "permission-mode" | "low-confidence" | "same-model" | "rewrite";

// An active rewrite has to return `permissionDecision: "allow"` for
// `updatedInput` to apply (https://code.claude.com/docs/en/hooks#pretooluse-decision-control),
// and that "allow" would override an ask or a deny the person's own
// permission rules would have produced for this Agent call. So a rewrite is
// only offered under a permission mode that would have let the call through
// anyway. Per https://code.claude.com/docs/en/permission-modes#available-modes
// only `bypassPermissions` runs "Everything" without asking: `acceptEdits`
// covers reads, file edits and common filesystem commands, and `auto` sends a
// subagent's task to a classifier before it starts, which an "allow" would
// skip. Under every other mode, including one this code does not know, the
// hook measures only and records why ("permission-mode").
const REWRITE_PERMISSION_MODES: ReadonlySet<string> = new Set(["bypassPermissions"]);

/** Whether the PreToolUse payload's `permission_mode` lets an active rewrite return "allow". */
export function permissionModeAllowsRewrite(permissionMode: string | null): boolean {
  return permissionMode !== null && REWRITE_PERMISSION_MODES.has(permissionMode);
}

export interface DecideModelRewriteInput {
  readonly mode: "measurement" | "active";
  readonly ready: boolean;
  readonly recommendation: ModelRecommendation;
  /** What the orchestrator actually requested; null means it named nothing, so the subagent would have inherited a model. */
  readonly requestedModel: string | null;
  readonly minConfidence: number;
  /** permissionModeAllowsRewrite of the PreToolUse payload's `permission_mode`. */
  readonly permissionAllowsRewrite: boolean;
}

/**
 * Measurement mode never rewrites -- it only records what Jev would have
 * done (model_measurement.ts). Readiness gates next: mod-skills' own
 * activation metric (evaluateModSkillsReadiness) applies here too, so
 * active mode does not start rewriting the instant it is turned on with no
 * evidence behind it. Confidence is inclusive: exactly `minConfidence`
 * clears the bar. A null `requestedModel` -- nothing named, so the
 * subagent would inherit whatever the session default is -- counts as
 * "different" from the recommendation: Jev decides the model independently
 * of whether the orchestrator happened to name one.
 */
export function decideModelRewrite(input: DecideModelRewriteInput): { rewrite: boolean; reason: ModelRewriteReason } {
  if (input.mode === "measurement") return { rewrite: false, reason: "measurement" };
  if (!input.ready) return { rewrite: false, reason: "not-ready" };
  if (!input.permissionAllowsRewrite) return { rewrite: false, reason: "permission-mode" };
  if (input.recommendation.confidence < input.minConfidence) return { rewrite: false, reason: "low-confidence" };
  const { entry } = input.recommendation;
  if (input.requestedModel !== null && (input.requestedModel === entry.agentModel || input.requestedModel === entry.id)) {
    return { rewrite: false, reason: "same-model" };
  }
  return { rewrite: true, reason: "rewrite" };
}

/**
 * The only shape a PreToolUse rewrite may send back: the original
 * `tool_input` with just `model` overridden, because `updatedInput`
 * REPLACES the whole tool_input (see the module comment) -- an omitted
 * field here is a field silently dropped from the real Agent call.
 */
export function buildUpdatedAgentInput(raw: Readonly<Record<string, unknown>>, agentModel: string): Record<string, unknown> {
  return { ...raw, model: agentModel };
}

// ---------------------------------------------------------------------------
// The complexity tier, asked in the same Jev call, recorded, never deciding.
//
// src/core/decisions.ts already carries a four-tier complexity question
// (trivial / standard / advanced / critical) that nothing called. Its tiers
// are fixed, while the model question above must follow the person's ladder
// (adding or reordering models needs no code change), so the ladder question
// decides and the tier is only measured next to it: a model-agnostic reading
// of how much effort the task needs, kept as evidence for a later effort
// slice. decisions.ts is imported, never edited here.
// ---------------------------------------------------------------------------

/** The key buildComplexityQuestion (decisions.ts) asks its question under. */
export const COMPLEXITY_QUESTION_KEY = "complexity";

/** The text the complexity question rates: the description when there is
 *  one, otherwise the prompt capped like the state's copy of it. */
export function complexityTaskText(input: AgentToolInput): string {
  return input.description ?? input.prompt.slice(0, MODEL_STATE_PROMPT_CHARS);
}

/** Both questions for one Jev request; null for an empty ladder. */
export function buildModelQuestions(ladder: readonly ModelEntry[], input: AgentToolInput): Record<string, Question> | null {
  const modelQuestion = buildModelQuestion(ladder);
  if (modelQuestion === null) return null;
  return { [MODEL_QUESTION_KEY]: modelQuestion, ...buildComplexityQuestion(complexityTaskText(input)) };
}

export interface ComplexityReading {
  readonly tier: ComplexityTier;
  readonly tierIndex: number;
  readonly score: number;
}

/** The tier scoreComplexity reads from the answers, or null when absent. */
export function interpretComplexityAnswer(answers: Record<string, Answer>): ComplexityReading | null {
  const decision = scoreComplexity(answers);
  return decision === null ? null : { tier: decision.tier, tierIndex: decision.tierIndex, score: decision.score };
}
