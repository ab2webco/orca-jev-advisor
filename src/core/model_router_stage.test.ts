import assert from "node:assert/strict";
import test from "node:test";

import type { QuotaAccount } from "./consumption.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { ANTHROPIC_PRICES, resolveAccountTiers } from "./model_router_accounts.ts";
import { activeGuards, buildTierState } from "./model_router_decide.ts";
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
  quotaPressureOf,
  shiftForPressure,
  summarizePreviousTurn,
  summarizeSinceLastPrompt,
} from "./model_router_stage.ts";
import type { ActivityMessage } from "./model_router_stage.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available };
}
const CATALOG: readonly ModelEntry[] = [
  entry("claude-fable-5-1", 1, false),
  entry("claude-opus-5-5", 2, true),
  entry("claude-sonnet-5-5", 3, true),
  entry("claude-haiku-4-5-20251001", 4, true),
];
const TIERS = resolveAccountTiers({ env: {}, catalog: CATALOG, quota: null });
const GATEWAY = resolveAccountTiers({ env: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_DEFAULT_OPUS_MODEL: "big", ANTHROPIC_DEFAULT_SONNET_MODEL: "mid", ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }, catalog: CATALOG, quota: null });
const OPUS = ANTHROPIC_PRICES["claude-opus-5-5"] ?? null;
const HAIKU = ANTHROPIC_PRICES["claude-haiku-4-5-20251001"] ?? null;
const CALM: GuardContext = { text: "summarise the README", activity: null, confidence: 0.9 };
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

function quotaBoth(session: number | null, weekly: number | null): QuotaAccount {
  return { id: "a", status: "ok", sessionUsedPercent: session, weeklyUsedPercent: weekly, resetsAt: null };
}

test("quota bands: the band is the tighter of the 5-hour and the 7-day window", () => {
  assert.equal(quotaBandOf(quotaBoth(96, 10), FRESH, NOW), "strong-economy");
  assert.equal(quotaBandOf(quotaBoth(85, 10), FRESH, NOW), "economy");
  assert.equal(quotaBandOf(quotaBoth(85, 96), FRESH, NOW), "strong-economy");
  assert.equal(quotaBandOf(quotaBoth(10, 85), FRESH, NOW), "economy");
  assert.equal(quotaBandOf(quotaBoth(null, 85), FRESH, NOW), "economy");
  assert.equal(quotaBandOf(quotaBoth(96, null), FRESH, NOW), "strong-economy");
  assert.equal(quotaBandOf(quotaBoth(null, null), FRESH, NOW), "normal");
});

// Live rate limits (0.6.11 T6): the figures Claude Code gives its status line,
// read through `$.session.usage().rateLimits`.
const LATER = new Date(NOW + 60 * 60_000).toISOString();
const EARLIER = new Date(NOW - 60_000).toISOString();

test("quota pressure: a live reading wins over the mirror and says so", () => {
  const live = [
    { kind: "five_hour", percentUsed: 97, resetsAt: LATER },
    { kind: "seven_day", percentUsed: 40, resetsAt: LATER },
  ];
  assert.deepEqual(quotaPressureOf({ live, mirror: quotaBoth(0, 0), mirrorCheckedAt: FRESH, nowMs: NOW }), { band: "strong-economy", source: "live" });
  const calm = [
    { kind: "five_hour", percentUsed: 5, resetsAt: LATER },
    { kind: "seven_day", percentUsed: 10, resetsAt: LATER },
  ];
  assert.deepEqual(quotaPressureOf({ live: calm, mirror: quotaBoth(99, 99), mirrorCheckedAt: FRESH, nowMs: NOW }), { band: "normal", source: "live" });
});

test("quota pressure: no live reading falls back to the mirror, or to none", () => {
  assert.deepEqual(quotaPressureOf({ live: [], mirror: quotaBoth(10, 85), mirrorCheckedAt: FRESH, nowMs: NOW }), { band: "economy", source: "mirror" });
  assert.deepEqual(quotaPressureOf({ live: [], mirror: quotaBoth(10, 85), mirrorCheckedAt: new Date(NOW - 31 * 60_000).toISOString(), nowMs: NOW }), { band: "normal", source: "none" });
  assert.deepEqual(quotaPressureOf({ live: [], mirror: null, mirrorCheckedAt: null, nowMs: NOW }), { band: "normal", source: "none" });
});

