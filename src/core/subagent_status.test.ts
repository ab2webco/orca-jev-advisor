import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import type { SubagentDecision } from "./model_router_subagent.ts";
import { parseRunningSubagents, reconcileRunning, subagentModelLabel, subagentWhy, subagentsStatusPart } from "./subagent_status.ts";
import type { RunningSubagent } from "./subagent_status.ts";

function entry(id: string, rank: number): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available: true };
}
const TIERS = resolveAccountTiers({ env: {}, catalog: [entry("claude-opus-5-5", 1), entry("claude-sonnet-5-5", 2), entry("claude-haiku-4-5-20251001", 3)], quota: null });

function decision(overrides: Partial<SubagentDecision>): SubagentDecision {
  return { tier: "standard", confidence: 0.9, current: "claude-opus-5-5", proposed: "claude-sonnet-5-5", model: "claude-opus-5-5", changed: false, reason: "same", guard: null, ...overrides };
}

test("subagentWhy: an explicit model kept is an explicit request", () => {
  assert.equal(subagentWhy({ decision: decision({ reason: "explicit" }), applied: false, explicit: true }), "explicit");
});

test("subagentWhy: a change only counts when it was applied (active mode)", () => {
  assert.equal(subagentWhy({ decision: decision({ reason: "switch", changed: true }), applied: true, explicit: false }), "chosen");
  assert.equal(subagentWhy({ decision: decision({ reason: "switch", changed: true }), applied: false, explicit: false }), "measuring");
  assert.equal(subagentWhy({ decision: decision({ reason: "explicit-upgrade", changed: true }), applied: true, explicit: true }), "raised");
  assert.equal(subagentWhy({ decision: decision({ reason: "explicit-upgrade", changed: true }), applied: false, explicit: true }), "explicit");
  assert.equal(subagentWhy({ decision: decision({ reason: "explicit-lowered", changed: true }), applied: true, explicit: true }), "lowered");
  assert.equal(subagentWhy({ decision: decision({ reason: "explicit-lowered", changed: true }), applied: false, explicit: true }), "explicit");
});

test("subagentWhy: a guard names what held the model", () => {
  assert.equal(subagentWhy({ decision: decision({ reason: "held-by-guard", guard: "low-confidence" }), applied: false, explicit: false }), "kept-unsure");
  assert.equal(subagentWhy({ decision: decision({ reason: "held-by-guard", guard: "pointer-prompt" }), applied: false, explicit: false }), "kept-pointer");
});

test("subagentWhy: no decision, or no Jev answer, is the inherited model (or the explicit one)", () => {
  assert.equal(subagentWhy({ decision: null, applied: false, explicit: false }), "inherited");
  assert.equal(subagentWhy({ decision: null, applied: false, explicit: true }), "explicit");
  assert.equal(subagentWhy({ decision: decision({ reason: "jev-failed", tier: null }), applied: false, explicit: false }), "no-jev");
  assert.equal(subagentWhy({ decision: decision({ reason: "jev-failed", tier: null }), applied: false, explicit: true }), "explicit");
  assert.equal(subagentWhy({ decision: decision({ reason: "same" }), applied: false, explicit: false }), "same");
});

test("subagentModelLabel: the account's label for a known id, a family name for an alias, the id otherwise", () => {
  assert.equal(subagentModelLabel("claude-opus-5-5", TIERS), "Opus 5.5");
  assert.equal(subagentModelLabel("claude-opus-5-5[1m]", TIERS), "Opus 5.5");
  assert.equal(subagentModelLabel("opus", TIERS), "Opus 5.5");
  assert.equal(subagentModelLabel("sonnet", null), "Sonnet");
  assert.equal(subagentModelLabel("claude-sonnet-5-5", null), "Sonnet");
  assert.equal(subagentModelLabel("some-gateway-model", null), "some-gateway-model");
});

test("subagentsStatusPart: nothing running shows nothing", () => {
  assert.equal(subagentsStatusPart("es", []), null);
});

