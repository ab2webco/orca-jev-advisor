import assert from "node:assert/strict";
import test from "node:test";

import { parseOrcaGameMode } from "./advisor_state.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import { decideStart, routerDecisionRecord } from "./model_router_decide.ts";
import type { GuardContext } from "./model_router_decide.ts";
import { decideStage } from "./model_router_stage.ts";
import { keptWhy, routerStatusText } from "./model_router_status.ts";
import { decideSubagent } from "./model_router_subagent.ts";
import { subagentWhy } from "./subagent_status.ts";
import { subagentWhyText } from "./subagent_band.ts";
import { NO_ORCA_PINS, modelPinnedTiers, orcaPinsOf } from "./orca_pins.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available };
}

// Haiku 4.5 kept as the simple tier takes no effort; the default ladder's Haiku 5.5 does.
const TIERS = resolveAccountTiers({
  env: {},
  catalog: [entry("claude-fable-5-1", 1, false), entry("claude-opus-5-5", 2, true), entry("claude-sonnet-5-5", 3, true), { ...entry("claude-haiku-4-5-20251001", 4, true), tier: "simple", supportsEffort: false }],
  quota: null,
});
const DEFAULT_TIERS = resolveAccountTiers({ env: {}, catalog: [], quota: null });
const CALM: GuardContext = { text: "list the files under src/", activity: null, confidence: 0.9 };
const MODEL = { model: true, effort: false } as const;
const EFFORT = { model: false, effort: true } as const;
const BOTH = { model: true, effort: true } as const;

// ---------------------------------------------------------------------------
// Reading the pins
// ---------------------------------------------------------------------------

test("pins: in a game pane, exactly `1` pins each dimension on its own", () => {
  assert.deepEqual(orcaPinsOf("on", "1", "1"), BOTH);
  assert.deepEqual(orcaPinsOf("zen", "1", undefined), MODEL);
  assert.deepEqual(orcaPinsOf("on", undefined, "1"), EFFORT);
});

test("pins: outside a game pane the variables pin nothing", () => {
  assert.deepEqual(orcaPinsOf(null, "1", "1"), NO_ORCA_PINS);
});

test("pins: a game pane with its HUD off is no game, so nothing is pinned", () => {
  assert.deepEqual(orcaPinsOf(parseOrcaGameMode("on", "0"), "1", "1"), NO_ORCA_PINS);
});

test("pins: any value other than `1` is not a pin", () => {
  for (const value of ["0", "true", "yes", " 1", "1 ", "", "01"]) assert.deepEqual(orcaPinsOf("on", value, value), NO_ORCA_PINS, JSON.stringify(value));
});

test("pins: a model pin turns every tier into the pinned model; a model the account does not hold gives null", () => {
  const pinned = modelPinnedTiers(TIERS, "claude-opus-5-5[1m]");
  assert.ok(pinned !== null);
  for (const tier of ["simple", "standard", "complex", "frontier"] as const) assert.equal(pinned[tier].modelId, "claude-opus-5-5");
  assert.equal(modelPinnedTiers(TIERS, "glm-5.3"), null);
});

// ---------------------------------------------------------------------------
// Session start (point A)
// ---------------------------------------------------------------------------

const START = { tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM } as const;

test("start: no pins decides exactly as before", () => {
  assert.deepEqual(decideStart({ ...START, pins: NO_ORCA_PINS }), decideStart(START));
});

test("start, model pinned: the model stays and the effort still follows Jev's tier", () => {
  const decision = decideStart({ ...START, pins: MODEL });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "medium");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "switch");
  assert.equal(decision.tier, "simple", "the row keeps Jev's tier");
  assert.equal(decision.proposed, "claude-haiku-4-5-20251001", "and the model Jev's tier names");
  assert.deepEqual(decision.orcaPin, ["model"]);
});

