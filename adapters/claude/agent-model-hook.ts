// ---------------------------------------------------------------------------
// The testable core of the Agent PreToolUse/PostToolUse hook.
//
// adapters/claude/agent-model.ts is the thin CLI entry point (reads stdin,
// resolves the API key, appends the measurement log, writes stdout) --
// exactly the split gate-bash.ts (a CLI) and src/core/decisions.ts (pure
// logic) already use, so this function can be unit tested with plain fake
// deps instead of a subprocess, network calls, and a throwaway filesystem.
//
// Two documented facts about Claude Code's Agent tool shape everything
// below (also cited in src/core/model_decisions.ts, which does the actual
// question-building and interpreting):
//
//   - PreToolUse's `hookSpecificOutput.updatedInput` REPLACES THE WHOLE
//     `tool_input` and only takes effect together with
//     `permissionDecision: "allow"` -- so a rewrite must echo every
//     original field, not just `model`.
//     https://code.claude.com/docs/en/hooks#pretooluse-decision-control
//   - PostToolUse on `Agent` reports `resolvedModel` (plus usage/duration
//     when present). https://code.claude.com/docs/en/hooks#agent
//
// ALWAYS fails open, same discipline as gate-bash.ts: this function never
// throws. Any unexpected error is caught and turned into a `source: "none"`
// decision row with `failOpen: "jev-unreachable"` when a tool_use_id is
// known (there is no question to answer once the id itself is unknown),
// and `stdout` is always `null` on that path -- an Agent call must never be
// blocked or rewritten by a bug in this hook.
//
// Measurement mode (the default) NEVER returns a non-null stdout: a silent
// PreToolUse response leaves the Agent call's permissions completely
// untouched, which is the whole point of "nothing changes yet" -- see
// model_decisions.ts's decideModelRewrite and the module note on
// permissionModeAllowsRewrite for why only `bypassPermissions` ever
// qualifies for a rewrite at all.
// ---------------------------------------------------------------------------

import { isRecord, isString } from "../../src/guards.ts";
import { availableLadder, type ModelEntry } from "../../src/core/model_catalog.ts";
import {
  DEFAULT_MODEL_REWRITE_CONFIDENCE,
  MODEL_QUESTION_KEY,
  buildModelQuestions,
  buildModelState,
  buildUpdatedAgentInput,
  decideModelRewrite,
  interpretComplexityAnswer,
  interpretModelAnswer,
  parseAgentToolInput,
  permissionModeAllowsRewrite,
  type AgentToolInput,
  type ComplexityReading,
} from "../../src/core/model_decisions.ts";
import { buildModelOutcomeRecord, type ModelDecisionRecord, type ModelFailOpenReason, type ModelMeasurementRecord } from "../../src/core/model_measurement.ts";
import { parseModelsMirror } from "../../src/core/model_mirror.ts";
import { JevRequestError, type JevResponse, type JsonValue, type Question } from "../../src/core/jev.ts";

export interface AgentModelHookDeps {
  readonly mirror: unknown;
  readonly apiKey: string | null;
  readonly askJev: (apiKey: string, state: JsonValue, questions: Record<string, Question>) => Promise<JevResponse>;
  readonly now: () => Date;
  readonly clockMs: () => number;
}

export interface AgentModelHookResult {
  readonly stdout: string | null;
  readonly record: ModelMeasurementRecord | null;
}

function readToolUseId(payload: Record<string, unknown>): string | null {
  const id = payload.tool_use_id;
  return isString(id) && id.length > 0 ? id : null;
}

interface NoneRowInput {
  readonly id: string;
  readonly at: string;
  readonly mode: "measurement" | "active";
  readonly failOpen: ModelFailOpenReason;
  readonly subagentType: string | null;
  readonly promptChars: number;
  readonly requestedModel: string | null;
  readonly ladderSize: number;
  readonly latencyMs: number | null;
  readonly permissionMode: string | null;
}

/** A fail-open decision row: source "none", every judged field null, applied always false. */
function buildNoneDecisionRecord(input: NoneRowInput): ModelDecisionRecord {
  return {
    type: "model-decision",
    id: input.id,
    at: input.at,
    mode: input.mode,
    source: "none",
    failOpen: input.failOpen,
    subagentType: input.subagentType,
    promptChars: input.promptChars,
    requestedModel: input.requestedModel,
    recommended: null,
    score: null,
    confidence: null,
    applied: false,
    rewriteReason: null,
    ladderSize: input.ladderSize,
    latencyMs: input.latencyMs,
    permissionMode: input.permissionMode,
    complexity: null,
  };
}

