import assert from "node:assert/strict";
import test from "node:test";

import type { Answer } from "./jev.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import {
  CONFIDENCE_FLOOR,
  PROMPT_CHARS,
  SENSITIVE_WORDS,
  TIER_EFFORT,
  activeGuards,
  buildTierQuestions,
  buildTierState,
  decideStart,
  interpretTier,
  mentionsSensitiveTopic,
  routerDecisionFileName,
  routerDecisionRecord,
  toRouterEffort,
} from "./model_router_decide.ts";
import type { GuardContext } from "./model_router_decide.ts";

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
const GATEWAY_TIERS = resolveAccountTiers({
  env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" },
  catalog: CATALOG,
  quota: null,
});

const CALM: GuardContext = { destinationKind: null, policyHit: false, text: "hello there", activity: null, confidence: 0.9 };

// ---------------------------------------------------------------------------
// T3 guards (§6.2)
// ---------------------------------------------------------------------------

test("guards: none hold on a calm turn", () => {
  assert.deepEqual(activeGuards(CALM), []);
});

test("guard: a client-site destination", () => {
  assert.deepEqual(activeGuards({ ...CALM, destinationKind: "client-site" }), ["client-site"]);
  assert.deepEqual(activeGuards({ ...CALM, destinationKind: "service" }), []);
});

test("guard: a requires_human / prohibits policy match", () => {
  assert.deepEqual(activeGuards({ ...CALM, policyHit: true }), ["policy"]);
});

test("guard: the sensitive-topic word list, in English and Spanish, whole words, accent- and case-insensitive", () => {
  for (const text of ["check the SECURITY headers", "rotate the credentials", "cut a release", "deploy it", "run the migration", "on production", "revisa la seguridad", "despliegue a producción", "la migración", "cambia la contraseña"]) {
    assert.equal(mentionsSensitiveTopic(text), true, text);
  }
  for (const text of ["hello", "redeployable is not a word here", "productive day", "summarise this file"]) {
    assert.equal(mentionsSensitiveTopic(text), false, text);
  }
  assert.ok(SENSITIVE_WORDS.length >= 6);
  assert.deepEqual(activeGuards({ ...CALM, text: "deploy to production" }), ["sensitive-topic"]);
});

test("guard: the activity's own text counts as the turn mentioning it", () => {
  const activity = { toolCalls: 2, filesEdited: 1, testsRun: 0, testsFailed: 0, errors: 0, mentions: "edited db/migration/001.sql" };
  assert.deepEqual(activeGuards({ ...CALM, activity }), ["sensitive-topic"]);
});

test("guard: the previous turn had a tool error or a failing test", () => {
  const base = { toolCalls: 3, filesEdited: 0, testsRun: 1, testsFailed: 0, errors: 0, mentions: "" };
  assert.deepEqual(activeGuards({ ...CALM, activity: base }), []);
  assert.deepEqual(activeGuards({ ...CALM, activity: { ...base, errors: 1 } }), ["previous-failure"]);
  assert.deepEqual(activeGuards({ ...CALM, activity: { ...base, testsFailed: 2 } }), ["previous-failure"]);
});

test("guard: Jev's confidence below 0.70 (unknown confidence counts as low)", () => {
  assert.equal(CONFIDENCE_FLOOR, 0.7);
  assert.deepEqual(activeGuards({ ...CALM, confidence: 0.69 }), ["low-confidence"]);
  assert.deepEqual(activeGuards({ ...CALM, confidence: 0.7 }), []);
  assert.deepEqual(activeGuards({ ...CALM, confidence: null }), ["low-confidence"]);
});

// ---------------------------------------------------------------------------
// T2 Jev tier question (§6.1)
// ---------------------------------------------------------------------------

test("tier state: the prompt is redacted with redactSecretsForJev, then cut to the first 2,000 chars", () => {
  const secret = "sk-ant-api03-" + "A".repeat(40);
  const state = buildTierState({ promptText: `use ANTHROPIC_API_KEY=${secret} and ${"x".repeat(3000)}`, activity: null, destinationKind: null, quotaBand: "normal" }) as Record<string, unknown>;
  const prompt = state.prompt as string;
  assert.equal(prompt.includes(secret), false);
  assert.ok(prompt.includes("[REDACTED]"));
  assert.equal(PROMPT_CHARS, 2000);
  assert.equal(prompt.length, 2000);
});