test("start, effort pinned: the model still switches and the session's own effort goes with it", () => {
  const decision = decideStart({ ...START, tiers: DEFAULT_TIERS, pins: EFFORT });
  assert.equal(decision.model, "claude-haiku-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, true);
  assert.deepEqual(decision.orcaPin, ["effort"]);
});

test("start, effort pinned: a model that takes no effort is sent none, as without the pin", () => {
  const decision = decideStart({ ...START, pins: EFFORT });
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
  assert.equal(decision.effort, null);
  assert.deepEqual(decision.orcaPin, []);
});

test("start, both pinned: nothing changes, and the reason says Orca pinned it", () => {
  const decision = decideStart({ ...START, pins: BOTH });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-orca-pin");
  assert.deepEqual(decision.orcaPin, ["model", "effort"]);
});

test("start, model pinned on a model the account does not hold: nothing changes", () => {
  const decision = decideStart({ ...START, configuredModel: "claude-opus-4-1", pins: MODEL });
  assert.equal(decision.model, "claude-opus-4-1");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-orca-pin");
});

test("start, pinned: a decision the pin did not touch keeps its own reason", () => {
  const decision = decideStart({ ...START, jev: { tier: "complex", confidence: 0.9 }, pins: BOTH });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "same");
  assert.deepEqual(decision.orcaPin, []);
});

// ---------------------------------------------------------------------------
// Later turns (point C)
// ---------------------------------------------------------------------------

const STAGE = {
  tiers: TIERS,
  jev: { tier: "complex", confidence: 0.9 },
  currentModel: "claude-sonnet-5-5",
  currentEffort: "medium",
  configuredModel: "claude-sonnet-5-5",
  configuredEffort: "medium",
  guards: CALM,
  band: "normal",
  pending: null,
  usage: { contextTokens: 80_000, avgOutput: 700, medianStepsPerTurn: 4 },
} as const;

