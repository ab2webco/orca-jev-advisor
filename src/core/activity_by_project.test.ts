import assert from "node:assert/strict";
import test from "node:test";

import type { GateDecisionInput } from "./activity_by_project.ts";
import { aggregateActivityByProject } from "./activity_by_project.ts";
import type { RouterDecisionRecord } from "./model_router_decide.ts";
import { summarizeRouterDecisions } from "./model_router_summary.ts";
import type { TurnUsageRecord } from "./consumption.ts";

// A fixed "now": a local calendar-day boundary is easy to reason about
// regardless of the machine's timezone, since we always compare local
// Y/M/D, never raw ms.
const NOW = new Date(2026, 8, 27, 15, 0, 0, 0).getTime(); // 2026-09-27 15:00 local
const DAY_MS = 24 * 3600_000;

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoAtLocalMidnight(daysAgo: number): string {
  const now = new Date(NOW);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 0, 0, 0, 0);
  return new Date(midnight.getTime()).toISOString();
}

function gateRow(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    at: new Date(NOW).toISOString(),
    project: "orca",
    commandFamily: "git",
    verdict: "allow",
    latencyMs: 120,
    ...overrides,
  };
}

function turnRow(overrides: Partial<TurnUsageRecord> = {}): TurnUsageRecord {
  return {
    at: new Date(NOW).toISOString(),
    agent: "main",
    model: "claude-sonnet-5",
    effort: null,
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    stopReason: "end_turn",
    account: "acct-1",
    project: "orca",
    ...overrides,
  };
}

function routerRow(overrides: Partial<RouterDecisionRecord> = {}): RouterDecisionRecord {
  return {
    at: new Date(NOW).toISOString(),
    account: "acct-1",
    point: "start",
    tier: "simple",
    confidence: 0.9,
    current: "claude-opus-5-5",
    proposed: "claude-haiku-4-5-20251001",
    applied: true,
    reason: "switch",
    guard: null,
    contextTokens: null,
    switchCost: null,
    stepSaving: null,
    expectedSteps: null,
    quotaBand: "normal",
    quotaSource: null,
    origin: null,
    effort: null,
    project: "orca",
    sessionId: null,
    turnId: null,
    agentId: null,
    workKind: null,
    ...overrides,
  };
}

test("empty input arrays: empty project list, no throw", () => {
  const summary = aggregateActivityByProject([], [], [], NOW);
  assert.deepEqual(summary.projects, []);
});

test("a single day of data for one project: one non-empty bucket, the other 6 empty, correct totals", () => {
  const summary = aggregateActivityByProject([gateRow()], [turnRow()], [], NOW);
  assert.equal(summary.projects.length, 1);
  const project = summary.projects[0]!;
  assert.equal(project.project, "orca");
  assert.equal(project.days.length, 7);
  const todayKey = localDayKey(NOW);
  const todayIndex = project.days.findIndex((d) => d.day === todayKey);
  assert.ok(todayIndex !== -1);
  assert.equal(project.days[todayIndex]!.judgedCommands, 1);
  assert.equal(project.days[todayIndex]!.mainSteps, 1);
  assert.equal(project.days[todayIndex]!.subagentSteps, 0);
  for (const [i, day] of project.days.entries()) {
    if (i === todayIndex) continue;
    assert.equal(day.judgedCommands, 0);
    assert.equal(day.mainSteps, 0);
    assert.equal(day.subagentSteps, 0);
  }
  assert.equal(project.gateOutcomes.allowed, 1);
  assert.equal(project.steps.main, 1);
  assert.equal(project.steps.subagent, 0);
  assert.equal(project.lastActivityAt, new Date(NOW).toISOString());
});

test("old records with a missing project field: grouped under the null project bucket, not dropped, not crashing", () => {
  // Simulates a pre-bf9ddb4 record shape by constructing an object without
  // `project` at all and casting through unknown, as the read side would
  // hand in for an old JSONL line (its own parser defaults it to null).
  const legacyTurnRow = { ...turnRow(), project: undefined } as unknown as TurnUsageRecord;
  const summary = aggregateActivityByProject([], [legacyTurnRow], [], NOW);
  assert.equal(summary.projects.length, 1);
  assert.equal(summary.projects[0]!.project, null);
  assert.equal(summary.projects[0]!.steps.main, 1);
});

test("multiple projects: ranking by recency, then by total interactions on a tie", () => {
  const recent = gateRow({ project: "alpha", at: new Date(NOW).toISOString() });
  const older = gateRow({ project: "beta", at: new Date(NOW - DAY_MS).toISOString() });
  const summary = aggregateActivityByProject([recent, older], [], [], NOW);
  assert.deepEqual(
    summary.projects.map((p) => p.project),
    ["alpha", "beta"],
  );
});

