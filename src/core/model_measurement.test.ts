import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import {
  MODEL_MEASUREMENT_FILE,
  buildModelOutcomeRecord,
  parseModelRecord,
  serializeModelRecord,
  summarizeModelMeasurements,
  type ModelDecisionRecord,
  type ModelOutcomeRecord,
} from "./model_measurement.ts";

function entry(overrides: Partial<ModelEntry> & { id: string; rank: number | null; agentModel: string }): ModelEntry {
  return {
    provider: "anthropic",
    label: overrides.id,
    source: "https://example.test/doc",
    available: true,
    ...overrides,
  };
}

const catalog: readonly ModelEntry[] = [
  entry({ id: "claude-opus-5-5", rank: 1, agentModel: "opus" }),
  entry({ id: "claude-sonnet-5", rank: 2, agentModel: "sonnet" }),
  entry({ id: "claude-haiku-4-5", rank: 3, agentModel: "haiku" }),
];

function judgedDecision(overrides: Partial<ModelDecisionRecord> = {}): ModelDecisionRecord {
  return {
    type: "model-decision",
    id: "tool-1",
    at: "2026-09-24T00:00:00.000Z",
    mode: "measurement",
    source: "jev",
    failOpen: null,
    subagentType: "Explore",
    promptChars: 120,
    requestedModel: "sonnet",
    recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 },
    score: 1.2,
    confidence: 0.9,
    applied: false,
    rewriteReason: "measurement",
    ladderSize: 3,
    latencyMs: 450,
    permissionMode: "bypassPermissions",
    complexity: { tier: "standard", tierIndex: 1, score: 1.1 },
    ...overrides,
  };
}