test("quota pressure: a live window that already reset is not a reading", () => {
  const live = [{ kind: "five_hour", percentUsed: 99, resetsAt: EARLIER }];
  assert.deepEqual(quotaPressureOf({ live, mirror: quotaBoth(10, 85), mirrorCheckedAt: FRESH, nowMs: NOW }), { band: "economy", source: "mirror" });
});

test("quota pressure: a window without a reset time still counts; other kinds (spend_limit) and junk are ignored", () => {
  assert.deepEqual(quotaPressureOf({ live: [{ kind: "five_hour", percentUsed: 90 }], mirror: null, mirrorCheckedAt: null, nowMs: NOW }), { band: "economy", source: "live" });
  assert.deepEqual(quotaPressureOf({ live: [{ kind: "spend_limit", percentUsed: 150, resetsAt: LATER }], mirror: null, mirrorCheckedAt: null, nowMs: NOW }), { band: "normal", source: "none" });
  assert.deepEqual(quotaPressureOf({ live: [{ kind: "five_hour", percentUsed: Number.NaN }], mirror: null, mirrorCheckedAt: null, nowMs: NOW }), { band: "normal", source: "none" });
});

test("quota pressure: a window the live reading lacks is filled from the fresh mirror", () => {
  const live = [{ kind: "five_hour", percentUsed: 10, resetsAt: LATER }];
  assert.deepEqual(quotaPressureOf({ live, mirror: quotaBoth(0, 96), mirrorCheckedAt: FRESH, nowMs: NOW }), { band: "strong-economy", source: "live+mirror" });
  assert.deepEqual(quotaPressureOf({ live, mirror: quotaBoth(0, 96), mirrorCheckedAt: null, nowMs: NOW }), { band: "normal", source: "live" });
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

/** A previous turn whose one tool call failed: the call, then the user message carrying its error result, as `$.session.messages()` links them. */
function failedTurn(tool: string, input: Readonly<Record<string, unknown>>, text: string): ActivityMessage[] {
  return [
    { role: "user", text: "first", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool, input, text, isError: true }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", isError: true }] },
    { role: "assistant", text: "done", toolUses: [] },
    { role: "user", text: "second", toolUses: [] },
  ];
}

/** F9: the failure is the `previous_turn.failed` fact Jev reads, no longer a guard. */
function raisesPreviousFailure(messages: readonly ActivityMessage[]): boolean {
  const state = buildTierState({ promptText: "go on", activity: summarizePreviousTurn(messages), destinationKind: null, quotaBand: "normal" }) as Record<string, Record<string, unknown> | null>;
  return state.previous_turn?.failed === true;
}

test("previous-failure: a read-only probe that fails (ls of a missing file) raises no guard", () => {
  const messages = failedTurn("Bash", { command: "ls node_modules/.bin/tsc" }, "ls: node_modules/.bin/tsc: No such file or directory");
  assert.equal(summarizePreviousTurn(messages)?.errors, 0);
  assert.equal(raisesPreviousFailure(messages), false);
});

test("previous-failure: a failed test run, a failed Edit and a failed rm still raise it, each counted once", () => {
  const tests = failedTurn("Bash", { command: "npm test" }, "✖ 2 failing");
  const edit = failedTurn("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "String to replace not found in file.");
  const rm = failedTurn("Bash", { command: "rm build/out.js" }, "rm: build/out.js: Permission denied");
  for (const messages of [tests, edit, rm]) {
    assert.equal(summarizePreviousTurn(messages)?.errors, 1);
    assert.equal(raisesPreviousFailure(messages), true);
  }
  assert.equal(summarizePreviousTurn(tests)?.testsFailed, 1, "a failed test run keeps counting as one");
});

test("previous-failure: an error result linked to no tool call still counts", () => {
  const messages: ActivityMessage[] = [
    { role: "user", text: "first", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool: "Bash", input: { command: "ls missing" }, isError: true }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ isError: true }] },
    { role: "user", text: "second", toolUses: [] },
  ];
  assert.equal(summarizePreviousTurn(messages)?.errors, 1);
});

