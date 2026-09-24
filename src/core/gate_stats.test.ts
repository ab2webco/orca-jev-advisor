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
  assert.deepEqual(summary.bySource, { "local-rule": 0, cache: 0, jev: 0, none: 0 });
  assert.deepEqual(summary.byCommandFamily, []);
  assert.equal(summary.familiesWithNoInterventions, 0);
  assert.deepEqual(summary.byProject, []);
  assert.deepEqual(summary.byPluginVersion, []);
  assert.equal(summary.noPluginVersionCount, 0);
  assert.equal(summary.jevLatency.sampleCount, 0);
  assert.equal(summary.jevLatency.medianMs, null);
  assert.equal(summary.jevLatency.p95Ms, null);
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
  assert.deepEqual(summary.bySource, { "local-rule": 2, cache: 1, jev: 2, none: 0 });
});

test("a 'none' record -- Jev was asked but never answered, so the command passed unjudged -- counts in its own bucket, never folded into 'jev'", () => {
  const summary = foldGateDecisions([
    record({ source: "jev", verdict: "allow", latencyMs: 400 }),
    record({ source: "none", verdict: "allow", latencyMs: null }),
    record({ source: "none", verdict: "allow", latencyMs: null }),
  ]);
  assert.equal(summary.totalDecisions, 3);
  assert.deepEqual(summary.bySource, { "local-rule": 0, cache: 0, jev: 1, none: 2 });
  // A 'none' record never carries a real latency (see gate_measurement.ts),
  // and even if it somehow did, latency is only ever meaningful for 'jev'.
  assert.equal(summary.jevLatency.sampleCount, 1);
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
    interventions: 2,
  });
  assert.deepEqual(summary.byCommandFamily[1], {
    commandFamily: "rm -rf",
    total: 1,
    byVerdict: { allow: 0, ask: 0, deny: 1 },
    interventions: 1,
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

// ---------------------------------------------------------------------------
// p95Ms -- odd/tasks/panel-interventions-and-mod-copy.md T3. A maximum is
// one sample and says nothing about the shape of the tail; p95 sits beside
// the median. Nearest-rank convention throughout: for n sorted-ascending
// samples, p95 is the value at index ceil(0.95 * n) - 1 -- always an actual
// recorded latency, never an interpolated value nobody measured.
// ---------------------------------------------------------------------------

test("p95Ms is null, never 0, when there is no sample at all", () => {
  const summary = foldGateDecisions([]);
  assert.equal(summary.jevLatency.p95Ms, null);
});

test("p95Ms for a singleton sample equals that one value, same as median and max", () => {
  const summary = foldGateDecisions([record({ source: "jev", verdict: "allow", latencyMs: 42 })]);
  assert.equal(summary.jevLatency.p95Ms, 42);
});

test("p95Ms picks the nearest-rank sample out of 20, not an interpolation between two", () => {
  const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
  const summary = foldGateDecisions(latencies.map((latencyMs) => record({ source: "jev", verdict: "allow", latencyMs })));
  // ceil(0.95 * 20) = 19th rank (1-based) -> index 18 (0-based) -> value 190.
  assert.equal(summary.jevLatency.p95Ms, 190);
  assert.equal(summary.jevLatency.maxMs, 200);
});

test("p95Ms differs from maxMs once the tail has more than one sample past it", () => {
  const latencies = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const summary = foldGateDecisions(latencies.map((latencyMs) => record({ source: "jev", verdict: "allow", latencyMs })));
  assert.equal(summary.jevLatency.p95Ms, 95);
  assert.equal(summary.jevLatency.maxMs, 100);
  assert.notEqual(summary.jevLatency.p95Ms, summary.jevLatency.maxMs);
});

// ---------------------------------------------------------------------------
// interventions per family -- odd/tasks/panel-interventions-and-mod-copy.md
// T4. Measured over 2,773 real decisions: 91 families, 61 of them 100%
// allowed. Sorting by total buries every one that actually intervened.
// ---------------------------------------------------------------------------

test("each family reports its own interventions (ask + deny), independent of total", () => {
  const summary = foldGateDecisions([
    record({ commandFamily: "grep", verdict: "allow", source: "cache" }),
    record({ commandFamily: "grep", verdict: "allow", source: "cache" }),
    record({ commandFamily: "terraform", verdict: "ask", source: "local-rule" }),
    record({ commandFamily: "terraform", verdict: "deny", source: "local-rule" }),
  ]);
  const grep = summary.byCommandFamily.find((f) => f.commandFamily === "grep");
  const terraform = summary.byCommandFamily.find((f) => f.commandFamily === "terraform");
  assert.equal(grep?.interventions, 0);
  assert.equal(terraform?.interventions, 2);
});

test("familiesWithNoInterventions counts families whose interventions is 0, without dropping them from byCommandFamily", () => {
  const summary = foldGateDecisions([
    record({ commandFamily: "grep", verdict: "allow", source: "cache" }),
    record({ commandFamily: "ls", verdict: "allow", source: "cache" }),
    record({ commandFamily: "terraform", verdict: "ask", source: "local-rule" }),
  ]);
  assert.equal(summary.byCommandFamily.length, 3, "the fold stays complete; the panel decides what to show");
  assert.equal(summary.familiesWithNoInterventions, 2);
});

test("familiesWithNoInterventions is 0 for an empty summary, not a stray count", () => {
  const summary = foldGateDecisions([]);
  assert.equal(summary.familiesWithNoInterventions, 0);
});

// ---------------------------------------------------------------------------
// byPluginVersion / noPluginVersionCount -- so a caller can tell "17 asks
// for this family" apart from "17 asks, 5 of them from before the deny tier
// existed" without inventing a time-window heuristic that cannot make that
// distinction (see gate_measurement.ts's own header on why).
// ---------------------------------------------------------------------------

test("byPluginVersion tallies which builds appear in the folded set, and noPluginVersionCount counts records with no version at all", () => {
  const summary = foldGateDecisions([
    record({ verdict: "ask", source: "local-rule", pluginVersion: "0.4.0" }),
    record({ verdict: "ask", source: "local-rule", pluginVersion: "0.4.0" }),
    record({ verdict: "ask", source: "local-rule", pluginVersion: "0.2.6" }),
    record({ verdict: "ask", source: "local-rule" }), // no pluginVersion at all: pre-0.4.0 on-disk shape.
  ]);
  assert.deepEqual(summary.byPluginVersion, [
    { pluginVersion: "0.4.0", total: 2 },
    { pluginVersion: "0.2.6", total: 1 },
  ]);
  assert.equal(summary.noPluginVersionCount, 1);
});

test("byPluginVersion and noPluginVersionCount are empty/zero for an empty summary", () => {
  const summary = foldGateDecisions([]);
  assert.deepEqual(summary.byPluginVersion, []);
  assert.equal(summary.noPluginVersionCount, 0);
});