function noneDecision(overrides: Partial<ModelDecisionRecord> = {}): ModelDecisionRecord {
  return {
    type: "model-decision",
    id: "tool-2",
    at: "2026-09-24T00:00:01.000Z",
    mode: "measurement",
    source: "none",
    failOpen: "empty-ladder",
    subagentType: null,
    promptChars: 0,
    requestedModel: null,
    recommended: null,
    score: null,
    confidence: null,
    applied: false,
    rewriteReason: null,
    ladderSize: 0,
    latencyMs: null,
    permissionMode: null,
    complexity: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<ModelOutcomeRecord> = {}): ModelOutcomeRecord {
  return {
    type: "model-outcome",
    id: "tool-1",
    at: "2026-09-24T00:00:02.000Z",
    status: "success",
    resolvedModel: "sonnet",
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 4000,
    ...overrides,
  };
}

test("MODEL_MEASUREMENT_FILE names the jsonl file", () => {
  assert.equal(MODEL_MEASUREMENT_FILE, "model-reclassifications.jsonl");
});

// ---------------------------------------------------------------------------
// buildModelOutcomeRecord
// ---------------------------------------------------------------------------

test("buildModelOutcomeRecord reads resolvedModel, status, usage tokens and durationMs defensively", () => {
  const record = buildModelOutcomeRecord("tool-1", "2026-09-24T00:00:02.000Z", {
    resolvedModel: "claude-sonnet-5-20260101",
    status: "success",
    usage: { input_tokens: 1000, output_tokens: 200 },
    durationMs: 4321,
  });
  assert.deepEqual(record, {
    type: "model-outcome",
    id: "tool-1",
    at: "2026-09-24T00:00:02.000Z",
    status: "success",
    resolvedModel: "claude-sonnet-5-20260101",
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 4321,
  });
});

test("buildModelOutcomeRecord falls back from durationMs to duration_ms", () => {
  const record = buildModelOutcomeRecord("tool-1", "at", { duration_ms: 999 });
  assert.equal(record.durationMs, 999);
});

test("buildModelOutcomeRecord prefers durationMs over duration_ms when both are present", () => {
  const record = buildModelOutcomeRecord("tool-1", "at", { durationMs: 111, duration_ms: 999 });
  assert.equal(record.durationMs, 111);
});

test("buildModelOutcomeRecord never invents a value: missing or wrongly typed fields read null", () => {
  const record = buildModelOutcomeRecord("tool-1", "at", {
    resolvedModel: 42,
    status: null,
    usage: { input_tokens: "a lot" },
    durationMs: "fast",
  });
  assert.deepEqual(record, {
    type: "model-outcome",
    id: "tool-1",
    at: "at",
    status: null,
    resolvedModel: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
  });
});

test("buildModelOutcomeRecord tolerates a non-object tool_response", () => {
  const record = buildModelOutcomeRecord("tool-1", "at", null);
  assert.deepEqual(record, {
    type: "model-outcome",
    id: "tool-1",
    at: "at",
    status: null,
    resolvedModel: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
  });
  assert.deepEqual(buildModelOutcomeRecord("tool-1", "at", "not an object"), record);
  assert.deepEqual(buildModelOutcomeRecord("tool-1", "at", undefined), record);
});

// ---------------------------------------------------------------------------
// serializeModelRecord / parseModelRecord
// ---------------------------------------------------------------------------

test("serializeModelRecord writes one newline-terminated JSON line", () => {
  const line = serializeModelRecord(judgedDecision());
  assert.ok(line.endsWith("\n"));
  assert.equal(line.split("\n").length, 2);
  assert.deepEqual(JSON.parse(line), judgedDecision());
});

test("a decision record round-trips through serialize and parse", () => {
  const record = judgedDecision();
  const parsed = parseModelRecord(serializeModelRecord(record));
  assert.deepEqual(parsed, record);
});

test("an outcome record round-trips through serialize and parse", () => {
  const record = outcome();
  const parsed = parseModelRecord(serializeModelRecord(record));
  assert.deepEqual(parsed, record);
});

test("parseModelRecord is tolerant of blank lines and invalid JSON", () => {
  assert.equal(parseModelRecord(""), null);
  assert.equal(parseModelRecord("   "), null);
  assert.equal(parseModelRecord("{not json"), null);
  assert.equal(parseModelRecord("[]"), null);
  assert.equal(parseModelRecord('{"type":"model-decision"}'), null);
});

test("regression: a source:none decision record is NOT discarded as malformed", () => {
  // Past defect (see gate_measurement.ts's own regression test for the
  // sibling case): a panel that only ever showed zero unjudged decisions
  // because the parser treated a 'none' row as invalid. It must round-trip.
  const record = noneDecision();
  const parsed = parseModelRecord(serializeModelRecord(record));
  assert.deepEqual(parsed, record);
  assert.equal((parsed as ModelDecisionRecord).source, "none");
});

test("parseModelRecord rejects a decision record with an invalid source or failOpen value", () => {
  const badSource = { ...judgedDecision(), source: "made-up" };
  const badFailOpen = { ...noneDecision(), failOpen: "made-up-reason" };
  assert.equal(parseModelRecord(JSON.stringify(badSource)), null);
  assert.equal(parseModelRecord(JSON.stringify(badFailOpen)), null);
});

// ---------------------------------------------------------------------------
// summarizeModelMeasurements
// ---------------------------------------------------------------------------

test("summarizeModelMeasurements on no records yields real zeros and nulls, never undefined", () => {
  const summary = summarizeModelMeasurements([], catalog);
  assert.deepEqual(summary, {
    decisions: 0,
    judged: 0,
    unjudged: 0,
    compared: 0,
    up: 0,
    down: 0,
    agree: 0,
    agreementRate: null,
    applied: 0,
    outcomes: 0,
    comparable: 0,
    matches: 0,
    matchRate: null,
    readiness: {
      ready: false,
      comparableShortfall: 1000,
      matchRateMet: null,
      reason: "not-enough-samples",
    },
  });
  for (const value of Object.values(summary)) assert.notEqual(value, undefined);
});

test("summarizeModelMeasurements dedupes decisions by id, last write wins", () => {
  const first = judgedDecision({ id: "dup", requestedModel: "sonnet", applied: false });
  const second = judgedDecision({ id: "dup", requestedModel: "opus", applied: true });
  const summary = summarizeModelMeasurements([first, second], catalog);
  assert.equal(summary.decisions, 1);
  assert.equal(summary.applied, 1);
});

test("summarizeModelMeasurements counts judged vs unjudged and applied", () => {
  const summary = summarizeModelMeasurements(
    [judgedDecision({ id: "a" }), noneDecision({ id: "b" }), judgedDecision({ id: "c", applied: true })],
    catalog,
  );
  assert.equal(summary.decisions, 3);
  assert.equal(summary.judged, 2);
  assert.equal(summary.unjudged, 1);
  assert.equal(summary.applied, 1);
});

test("summarizeModelMeasurements counts up/down/agree only for judged decisions that resolve to a ranked catalog entry", () => {
  const up = judgedDecision({ id: "up", requestedModel: "haiku", recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } }); // haiku(3) -> sonnet(2): a larger model
  const down = judgedDecision({ id: "down", requestedModel: "sonnet", recommended: { id: "claude-haiku-4-5", agentModel: "haiku", rank: 3 } }); // sonnet(2) -> haiku(3): a smaller model
  const agree = judgedDecision({ id: "agree", requestedModel: "sonnet", recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } });
  const unresolvedRequest = judgedDecision({ id: "unresolved", requestedModel: "some-unknown-model" });
  const unrankedRecommendation = judgedDecision({ id: "unranked-rec", requestedModel: "sonnet", recommended: { id: "claude-x", agentModel: "x", rank: null } });

  const summary = summarizeModelMeasurements([up, down, agree, unresolvedRequest, unrankedRecommendation], catalog);
  assert.equal(summary.compared, 3);
  assert.equal(summary.up, 1);
  assert.equal(summary.down, 1);
  assert.equal(summary.agree, 1);
  assert.equal(summary.agreementRate, 1 / 3);
});