test("previous-failure: which failed calls are read-only probes (their errors do not count)", () => {
  const probes: readonly [string, Readonly<Record<string, unknown>>][] = [
    ["Read", { file_path: "missing.ts" }],
    ["Grep", { pattern: "x" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["LS", { path: "missing" }],
    ["Bash", { command: "ls -la missing 2>/dev/null" }],
    ["Bash", { command: "ls missing 2>&1 | head -5" }],
    ["Bash", { command: "which deno || echo none" }],
    ["Bash", { command: "command -v tsc" }],
    ["Bash", { command: "type deno" }],
    ["Bash", { command: "test -f deno.json && cat deno.json" }],
    ["Bash", { command: "[ -d src ]" }],
    ["Bash", { command: "stat package.json; wc -l src/*.ts; file README.md" }],
    ["Bash", { command: "head -5 a.ts; tail -5 b.ts" }],
    ["Bash", { command: 'grep -rn "a|b && c" src' }],
    ["Bash", { command: "grep a\\|b src" }],
    ["Bash", { command: "rg foo | wc -l" }],
    ["Bash", { command: 'find . -name "*.ts" -newer x' }],
    ["Bash", { command: "pwd\necho $HOME" }],
    ["Bash", { command: "deno --version" }],
    ["Bash", { command: "echo done > /dev/null" }],
    ["Bash", { command: "git status --short" }],
    ["Bash", { command: "git log --oneline -3 && git show HEAD && git diff --stat" }],
    ["Bash", { command: "git rev-parse HEAD; git branch --list 'feat*'" }],
    ["Bash", { command: "git ls-files src; git check-ignore node_modules" }],
    // F10: moving around to look is looking.
    ["Bash", { command: "cd src && ls" }],
  ];
  const notProbes: readonly [string, Readonly<Record<string, unknown>>][] = [
    ["Edit", { file_path: "src/a.ts" }],
    ["Write", { file_path: "src/a.ts" }],
    ["Bash", {}],
    ["Bash", { command: "" }],
    ["Bash", { command: "npm test" }],
    ["Bash", { command: "rm build/out.js" }],
    ["Bash", { command: "deno check src/a.ts" }],
    ["Bash", { command: "ls && rm x" }],
    ["Bash", { command: "ls & rm x" }],
    ["Bash", { command: "ls\nrm x" }],
    ["Bash", { command: "ls | xargs rm" }],
    ["Bash", { command: "cd src && npm run build" }],
    ["Bash", { command: "FOO=1 ls" }],
    ["Bash", { command: "echo x > out.txt" }],
    ["Bash", { command: "cat a >> b" }],
    ["Bash", { command: "echo $(rm x)" }],
    ["Bash", { command: "echo `rm x`" }],
    ["Bash", { command: "cat <(rm x)" }],
    ["Bash", { command: "find . -name '*.tmp' -delete" }],
    ["Bash", { command: "find . -exec rm {} ;" }],
    ["Bash", { command: "find . -execdir rm {} +" }],
    ["Bash", { command: "npx tsc --version" }],
    ["Bash", { command: "git push" }],
    ["Bash", { command: "git branch" }],
    ["Bash", { command: "git branch --list -D old" }],
    ["Bash", { command: "git -C src status" }],
  ];
  for (const [tool, input] of probes) assert.equal(summarizePreviousTurn(failedTurn(tool, input, "error"))?.errors, 0, `${tool} ${JSON.stringify(input)} is a probe`);
  for (const [tool, input] of notProbes) assert.equal(summarizePreviousTurn(failedTurn(tool, input, "error"))?.errors, 1, `${tool} ${JSON.stringify(input)} is not a probe`);
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
  const unsure = stage({ jev: { tier: "complex", confidence: 0.6 }, currentModel: "claude-sonnet-5-5", currentEffort: "medium", configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.6 } });
  assert.equal(unsure.changed, false);
  assert.equal(unsure.reason, "low-confidence");
});

test("stage: under ANY guard, a session running below its own model is restored to at least its own (§6.2)", () => {
  const failed = { toolCalls: 2, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const restore = stage({ jev: { tier: "simple", confidence: 0.6 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, guards: { ...CALM, confidence: 0.6, activity: failed } });
  assert.equal(restore.model, "claude-opus-5-5", "an unsure turn on the weaker model restores at least the session's own");
  assert.equal(restore.effort, "high");
  assert.equal(restore.changed, true);
  assert.equal(restore.reason, "floor-restore");
  assert.equal(restore.guard, "low-confidence", "F9: the failure itself is a fact for Jev, not the guard");
  // The live case: Haiku after a simple start, then an unsure standard turn on a Sonnet session.
  const unsure = stage({ jev: { tier: "standard", confidence: 0.55 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.55 } });
  assert.equal(unsure.model, "claude-sonnet-5-5");
  assert.equal(unsure.effort, "medium");
  assert.equal(unsure.reason, "floor-restore");
  assert.equal(unsure.guard, "low-confidence");
  // A guard with a proposal above the floor goes to the proposal.
  const higher = stage({ jev: { tier: "complex", confidence: 0.5 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: { ...CALM, confidence: 0.5 } });
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
  const decision = stage({ pending: { tier: "simple", turns: 1 }, guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
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
  const decision = stage({ jev: { tier: "simple", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredEffort: "max", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "max");
});

test("finding 7: restoring or upgrading to the session's own base model keeps its [1m] id", () => {
  const restore = stage({ jev: { tier: "simple", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-opus-5-5[1m]", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
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

test("N2 (pinning, F9): decideEngineTurn restores the floor only below it, and only on a hard guard", () => {
  const failed = { toolCalls: 1, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "npm test" };
  const base = { tiers: TIERS, currentModel: "claude-haiku-4-5-20251001", configuredModel: "claude-opus-5-5", configuredEffort: "max" as const, text: "hola" };
  const restore = decideEngineTurn({ ...base, activity: failed, text: "Read /x/brief.md and do what it says" });
  assert.equal(restore?.model, "claude-opus-5-5");
  assert.equal(restore?.effort, "max");
  assert.equal(restore?.guard, "pointer-prompt");
  assert.equal(decideEngineTurn({ ...base, activity: failed }), null, "a failure alone is a fact for Jev's next judgment, not a restore");
  assert.equal(decideEngineTurn({ ...base, text: "now deploy to production", activity: null }), null, "a sensitive word is a hint only");
  assert.equal(decideEngineTurn({ ...base, currentModel: "claude-opus-5-5", activity: failed, text: "Read /x/brief.md and do what it says" }), null, "at the floor already");
});

// ---------------------------------------------------------------------------
// 0.6.2 E1: a tier-driven upgrade uses the tier's effort
// ---------------------------------------------------------------------------

const XHIGH_SESSION = { configuredModel: "claude-opus-5-5", configuredEffort: "xhigh" } as const;

test("E1: an upgrade back to the session's own model uses the tier's effort, not the session's sticky xhigh", () => {
  const decision = stage({ ...XHIGH_SESSION, jev: { tier: "complex", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null });
  assert.equal(decision.reason, "upgrade");
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.effortTarget, "high");
});

test("E1: frontier work on Opus (no Fable) upgrades at xhigh, the frontier tier's own effort", () => {
  const decision = stage({ ...XHIGH_SESSION, jev: { tier: "frontier", confidence: 0.9 }, currentModel: "claude-sonnet-5-5", currentEffort: "medium" });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
});

test("E1: a person's max or numeric effort is never lowered by an upgrade back to their own model", () => {
  for (const configuredEffort of ["max", 32_000] as const) {
    const decision = stage({ jev: { tier: "complex", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredEffort });
    assert.equal(decision.reason, "upgrade");
    assert.equal(decision.effort, configuredEffort);
  }
});

test("E1: a guard-driven floor-restore keeps the person's configured effort exactly", () => {
  const decision = stage({ ...XHIGH_SESSION, jev: { tier: "complex", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.reason, "floor-restore");
  assert.equal(decision.effort, "xhigh");
});

test("E1/E3: a per-tier effort override replaces the default for that tier", () => {
  const decision = stage({ ...XHIGH_SESSION, jev: { tier: "complex", confidence: 0.9 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, tierEffort: { simple: "low", standard: "medium", complex: "xhigh", frontier: "max" } });
  assert.equal(decision.effort, "xhigh");
});

// ---------------------------------------------------------------------------
// 0.6.2 E2: effort recalculated on every person prompt within the same model
// ---------------------------------------------------------------------------

// Opus: cacheWrite $8/M, output $20/M. 80k context → rewrite $0.64, × 1.2 = $0.768.
// 4,000 fewer output tokens/step × $20/M = $0.08 × 12 steps = $0.96: worth it.
const OUTPUTS_WORTH = { xhigh: 6000, high: 2000, medium: 900 } as const;
// 500 fewer × $20/M = $0.01 × 12 = $0.12: not worth it.
const OUTPUTS_THIN = { xhigh: 2000, high: 1500 } as const;
const ON_OPUS_XHIGH = { ...XHIGH_SESSION, currentModel: "claude-opus-5-5", currentEffort: "xhigh" } as const;

test("E2 raise: a higher tier on the same model raises the effort at once with confidence ≥ 0.70", () => {
  const decision = stage({ jev: { tier: "frontier", confidence: 0.8 } });
  assert.equal(decision.reason, "effort-raise");
  assert.equal(decision.changed, true);
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.effortTarget, "xhigh");
  assert.equal(decision.pending, null);
});

test("E2 raise: under 0.70 the effort stays", () => {
  const decision = stage({ jev: { tier: "frontier", confidence: 0.6 }, guards: { ...CALM, confidence: 0.6 } });
  assert.equal(decision.reason, "low-confidence");
  assert.equal(decision.changed, false);
  assert.equal(decision.effort, "high");
});

test("E2 raise: a guard never blocks a raise", () => {
  const decision = stage({ jev: { tier: "frontier", confidence: 0.9 }, guards: { ...CALM, text: "deploy the migration to production" } });
  assert.equal(decision.reason, "effort-raise");
  assert.equal(decision.effort, "xhigh");
});

test("E2 lower: the same lower effort must repeat on 2 consecutive person prompts", () => {
  const first = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_WORTH });
  assert.equal(first.reason, "effort-hysteresis");
  assert.equal(first.changed, false);
  assert.equal(first.effort, "xhigh");
  assert.equal(first.effortTarget, "high");
  assert.deepEqual(first.pending, { tier: "complex", turns: 1, effort: "high" });
  const second = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_WORTH, pending: first.pending });
  assert.equal(second.reason, "effort-lower");
  assert.equal(second.changed, true);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "high");
  assert.equal(second.pending, null);
  assert.ok(second.breakEven !== null && second.breakEven.worthIt);
  assert.ok(Math.abs((second.breakEven?.switchCost ?? 0) - 0.64) < 1e-9);
  assert.ok(Math.abs((second.breakEven?.stepSaving ?? 0) - 0.08) < 1e-9);
});

test("E2 lower: a different lower effort restarts the count", () => {
  const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "standard", confidence: 0.9 }, tiers: resolveAccountTiers({ env: {}, catalog: CATALOG.map((row) => (row.id === "claude-sonnet-5-5" ? { ...row, available: false } : row)), quota: null }), effortOutput: OUTPUTS_WORTH, pending: { tier: "complex", turns: 1, effort: "high" } });
  assert.equal(decision.reason, "effort-hysteresis");
  assert.deepEqual(decision.pending, { tier: "standard", turns: 1, effort: "medium" });
});

test("E2 lower: economy relaxes the count to 1 prompt", () => {
  const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_WORTH, band: "economy" });
  assert.equal(decision.reason, "effort-lower");
  assert.equal(decision.effort, "high");
});

test("E2 lower: a guard holds the effort and drops the count", () => {
  const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_WORTH, pending: { tier: "complex", turns: 1, effort: "high" }, guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.reason, "held-by-guard");
  assert.equal(decision.changed, false);
  assert.equal(decision.pending, null);
});

test("E2 lower: a saving that does not beat the rewrite by 20% keeps the effort", () => {
  const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_THIN, pending: { tier: "complex", turns: 1, effort: "high" } });
  assert.equal(decision.reason, "effort-break-even");
  assert.equal(decision.changed, false);
  assert.equal(decision.breakEven?.worthIt, false);
});

test("E2 lower: no usage yet means no break-even", () => {
  const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput: OUTPUTS_WORTH, pending: { tier: "complex", turns: 1, effort: "high" }, usage: null });
  assert.equal(decision.reason, "effort-break-even");
  assert.equal(decision.changed, false);
});

test("E2 lower: unknown output for either effort means unknown savings, so no lowering", () => {
  for (const effortOutput of [null, undefined, { xhigh: 6000 }, { high: 2000 }]) {
    const decision = stage({ ...ON_OPUS_XHIGH, jev: { tier: "complex", confidence: 0.9 }, effortOutput, pending: { tier: "complex", turns: 1, effort: "high" } });
    assert.equal(decision.reason, "effort-unknown-savings");
    assert.equal(decision.changed, false);
    assert.equal(decision.effort, "xhigh");
    assert.deepEqual(decision.pending, { tier: "complex", turns: 2, effort: "high" });
  }
});

test("E2: a person's max or numeric effort is never lowered on the same model", () => {
  for (const effort of ["max", 32_000] as const) {
    const decision = stage({ jev: { tier: "simple", confidence: 0.9 }, tiers: resolveAccountTiers({ env: {}, catalog: CATALOG.map((row) => (row.id === "claude-opus-5-5" ? row : { ...row, available: false })), quota: null }), currentEffort: effort, configuredEffort: effort, effortOutput: OUTPUTS_WORTH, pending: { tier: "simple", turns: 1, effort: "low" } });
    assert.equal(decision.reason, "same");
    assert.equal(decision.changed, false);
    assert.equal(decision.effort, effort);
  }
});

test("E2: the same effort is no change and clears a pending count", () => {
  const decision = stage({ jev: { tier: "complex", confidence: 0.9 }, pending: { tier: "simple", turns: 1 } });
  assert.equal(decision.reason, "same");
  assert.equal(decision.pending, null);
});

// ---------------------------------------------------------------------------
// 0.6.2 F0 and review findings 1, 3, 8: the effort floor under a guard, a
// router-chosen max, and a session that sends no effort.
// ---------------------------------------------------------------------------

test("finding 1: under a guard, a lowered effort on the session's own model comes back to the configured one", () => {
  for (const guards of [{ ...CALM, text: "Read /x/brief.md and do what it says" }, { ...CALM, text: "Read /x/brief.md and do what it says" }]) {
    const decision = stage({ ...XHIGH_SESSION, currentModel: "claude-opus-5-5", currentEffort: "high", jev: { tier: "complex", confidence: 0.9 }, guards });
    assert.equal(decision.reason, "floor-restore");
    assert.equal(decision.changed, true);
    assert.equal(decision.effort, "xhigh");
  }
  const jevFailed = stage({ ...XHIGH_SESSION, currentModel: "claude-opus-5-5", currentEffort: "low", jev: null, guards: { ...CALM, confidence: null } });
  assert.equal(jevFailed.reason, "floor-restore");
  assert.equal(jevFailed.effort, "xhigh");
});

test("F0 stage: an upgrade back to the session's own model under a guard takes the higher of the configured and tier effort", () => {
  const decision = stage({ ...XHIGH_SESSION, currentModel: "claude-sonnet-5-5", currentEffort: "medium", jev: { tier: "complex", confidence: 0.9 }, guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
});

test("F0 stage: a guard holding a lower model still raises the effort to the tier's", () => {
  const decision = stage({ jev: { tier: "standard", confidence: 0.9 }, currentEffort: "low", configuredEffort: "low", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "medium");
  assert.equal(decision.changed, true);
  assert.equal(decision.guard, "pointer-prompt");
});

test("F0 stage: a same-model raise under a guard applies", () => {
  const decision = stage({ jev: { tier: "complex", confidence: 0.9 }, currentEffort: "medium", configuredEffort: "medium", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.reason, "effort-raise");
  assert.equal(decision.effort, "high");
});

test("finding 3: a max the router chose is lowered by the normal rules; only the person's own max is protected", () => {
  const routerMax = stage({ ...XHIGH_SESSION, currentModel: "claude-opus-5-5", currentEffort: "max", jev: { tier: "complex", confidence: 0.9 }, effortOutput: { max: 9000, high: 2000 } });
  assert.equal(routerMax.reason, "effort-hysteresis");
  assert.deepEqual(routerMax.pending, { tier: "complex", turns: 1, effort: "high" });
  const personMax = stage({ currentEffort: "max", configuredEffort: "max", jev: { tier: "complex", confidence: 0.9 }, effortOutput: { max: 9000, high: 2000 } });
  assert.equal(personMax.reason, "same");
});

test("nit 8: a session that sends no effort can still be raised (none is the API default, not a person's choice)", () => {
  const decision = stage({ currentEffort: null, configuredEffort: null, jev: { tier: "frontier", confidence: 0.95 } });
  assert.equal(decision.reason, "effort-raise");
  assert.equal(decision.effort, "xhigh");
});

// 0.6.2 F9: a failing previous turn is a fact Jev weighs, not a veto.
test("F9 stage: a failing previous turn plus a confident simple judgment now downgrades", () => {
  const failed = { toolCalls: 2, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "" };
  const decision = stage({ jev: { tier: "simple", confidence: 0.95 }, pending: { tier: "simple", turns: 1 }, guards: { ...CALM, activity: failed } });
  assert.equal(decision.reason, "downgrade");
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
});

test("F9/F11 engine turn: a failed test no longer restores the floor by itself; a pointer prompt does", () => {
  const failed = { toolCalls: 2, filesEdited: 0, testsRun: 1, testsFailed: 1, errors: 0, mentions: "deploy" };
  const base = { tiers: TIERS, currentModel: "claude-haiku-4-5-20251001", configuredModel: "claude-opus-5-5", configuredEffort: "xhigh" as const, activity: failed };
  assert.equal(decideEngineTurn({ ...base, text: "run the tests and deploy" }), null);
  const pointer = decideEngineTurn({ ...base, text: "Read /x/brief.md and do what it says" });
  assert.equal(pointer?.reason, "floor-restore");
  assert.equal(pointer?.guard, "pointer-prompt");
  assert.equal(pointer?.model, "claude-opus-5-5");
});

test("F10: a failed cd is looking around, not the work failing; deno check and tsc still count", () => {
  assert.equal(raisesPreviousFailure(failedTurn("Bash", { command: "cd /missing/dir" }, "cd: no such file or directory: /missing/dir")), false);
  assert.equal(raisesPreviousFailure(failedTurn("Bash", { command: "cd app && ls" }, "cd: no such file or directory: app")), false);
  assert.equal(raisesPreviousFailure(failedTurn("Bash", { command: "deno check src/main.ts" }, "error: TS2322")), true);
  assert.equal(raisesPreviousFailure(failedTurn("Bash", { command: "tsc -p ." }, "error TS2322")), true);
  assert.equal(raisesPreviousFailure(failedTurn("Bash", { command: "cd app && npm run build" }, "build failed")), true, "a cd followed by real work is the work");
});

// ---------------------------------------------------------------------------
// Context-window floor: never a model whose window the context would overflow
// ---------------------------------------------------------------------------

const BIG_CONTEXT = { contextTokens: 300_000, avgOutput: 700, medianStepsPerTurn: 40 };

test("context floor: with 300K of context a simple turn never goes to Haiku (200K); it goes to the next tier that fits", () => {
  const decision = stage({ jev: { tier: "simple", confidence: 0.95 }, usage: BIG_CONTEXT, pending: { tier: "standard", turns: 5 } });
  assert.notEqual(decision.model, "claude-haiku-4-5-20251001");
  assert.notEqual(decision.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision.proposed, "claude-sonnet-5-5");
  assert.equal(decision.guard, "context-window");
});

test("context floor: the 10% margin counts -- 185K does not fit a 200K window", () => {
  const decision = stage({ jev: { tier: "simple", confidence: 0.95 }, usage: { ...BIG_CONTEXT, contextTokens: 185_000 } });
  assert.equal(decision.proposed, "claude-sonnet-5-5");
  assert.equal(decision.guard, "context-window");
  const fits = stage({ jev: { tier: "simple", confidence: 0.95 }, usage: { ...BIG_CONTEXT, contextTokens: 180_000 } });
  assert.equal(fits.proposed, "claude-haiku-4-5-20251001");
  assert.notEqual(fits.guard, "context-window");
});

test("context floor: a session already on a model too small for its context moves up, whatever Jev's confidence", () => {
  const decision = stage({ jev: { tier: "simple", confidence: 0.4 }, currentModel: "claude-haiku-4-5-20251001", currentEffort: null, configuredModel: "claude-haiku-4-5-20251001", configuredEffort: null, usage: BIG_CONTEXT });
  assert.equal(decision.model, "claude-sonnet-5-5");
  assert.equal(decision.changed, true);
  assert.equal(decision.guard, "context-window");
});

test("context floor: when no tier fits, the current model is held and the guard is named", () => {
  const decision = stage({ jev: { tier: "simple", confidence: 0.95 }, usage: { ...BIG_CONTEXT, contextTokens: 950_000 } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-guard");
  assert.equal(decision.guard, "context-window");
});

test("context floor: an unknown window (a gateway) or an unknown context applies no floor", () => {
  const gateway = stage({ tiers: GATEWAY, jev: { tier: "simple", confidence: 0.95 }, currentModel: "big", configuredModel: "big", usage: BIG_CONTEXT });
  assert.notEqual(gateway.guard, "context-window");
  const unknown = stage({ jev: { tier: "simple", confidence: 0.95 }, usage: null });
  assert.equal(unknown.proposed, "claude-haiku-4-5-20251001");
});