test("multiple projects: a same lastActivityAt tie breaks by total interactions (judged commands + steps) descending", () => {
  const at = new Date(NOW).toISOString();
  const gateRows = [gateRow({ project: "busy", at }), gateRow({ project: "busy", at, commandFamily: "npm" }), gateRow({ project: "quiet", at })];
  const turnRows = [turnRow({ project: "busy", at })];
  const summary = aggregateActivityByProject(gateRows, turnRows, [], NOW);
  assert.deepEqual(
    summary.projects.map((p) => p.project),
    ["busy", "quiet"],
  );
});

test("gate outcome mapping: one row per verdict maps to the right counter; an unrecognized verdict doesn't throw or miscount", () => {
  const rows: GateDecisionInput[] = [
    gateRow({ verdict: "allow" }),
    gateRow({ verdict: "ask" }),
    gateRow({ verdict: "deny" }),
    gateRow({ verdict: "advise" }),
    gateRow({ verdict: "something-unknown" }),
  ];
  const summary = aggregateActivityByProject(rows, [], [], NOW);
  const project = summary.projects[0]!;
  assert.deepEqual(project.gateOutcomes, { allowed: 1, asked: 1, blocked: 1, advised: 1 });
});

test("router: a project with decisions reuses summarizeRouterDecisions's own saving estimate", () => {
  const decision = routerRow({
    at: new Date(NOW).toISOString(),
    point: "stage",
    reason: "downgrade",
    contextTokens: 80_000,
    switchCost: 0.16,
    stepSaving: 0.0185,
    expectedSteps: 12,
    applied: true,
    proposed: "claude-haiku-4-5-20251001",
  });
  const usageRows: TurnUsageRecord[] = Array.from({ length: 12 }, (_, i) =>
    turnRow({ at: new Date(NOW + (i + 1) * 60_000).toISOString(), model: "claude-haiku-4-5-20251001", account: "acct-1" }),
  );
  const summary = aggregateActivityByProject([], usageRows, [decision], NOW);
  const project = summary.projects[0]!;
  assert.ok(project.router !== null);
  const expected = summarizeRouterDecisions([decision], usageRows, NOW, 7 * DAY_MS);
  assert.deepEqual(project.router, expected);
});

test("router: a project with no router-decision rows reports null, not zeros dressed up as data", () => {
  const summary = aggregateActivityByProject([gateRow()], [], [], NOW);
  assert.equal(summary.projects[0]!.router, null);
});

test("tokens/cost: Sonnet, Opus and Fable ids total correctly and produce a plausible cost; an unrecognized id costs 0 but still counts tokens", () => {
  const rows: TurnUsageRecord[] = [
    turnRow({ model: "claude-sonnet-5", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "claude-opus-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "claude-fable-5-1", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "some-gateway-model", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
  ];
  const summary = aggregateActivityByProject([], rows, [], NOW);
  const project = summary.projects[0]!;
  const byModel = new Map(project.tokensByModel.map((m) => [m.model, m]));

  const sonnet = byModel.get("claude-sonnet-5")!;
  assert.equal(sonnet.input, 1_000_000);
  assert.equal(sonnet.output, 1_000_000);
  assert.ok(sonnet.estimatedCostUsd > 0);

  const opus = byModel.get("claude-opus-5-5")!;
  assert.ok(opus.estimatedCostUsd > 0);

  const fable = byModel.get("claude-fable-5-1")!;
  assert.ok(fable.estimatedCostUsd > opus.estimatedCostUsd, "Fable is priced above Opus");

  const unknown = byModel.get("some-gateway-model")!;
  assert.equal(unknown.input, 1_000_000);
  assert.equal(unknown.output, 1_000_000);
  assert.equal(unknown.estimatedCostUsd, 0);

  assert.ok(project.totalEstimatedCostUsd > 0);
});

test("day bucketing: a row exactly at local midnight lands in that calendar day's bucket, not the day before", () => {
  const midnightSixDaysAgo = isoAtLocalMidnight(6);
  const summary = aggregateActivityByProject([gateRow({ at: midnightSixDaysAgo })], [], [], NOW);
  const project = summary.projects[0]!;
  const expectedKey = localDayKey(new Date(midnightSixDaysAgo).getTime());
  assert.equal(project.days[0]!.day, expectedKey, "the oldest bucket is 6 days ago, matching the midnight row's own local day");
  assert.equal(project.days[0]!.judgedCommands, 1);
  for (let i = 1; i < 7; i += 1) assert.equal(project.days[i]!.judgedCommands, 0);
});
