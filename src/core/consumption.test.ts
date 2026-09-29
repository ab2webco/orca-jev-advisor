// Unit tests for JEV-060 slice 1's T3 pure functions: turn-usage
// aggregation, quota.json parsing, and the four recommendation triggers.
// Pure input to pure output throughout -- no filesystem, no clock (the
// aggregation takes `nowMs` as a parameter instead of reading Date.now()
// itself, so a test can pin "now" exactly).
//
// Run with: node --test --experimental-strip-types src/core/consumption.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateTurnUsage,
  CLAUDE_MD_TOKEN_THRESHOLD,
  claudeMdSizeTrigger,
  LONG_SESSION_CONTEXT_THRESHOLD_TOKENS,
  longSessionTrigger,
  mcpServerCountTrigger,
  parseQuota,
  SUBAGENT_SHARE_THRESHOLD,
  subagentShareTrigger,
  type TurnUsageRecord,
} from "./consumption.ts";

const NOW = Date.parse("2026-09-26T20:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let nextId = 0;
function step(overrides: Partial<TurnUsageRecord> = {}): TurnUsageRecord {
  nextId += 1;
  return {
    at: new Date(NOW).toISOString(),
    agent: "main",
    model: "claude-sonnet-5",
    effort: null,
    input: 100,
    output: 50,
    cacheRead: 1000,
    cacheWrite: 200,
    stopReason: "end_turn",
    account: "home",
    project: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// aggregateTurnUsage
// ---------------------------------------------------------------------------

test("aggregateTurnUsage: empty input yields honest zeros, not fabricated data", () => {
  const result = aggregateTurnUsage([], NOW);
  for (const window of [result.last24h, result.last7d]) {
    assert.equal(window.stepCount, 0);
    assert.deepEqual(window.byModel, []);
    assert.equal(window.avgMainStepContextReread, null);
    assert.equal(window.subagentShare, null);
  }
});

test("aggregateTurnUsage: a window with zero records (all steps outside it) reads the same as no records at all", () => {
  const old = step({ at: new Date(NOW - 10 * DAY_MS).toISOString() });
  const result = aggregateTurnUsage([old], NOW);
  assert.equal(result.last7d.stepCount, 0);
  assert.deepEqual(result.last7d.byModel, []);
  assert.equal(result.last7d.avgMainStepContextReread, null);
  assert.equal(result.last7d.subagentShare, null);
});

test("aggregateTurnUsage: a step with all-null numeric fields is counted but contributes no share data", () => {
  const blank = step({ input: null, output: null, cacheRead: null, cacheWrite: null });
  const result = aggregateTurnUsage([blank], NOW);
  assert.equal(result.last24h.stepCount, 1);
  assert.equal(result.last24h.byModel.length, 1);
  const model = result.last24h.byModel[0];
  assert.equal(model?.stepCount, 1);
  assert.equal(model?.inputShare, null);
  assert.equal(model?.cacheReadShare, null);
  assert.equal(model?.cacheWriteShare, null);
  assert.equal(model?.outputShare, null);
  // No non-null numeric field anywhere -- the main-step average and the
  // subagent share must both stay null rather than reading as 0.
  assert.equal(result.last24h.avgMainStepContextReread, null);
  assert.equal(result.last24h.subagentShare, null);
});

test("aggregateTurnUsage: per-model shares are WITHIN that model's own total (input+output+cacheRead+cacheWrite), never across models", () => {
  const records = [
    step({ model: "sonnet", input: 100, output: 100, cacheRead: 700, cacheWrite: 100 }), // total 1000, cacheRead 70%
    step({ model: "opus", input: 0, output: 0, cacheRead: 900, cacheWrite: 100 }), // total 1000, cacheRead 90%
  ];
  const result = aggregateTurnUsage(records, NOW);
  const sonnet = result.last24h.byModel.find((m) => m.model === "sonnet");
  const opus = result.last24h.byModel.find((m) => m.model === "opus");
  assert.equal(sonnet?.cacheReadShare, 0.7);
  assert.equal(opus?.cacheReadShare, 0.9);
});

test("aggregateTurnUsage: a model's four shares (input, output, cacheRead, cacheWrite) sum to 100% +/- 1 of its own total when it has any data", () => {
  const records = [
    step({ model: "sonnet", input: 100, output: 50, cacheRead: 700, cacheWrite: 150 }), // total 1000
    step({ model: "opus", input: 300, output: 200, cacheRead: 400, cacheWrite: 100 }), // total 1000
  ];
  const result = aggregateTurnUsage(records, NOW);
  for (const modelId of ["sonnet", "opus"]) {
    const model = result.last24h.byModel.find((m) => m.model === modelId);
    const sum =
      (model?.inputShare ?? 0) + (model?.outputShare ?? 0) + (model?.cacheReadShare ?? 0) + (model?.cacheWriteShare ?? 0);
    assert.ok(Math.abs(sum - 1) <= 0.01, `${modelId} shares should sum to ~1, got ${sum}`);
  }
});

test("aggregateTurnUsage: a null numeric field is excluded from its own sum, never coerced to 0 -- a model with SOME null cacheRead entries still shares correctly over the entries that reported it", () => {
  const records = [
    step({ model: "sonnet", input: 0, output: 0, cacheRead: 800, cacheWrite: 200 }), // total 1000, cacheRead 800
    step({ model: "sonnet", input: 0, output: 0, cacheRead: null, cacheWrite: 0 }), // contributes nothing to any field sum
  ];
  const result = aggregateTurnUsage(records, NOW);
  const sonnet = result.last24h.byModel.find((m) => m.model === "sonnet");
  assert.equal(sonnet?.stepCount, 2);
  // Denominator is 800 (cacheRead) + 200 (cacheWrite) from the first record
  // only -- the second record's null cacheRead never becomes a 0 that would
  // shrink cacheReadShare, and its own all-else-zero fields add nothing.
  assert.equal(sonnet?.cacheReadShare, 0.8);
});

test("aggregateTurnUsage: average main-step context re-read is scoped to agent === 'main' only, excluding subagent steps and null cacheRead", () => {
  const records = [
    step({ agent: "main", cacheRead: 100000 }),
    step({ agent: "main", cacheRead: 200000 }),
    step({ agent: "main", cacheRead: null }), // excluded, never treated as 0
    step({ agent: "subagent", cacheRead: 999999 }), // excluded: not a main step
  ];
  const result = aggregateTurnUsage(records, NOW);
  assert.equal(result.last24h.avgMainStepContextReread, 150000);
});

test("aggregateTurnUsage: main-vs-subagent share is subagent's null-safe token total over the grand null-safe total", () => {
  const records = [
    step({ agent: "main", input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }), // main total 200
    step({ agent: "subagent", input: 50, output: 50, cacheRead: 0, cacheWrite: 0 }), // subagent total 100
  ];
  const result = aggregateTurnUsage(records, NOW);
  // grand total 300, subagent 100 -> share 1/3
  assert.ok(Math.abs((result.last24h.subagentShare ?? -1) - 1 / 3) < 1e-9);
});

test("aggregateTurnUsage: 24h and 7d windows are independent -- a step 2 days old counts in the week but not the day", () => {
  const twoDaysAgo = step({ at: new Date(NOW - 2 * DAY_MS).toISOString() });
  const result = aggregateTurnUsage([twoDaysAgo], NOW);
  assert.equal(result.last24h.stepCount, 0);
  assert.equal(result.last7d.stepCount, 1);
});

// ---------------------------------------------------------------------------
// parseQuota
// ---------------------------------------------------------------------------

test("parseQuota: null input reads as no accounts, no checkedAt -- never throws", () => {
  assert.deepEqual(parseQuota(null), { accounts: [], checkedAt: null });
});

test("parseQuota: malformed (non-object) input reads the same as null", () => {
  assert.deepEqual(parseQuota("garbage"), { accounts: [], checkedAt: null });
  assert.deepEqual(parseQuota(42), { accounts: [], checkedAt: null });
});

test("parseQuota: an account missing fableWeekly entirely never gets one fabricated", () => {
  const result = parseQuota({
    accounts: [{ id: "a1", status: "ok", sessionUsedPercent: 10, weeklyUsedPercent: 81, resetsAt: 123 }],
    checkedAt: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(result.accounts.length, 1);
  assert.equal("fableWeekly" in result.accounts[0]!, false);
});

test("parseQuota: an account that genuinely has fableWeekly keeps it", () => {
  const result = parseQuota({
    accounts: [
      {
        id: "a1",
        status: "ok",
        sessionUsedPercent: 10,
        weeklyUsedPercent: 81,
        resetsAt: 123,
        fableWeekly: { usedPercent: 5, resetsAt: 456 },
      },
    ],
    checkedAt: "2026-09-26T00:00:00.000Z",
  });
  assert.deepEqual(result.accounts[0]?.fableWeekly, { usedPercent: 5, resetsAt: 456 });
});

test("parseQuota: a malformed field on one account degrades that field to null, never throws, never drops the account", () => {
  const result = parseQuota({
    accounts: [{ id: "a1", status: 123, sessionUsedPercent: "not-a-number", weeklyUsedPercent: null, resetsAt: null }],
    checkedAt: null,
  });
  assert.deepEqual(result.accounts, [{ id: "a1", status: null, sessionUsedPercent: null, weeklyUsedPercent: null, resetsAt: null }]);
});

test("parseQuota: an account with no string id is dropped -- it cannot be identified on the board", () => {
  const result = parseQuota({ accounts: [{ id: 42, status: "ok" }], checkedAt: null });
  assert.deepEqual(result.accounts, []);
});

// ---------------------------------------------------------------------------
// Recommendation triggers
// ---------------------------------------------------------------------------

test("claudeMdSizeTrigger: null byte length (file does not exist) yields null, not a fabricated zero", () => {
  assert.equal(claudeMdSizeTrigger(null), null);
});

test("claudeMdSizeTrigger: exactly 8k tokens (32000 bytes, /4) is NOT over the threshold", () => {
  const trigger = claudeMdSizeTrigger(CLAUDE_MD_TOKEN_THRESHOLD * 4);
  assert.equal(trigger?.estimatedTokens, CLAUDE_MD_TOKEN_THRESHOLD);
  assert.equal(trigger?.overThreshold, false);
});

test("claudeMdSizeTrigger: one byte over 8k tokens' worth IS over the threshold", () => {
  const trigger = claudeMdSizeTrigger(CLAUDE_MD_TOKEN_THRESHOLD * 4 + 1);
  assert.equal(trigger?.overThreshold, true);
  assert.ok((trigger?.estimatedTokens ?? 0) > CLAUDE_MD_TOKEN_THRESHOLD);
});

test("mcpServerCountTrigger: null .claude.json reads as 0 servers", () => {
  assert.deepEqual(mcpServerCountTrigger(null), { count: 0 });
});

test("mcpServerCountTrigger: a .claude.json with no mcpServers key reads as 0", () => {
  assert.deepEqual(mcpServerCountTrigger({ someOtherKey: true }), { count: 0 });
});

test("mcpServerCountTrigger: a malformed (non-object) mcpServers value reads as 0", () => {
  assert.deepEqual(mcpServerCountTrigger({ mcpServers: "not-an-object" }), { count: 0 });
});

test("mcpServerCountTrigger: counts the real keys of mcpServers, many", () => {
  assert.deepEqual(
    mcpServerCountTrigger({ mcpServers: { a: {}, b: {}, c: {}, d: {}, e: {} } }),
    { count: 5 },
  );
});

test("longSessionTrigger: null average (no main-step data yet) yields null, never a fabricated zero", () => {
  assert.equal(longSessionTrigger(null), null);
});

test("longSessionTrigger: exactly the threshold is NOT over it", () => {
  const trigger = longSessionTrigger(LONG_SESSION_CONTEXT_THRESHOLD_TOKENS);
  assert.equal(trigger?.overThreshold, false);
});

test("longSessionTrigger: one token over the threshold IS over it", () => {
  const trigger = longSessionTrigger(LONG_SESSION_CONTEXT_THRESHOLD_TOKENS + 1);
  assert.equal(trigger?.overThreshold, true);
  assert.equal(trigger?.avgMainStepContextReread, LONG_SESSION_CONTEXT_THRESHOLD_TOKENS + 1);
});

test("subagentShareTrigger: null share (no data yet) yields null, never a fabricated zero", () => {
  assert.equal(subagentShareTrigger(null), null);
});

test("subagentShareTrigger: exactly the threshold (40%) is NOT over it", () => {
  const trigger = subagentShareTrigger(SUBAGENT_SHARE_THRESHOLD);
  assert.equal(trigger?.overThreshold, false);
  assert.equal(trigger?.subagentSharePercent, 40);
});

test("subagentShareTrigger: over the threshold reports the real percent, e.g. 47%", () => {
  const trigger = subagentShareTrigger(0.47);
  assert.equal(trigger?.overThreshold, true);
  assert.equal(trigger?.subagentSharePercent, 47);
});

// 0.6.8 T6: subagent tokens counted apart from the main conversation, as
// real totals, not only as a share.
test("aggregateTurnUsage: byAgent counts main and subagent steps and tokens apart", () => {
  const result = aggregateTurnUsage([
    step({ agent: "main", input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }),
    step({ agent: "main", input: 1, output: 1, cacheRead: null, cacheWrite: null }),
    step({ agent: "subagent", input: 7, output: 3, cacheRead: 40, cacheWrite: 0 }),
  ], NOW);
  assert.deepEqual(result.last24h.byAgent, {
    main: { stepCount: 2, tokens: 137 },
    subagent: { stepCount: 1, tokens: 50 },
  });
});

test("aggregateTurnUsage: byAgent reads null tokens for a side with no reported figure, and zero steps when it has none", () => {
  const result = aggregateTurnUsage([
    step({ agent: "main", input: null, output: null, cacheRead: null, cacheWrite: null }),
  ], NOW);
  assert.deepEqual(result.last24h.byAgent, {
    main: { stepCount: 1, tokens: null },
    subagent: { stepCount: 0, tokens: null },
  });
  assert.deepEqual(aggregateTurnUsage([], NOW).last7d.byAgent, {
    main: { stepCount: 0, tokens: null },
    subagent: { stepCount: 0, tokens: null },
  });
});
