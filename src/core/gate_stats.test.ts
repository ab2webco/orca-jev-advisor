// Unit tests for foldGateDecisions -- pure input to pure output, no
// filesystem, no clock. Run with: node --test src/core/gate_stats.test.ts
// (this project has no test runner configured yet; node:test is the
// built-in one, and Node 24's native TypeScript support runs this file
// directly, same as `node src/supervisor.ts --self-check` already does).

import assert from "node:assert/strict";
import test from "node:test";

import { foldGateDecisions } from "./gate_stats.ts";
import type { GateDecisionRecord } from "./gate_measurement.ts";

let nextId = 0;
function record(overrides: Partial<GateDecisionRecord> & Pick<GateDecisionRecord, "source" | "verdict">): GateDecisionRecord {
  nextId += 1;
  return {
    type: "gate-decision",
    id: `test-${nextId}`,
    at: "2026-01-01T00:00:00.000Z",
    project: "demo-repo",
    commandFamily: "git push",
    latencyMs: null,
    ...overrides,
  };
}

test("empty input yields an honest zeroed summary, not nulls masquerading as data", () => {
  const summary = foldGateDecisions([]);
  assert.equal(summary.totalDecisions, 0);
  assert.deepEqual(summary.byVerdict, { allow: 0, ask: 0, deny: 0 });
  assert.deepEqual(summary.bySource, { "local-rule": 0, cache: 0, jev: 0 });
  assert.deepEqual(summary.byCommandFamily, []);
  assert.deepEqual(summary.byProject, []);
  assert.equal(summary.jevLatency.sampleCount, 0);
  assert.equal(summary.jevLatency.medianMs, null);
  assert.equal(summary.jevLatency.maxMs, null);
});

test("counts verdicts and sources independently", () => {
  const summary = foldGateDecisions([
    record({ source: "local-rule", verdict: "ask" }),
    record({ source: "local-rule", verdict: "ask" }),
    record({ source: "cache", verdict: "allow" }),
    record({ source: "jev", verdict: "allow", latencyMs: 400 }),
    record({ source: "jev", verdict: "deny", latencyMs: 900 }),
  ]);
  assert.equal(summary.totalDecisions, 5);
  assert.deepEqual(summary.byVerdict, { allow: 2, ask: 2, deny: 1 });
  assert.deepEqual(summary.bySource, { "local-rule": 2, cache: 1, jev: 2 });
});

test("jev latency: median and max come only from jev-sourced records with a real latencyMs", () => {
  const summary = foldGateDecisions([
    record({ source: "local-rule", verdict: "ask", latencyMs: null }),
    record({ source: "cache", verdict: "allow", latencyMs: null }),
    record({ source: "jev", verdict: "allow", latencyMs: 100 }),
    record({ source: "jev", verdict: "allow", latencyMs: 300 }),
    record({ source: "jev", verdict: "ask", latencyMs: 200 }),
  ]);
  assert.equal(summary.jevLatency.sampleCount, 3);
  assert.equal(summary.jevLatency.medianMs, 200);
  assert.equal(summary.jevLatency.maxMs, 300);
});

test("jev latency median for an even sample size averages the two middle values", () => {
  const summary = foldGateDecisions([
    record({ source: "jev", verdict: "allow", latencyMs: 100 }),
    record({ source: "jev", verdict: "allow", latencyMs: 200 }),
    record({ source: "jev", verdict: "allow", latencyMs: 300 }),
    record({ source: "jev", verdict: "allow", latencyMs: 400 }),
  ]);
  assert.equal(summary.jevLatency.medianMs, 250);
  assert.equal(summary.jevLatency.maxMs, 400);
});

test("a local-rule or cache record never counted in jev latency, even if latencyMs is somehow non-null", () => {
  const summary = foldGateDecisions([
    record({ source: "local-rule", verdict: "ask", latencyMs: 5 }),
    record({ source: "cache", verdict: "allow", latencyMs: 7 }),
  ]);
  assert.equal(summary.jevLatency.sampleCount, 0);
  assert.equal(summary.jevLatency.medianMs, null);
  assert.equal(summary.jevLatency.maxMs, null);
});

test("command families aggregate total and per-family verdict breakdown, sorted by total descending", () => {
  const summary = foldGateDecisions([
    record({ commandFamily: "git push", verdict: "allow", source: "cache" }),
    record({ commandFamily: "git push", verdict: "ask", source: "local-rule" }),
    record({ commandFamily: "git push", verdict: "ask", source: "local-rule" }),
    record({ commandFamily: "rm -rf", verdict: "deny", source: "local-rule" }),
  ]);
  assert.equal(summary.byCommandFamily.length, 2);
  assert.deepEqual(summary.byCommandFamily[0], {
    commandFamily: "git push",
    total: 3,
    byVerdict: { allow: 1, ask: 2, deny: 0 },
  });
  assert.deepEqual(summary.byCommandFamily[1], {
    commandFamily: "rm -rf",
    total: 1,
    byVerdict: { allow: 0, ask: 0, deny: 1 },
  });
});

test("projects aggregate total, sorted descending, and a null project is kept as its own bucket rather than dropped", () => {
  const summary = foldGateDecisions([
    record({ project: "repo-a", verdict: "allow", source: "cache" }),
    record({ project: "repo-a", verdict: "allow", source: "cache" }),
    record({ project: "repo-b", verdict: "ask", source: "local-rule" }),
    record({ project: null, verdict: "allow", source: "cache" }),
  ]);
  assert.equal(summary.byProject.length, 3);
  assert.deepEqual(summary.byProject[0], { project: "repo-a", total: 2 });
  const rest = summary.byProject.slice(1).map((p) => p.project).sort();
  assert.deepEqual(rest, [null, "repo-b"]);
});

test("a single record produces sane singleton stats (median equals the one value, max equals the one value)", () => {
  const summary = foldGateDecisions([record({ source: "jev", verdict: "allow", latencyMs: 42 })]);
  assert.equal(summary.jevLatency.medianMs, 42);
  assert.equal(summary.jevLatency.maxMs, 42);
  assert.equal(summary.jevLatency.sampleCount, 1);
});