test("tier state: carries the previous turn's activity, the destination kind and the quota band", () => {
  const activity = { toolCalls: 4, filesEdited: 2, testsRun: 1, testsFailed: 1, errors: 0, mentions: "src/a.ts" };
  const state = buildTierState({ promptText: "fix it", activity, destinationKind: "service", quotaBand: "economy" }) as Record<string, unknown>;
  assert.deepEqual(state.previous_turn, { tool_calls: 4, files_edited: 2, tests_run: 1, tests_failed: 1, errors: 0 });
  assert.equal(state.destination_kind, "service");
  assert.equal(state.quota_pressure, "economy");
  const bare = buildTierState({ promptText: "hi", activity: null, destinationKind: null, quotaBand: "normal" }) as Record<string, unknown>;
  assert.equal(bare.previous_turn, null);
  assert.equal(bare.destination_kind, "unknown");
});

test("tier question: one Choice question over exactly the four tiers", () => {
  const questions = buildTierQuestions();
  const ids = Object.keys(questions);
  assert.deepEqual(ids, ["tier"]);
  const question = questions.tier;
  assert.ok(question !== undefined && question.type === "choice");
  if (question.type === "choice") assert.deepEqual(Object.keys(question.criteria), ["simple", "standard", "complex", "frontier"]);
});

test("tier answer: a tier plus confidence; anything else is a failure (null), never a guess", () => {
  const ok: Record<string, Answer> = { tier: { type: "choice", choice: "complex", probabilities: { complex: 0.8 }, confidence: 0.82 } };
  assert.deepEqual(interpretTier(ok), { tier: "complex", confidence: 0.82 });
  assert.equal(interpretTier({}), null);
  assert.equal(interpretTier({ tier: { type: "choice", choice: "huge", probabilities: {}, confidence: 0.9 } }), null);
  assert.equal(interpretTier({ tier: { type: "noul", noul: 1 } }), null);
});

// ---------------------------------------------------------------------------
// Session start (§6.3), guards applied after Jev
// ---------------------------------------------------------------------------

test("tier effort: low, medium, high, xhigh", () => {
  assert.deepEqual(TIER_EFFORT, { simple: "low", standard: "medium", complex: "high", frontier: "xhigh" });
});

test("start: Jev failure changes nothing", () => {
  const decision = decideStart({ tiers: TIERS, jev: null, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: { ...CALM, confidence: null } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "jev-failed");
  assert.equal(decision.tier, null);
});

test("start: a simple prompt on an Opus session moves to Haiku, with no effort (Haiku has none)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
  assert.equal(decision.effort, null);
  assert.equal(decision.changed, true);
  assert.equal(decision.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision.current, "claude-opus-5-5");
  assert.equal(decision.guard, null);
});

test("start: a standard prompt picks Sonnet at medium effort", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  assert.equal(decision.model, "claude-sonnet-5");
  assert.equal(decision.effort, "medium");
});

test("start: any guard holds the session's configured model (and effort) instead of going below it", () => {
  for (const guards of [{ ...CALM, text: "deploy to production" }, { ...CALM, confidence: 0.5 }, { ...CALM, destinationKind: "client-site" as const }, { ...CALM, policyHit: true }]) {
    const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: guards.confidence ?? 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards });
    assert.equal(decision.model, "claude-opus-5-5");
    assert.equal(decision.effort, "high");
    assert.equal(decision.changed, false);
    assert.equal(decision.reason, "held-by-guard");
    assert.notEqual(decision.guard, null);
  }
});

test("start: upgrading is always allowed, guards or not", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: { ...CALM, text: "security review" } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, true);
});

test("start: a configured model the account's tiers do not include is never gone below under a guard", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-sonnet-4-5", configuredEffort: "medium", guards: { ...CALM, text: "deploy" } });
  assert.equal(decision.model, "claude-sonnet-4-5");
  assert.equal(decision.changed, false);
});

test("start: frontier collapses to complex where they resolve to the same model", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "frontier", confidence: 0.9 }, configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: CALM });
  assert.equal(decision.tier, "complex");
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
});

test("start: same model and effort as configured is no change", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-sonnet-5", configuredEffort: "medium", guards: CALM });
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "same");
});

