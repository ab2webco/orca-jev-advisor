import assert from "node:assert/strict";
import test from "node:test";

import type { QuotaAccount } from "./consumption.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { ANTHROPIC_PRICES, resolveAccountTiers } from "./model_router_accounts.ts";
import type { GuardContext } from "./model_router_decide.ts";
import {
  breakEven,
  decideEngineTurn,
  isNewPrompt,
  lastPromptKey,
  decideStage,
  expectedSteps,
  hysteresisTurns,
  medianOf,
  quotaBandOf,
  shiftForPressure,
  summarizePreviousTurn,
  summarizeSinceLastPrompt,
} from "./model_router_stage.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available };
}
const CATALOG: readonly ModelEntry[] = [
  entry("claude-fable-5-1", 1, false),
  entry("claude-opus-5-5", 2, true),
  entry("claude-sonnet-5", 3, true),
  entry("claude-haiku-4-5-20251001", 4, true),
];
const TIERS = resolveAccountTiers({ env: {}, catalog: CATALOG, quota: null });
const GATEWAY = resolveAccountTiers({ env: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_DEFAULT_OPUS_MODEL: "big", ANTHROPIC_DEFAULT_SONNET_MODEL: "mid", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }, catalog: CATALOG, quota: null });
const OPUS = ANTHROPIC_PRICES["claude-opus-5-5"] ?? null;
const HAIKU = ANTHROPIC_PRICES["claude-haiku-4-5-20251001"] ?? null;
const CALM: GuardContext = { destinationKind: null, policyHit: false, text: "summarise the README", activity: null, confidence: 0.9 };
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

// ---------------------------------------------------------------------------
// T4 break-even (§6.4)
// ---------------------------------------------------------------------------

test("expectedSteps: median × 3, floor 5, default 10", () => {
  assert.equal(expectedSteps(null), 10);
  assert.equal(expectedSteps(4), 12);
  assert.equal(expectedSteps(1), 5);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
});

test("break-even, the worked example: 80k context Opus→Haiku; decide only with enough expected steps", () => {
  const atDefault = breakEven({ contextTokens: 80_000, avgOutput: 700, current: OPUS, proposed: HAIKU, medianStepsPerTurn: null });
  assert.ok(atDefault !== null);
  assert.ok(Math.abs(atDefault.switchCost - 80_000 * 2e-6) < 1e-12);
  assert.ok(Math.abs(atDefault.stepSaving - (80_000 * 0.1e-6 + 700 * 15e-6)) < 1e-12);
  assert.equal(atDefault.expectedSteps, 10);
  // 0.0185 × 10 = 0.185 < 1.2 × 0.16 = 0.192: not worth it.
  assert.equal(atDefault.worthIt, false);
  // 0.0185 × 12 = 0.222 > 0.192: worth it.
  assert.equal(breakEven({ contextTokens: 80_000, avgOutput: 700, current: OPUS, proposed: HAIKU, medianStepsPerTurn: 4 })?.worthIt, true);
  assert.equal(breakEven({ contextTokens: 80_000, avgOutput: 700, current: OPUS, proposed: HAIKU, medianStepsPerTurn: 3 })?.worthIt, false);
});

test("break-even: unknown prices on either side is no answer (downgrades disabled)", () => {
  assert.equal(breakEven({ contextTokens: 80_000, avgOutput: 700, current: null, proposed: HAIKU, medianStepsPerTurn: 4 }), null);
  assert.equal(breakEven({ contextTokens: 80_000, avgOutput: 700, current: OPUS, proposed: null, medianStepsPerTurn: 4 }), null);
});

test("break-even: an effort-only change saves on output alone, so on the same model it never pays", () => {
  const sameModel = breakEven({ contextTokens: 80_000, avgOutput: 700, current: OPUS, proposed: OPUS, medianStepsPerTurn: 10 });
  assert.equal(sameModel?.stepSaving, 0);
  assert.equal(sameModel?.worthIt, false);
});

// ---------------------------------------------------------------------------
// T5 quota bands (§6.5)
// ---------------------------------------------------------------------------

function quota(weekly: number | null): QuotaAccount {
  return { id: "a", status: "ok", sessionUsedPercent: 0, weeklyUsedPercent: weekly, resetsAt: null };
}
const FRESH = new Date(NOW - 5 * 60_000).toISOString();

test("quota bands: < 80 normal, 80–94 economy, ≥ 95 strong economy", () => {
  assert.equal(quotaBandOf(quota(79.9), FRESH, NOW), "normal");
  assert.equal(quotaBandOf(quota(80), FRESH, NOW), "economy");
  assert.equal(quotaBandOf(quota(94.9), FRESH, NOW), "economy");
  assert.equal(quotaBandOf(quota(95), FRESH, NOW), "strong-economy");
  assert.equal(quotaBandOf(quota(100), FRESH, NOW), "strong-economy");
});

