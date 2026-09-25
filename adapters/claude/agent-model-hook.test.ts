// Exercises handleAgentModelHook (the testable core of agent-model.ts) with
// plain fake deps -- no network, no filesystem, no clock. See the module
// note on agent-model-hook.ts for why the CLI entry point stays a thin
// shell around this function.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { JevRequestError, type JevResponse } from "../../src/core/jev.ts";
import { COMPLEXITY_QUESTION_KEY, MODEL_QUESTION_KEY } from "../../src/core/model_decisions.ts";
import type { ModelEntry } from "../../src/core/model_catalog.ts";
import type { ModelDecisionRecord, ModelOutcomeRecord } from "../../src/core/model_measurement.ts";
import { handleAgentModelHook, type AgentModelHookDeps } from "./agent-model-hook.ts";

function entry(overrides: Partial<ModelEntry> & { id: string; rank: number }): ModelEntry {
  return {
    provider: "anthropic",
    label: overrides.id,
    agentModel: overrides.id,
    source: "https://example.test/doc",
    available: true,
    ...overrides,
  };
}

const OPUS = entry({ id: "opus", rank: 1, label: "Opus 5.5" });
const SONNET = entry({ id: "sonnet", rank: 2, label: "Sonnet 5" });
const HAIKU = entry({ id: "haiku", rank: 3, label: "Haiku 4.5" });
const LADDER = [OPUS, SONNET, HAIKU];

const FIXED_NOW = new Date("2026-09-24T00:00:00.000Z");

function scoreAnswer(score: number, confidence = 0.9) {
  return { type: "score" as const, score, legend: {}, probabilities: {}, confidence };
}

/** answers[MODEL_QUESTION_KEY] is scored against the SMALLEST-first ordering
 *  (haiku=0, sonnet=1, opus=2) -- see model_decisions.ts's buildModelQuestion. */
function jevResponse(modelScore: number, extra?: Partial<JevResponse["answers"]>): JevResponse {
  return {
    model: "jev-latest",
    usage: { input_tokens: 10, output_tokens: 5 },
    answers: {
      [MODEL_QUESTION_KEY]: scoreAnswer(modelScore),
      ...extra,
    },
  };
}

function baseDeps(overrides: Partial<AgentModelHookDeps> = {}): AgentModelHookDeps {
  return {
    mirror: { active: false, ready: false, models: LADDER },
    apiKey: "test-key",
    askJev: async () => jevResponse(2),
    now: () => FIXED_NOW,
    clockMs: (() => {
      let t = 0;
      return () => {
        t += 100;
        return t;
      };
    })(),
    ...overrides,
  };
}

function preToolUsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "tool-1",
    tool_input: { prompt: "do the thing", description: "a task", subagent_type: "general-purpose", model: "haiku" },
    permission_mode: "default",
    ...overrides,
  };
}

function decisionRecord(result: { record: unknown }): ModelDecisionRecord {
  assert.ok(result.record !== null && (result.record as { type: string }).type === "model-decision");
  return result.record as ModelDecisionRecord;
}

// ---------------------------------------------------------------------------

test("a non-Agent tool_name is ignored entirely", async () => {
  const result = await handleAgentModelHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "x" }, baseDeps());
  assert.deepEqual(result, { stdout: null, record: null });
});

test("PreToolUse with no tool_use_id yields no stdout and no record", async () => {
  const result = await handleAgentModelHook(preToolUsePayload({ tool_use_id: undefined }), baseDeps());
  assert.deepEqual(result, { stdout: null, record: null });
});

test("fail-open: invalid tool_input (no prompt) records source none / invalid-input", async () => {
  const result = await handleAgentModelHook(preToolUsePayload({ tool_input: { description: "no prompt here" } }), baseDeps());
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.source, "none");
  assert.equal(record.failOpen, "invalid-input");
  assert.equal(record.subagentType, null);
  assert.equal(record.promptChars, 0);
  assert.equal(record.requestedModel, null);
  assert.equal(record.ladderSize, 0);
  assert.equal(record.latencyMs, null);
  assert.equal(record.applied, false);
});

test("fail-open: an empty ladder records source none / empty-ladder", async () => {
  const result = await handleAgentModelHook(preToolUsePayload(), baseDeps({ mirror: { active: false, ready: false, models: [] } }));
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "empty-ladder");
  assert.equal(record.subagentType, "general-purpose");
  assert.equal(record.promptChars, "do the thing".length);
  assert.equal(record.ladderSize, 0);
});

test("fail-open: no API key records source none / no-key, with the real ladder size known", async () => {
  const result = await handleAgentModelHook(preToolUsePayload(), baseDeps({ apiKey: null }));
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "no-key");
  assert.equal(record.ladderSize, LADDER.length);
  assert.equal(record.latencyMs, null, "no Jev call was ever made");
});

test("fail-open: a 401 from Jev records source none / auth-rejected, with latency", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({
      askJev: async () => {
        throw new JevRequestError("nope", 401);
      },
    }),
  );
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "auth-rejected");
  assert.ok(typeof record.latencyMs === "number" && record.latencyMs > 0);
});

test("fail-open: any other Jev failure records source none / jev-unreachable", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({
      askJev: async () => {
        throw new Error("network exploded");
      },
    }),
  );
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "jev-unreachable");
});

test("fail-open: an unparseable answer records source none / unparseable-answer, keeping latency, with complexity null", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({ askJev: async () => ({ model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 }, answers: {} }) }),
  );
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "unparseable-answer");
  assert.ok(typeof record.latencyMs === "number" && record.latencyMs > 0);
  assert.equal(record.complexity, null);
});

