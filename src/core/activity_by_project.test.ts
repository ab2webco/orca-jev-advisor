import assert from "node:assert/strict";
import test from "node:test";

import type { GateDecisionInput } from "./activity_by_project.ts";
import { ACTIVITY_PROJECTS_SHOWN, aggregateActivityForWindow } from "./activity_by_project.ts";
import { boardWindows } from "./board_windows.ts";
import type { BoardWindow } from "./board_windows.ts";
import type { RouterDecisionRecord } from "./model_router_decide.ts";
import { summarizeRouterDecisions } from "./model_router_summary.ts";
import type { TurnUsageRecord } from "./consumption.ts";

const NOW = Date.parse("2026-09-27T15:00:00.000Z");
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOWS = boardWindows(NOW, { pluginVersion: "0.11.0", firstAtMs: NOW - 3 * HOUR_MS });
const WEEK: BoardWindow = WINDOWS.week;

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

test("empty input arrays: no project, zero totals, no rest row", () => {
  const summary = aggregateActivityForWindow([], [], [], NOW, WEEK);
  assert.deepEqual(summary.projects, []);
  assert.equal(summary.rest, null);
  assert.deepEqual(summary.totals, { projects: 0, judged: 0, steps: 0, tokens: 0, estimatedCostUsd: 0, routerSavedEstimate: null });
});

test("one project: judged commands, steps, tokens and outcomes inside the window", () => {
  const summary = aggregateActivityForWindow([gateRow()], [turnRow(), turnRow({ agent: "subagent" })], [], NOW, WEEK);
  assert.equal(summary.projects.length, 1);
  const project = summary.projects[0]!;
  assert.equal(project.project, "orca");
  assert.equal(project.judged, 1);
  assert.deepEqual(project.steps, { main: 1, subagent: 1 });
  assert.equal(project.tokens, 300);
  assert.equal(project.gateOutcomes.allowed, 1);
  assert.equal(project.lastActivityAt, new Date(NOW).toISOString());
});

test("the window is rolling: 24 h counts only the last 24 hours, the same instant on every tab", () => {
  const rows = [gateRow({ at: new Date(NOW - 2 * HOUR_MS).toISOString() }), gateRow({ at: new Date(NOW - 25 * HOUR_MS).toISOString() })];
  assert.equal(aggregateActivityForWindow(rows, [], [], NOW, WINDOWS.day).projects[0]!.judged, 1);
  assert.equal(aggregateActivityForWindow(rows, [], [], NOW, WEEK).projects[0]!.judged, 2);
  assert.equal(aggregateActivityForWindow(rows, [], [], NOW, WINDOWS.version).projects[0]!.judged, 1);
  assert.equal(aggregateActivityForWindow(rows, [], [], NOW, WINDOWS.all).projects[0]!.judged, 2);
});

test("an unavailable version window holds no project", () => {
  const noVersion = boardWindows(NOW, null).version;
  assert.deepEqual(aggregateActivityForWindow([gateRow()], [turnRow()], [], NOW, noVersion).projects, []);
});

test("old records with a missing project field: grouped under the null project, not dropped", () => {
  const legacyTurnRow = { ...turnRow(), project: undefined } as unknown as TurnUsageRecord;
  const summary = aggregateActivityForWindow([], [legacyTurnRow], [], NOW, WEEK);
  assert.equal(summary.projects.length, 1);
  assert.equal(summary.projects[0]!.project, null);
  assert.equal(summary.projects[0]!.steps.main, 1);
});

test("ranking: by estimated cost, then by interactions, so the project that used the most is first", () => {
  const gateRows = [gateRow({ project: "gate-only" }), gateRow({ project: "gate-only" }), gateRow({ project: "gate-only" })];
  const turnRows = [turnRow({ project: "cheap", model: "claude-haiku-4-5-20251001" }), turnRow({ project: "dear", model: "claude-opus-5-5", input: 10_000 })];
  const summary = aggregateActivityForWindow(gateRows, turnRows, [], NOW, WEEK);
  assert.deepEqual(summary.projects.map((p) => p.project), ["dear", "cheap", "gate-only"]);
});

test("gate outcome mapping: one row per verdict maps to the right counter; an unrecognized verdict is not counted", () => {
  const rows: GateDecisionInput[] = [
    gateRow({ verdict: "allow" }),
    gateRow({ verdict: "ask" }),
    gateRow({ verdict: "deny" }),
    gateRow({ verdict: "advise" }),
    gateRow({ verdict: "something-unknown" }),
  ];
  const project = aggregateActivityForWindow(rows, [], [], NOW, WEEK).projects[0]!;
  assert.deepEqual(project.gateOutcomes, { allowed: 1, asked: 1, blocked: 1, advised: 1 });
  assert.equal(project.judged, 4);
});

