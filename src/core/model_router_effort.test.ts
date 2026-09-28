import assert from "node:assert/strict";
import test from "node:test";

import { EFFORT_MIN_STEPS, effortOutputMedians, isRecentTurnUsageFile } from "./model_router_effort.ts";

const NOW = Date.parse("2026-09-27T12:30:00.000Z");
const SINCE = NOW - 7 * 24 * 3_600_000;

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ at: "2026-09-27T10:00:00.000Z", agent: "main", model: "claude-opus-5-5", effort: "xhigh", output: 1000, account: "acct", ...fields });
}

function many(count: number, fields: Record<string, unknown>): string[] {
  return Array.from({ length: count }, (_, i) => line({ output: 1000 + i, ...fields }));
}

test("isRecentTurnUsageFile: hourly turn-usage files from the last 7 days only", () => {
  assert.equal(isRecentTurnUsageFile("turn-usage-2026-09-27T12.jsonl", SINCE), true);
  assert.equal(isRecentTurnUsageFile("turn-usage-2026-09-20T12.jsonl", SINCE), true, "the hour the window starts in counts");
  assert.equal(isRecentTurnUsageFile("turn-usage-2026-09-20T11.jsonl", SINCE), false);
  assert.equal(isRecentTurnUsageFile("model-router-decisions-2026-09-27T12.jsonl", SINCE), false);
  assert.equal(isRecentTurnUsageFile("turn-usage-garbage.jsonl", SINCE), false);
});

test("effortOutputMedians: the median output per MAIN step, per effort, on this account and base model", () => {
  const lines = [
    ...many(EFFORT_MIN_STEPS, { effort: "xhigh", output: 5000 }),
    ...many(EFFORT_MIN_STEPS - 1, { effort: "high", output: 2000 }),
    line({ effort: "high", output: 2400, model: "claude-opus-5-5[1m]" }),
    ...many(30, { effort: "high", output: 99_999, agent: "subagent" }),
    ...many(30, { effort: "high", output: 99_999, account: "other" }),
    ...many(30, { effort: "high", output: 99_999, model: "claude-sonnet-5" }),
    ...many(30, { effort: "high", output: 99_999, at: "2026-09-01T00:00:00.000Z" }),
    ...many(30, { effort: "high", output: null }),
    "not json",
    "",
  ];
  const medians = effortOutputMedians(lines, { account: "acct", model: "claude-opus-5-5[1m]", sinceMs: SINCE });
  assert.deepEqual(medians, { xhigh: 5000, high: 2000 });
});

test("effortOutputMedians: fewer than 20 real steps at an effort is no median for it", () => {
  const lines = [...many(EFFORT_MIN_STEPS, { effort: "xhigh" }), ...many(EFFORT_MIN_STEPS - 1, { effort: "high" }), ...many(40, { effort: 32_000 })];
  const medians = effortOutputMedians(lines, { account: "acct", model: "claude-opus-5-5", sinceMs: SINCE });
  assert.equal(EFFORT_MIN_STEPS, 20);
  assert.deepEqual(Object.keys(medians), ["xhigh"]);
});
