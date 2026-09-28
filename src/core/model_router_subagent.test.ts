import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import type { GuardContext } from "./model_router_decide.ts";
import { decideSubagent, explicitModelRank, subagentStepEffort } from "./model_router_subagent.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available };
}
const TIERS = resolveAccountTiers({
  env: {},
  catalog: [entry("claude-fable-5-1", 1, false), entry("claude-opus-5-5", 2, true), entry("claude-sonnet-5", 3, true), entry("claude-haiku-4-5-20251001", 4, true)],
  quota: null,
});
const CALM: GuardContext = { text: "list the files under src/", activity: null, confidence: 0.9 };

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
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.changed, false);
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.guard, "pointer-prompt");
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
  const guarded = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.95 }, parentModel: "claude-opus-5-5", explicitModel: "haiku", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(guarded.changed, true);
  assert.equal(guarded.model, "claude-opus-5-5");
  assert.equal(guarded.reason, "explicit-upgrade");
});

test("subagent: the parent's own model with a context-window suffix is the same model, not a switch", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, parentModel: "claude-opus-5-5[1m]", explicitModel: undefined, guards: CALM });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "same");
});

// ---------------------------------------------------------------------------
// JEV-061 slice 2: the subagent's own first-step effort
// ---------------------------------------------------------------------------

test("subagentStepEffort: a standard-tier subagent is lowered from the parent's inherited xhigh/high to medium", () => {
  assert.equal(subagentStepEffort("medium", "xhigh"), "medium");
  assert.equal(subagentStepEffort("medium", "high"), "medium");
});

test("subagentStepEffort: unguarded, a lower inherited effort than the tier's own is raised to the tier's (0.6.3 F0)", () => {
  assert.equal(subagentStepEffort("high", "low"), "high");
  assert.equal(subagentStepEffort("xhigh", "medium"), "xhigh");
});

test("subagentStepEffort: exactly the tier's own effort is left as it is", () => {
  assert.equal(subagentStepEffort("medium", "medium"), "medium");
});

test("subagentStepEffort: a person's own max or numeric budget is never touched", () => {
  assert.equal(subagentStepEffort("low", "max"), "max");
  assert.equal(subagentStepEffort("low", 12000), 12000);
});

test("subagentStepEffort: a no-effort tier (Haiku) removes whatever effort was inherited", () => {
  assert.equal(subagentStepEffort(null, "high"), undefined);
  assert.equal(subagentStepEffort(null, undefined), undefined);
});

test("subagentStepEffort: nothing inherited (no current effort) simply takes the tier's own", () => {
  assert.equal(subagentStepEffort("medium", undefined), "medium");
});

// ---------------------------------------------------------------------------
// 0.6.2 F0 and review finding 2: a guard at spawn is logged, blocks lowering
// the subagent's effort, and never blocks raising it.
// ---------------------------------------------------------------------------

test("finding 2: a same-model subagent under a guard names the guard", () => {
  const pointer = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: { ...CALM, text: "writer\nRead /x/brief.md and do what it says" } });
  assert.equal(pointer.reason, "same");
  assert.equal(pointer.guard, "pointer-prompt");
  const unsure = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.4 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: { ...CALM, confidence: 0.4 } });
  assert.equal(unsure.guard, "low-confidence");
  const up = decideSubagent({ tiers: TIERS, jev: { tier: "complex", confidence: 0.4 }, parentModel: "claude-sonnet-5", explicitModel: undefined, guards: { ...CALM, confidence: 0.4 } });
  assert.equal(up.reason, "switch");
  assert.equal(up.guard, "low-confidence");
});

test("F0 subagentStepEffort: under a guard, the higher of the inherited and the tier's effort", () => {
  assert.equal(subagentStepEffort("high", "medium", true), "high", "raised");
  assert.equal(subagentStepEffort("medium", "xhigh", true), "xhigh", "never lowered under a guard");
  assert.equal(subagentStepEffort("low", "max", true), "max");
  assert.equal(subagentStepEffort("low", 12000, true), 12000);
  assert.equal(subagentStepEffort("high", undefined, true), "high");
  assert.equal(subagentStepEffort("medium", "xhigh", false), "medium", "unguarded: the tier's own effort applies outright");
});