test("only the first projects are kept; the rest fold into one row that still counts in the totals", () => {
  const rows = Array.from({ length: ACTIVITY_PROJECTS_SHOWN + 3 }, (_, i) => gateRow({ project: `p-${String(i).padStart(2, "0")}` }));
  const summary = aggregateActivityForWindow(rows, [], [], NOW, WEEK);
  assert.equal(summary.projects.length, ACTIVITY_PROJECTS_SHOWN);
  assert.deepEqual(summary.rest, { projects: 3, judged: 3, steps: 0, tokens: 0, estimatedCostUsd: 0 });
  assert.equal(summary.totals.projects, ACTIVITY_PROJECTS_SHOWN + 3);
  assert.equal(summary.totals.judged, ACTIVITY_PROJECTS_SHOWN + 3);
});

test("router: a project's applied switches and its share of the estimate; the shares add up to the router total", () => {
  const decision = routerRow({ point: "stage", reason: "downgrade", contextTokens: 80_000, switchCost: 0.16, stepSaving: 0.0185, expectedSteps: 12 });
  const other = routerRow({ project: "beta", at: new Date(NOW - HOUR_MS).toISOString(), point: "stage", switchCost: 0.05, stepSaving: 0.02 });
  const usageRows: TurnUsageRecord[] = [
    ...Array.from({ length: 12 }, (_, i) => turnRow({ at: new Date(NOW - HOUR_MS + (i + 1) * 60_000).toISOString(), model: "claude-haiku-4-5-20251001", project: "beta" })),
  ];
  const summary = aggregateActivityForWindow([], usageRows, [decision, other], NOW, WEEK);
  const total = summarizeRouterDecisions([decision, other], usageRows, NOW, 7 * DAY_MS);
  const orca = summary.projects.find((p) => p.project === "orca")!;
  assert.equal(orca.router?.applied, 1);
  assert.ok(total.savedEstimate !== null && summary.totals.routerSavedEstimate !== null);
  assert.ok(Math.abs(summary.totals.routerSavedEstimate - total.savedEstimate) < 1e-9);
});

test("router: a project with no router-decision rows reports null, not zeros dressed up as data", () => {
  assert.equal(aggregateActivityForWindow([gateRow()], [], [], NOW, WEEK).projects[0]!.router, null);
});

test("tokens/cost: models are priced, an unrecognized id costs 0 but still counts tokens, and the dearest model is listed first", () => {
  const rows: TurnUsageRecord[] = [
    turnRow({ model: "claude-sonnet-5", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "claude-opus-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "claude-fable-5-1", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    turnRow({ model: "some-gateway-model", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
  ];
  const project = aggregateActivityForWindow([], rows, [], NOW, WEEK).projects[0]!;
  assert.equal(project.tokens, 6_000_000);
  const byModel = new Map(project.models.map((m) => [m.model, m]));
  assert.ok(byModel.get("claude-fable-5-1")!.estimatedCostUsd > byModel.get("claude-opus-5-5")!.estimatedCostUsd, "Fable is priced above Opus");
  assert.equal(byModel.get("some-gateway-model")?.estimatedCostUsd ?? 0, 0);
  const costs = project.models.map((m) => m.estimatedCostUsd);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a));
  assert.ok(Math.abs(project.estimatedCostUsd - [...byModel.values()].reduce((s, m) => s + m.estimatedCostUsd, 0)) < 1e-9);
});

test("tokens/cost: Haiku 5.5 is priced per request by its own prompt, never by the total of many requests", () => {
  const model = "claude-haiku-5-5";
  const shortOnes = aggregateActivityForWindow([], [turnRow({ model, input: 20_000, cacheRead: 40_000, cacheWrite: 0, output: 1_000 }), turnRow({ model, input: 20_000, cacheRead: 40_000, cacheWrite: 0, output: 1_000 })], [], NOW, WEEK);
  const baseCost = 2 * (20_000 * 0.1 + 40_000 * 0.01 + 1_000 * 0.5) / 1_000_000;
  assert.ok(Math.abs(shortOnes.projects[0]!.estimatedCostUsd - baseCost) < 1e-12);
  const longOne = aggregateActivityForWindow([], [turnRow({ model, input: 2_000, cacheRead: 148_000, cacheWrite: 0, output: 1_000 })], [], NOW, WEEK);
  const longCost = (2_000 * 0.5 + 148_000 * 0.05 + 1_000 * 2.5) / 1_000_000;
  assert.ok(Math.abs(longOne.projects[0]!.estimatedCostUsd - longCost) < 1e-12);
});