test("quota bands: missing, unknown or stale (> 30 min) quota means normal", () => {
  assert.equal(quotaBandOf(null, FRESH, NOW), "normal");
  assert.equal(quotaBandOf(quota(null), FRESH, NOW), "normal");
  assert.equal(quotaBandOf(quota(99), null, NOW), "normal");
  assert.equal(quotaBandOf(quota(99), new Date(NOW - 31 * 60_000).toISOString(), NOW), "normal");
  assert.equal(quotaBandOf(quota(99), new Date(NOW - 29 * 60_000).toISOString(), NOW), "strong-economy");
  assert.equal(quotaBandOf(quota(99), "not a date", NOW), "normal");
});

test("hysteresis: 2 turns in normal, 1 under pressure", () => {
  assert.equal(hysteresisTurns("normal"), 2);
  assert.equal(hysteresisTurns("economy"), 1);
  assert.equal(hysteresisTurns("strong-economy"), 1);
});

const READ_ONLY = { toolCalls: 3, filesEdited: 0, testsRun: 0, testsFailed: 0, errors: 0, mentions: "" };

test("pressure shift (G4, owner rule): only at >= 95%, standard goes to simple, and only after a read-only, failure-free turn", () => {
  assert.equal(shiftForPressure("standard", "strong-economy", [], READ_ONLY), "simple");
  // Normal and economy (80-94%) never shift a tier; economy only relaxes hysteresis.
  assert.equal(shiftForPressure("standard", "normal", [], READ_ONLY), "standard");
  assert.equal(shiftForPressure("standard", "economy", [], READ_ONLY), "standard");
  // The previous turn edited files, or a tool failed, or there was no previous turn.
  assert.equal(shiftForPressure("standard", "strong-economy", [], { ...READ_ONLY, filesEdited: 1 }), "standard");
  assert.equal(shiftForPressure("standard", "strong-economy", [], { ...READ_ONLY, errors: 1 }), "standard");
  assert.equal(shiftForPressure("standard", "strong-economy", [], { ...READ_ONLY, testsRun: 1, testsFailed: 1 }), "standard");
  assert.equal(shiftForPressure("standard", "strong-economy", [], null), "standard");
  // Only standard moves; any guard stops it.
  assert.equal(shiftForPressure("complex", "strong-economy", [], READ_ONLY), "complex");
  assert.equal(shiftForPressure("simple", "strong-economy", [], READ_ONLY), "simple");
  assert.equal(shiftForPressure("standard", "strong-economy", ["sensitive-topic"], READ_ONLY), "standard");
});

test("stage under strong economy: a standard turn after a read-only turn runs on the simple tier", () => {
  const decision = stage({ jev: { tier: "standard", confidence: 0.9 }, band: "strong-economy", guards: { ...CALM, activity: READ_ONLY }, pending: { tier: "simple", turns: 1 } });
  assert.equal(decision.tier, "simple");
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
});

// ---------------------------------------------------------------------------
// Previous-turn activity (§6.1's compact summary)
// ---------------------------------------------------------------------------

test("summarizePreviousTurn: counts the turn between the last two real prompts", () => {
  const messages = [
    { role: "user" as const, text: "first", toolUses: [] },
    {
      role: "assistant" as const,
      text: "",
      toolUses: [
        { tool: "Edit", input: { file_path: "src/a.ts" } },
        { tool: "Bash", input: { command: "npm test" }, text: "✖ 2 failing", isError: true as const },
        { tool: "Read", input: { file_path: "README.md" } },
      ],
    },
    { role: "user" as const, text: "", toolUses: [], toolResults: [{ isError: true }] },
    { role: "assistant" as const, text: "done", toolUses: [] },
    { role: "user" as const, text: "second", toolUses: [] },
  ];
  const activity = summarizePreviousTurn(messages);
  assert.ok(activity !== null);
  assert.equal(activity.toolCalls, 3);
  assert.equal(activity.filesEdited, 1);
  assert.equal(activity.testsRun, 1);
  assert.equal(activity.testsFailed, 1);
  assert.equal(activity.errors, 1);
  assert.ok(activity.mentions.includes("src/a.ts"));
  assert.ok(activity.mentions.includes("npm test"));
  assert.equal(summarizePreviousTurn([{ role: "user", text: "only one", toolUses: [] }]), null);
});

// ---------------------------------------------------------------------------
// T7 stage decision (point C, §6.4)
// ---------------------------------------------------------------------------

const USAGE = { contextTokens: 80_000, avgOutput: 700, medianStepsPerTurn: 4 };

