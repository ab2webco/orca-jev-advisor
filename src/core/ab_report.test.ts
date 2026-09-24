// Pure logic tests for foldAbResults -- pure input to pure output, no
// filesystem, no clock, no randomness. Run with:
// node --test --experimental-strip-types src/core/ab_report.test.ts
//
// Fixtures mirror the real on-disk row shape one comparison actually
// produces (see ab_benchmark.ts's own AbComparisonResult and the real
// ab-benchmark-results.jsonl sample quoted in odd/tasks/advisor-board-charts.md),
// never an invented shape.

import assert from "node:assert/strict";
import test from "node:test";

import { foldAbResults } from "./ab_report.ts";
import type { AbComparisonResult } from "./ab_benchmark.ts";

function comparison(overrides: Partial<AbComparisonResult> = {}): AbComparisonResult {
  return {
    id: "s1",
    at: "2026-09-24T15:02:03.837Z",
    commandFamily: "cd",
    destinationKind: null,
    jev: { verdict: "allow", latencyMs: 784, inputTokens: 464, outputTokens: 53 },
    bigModel: {
      verdict: "allow",
      latencyMs: 3839,
      inputTokens: 2,
      outputTokens: 34,
      cacheCreationInputTokens: 47338,
      cacheReadInputTokens: 12098,
      modelId: "claude-opus-5-5[1m]",
      failureReason: null,
    },
    agree: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// empty input
// ---------------------------------------------------------------------------

test("empty input: every statistic is null, never a fabricated zero or NaN", () => {
  const summary = foldAbResults([]);
  assert.equal(summary.sampleCount, 0);

  assert.deepEqual(summary.jevLatency, { sampleCount: 0, medianMs: null, minMs: null, maxMs: null });
  assert.deepEqual(summary.bigModelLatency, { sampleCount: 0, medianMs: null, minMs: null, maxMs: null });

  assert.deepEqual(summary.modelIds, []);

  assert.equal(summary.agreementCount, 0);
  assert.equal(summary.disagreementCount, 0);
  assert.equal(summary.agreementRate, null);
  assert.deepEqual(summary.disagreements, []);

  assert.equal(summary.failureCount, 0);

  assert.deepEqual(summary.jevTokens, { inputTotal: 0, outputTotal: 0 });
  assert.deepEqual(summary.bigModelTokens, { inputTotal: 0, outputTotal: 0, cacheCreationInputTotal: 0, cacheReadInputTotal: 0 });

  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number") assert.equal(Number.isNaN(value), false, `${key} must never be NaN`);
  }
});

// ---------------------------------------------------------------------------
// single sample
// ---------------------------------------------------------------------------

test("single sample: latency stats collapse to that one value, agreement is fully resolved", () => {
  const summary = foldAbResults([comparison()]);
  assert.equal(summary.sampleCount, 1);
  assert.deepEqual(summary.jevLatency, { sampleCount: 1, medianMs: 784, minMs: 784, maxMs: 784 });
  assert.deepEqual(summary.bigModelLatency, { sampleCount: 1, medianMs: 3839, minMs: 3839, maxMs: 3839 });
  assert.equal(summary.agreementCount, 1);
  assert.equal(summary.disagreementCount, 0);
  assert.equal(summary.agreementRate, 1);
  assert.equal(summary.failureCount, 0);
});

// ---------------------------------------------------------------------------
// median: even and odd sample counts
// ---------------------------------------------------------------------------

test("median over an odd sample count is the middle value", () => {
  const summary = foldAbResults([
    comparison({ id: "a", jev: { verdict: "allow", latencyMs: 300, inputTokens: 1, outputTokens: 1 } }),
    comparison({ id: "b", jev: { verdict: "allow", latencyMs: 100, inputTokens: 1, outputTokens: 1 } }),
    comparison({ id: "c", jev: { verdict: "allow", latencyMs: 200, inputTokens: 1, outputTokens: 1 } }),
  ]);
  assert.deepEqual(summary.jevLatency, { sampleCount: 3, medianMs: 200, minMs: 100, maxMs: 300 });
});

test("median over an even sample count averages the two middle values", () => {
  const summary = foldAbResults([
    comparison({ id: "a", jev: { verdict: "allow", latencyMs: 100, inputTokens: 1, outputTokens: 1 } }),
    comparison({ id: "b", jev: { verdict: "allow", latencyMs: 200, inputTokens: 1, outputTokens: 1 } }),
    comparison({ id: "c", jev: { verdict: "allow", latencyMs: 300, inputTokens: 1, outputTokens: 1 } }),
    comparison({ id: "d", jev: { verdict: "allow", latencyMs: 400, inputTokens: 1, outputTokens: 1 } }),
  ]);
  assert.deepEqual(summary.jevLatency, { sampleCount: 4, medianMs: 250, minMs: 100, maxMs: 400 });
});

// ---------------------------------------------------------------------------
// failed comparisons: excluded from big-model latency and agreement, still counted
// ---------------------------------------------------------------------------

test("a row with a failureReason is excluded from big-model latency and agreement, but counted in failureCount", () => {
  const summary = foldAbResults([
    comparison({ id: "a", agree: true }),
    comparison({
      id: "b",
      agree: null,
      jev: { verdict: "allow", latencyMs: 500, inputTokens: 10, outputTokens: 2 },
      bigModel: {
        verdict: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        modelId: null,
        failureReason: "cli_not_found",
      },
    }),
  ]);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.failureCount, 1);
  // Big-model latency only reflects the conclusive row.
  assert.deepEqual(summary.bigModelLatency, { sampleCount: 1, medianMs: 3839, minMs: 3839, maxMs: 3839 });
  // Jev latency still reflects both rows -- Jev ran regardless of the big-model outcome.
  assert.deepEqual(summary.jevLatency, { sampleCount: 2, medianMs: (784 + 500) / 2, minMs: 500, maxMs: 784 });
  // The failed row must never enter agreement/disagreement.
  assert.equal(summary.agreementCount, 1);
  assert.equal(summary.disagreementCount, 0);
  assert.equal(summary.agreementRate, 1);
});

