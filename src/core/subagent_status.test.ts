import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import type { SubagentDecision } from "./model_router_subagent.ts";
import { subagentModelLabel, subagentWhy, subagentsStatusPart } from "./subagent_status.ts";

function entry(id: string, rank: number): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available: true };
}
const TIERS = resolveAccountTiers({ env: {}, catalog: [entry("claude-opus-5-5", 1), entry("claude-sonnet-5", 2), entry("claude-haiku-4-5-20251001", 3)], quota: null });

function decision(overrides: Partial<SubagentDecision>): SubagentDecision {
  return { tier: "standard", confidence: 0.9, current: "claude-opus-5-5", proposed: "claude-sonnet-5", model: "claude-opus-5-5", changed: false, reason: "same", guard: null, ...overrides };
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
  assert.equal(subagentModelLabel("claude-sonnet-5", null), "Sonnet");
  assert.equal(subagentModelLabel("some-gateway-model", null), "some-gateway-model");
});

test("subagentsStatusPart: nothing running shows nothing", () => {
  assert.equal(subagentsStatusPart("es", []), null);
});

test("subagentsStatusPart: groups by model and reason, in the order they started", () => {
  const running = [
    { label: "Opus 5.5", why: "explicit" as const },
    { label: "Sonnet 5", why: "chosen" as const },
    { label: "Opus 5.5", why: "explicit" as const },
  ];
  assert.equal(subagentsStatusPart("es", running), "agentes: 2 en Opus 5.5 (pedido explícito), 1 en Sonnet 5 (lo eligió Jev)");
  assert.equal(subagentsStatusPart("en", running), "agents: 2 on Opus 5.5 (explicit request), 1 on Sonnet 5 (chosen by Jev)");
});

test("subagentsStatusPart: every reason has words in both languages", () => {
  for (const why of ["explicit", "lowered", "raised", "chosen", "same", "kept-unsure", "kept-pointer", "measuring", "inherited", "no-jev"] as const) {
    for (const locale of ["es", "en"] as const) {
      const text = subagentsStatusPart(locale, [{ label: "Opus 5.5", why }]);
      assert.ok(text !== null && !text.includes("agents.") && !text.includes("{{"), `${locale}/${why}: ${text}`);
    }
  }
});