test("summarizeModelMeasurements joins outcomes to decisions by id for comparable/matches", () => {
  const decision = judgedDecision({ id: "tool-1", requestedModel: "sonnet", recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } });
  const matchingOutcome = outcome({ id: "tool-1", resolvedModel: "sonnet" });
  const summary = summarizeModelMeasurements([decision, matchingOutcome], catalog);
  assert.equal(summary.outcomes, 1);
  assert.equal(summary.comparable, 1);
  assert.equal(summary.matches, 1);
  assert.equal(summary.matchRate, 1);
});

test("summarizeModelMeasurements matches by recommended.id as well as recommended.agentModel", () => {
  const decision = judgedDecision({ id: "tool-1", recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } });
  const matchesById = outcome({ id: "tool-1", resolvedModel: "claude-sonnet-5" });
  const summary = summarizeModelMeasurements([decision, matchesById], catalog);
  assert.equal(summary.matches, 1);
});

test("summarizeModelMeasurements counts a mismatched or nulled-out outcome as comparable but not a match", () => {
  const decision = judgedDecision({ id: "tool-1", recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } });
  const mismatched = outcome({ id: "tool-1", resolvedModel: "haiku" });
  const summary = summarizeModelMeasurements([decision, mismatched], catalog);
  assert.equal(summary.comparable, 1);
  assert.equal(summary.matches, 0);
  assert.equal(summary.matchRate, 0);
});

test("an outcome with a null resolvedModel is not comparable", () => {
  const decision = judgedDecision({ id: "tool-1" });
  const unresolved = outcome({ id: "tool-1", resolvedModel: null });
  const summary = summarizeModelMeasurements([decision, unresolved], catalog);
  assert.equal(summary.comparable, 0);
  assert.equal(summary.matchRate, null);
});

test("an outcome record whose id matches no decision is ignored", () => {
  const decision = judgedDecision({ id: "tool-1" });
  const orphan = outcome({ id: "does-not-exist" });
  const summary = summarizeModelMeasurements([decision, orphan], catalog);
  assert.equal(summary.outcomes, 0);
  assert.equal(summary.comparable, 0);
});

test("summarizeModelMeasurements feeds comparable/matchRate into evaluateModSkillsReadiness with the given thresholds", () => {
  const decisions = Array.from({ length: 5 }, (_, index) =>
    judgedDecision({ id: `d${index}`, recommended: { id: "claude-sonnet-5", agentModel: "sonnet", rank: 2 } }),
  );
  const outcomes = decisions.map((decision) => outcome({ id: decision.id, resolvedModel: "sonnet" }));
  const summary = summarizeModelMeasurements([...decisions, ...outcomes], catalog, { minComparable: 5, minMatchRate: 0.5 });
  assert.equal(summary.comparable, 5);
  assert.equal(summary.matchRate, 1);
  assert.equal(summary.readiness.ready, true);
  assert.equal(summary.readiness.reason, "ready");
});

test("a decision row carries the permission mode and the complexity tier, and both survive a round trip", () => {
  const row = judgedDecision({ rewriteReason: "permission-mode", permissionMode: "default" });
  const parsed = parseModelRecord(serializeModelRecord(row));
  assert.deepEqual(parsed, row);
});

test("a decision row with a malformed complexity reading is rejected", () => {
  const bad = { ...judgedDecision(), complexity: { tier: "enormous", tierIndex: 9, score: 1 } };
  assert.equal(parseModelRecord(JSON.stringify(bad)), null);
});