test("measurement mode prints nothing on stdout but still records the recommendation as a judged row", async () => {
  const result = await handleAgentModelHook(preToolUsePayload(), baseDeps());
  assert.equal(result.stdout, null, "measurement mode must never touch permissions");
  const record = decisionRecord(result);
  assert.equal(record.source, "jev");
  assert.equal(record.failOpen, null);
  assert.equal(record.mode, "measurement");
  assert.deepEqual(record.recommended, { id: "opus", agentModel: "opus", rank: 1 });
  assert.equal(record.applied, false);
  assert.equal(record.rewriteReason, "measurement");
});

test("active, ready, bypassPermissions, confident and different: rewrites and echoes every original field, including an unknown one", async () => {
  const payload = preToolUsePayload({
    permission_mode: "bypassPermissions",
    tool_input: {
      prompt: "do the thing",
      description: "a task",
      subagent_type: "general-purpose",
      model: "haiku",
      some_unknown_field: { nested: true },
    },
  });
  const result = await handleAgentModelHook(payload, baseDeps({ mirror: { active: true, ready: true, models: LADDER } }));
  assert.ok(typeof result.stdout === "string");
  const parsed = JSON.parse(result.stdout as string);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Opus 5\.5/);
  assert.deepEqual(parsed.hookSpecificOutput.updatedInput, {
    prompt: "do the thing",
    description: "a task",
    subagent_type: "general-purpose",
    model: "opus",
    some_unknown_field: { nested: true },
  });
  const record = decisionRecord(result);
  assert.equal(record.applied, true);
  assert.equal(record.rewriteReason, "rewrite");
});

test("active mode under permission_mode 'default' never rewrites -- reason permission-mode", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload({ permission_mode: "default" }),
    baseDeps({ mirror: { active: true, ready: true, models: LADDER } }),
  );
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.applied, false);
  assert.equal(record.rewriteReason, "permission-mode");
});

test("requesting exactly the recommended model never rewrites -- reason same-model", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload({ permission_mode: "bypassPermissions", tool_input: { prompt: "do the thing", model: "opus" } }),
    baseDeps({ mirror: { active: true, ready: true, models: LADDER } }),
  );
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.applied, false);
  assert.equal(record.rewriteReason, "same-model");
});

test("the complexity reading (decisions.ts) is recorded alongside a judged decision", async () => {
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({ askJev: async () => jevResponse(2, { [COMPLEXITY_QUESTION_KEY]: scoreAnswer(3) }) }),
  );
  const record = decisionRecord(result);
  assert.ok(record.complexity !== null);
  assert.equal(record.complexity?.tier, "critical");
});

test("PostToolUse on Agent records an outcome row, never stdout", async () => {
  const result = await handleAgentModelHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "tool-1",
      tool_response: { resolvedModel: "claude-opus-5-5", status: "ok", totalDurationMs: 4200, usage: { input_tokens: 100, output_tokens: 50 } },
    },
    baseDeps(),
  );
  assert.equal(result.stdout, null);
  assert.ok(result.record !== null && result.record.type === "model-outcome");
  const record = result.record as ModelOutcomeRecord;
  assert.equal(record.id, "tool-1");
  assert.equal(record.resolvedModel, "claude-opus-5-5");
  assert.equal(record.status, "ok");
  assert.equal(record.durationMs, 4200);
  assert.equal(record.inputTokens, 100);
  assert.equal(record.outputTokens, 50);
});

test("PostToolUseFailure on Agent records an outcome row with status failed", async () => {
  const result = await handleAgentModelHook(
    { hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "tool-2" },
    baseDeps(),
  );
  assert.equal(result.stdout, null);
  assert.ok(result.record !== null && result.record.type === "model-outcome");
  const record = result.record as ModelOutcomeRecord;
  assert.equal(record.id, "tool-2");
  assert.equal(record.status, "failed");
  assert.equal(record.resolvedModel, null);
});

test("an unrecognized hook_event_name on Agent is ignored", async () => {
  const result = await handleAgentModelHook({ hook_event_name: "SomethingElse", tool_name: "Agent", tool_use_id: "tool-3" }, baseDeps());
  assert.deepEqual(result, { stdout: null, record: null });
});

test("a synchronous throw from askJev is caught by the inner Jev try/catch, same as a rejection -- jev-unreachable", async () => {
  // This does NOT exercise the outer catch-all (see the next test for that):
  // `await deps.askJev(...)` catches a synchronous throw exactly like a
  // rejected promise, so this lands in the ordinary jev-unreachable path.
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({
      askJev: () => {
        throw new Error("boom, thrown synchronously instead of rejected");
      },
    }),
  );
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "jev-unreachable");
});

test("never throws: an unexpected exception OUTSIDE the Jev call still fails open to a none/jev-unreachable row", async () => {
  // deps.now() is called before the Jev call is ever reached (to stamp
  // `at`), so throwing from it is what actually reaches the outer
  // catch-all in handleAgentModelHook, rather than the inner try/catch
  // around askJev that the test above already covers.
  const result = await handleAgentModelHook(
    preToolUsePayload(),
    baseDeps({
      now: () => {
        throw new Error("clock exploded");
      },
    }),
  );
  assert.equal(result.stdout, null);
  const record = decisionRecord(result);
  assert.equal(record.failOpen, "jev-unreachable");
  assert.equal(record.source, "none");
});