test("start: a gateway gets its own ids, with no effort", () => {
  const decision = decideStart({ tiers: GATEWAY_TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "glm-5.3", configuredEffort: null, guards: CALM });
  assert.equal(decision.model, "glm-4.5-air");
  assert.equal(decision.effort, null);
});

// ---------------------------------------------------------------------------
// The decision log (§7)
// ---------------------------------------------------------------------------

test("toRouterEffort: only the four named levels; max, numbers and absence are none", () => {
  assert.equal(toRouterEffort("medium"), "medium");
  assert.equal(toRouterEffort("xhigh"), "xhigh");
  assert.equal(toRouterEffort("max"), null);
  assert.equal(toRouterEffort(12000), null);
  assert.equal(toRouterEffort(undefined), null);
});

test("decision log: hourly file name, like turn-usage", () => {
  assert.equal(routerDecisionFileName("2026-09-26T14:05:00.000Z"), "model-router-decisions-2026-09-26T14.jsonl");
});

test("decision log record: exactly the spec's fields, no prompt text", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: { ...CALM, text: "secret prompt words" } });
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "start", decision, applied: true, quotaBand: "normal" });
  assert.deepEqual(Object.keys(record).sort(), ["account", "applied", "at", "confidence", "contextTokens", "current", "expectedSteps", "guard", "point", "proposed", "quotaBand", "reason", "stepSaving", "switchCost", "tier"].sort());
  assert.equal(record.proposed, "claude-haiku-4-5-20251001");
  assert.equal(record.contextTokens, null);
  assert.equal(JSON.stringify(record).includes("prompt words"), false);
});

test("start: quota pressure never shifts the first prompt's tier -- there is no previous turn to show it was read-only (G4)", () => {
  for (const band of ["economy", "strong-economy"] as const) {
    const decision = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM, band });
    assert.equal(decision.model, "claude-sonnet-5");
    assert.equal(decision.tier, "standard");
  }
});

// ---------------------------------------------------------------------------
// Review round 2: findings 2 and 7
// ---------------------------------------------------------------------------

test("finding 2: under a guard, a same-rank proposal keeps the session's own effort too", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.4 }, configuredModel: "claude-opus-5-5", configuredEffort: "xhigh", guards: { ...CALM, confidence: 0.4 } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "held-by-guard");
});

test("finding 2: a session at max effort is never lowered, guard or not", () => {
  const guarded = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "max", guards: { ...CALM, text: "release the deploy" } });
  assert.equal(guarded.effort, "max");
  assert.equal(guarded.changed, false);
  const calm = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: 32000, guards: CALM });
  assert.equal(calm.effort, 32000);
  assert.equal(calm.changed, false);
});

test("finding 7: a [1m] session keeps its exact model id when Jev picks its own tier", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5[1m]", configuredEffort: "high", guards: CALM });
  assert.equal(decision.model, "claude-opus-5-5[1m]");
  assert.equal(decision.changed, false);
  const effortOnly = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5[1m]", configuredEffort: "low", guards: CALM });
  assert.equal(effortOnly.model, "claude-opus-5-5[1m]");
  assert.equal(effortOnly.effort, "high");
});

test("tier question (round 2): each tier's definition carries short real developer examples in Spanish and English", () => {
  const question = buildTierQuestions().tier;
  assert.ok(question !== undefined && question.type === "choice");
  if (question.type !== "choice") return;
  const spanish = /[áéíóúñ]|\b(arregla|revisa|diseña|corre|lee|agrega|añade|prueba|cambia|renombra)\b/i;
  for (const tier of ["simple", "standard", "complex", "frontier"]) {
    const criterion = question.criteria[tier] ?? "";
    const examples = criterion.match(/"[^"]+"/g) ?? [];
    assert.ok(examples.length >= 3, `${tier}: at least three quoted examples`);
    assert.ok(examples.some((example) => spanish.test(example)), `${tier}: a Spanish example`);
    assert.ok(examples.some((example) => !spanish.test(example)), `${tier}: an English example`);
    assert.ok(examples.every((example) => example.length <= 60), `${tier}: examples are short, like real prompts`);
  }
  assert.match(question.instructions, /short|corto/i, "the instructions say real prompts are short");
});
