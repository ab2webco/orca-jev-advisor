import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRouterDecisions } from "./model_router_summary.ts";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const DAY = 24 * 3600_000;

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    at: "2026-09-27T10:00:00.000Z", account: "acct", point: "start", tier: "simple", confidence: 0.9,
    current: "claude-opus-5-5", proposed: "claude-haiku-4-5-20251001", applied: true, reason: "switch", guard: null,
    contextTokens: null, switchCost: null, stepSaving: null, expectedSteps: null, quotaBand: "normal",
    ...overrides,
  };
}

function usage(at: string, model: string, account = "acct"): Record<string, unknown> {
  return { at, agent: "main", model, effort: null, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, stopReason: "end_turn", account };
}

test("summary: decisions by point and tier, applied vs measured, inside the window only", () => {
  const summary = summarizeRouterDecisions(
    [
      decision({}),
      decision({ point: "stage", tier: "complex", applied: false, reason: "hysteresis" }),
      decision({ point: "subagent", tier: "simple" }),
      decision({ at: "2026-09-20T10:00:00.000Z" }),
      { junk: true },
    ],
    [],
    NOW,
    DAY,
  );
  assert.equal(summary.total, 3);
  assert.equal(summary.applied, 2);
  assert.equal(summary.measured, 1);
  assert.deepEqual(summary.byPoint.start, { simple: 1, standard: 0, complex: 0, frontier: 0 });
  assert.deepEqual(summary.byPoint.stage, { simple: 0, standard: 0, complex: 1, frontier: 0 });
  assert.deepEqual(summary.byPoint.subagent, { simple: 1, standard: 0, complex: 0, frontier: 0 });
  assert.equal(summary.savedEstimate, null, "no applied downgrade with break-even numbers: nothing to estimate");
});

test("summary: estimated saving = Σ(stepSaving × steps actually run on the new model after the switch) − switchCost", () => {
  const switched = decision({ at: "2026-09-27T10:00:00.000Z", point: "stage", reason: "downgrade", contextTokens: 80_000, switchCost: 0.16, stepSaving: 0.0185, expectedSteps: 12 });
  const usageRows = [
    usage("2026-09-27T09:59:00.000Z", "claude-haiku-4-5-20251001"),
    ...Array.from({ length: 12 }, (_, i) => usage(`2026-09-27T10:0${Math.floor(i / 6)}:${String(10 + i).padStart(2, "0")}.000Z`, "claude-haiku-4-5-20251001")),
    usage("2026-09-27T10:05:00.000Z", "claude-opus-5-5"),
    usage("2026-09-27T10:06:00.000Z", "claude-haiku-4-5-20251001", "other-account"),
  ];
  const summary = summarizeRouterDecisions([switched], usageRows, NOW, DAY);
  assert.ok(summary.savedEstimate !== null);
  assert.ok(Math.abs(summary.savedEstimate - (0.0185 * 12 - 0.16)) < 1e-9);
  assert.equal(summary.switchesEstimated, 1);
});

test("summary: a measured (not applied) downgrade never counts toward the saving", () => {
  const measured = decision({ applied: false, point: "stage", reason: "downgrade", switchCost: 0.16, stepSaving: 0.0185 });
  assert.equal(summarizeRouterDecisions([measured], [usage("2026-09-27T10:01:00.000Z", "claude-haiku-4-5-20251001")], NOW, DAY).savedEstimate, null);
});