function stage(overrides: Partial<Parameters<typeof decideStage>[0]>): ReturnType<typeof decideStage> {
  return decideStage({
    tiers: TIERS,
    jev: { tier: "simple", confidence: 0.9 },
    currentModel: "claude-opus-5-5",
    currentEffort: "high",
    configuredModel: "claude-opus-5-5",
    configuredEffort: "high",
    guards: CALM,
    band: "normal",
    pending: null,
    usage: USAGE,
    ...overrides,
  });
}

test("stage: Jev failure changes nothing", () => {
  const decision = stage({ jev: null, guards: { ...CALM, confidence: null } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "jev-failed");
});

test("stage: an upgrade with confidence ≥ 0.70 switches immediately", () => {
  const decision = stage({ jev: { tier: "complex", confidence: 0.8 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "upgrade");
  assert.equal(decision.pending, null);
});

test("stage: an upgrade under 0.70 waits when the session is already at or above its own model", () => {
  const unsure = stage({ jev: { tier: "complex", confidence: 0.6 }, currentModel: "claude-sonnet-5", currentEffort: "medium", configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.6 } });
  assert.equal(unsure.changed, false);
  assert.equal(unsure.reason, "low-confidence");
});

test("stage: under ANY guard, a session running below its own model is restored to at least its own (§6.2)", () => {
  const failed = { toolCalls: 2, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const restore = stage({ jev: { tier: "simple", confidence: 0.6 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, guards: { ...CALM, confidence: 0.6, activity: failed } });
  assert.equal(restore.model, "claude-opus-5-5", "a failure on the weaker model restores at least the session's own");
  assert.equal(restore.effort, "high");
  assert.equal(restore.changed, true);
  assert.equal(restore.reason, "floor-restore");
  assert.equal(restore.guard, "previous-failure");
  // The live case: Haiku after a simple start, then an unsure standard turn on a Sonnet session.
  const unsure = stage({ jev: { tier: "standard", confidence: 0.55 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.55 } });
  assert.equal(unsure.model, "claude-sonnet-5");
  assert.equal(unsure.effort, "medium");
  assert.equal(unsure.reason, "floor-restore");
  assert.equal(unsure.guard, "low-confidence");
  // A guard with a proposal above the floor goes to the proposal.
  const higher = stage({ jev: { tier: "complex", confidence: 0.5 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.5 } });
  assert.equal(higher.model, "claude-opus-5-5");
});

test("stage: a downgrade needs the same lower tier on 2 consecutive turns AND a positive break-even", () => {
  const first = stage({});
  assert.equal(first.changed, false);
  assert.equal(first.reason, "hysteresis");
  assert.deepEqual(first.pending, { tier: "simple", turns: 1 });
  const second = stage({ pending: first.pending });
  assert.equal(second.changed, true);
  assert.equal(second.model, "claude-haiku-4-5-20251001");
  assert.equal(second.reason, "downgrade");
  assert.ok(second.breakEven !== null && second.breakEven.worthIt);
  // A different lower tier restarts the count.
  const other = stage({ jev: { tier: "standard", confidence: 0.9 }, pending: { tier: "simple", turns: 1 } });
  assert.deepEqual(other.pending, { tier: "standard", turns: 1 });
});

test("stage: a downgrade whose break-even is negative does not happen, even after hysteresis", () => {
  const decision = stage({ pending: { tier: "simple", turns: 1 }, usage: { ...USAGE, medianStepsPerTurn: 1 } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "break-even");
});

test("stage: no downgrade under a guard, and the pending count is dropped", () => {
  const decision = stage({ pending: { tier: "simple", turns: 1 }, guards: { ...CALM, text: "now deploy to production" } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-guard");
  assert.equal(decision.pending, null);
});

test("stage: economy relaxes hysteresis to 1 turn", () => {
  const decision = stage({ band: "economy" });
  assert.equal(decision.changed, true);
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
});

test("stage: unknown prices (a gateway) disable downgrades", () => {
  const decision = stage({ tiers: GATEWAY, currentModel: "big", currentEffort: null, configuredModel: "big", configuredEffort: null, pending: { tier: "simple", turns: 1 } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "prices-unknown");
});

test("stage: no usage yet means no break-even, so no downgrade", () => {
  const decision = stage({ pending: { tier: "simple", turns: 1 }, usage: null });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "break-even");
});

test("stage: same tier as the current model is no change, and clears a pending count", () => {
  const decision = stage({ jev: { tier: "complex", confidence: 0.9 }, pending: { tier: "simple", turns: 1 } });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "same");
  assert.equal(decision.pending, null);
});

// ---------------------------------------------------------------------------
// Review round 2: findings 1, 2 and 7
// ---------------------------------------------------------------------------

test("finding 1: a Jev failure below the session's own model restores the floor (a failure is itself a guard)", () => {
  const failed = { toolCalls: 2, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const decision = stage({ jev: null, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredEffort: "xhigh", guards: { ...CALM, text: "deploy the migration to production", activity: failed, confidence: null } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "floor-restore");
  // At or above the floor, a Jev failure still changes nothing.
  const atFloor = stage({ jev: null, guards: { ...CALM, confidence: null } });
  assert.equal(atFloor.changed, false);
  assert.equal(atFloor.reason, "jev-failed");
});

test("finding 2: a floor-restore sends exactly the session's own effort, max included", () => {
  const failed = { toolCalls: 1, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const decision = stage({ jev: { tier: "simple", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredEffort: "max", guards: { ...CALM, activity: failed } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "max");
});

test("finding 7: restoring or upgrading to the session's own base model keeps its [1m] id", () => {
  const failed = { toolCalls: 1, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const restore = stage({ jev: { tier: "simple", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-opus-5-5[1m]", guards: { ...CALM, activity: failed } });
  assert.equal(restore.model, "claude-opus-5-5[1m]");
  const upgrade = stage({ jev: { tier: "complex", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-opus-5-5[1m]" });
  assert.equal(upgrade.model, "claude-opus-5-5[1m]");
});

// ---------------------------------------------------------------------------
// Round 3: N1 and N2 (pure)
// ---------------------------------------------------------------------------

test("N1: a downgrade back to the session's own model returns its exact [1m] id and its own effort", () => {
  for (const configuredEffort of ["medium", "max"] as const) {
    const decision = stage({
      jev: { tier: "simple", confidence: 0.9 },
      currentModel: "claude-opus-5-5",
      currentEffort: "high",
      configuredModel: "claude-haiku-4-5-20251001[1m]",
      configuredEffort,
      pending: { tier: "simple", turns: 1 },
    });
    assert.equal(decision.reason, "downgrade");
    assert.equal(decision.model, "claude-haiku-4-5-20251001[1m]");
    assert.equal(decision.effort, configuredEffort);
  }
});

test("N2: summarizeSinceLastPrompt covers the work after the last real prompt (an engine-started turn)", () => {
  const messages = [
    { role: "user" as const, text: "run the tests", toolUses: [] },
    { role: "assistant" as const, text: "", toolUses: [{ tool: "Bash", input: { command: "npm test" }, text: "✖ 1 failing", isError: true as const }] },
    { role: "assistant" as const, text: "one fails", toolUses: [] },
  ];
  const activity = summarizeSinceLastPrompt(messages);
  assert.ok(activity !== null);
  assert.equal(activity.testsFailed, 1);
  assert.ok(activity.mentions.includes("npm test"));
  assert.equal(summarizeSinceLastPrompt([]), null);
});

test("N3 (pinning): a new prompt is a new text, or the same text further down; /compact moving it up is not new", () => {
  const before = lastPromptKey([{ role: "user", text: "hola", toolUses: [] }, { role: "assistant", text: "", toolUses: [] }, { role: "user", text: "sigue", toolUses: [] }]);
  assert.ok(before !== null);
  const compacted = lastPromptKey([{ role: "user", text: "sigue", toolUses: [] }]);
  assert.equal(isNewPrompt(before, compacted), false);
  const other = lastPromptKey([{ role: "user", text: "Summary", toolUses: [] }, { role: "user", text: "nuevo", toolUses: [] }, { role: "assistant", text: "", toolUses: [] }]);
  assert.equal(isNewPrompt(before, other), true);
  const repeated = lastPromptKey([...Array.from({ length: 5 }, () => ({ role: "assistant" as const, text: "", toolUses: [] })), { role: "user", text: "sigue", toolUses: [] }]);
  assert.equal(isNewPrompt(before, repeated), true);
  assert.equal(isNewPrompt(null, before), true);
  assert.equal(isNewPrompt(before, null), false);
  assert.equal(JSON.stringify(before).includes("sigue"), false, "the key never carries the prompt text");
});

test("N2 (pinning): decideEngineTurn restores the floor only below it, and only on a failure or a sensitive topic", () => {
  const failed = { toolCalls: 1, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "npm test" };
  const base = { tiers: TIERS, currentModel: "claude-haiku-4-5-20251001", configuredModel: "claude-opus-5-5", configuredEffort: "max" as const, text: "hola" };
  const restore = decideEngineTurn({ ...base, activity: failed });
  assert.equal(restore?.model, "claude-opus-5-5");
  assert.equal(restore?.effort, "max");
  assert.equal(restore?.guard, "previous-failure");
  assert.equal(decideEngineTurn({ ...base, activity: { ...failed, testsFailed: 0 } }), null, "clean work keeps the sticky choice");
  assert.equal(decideEngineTurn({ ...base, text: "now deploy to production", activity: null })?.guard, "sensitive-topic");
  assert.equal(decideEngineTurn({ ...base, currentModel: "claude-opus-5-5", activity: failed }), null, "at the floor already");
});