test("stage, model pinned: an upgrade becomes an effort raise on the pinned model", () => {
  assert.equal(decideStage(STAGE).model, "claude-opus-5-5", "without the pin it upgrades");
  const decision = decideStage({ ...STAGE, pins: MODEL });
  assert.equal(decision.model, "claude-sonnet-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.reason, "effort-raise");
  assert.equal(decision.proposed, "claude-opus-5-5");
  assert.equal(decision.tier, "complex");
  assert.deepEqual(decision.orcaPin, ["model"]);
});

test("stage, effort pinned: an effort raise on the same model is held", () => {
  const input = { ...STAGE, currentModel: "claude-opus-5-5", configuredModel: "claude-opus-5-5" } as const;
  assert.equal(decideStage(input).reason, "effort-raise", "without the pin it raises");
  const decision = decideStage({ ...input, pins: EFFORT });
  assert.equal(decision.effort, "medium");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-orca-pin");
  assert.equal(decision.effortTarget, "high", "the effort Jev's tier asked for, for the status line");
  assert.deepEqual(decision.orcaPin, ["effort"]);
});

test("stage, model pinned: a model downgrade waiting on hysteresis is not counted", () => {
  const input = { ...STAGE, jev: { tier: "simple", confidence: 0.9 }, currentModel: "claude-opus-5-5", configuredModel: "claude-opus-5-5", currentEffort: "medium", configuredEffort: "medium" } as const;
  assert.equal(decideStage(input).reason, "hysteresis");
  const decision = decideStage({ ...input, pins: MODEL });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-orca-pin");
  assert.equal(decision.pending, null, "no model lowering waits");
});

test("stage, effort pinned: an effort lowering is never queued", () => {
  const input = { ...STAGE, jev: { tier: "standard", confidence: 0.9 }, currentModel: "claude-opus-5-5", configuredModel: "claude-opus-5-5", currentEffort: "high", configuredEffort: "high", tiers: resolveAccountTiers({ env: {}, catalog: [entry("claude-opus-5-5", 1, true), { ...entry("claude-opus-5-5", 2, true), tier: "standard" }], quota: null }) } as const;
  assert.equal(decideStage(input).reason, "effort-hysteresis");
  const decision = decideStage({ ...input, pins: EFFORT });
  assert.equal(decision.changed, false);
  assert.equal(decision.pending, null);
});

// ---------------------------------------------------------------------------
// Subagents (point B)
// ---------------------------------------------------------------------------

test("subagent, model pinned: the parent's model is kept, and the reason says Orca pinned it", () => {
  const input = { tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: CALM } as const;
  assert.equal(decideSubagent(input).changed, true);
  const decision = decideSubagent({ ...input, pins: MODEL });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-orca-pin");
  assert.equal(decision.proposed, "claude-haiku-4-5-20251001");
  assert.deepEqual(decision.orcaPin, ["model"]);
});

test("subagent, model pinned: an explicit model the router would raise stays as asked", () => {
  const input = { tiers: TIERS, jev: { tier: "complex", confidence: 0.4 }, parentModel: "claude-opus-5-5", explicitModel: "sonnet", guards: { ...CALM, confidence: 0.4 } } as const;
  assert.equal(decideSubagent(input).reason, "explicit-upgrade");
  const decision = decideSubagent({ ...input, pins: MODEL });
  assert.equal(decision.model, "sonnet");
  assert.equal(decision.reason, "held-by-orca-pin");
});

test("subagent, effort pinned only: the model is still routed", () => {
  const input = { tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: CALM } as const;
  assert.deepEqual(decideSubagent({ ...input, pins: EFFORT }), { ...decideSubagent(input), orcaPin: [] });
});

// ---------------------------------------------------------------------------
// What the person and the log see
// ---------------------------------------------------------------------------

test("record: the held dimensions are logged with the reason, and only when a pin held one", () => {
  const base = { at: "2026-10-16T10:00:00.000Z", account: "acct-1", point: "start", applied: false, quotaBand: "normal" } as const;
  const held = routerDecisionRecord({ ...base, decision: decideStart({ ...START, pins: BOTH }) });
  assert.equal(held.reason, "held-by-orca-pin");
  assert.deepEqual(held.orcaPin, ["model", "effort"]);
  assert.equal("orcaPin" in routerDecisionRecord({ ...base, decision: decideStart(START) }), false);
});

test("status line: a held model says it was kept because Orca pinned it, not that it switched", () => {
  const decision = decideStart({ ...START, pins: BOTH });
  const why = keptWhy(decision);
  assert.equal(why, "orca-pin");
  assert.equal(routerStatusText("en", "active", { label: "Opus 5.5", effort: "high", tier: "simple", kept: why }), "model: Opus 5.5 · high effort · kept: pinned by Orca (Jev: ask)");
  assert.equal(routerStatusText("es", "active", { label: "Opus 5.5", effort: "high", tier: "simple", kept: why }), "modelo: Opus 5.5 · esfuerzo alto · se mantiene: fijado por Orca (Jev: consultar)");
});

test("status line: a held effort on the same model says why too", () => {
  const decision = decideStage({ ...STAGE, currentModel: "claude-opus-5-5", configuredModel: "claude-opus-5-5", pins: EFFORT });
  assert.equal(keptWhy(decision), "orca-pin");
});

test("agents band: a subagent kept on its parent's model by a pin says so", () => {
  const decision = decideSubagent({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, parentModel: "claude-opus-5-5", explicitModel: undefined, guards: CALM, pins: MODEL });
  const why = subagentWhy({ decision, applied: false, explicit: false });
  assert.equal(why, "kept-pinned");
  const agent = { id: "agent-1", type: "general-purpose", description: "List files", label: "Opus 5.5", effort: null, effortSource: null, why, wouldUse: null } as const;
  assert.equal(subagentWhyText("en", agent, false), "kept: pinned by Orca");
  assert.equal(subagentWhyText("en", agent, true), "pinned");
  assert.equal(subagentWhyText("es", agent, false), "se mantiene: fijado por Orca");
  assert.equal(subagentWhyText("es", agent, true), "fijado");
});
