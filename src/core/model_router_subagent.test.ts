import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import type { GuardContext } from "./model_router_decide.ts";
import { decideSubagent, explicitModelRank } from "./model_router_subagent.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available };
}
const TIERS = resolveAccountTiers({
  env: {},
  catalog: [entry("claude-fable-5-1", 1, false), entry("claude-opus-5-5", 2, true), entry("claude-sonnet-5", 3, true), entry("claude-haiku-4-5-20251001", 4, true)],
  quota: null,
});
const CALM: GuardContext = { destinationKind: null, policyHit: false, text: "list the files under src/", activity: null, confidence: 0.9 };

test("explicit model rank: aliases and full ids both place on the account's ladder", () => {
  assert.equal(explicitModelRank(TIERS, "haiku"), 0);
  assert.equal(explicitModelRank(TIERS, "sonnet"), 1);
  assert.equal(explicitModelRank(TIERS, "opus"), 2);
  assert.equal(explicitModelRank(TIERS, "claude-sonnet-5"), 1);
  assert.equal(explicitModelRank(TIERS, "fable"), 2, "fable collapses to Opus where the account has no Fable");
  assert.equal(explicitModelRank(TIERS, "inherit"), null);
  assert.equal(explicitModelRank(TIERS, "something-else"), null);
});

test("subagent: no explicit model -- the tier's full id, down or up from the parent's", () => {
  const down = decideSubagent({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: CALM });
  assert.equal(down.model, "claude-haiku-4-5-20251001");
  assert.equal(down.changed, true);
  const up = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, parentModel: "claude-sonnet-5", explicitModel: undefined, guards: CALM });
  assert.equal(up.model, "claude-opus-5-5");
});

test("subagent: always a full model id, never an alias", () => {
  for (const tier of ["simple", "standard", "complex", "frontier"] as const) {
    const decision = decideSubagent({ tiers: TIERS, jev: { tier, confidence: 0.9 }, parentModel: "claude-sonnet-5", explicitModel: undefined, guards: CALM });
    assert.ok(decision.model.startsWith("claude-"), decision.model);
  }
});

test("subagent: guards keep at least the parent's model", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: { ...CALM, text: "rotate the production credentials" } });
  assert.equal(decision.changed, false);
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.guard, "sensitive-topic");
});

test("subagent: Jev failure changes nothing", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: null, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: { ...CALM, confidence: null } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "jev-failed");
});

test("subagent: an explicit model is the parent's intent -- never downgraded", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "simple", confidence: 0.95 }, parentModel: "claude-opus-5-5", explicitModel: "sonnet", guards: CALM });
  assert.equal(decision.changed, false);
  assert.equal(decision.model, "sonnet");
  assert.equal(decision.reason, "explicit");
});

test("subagent: an explicit model is upgraded only on a guard, to a full id", () => {
  const noGuard = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.95 }, parentModel: "claude-opus-5-5", explicitModel: "haiku", guards: CALM });
  assert.equal(noGuard.changed, false);
  const guarded = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.95 }, parentModel: "claude-opus-5-5", explicitModel: "haiku", guards: { ...CALM, text: "audit the security of the login flow" } });
  assert.equal(guarded.changed, true);
  assert.equal(guarded.model, "claude-opus-5-5");
  assert.equal(guarded.reason, "explicit-upgrade");
});

test("subagent: the parent's own model with a context-window suffix is the same model, not a switch", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, parentModel: "claude-opus-5-5[1m]", explicitModel: undefined, guards: CALM });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "same");
});