// 0.6.14 T2: the line only counts them; which agent runs which model, and
// why, is each agent's own row in the band (subagent_band.test.ts), since
// grouped by model the person could not tell the agents apart.
test("subagentsStatusPart: counts the agents running now", () => {
  const running = [
    { label: "Opus 5.5", why: "explicit" as const },
    { label: "Sonnet 5.5", why: "chosen" as const },
    { label: "Opus 5.5", why: "explicit" as const },
  ];
  assert.equal(subagentsStatusPart("es", running), "agentes: 3");
  assert.equal(subagentsStatusPart("en", running), "agents: 3");
});

test("subagentsStatusPart: every reason has words in both languages", () => {
  for (const why of ["explicit", "lowered", "raised", "chosen", "same", "kept-unsure", "kept-pointer", "measuring", "inherited", "no-jev"] as const) {
    for (const locale of ["es", "en"] as const) {
      const text = subagentsStatusPart(locale, [{ label: "Opus 5.5", why }]);
      assert.ok(text !== null && !text.includes("agents.") && !text.includes("{{"), `${locale}/${why}: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 0.6.14 T1: each running subagent carries what it is, what it does, its
// model, its effort and why; the set survives a plugin reload and an agent
// the host runs that nothing recorded still counts.
// ---------------------------------------------------------------------------

function agent(id: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  return { id, type: "acme-frontend-developer", description: `task ${id}`, label: "Opus 5.5", effort: "high", why: "explicit", wouldUse: null, ...overrides };
}

test("reconcileRunning: a recorded agent the host no longer runs is dropped, the one just started is kept", () => {
  const recorded = [agent("a-1"), agent("a-2"), agent("a-3")];
  const listed = [
    { id: "a-1", type: "acme-frontend-developer", description: "task a-1", status: "running" },
    { id: "a-2", type: "acme-frontend-developer", description: "task a-2", status: "completed" },
  ];
  const { kept, shown } = reconcileRunning(recorded, listed, "a-3");
  assert.deepEqual(kept.map((a) => a.id), ["a-1", "a-3"]);
  assert.deepEqual(shown.map((a) => a.id), ["a-1", "a-3"]);
});

test("reconcileRunning: an agent the host runs with no record gets a row of its own, never dropped from the count", () => {
  const recorded = [agent("a-2")];
  const listed = [
    { id: "a-1", type: "acme-frontend-developer", description: "Reading playwright.config.ts", status: "running" },
    { id: "a-2", type: "acme-frontend-developer", description: "task a-2", status: "running" },
  ];
  const { kept, shown } = reconcileRunning(recorded, listed, null);
  assert.deepEqual(kept.map((a) => a.id), ["a-2"], "an unknown agent is shown, not recorded");
  assert.equal(shown.length, 2);
  assert.deepEqual(shown[0], { id: "a-1", type: "acme-frontend-developer", description: "Reading playwright.config.ts", label: null, effort: null, why: "unknown", wouldUse: null });
});

test("reconcileRunning: with no host list, what spawn recorded stands", () => {
  const recorded = [agent("a-1"), agent("a-2")];
  const { kept, shown } = reconcileRunning(recorded, null, null);
  assert.deepEqual(kept, recorded);
  assert.deepEqual(shown, recorded);
});

test("parseRunningSubagents: reads back what was stored, drops what is malformed", () => {
  const stored = [agent("a-1", { effort: null, why: "lowered", wouldUse: "Haiku 4.5" }), agent("a-2", { label: null, effort: 4096 })];
  assert.deepEqual(parseRunningSubagents({ agents: JSON.parse(JSON.stringify(stored)) }), stored);
  assert.deepEqual(parseRunningSubagents(undefined), []);
  assert.deepEqual(parseRunningSubagents({ agents: [{ id: "x" }, null, 3, { ...stored[0], why: "nonsense" }] }), []);
});

test("subagentsStatusPart: an agent with no record counts", () => {
  const running = [agent("a-1"), agent("a-2", { label: null, effort: null, why: "unknown" })];
  assert.equal(subagentsStatusPart("es", running), "agentes: 2");
  assert.equal(subagentsStatusPart("en", running), "agents: 2");
});