test("real-data shape: a single disagreement bucket -- Jev allow, big model ask, counted 9 times", () => {
  const agreeing = Array.from({ length: 11 }, (_, i) => comparison({ id: `agree-${i}`, agree: true }));
  const disagreeing = Array.from({ length: 9 }, (_, i) =>
    comparison({
      id: `disagree-${i}`,
      agree: false,
      jev: { verdict: "allow", latencyMs: 236, inputTokens: 1, outputTokens: 1 },
      bigModel: { ...comparison().bigModel, verdict: "ask" },
    }),
  );
  const summary = foldAbResults([...agreeing, ...disagreeing]);
  assert.equal(summary.sampleCount, 20);
  assert.equal(summary.agreementCount, 11);
  assert.equal(summary.disagreementCount, 9);
  assert.equal(summary.agreementRate, 11 / 20);
  assert.deepEqual(summary.disagreements, [{ jevVerdict: "allow", bigModelVerdict: "ask", count: 9 }]);
});

// ---------------------------------------------------------------------------
// model ids: deduplicated and sorted
// ---------------------------------------------------------------------------

test("modelIds: distinct non-null model ids, deduplicated and sorted", () => {
  const summary = foldAbResults([
    comparison({ id: "a", bigModel: { ...comparison().bigModel, modelId: "claude-sonnet-5" } }),
    comparison({ id: "b", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" } }),
    comparison({ id: "c", bigModel: { ...comparison().bigModel, modelId: "claude-sonnet-5" } }),
    comparison({
      id: "d",
      agree: null,
      bigModel: {
        verdict: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        modelId: null,
        failureReason: "cli_not_found",
      },
    }),
  ]);
  assert.deepEqual(summary.modelIds, ["claude-opus-5-5[1m]", "claude-sonnet-5"]);
});

// ---------------------------------------------------------------------------
// token totals: input/output for both sides, cache totals kept separate
// ---------------------------------------------------------------------------

test("token totals: jev and big-model input/output summed, cache totals kept separate from the input total", () => {
  const summary = foldAbResults([
    comparison({
      id: "a",
      jev: { verdict: "allow", latencyMs: 100, inputTokens: 100, outputTokens: 10 },
      bigModel: { ...comparison().bigModel, inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 1000, cacheReadInputTokens: 200 },
    }),
    comparison({
      id: "b",
      jev: { verdict: "allow", latencyMs: 100, inputTokens: 50, outputTokens: 5 },
      bigModel: { ...comparison().bigModel, inputTokens: 2, outputTokens: 1, cacheCreationInputTokens: 500, cacheReadInputTokens: 300 },
    }),
  ]);
  assert.deepEqual(summary.jevTokens, { inputTotal: 150, outputTotal: 15 });
  assert.deepEqual(summary.bigModelTokens, { inputTotal: 7, outputTotal: 4, cacheCreationInputTotal: 1500, cacheReadInputTotal: 500 });
});