async function handlePreToolUse(payload: Record<string, unknown>, id: string, deps: AgentModelHookDeps): Promise<AgentModelHookResult> {
  const at = deps.now().toISOString();
  const permissionMode = isString(payload.permission_mode) ? payload.permission_mode : null;

  const input: AgentToolInput | null = parseAgentToolInput(payload.tool_input);
  if (input === null) {
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id, at, mode: "measurement", failOpen: "invalid-input",
        subagentType: null, promptChars: 0, requestedModel: null, ladderSize: 0, latencyMs: null, permissionMode,
      }),
    };
  }

  const mirror = parseModelsMirror(deps.mirror);
  const ladder: readonly ModelEntry[] = availableLadder(mirror.models);
  const mode: "measurement" | "active" = mirror.active ? "active" : "measurement";
  const promptChars = input.prompt.length;

  const questions = buildModelQuestions(ladder, input);
  if (ladder.length === 0 || questions === null) {
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id, at, mode, failOpen: "empty-ladder",
        subagentType: input.subagentType, promptChars, requestedModel: input.model, ladderSize: ladder.length, latencyMs: null, permissionMode,
      }),
    };
  }

  if (deps.apiKey === null) {
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id, at, mode, failOpen: "no-key",
        subagentType: input.subagentType, promptChars, requestedModel: input.model, ladderSize: ladder.length, latencyMs: null, permissionMode,
      }),
    };
  }

  const state = buildModelState(input, ladder);
  const t0 = deps.clockMs();
  let response: JevResponse;
  try {
    response = await deps.askJev(deps.apiKey, state, questions);
  } catch (error) {
    const latencyMs = deps.clockMs() - t0;
    const failOpen: ModelFailOpenReason = error instanceof JevRequestError && (error.status === 401 || error.status === 403) ? "auth-rejected" : "jev-unreachable";
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id, at, mode, failOpen,
        subagentType: input.subagentType, promptChars, requestedModel: input.model, ladderSize: ladder.length, latencyMs, permissionMode,
      }),
    };
  }
  const latencyMs = deps.clockMs() - t0;

  const recommendation = interpretModelAnswer(response.answers[MODEL_QUESTION_KEY], ladder);
  if (recommendation === null) {
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id, at, mode, failOpen: "unparseable-answer",
        subagentType: input.subagentType, promptChars, requestedModel: input.model, ladderSize: ladder.length, latencyMs, permissionMode,
      }),
    };
  }

  const complexity: ComplexityReading | null = interpretComplexityAnswer(response.answers);
  const decision = decideModelRewrite({
    mode,
    ready: mirror.ready,
    recommendation,
    requestedModel: input.model,
    minConfidence: DEFAULT_MODEL_REWRITE_CONFIDENCE,
    permissionAllowsRewrite: permissionModeAllowsRewrite(permissionMode),
  });

  const entry = recommendation.entry;
  const stdout = decision.rewrite
    ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `orca-jev-advisor: Jev moved this subagent to ${entry.label}`,
          updatedInput: buildUpdatedAgentInput(input.raw, entry.agentModel),
        },
      })
    : null;

  const record: ModelDecisionRecord = {
    type: "model-decision",
    id,
    at,
    mode,
    source: "jev",
    failOpen: null,
    subagentType: input.subagentType,
    promptChars,
    requestedModel: input.model,
    recommended: { id: entry.id, agentModel: entry.agentModel, rank: entry.rank },
    score: recommendation.score,
    confidence: recommendation.confidence,
    applied: decision.rewrite,
    rewriteReason: decision.reason,
    ladderSize: ladder.length,
    latencyMs,
    permissionMode,
    complexity,
  };

  return { stdout, record };
}

/**
 * `payload` is the raw hook JSON on stdin, already `JSON.parse`d by the CLI
 * entry point. Never throws: any unexpected error is caught and, when the
 * Agent tool_use_id is at least known, turned into a fail-open `source:
 * "none"` decision row (`failOpen: "jev-unreachable"`) -- `stdout` is
 * always `null` on that path.
 */
export async function handleAgentModelHook(payload: unknown, deps: AgentModelHookDeps): Promise<AgentModelHookResult> {
  const id = isRecord(payload) ? readToolUseId(payload) : null;
  try {
    if (!isRecord(payload) || payload.tool_name !== "Agent") return { stdout: null, record: null };
    if (id === null) return { stdout: null, record: null };

    if (payload.hook_event_name === "PreToolUse") {
      return await handlePreToolUse(payload, id, deps);
    }
    if (payload.hook_event_name === "PostToolUse") {
      return { stdout: null, record: buildModelOutcomeRecord(id, deps.now().toISOString(), payload.tool_response) };
    }
    if (payload.hook_event_name === "PostToolUseFailure") {
      const base = buildModelOutcomeRecord(id, deps.now().toISOString(), null);
      return { stdout: null, record: { ...base, status: "failed" } };
    }
    return { stdout: null, record: null };
  } catch {
    if (id === null) return { stdout: null, record: null };
    return {
      stdout: null,
      record: buildNoneDecisionRecord({
        id,
        at: new Date().toISOString(),
        mode: "measurement",
        failOpen: "jev-unreachable",
        subagentType: null,
        promptChars: 0,
        requestedModel: null,
        ladderSize: 0,
        latencyMs: null,
        permissionMode: null,
      }),
    };
  }
}
