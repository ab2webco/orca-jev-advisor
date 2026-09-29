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
  entry("claude-sonnet-5-5", 3, true),
  entry("claude-haiku-4-5-20251001", 4, true),
];
const TIERS = resolveAccountTiers({ env: {}, catalog: CATALOG, quota: null });
const GATEWAY_TIERS = resolveAccountTiers({
  env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" },
  catalog: CATALOG,
  quota: null,
});

const CALM: GuardContext = { text: "hello there", activity: null, confidence: 0.9 };

// ---------------------------------------------------------------------------
// T3 guards (§6.2)
// ---------------------------------------------------------------------------

test("guards: none hold on a calm turn", () => {
  assert.deepEqual(activeGuards(CALM), []);
});

test("guard (F11): a client-site destination is a fact for Jev, not a guard", () => {
  assert.deepEqual(activeGuards({ ...CALM, destinationKind: "client-site" } as GuardContext), []);
});

test("guard (F11): a requires_human / prohibits policy match is the gate's, not the router's", () => {
  assert.deepEqual(activeGuards({ ...CALM, policyHit: true } as GuardContext), []);
});

test("guard: the sensitive-topic word list, in English and Spanish, whole words, accent- and case-insensitive", () => {
  for (const text of ["check the SECURITY headers", "rotate the credentials", "cut a release", "deploy it", "run the migration", "on production", "revisa la seguridad", "despliegue a producción", "la migración", "cambia la contraseña"]) {
    assert.equal(mentionsSensitiveTopic(text), true, text);
  }
  for (const text of ["hello", "redeployable is not a word here", "productive day", "summarise this file"]) {
    assert.equal(mentionsSensitiveTopic(text), false, text);
  }
  assert.ok(SENSITIVE_WORDS.length >= 6);
  assert.deepEqual(activeGuards({ ...CALM, text: "deploy to production" }), [], "F9: a hint, not a guard");
});

test("topic flags: the activity's own text counts as the turn mentioning it (F9: a hint, not a guard)", () => {
  const activity = { toolCalls: 2, filesEdited: 1, testsRun: 0, testsFailed: 0, errors: 0, mentions: "edited db/migration/001.sql" };
  assert.deepEqual(activeGuards({ ...CALM, activity }), []);
  assert.deepEqual((buildTierState({ promptText: "go on", activity, destinationKind: null, quotaBand: "normal" }) as Record<string, unknown>).topic_flags, ["migration"]);
});

test("previous turn failed: a tool error or a failing test is a fact in Jev's state (F9), not a guard", () => {
  const base = { toolCalls: 3, filesEdited: 0, testsRun: 1, testsFailed: 0, errors: 0, mentions: "" };
  const failed = (activity: typeof base): unknown => ((buildTierState({ promptText: "go on", activity, destinationKind: null, quotaBand: "normal" }) as Record<string, Record<string, unknown>>).previous_turn ?? {}).failed;
  assert.equal(failed(base), false);
  assert.equal(failed({ ...base, errors: 1 }), true);
  assert.equal(failed({ ...base, testsFailed: 2 }), true);
  assert.deepEqual(activeGuards({ ...CALM, activity: { ...base, errors: 1 } }), []);
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
  assert.deepEqual(state.previous_turn, { tool_calls: 4, files_edited: 2, tests_run: 1, tests_failed: 1, errors: 0, failed: true });
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
  assert.equal(decision.model, "claude-sonnet-5-5");
  assert.equal(decision.effort, "medium");
});

test("start: any guard holds the session's configured model (and effort) instead of going below it", () => {
  for (const guards of [{ ...CALM, text: "Read /x/brief.md and do what it says" }, { ...CALM, confidence: 0.5 }, { ...CALM, text: "Read /x/brief.md and do what it says" }, { ...CALM, text: "Read /x/brief.md and do what it says" }]) {
    const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: guards.confidence ?? 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards });
    assert.equal(decision.model, "claude-opus-5-5");
    assert.equal(decision.effort, "high");
    assert.equal(decision.changed, false);
    assert.equal(decision.reason, "held-by-guard");
    assert.notEqual(decision.guard, null);
  }
});

test("start: upgrading is always allowed, guards or not", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: { ...CALM, text: "security review" } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, true);
});

test("start: a configured model the account's tiers do not include is never gone below under a guard", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-sonnet-4-5", configuredEffort: "medium", guards: { ...CALM, text: "Read /x/brief.md and do what it says" } });
  assert.equal(decision.model, "claude-sonnet-4-5");
  assert.equal(decision.changed, false);
});

test("start: frontier collapses to complex where they resolve to the same model; the effort stays the frontier's (0.6.2 E1)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "frontier", confidence: 0.9 }, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: CALM });
  assert.equal(decision.tier, "complex");
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
});

test("start: same model and effort as configured is no change", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: CALM });
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
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "start", decision, applied: true, quotaBand: "normal", project: null });
  assert.deepEqual(Object.keys(record).sort(), ["account", "applied", "at", "confidence", "contextTokens", "current", "effort", "expectedSteps", "guard", "origin", "point", "project", "proposed", "quotaBand", "quotaSource", "reason", "stepSaving", "switchCost", "tier"].sort());
  assert.equal(record.proposed, "claude-haiku-4-5-20251001");
  assert.equal(record.contextTokens, null);
  assert.equal(record.origin, null, "no origin given -- defaults to null");
  assert.equal(record.effort, null, "no effort given -- defaults to null");
  assert.equal(record.project, null, "no project given -- defaults to null");
  assert.equal(record.quotaSource, null, "no quota source given -- defaults to null");
  assert.equal(JSON.stringify(record).includes("prompt words"), false);
});

test("decision log record: project is carried through verbatim (JEVADV-63)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "start", decision, applied: true, quotaBand: "normal", project: "orca-supervisor" });
  assert.equal(record.project, "orca-supervisor");
});

test("decision log record: quotaSource says which reading fed the band (0.6.11 T6)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "start", decision, applied: true, quotaBand: "economy", quotaSource: "live" });
  assert.equal(record.quotaSource, "live");
});

test("decision log record: origin is the PromptOrigin kind, never the notification's text (JEV-061)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "stage", decision, applied: false, quotaBand: "normal", origin: "task-notification" });
  assert.equal(record.origin, "task-notification");
});

test("decision log record: effort is the subagent's own target effort, when the router set one (JEV-061 slice 2)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  const record = routerDecisionRecord({ at: "2026-09-26T14:05:00.000Z", account: "acct", point: "subagent", decision, applied: true, quotaBand: "normal", effort: "medium" });
  assert.equal(record.effort, "medium");
});

test("start: quota pressure never shifts the first prompt's tier -- there is no previous turn to show it was read-only (G4)", () => {
  for (const band of ["economy", "strong-economy"] as const) {
    const decision = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM, band });
    assert.equal(decision.model, "claude-sonnet-5-5");
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

// ---------------------------------------------------------------------------
// 0.6.2 E1/E3 at session start: the tier's effort, the person's per-tier map
// ---------------------------------------------------------------------------

test("start: frontier work on Opus (no Fable) starts at the frontier's xhigh", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "frontier", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
});

test("start: a per-tier effort override replaces the default", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: CALM, tierEffort: { simple: "low", standard: "medium", complex: "xhigh", frontier: "xhigh" } });
  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.changed, true);
});

// ---------------------------------------------------------------------------
// 0.6.2 E6: a short prompt that only points to a document to read and act on
// says nothing about the work; Jev would judge the pointer ("simple").
// ---------------------------------------------------------------------------

import { isPointerPrompt } from "./model_router_decide.ts";

test("pointer-prompt: short read-and-act pointers, English and Spanish", () => {
  for (const text of [
    "Read /home/me/jobs/74914c09/tmp/brief-062-effort.md completely and do what it says.",
    "Read /home/dev/Library/Application\\ Support/orca/jobs/tmp/brief.md completely and do what it says.",
    "read ./docs/task.md and do what it says",
    "follow the instructions in ~/notes/plan.txt",
    "Follow docs/brief.md",
    "lee el archivo /tmp/brief.md y haz lo que dice",
    "Lee ~/tareas/brief.md completo y haz lo que pide.",
    "sigue las instrucciones de ./PLAN.md",
    "/tmp/brief-062.md",
    "  `~/jobs/brief.md`  ",
  ]) assert.equal(isPointerPrompt(text), true, text);
});

test("pointer-prompt: work that names a file, long prompts and plain questions are not pointers", () => {
  for (const text of [
    "arregla el bug en src/a.ts",
    "fix the failing test in ./src/parser.test.ts",
    "add a --json flag to the export command",
    "lee el README y resúmelo",
    "what does /usr/bin/env do?",
    "hola",
    `Read /tmp/brief.md and do what it says. ${"Also consider the cache layer and the retry policy in depth. ".repeat(8)}`,
  ]) assert.equal(isPointerPrompt(text), false, text);
});

test("pointer-prompt is a guard: point A keeps the configured model and effort, and logs the guard", () => {
  const text = "Read /tmp/brief-062.md completely and do what it says.";
  assert.deepEqual(activeGuards({ ...CALM, text }), ["pointer-prompt"]);
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "xhigh", guards: { ...CALM, text } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.changed, false);
  assert.equal(decision.guard, "pointer-prompt");
});

test("pointer-prompt never blocks an upgrade", () => {
  const text = "Read /tmp/brief-062.md completely and do what it says.";
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-sonnet-5-5", configuredEffort: "medium", guards: { ...CALM, text } });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.changed, true);
});

test("pointer-prompt is the guard named first: Jev's low confidence on a pointer is a symptom of it", () => {
  const text = "Read /tmp/brief-062.md completely and do what it says.";
  assert.deepEqual(activeGuards({ ...CALM, text, confidence: 0.69 }), ["pointer-prompt", "low-confidence"]);
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.69 }, configuredModel: "claude-opus-5-5", configuredEffort: "xhigh", guards: { ...CALM, text, confidence: 0.69 } });
  assert.equal(decision.guard, "pointer-prompt");
});

// ---------------------------------------------------------------------------
// 0.6.2 F0 (found live): a guard may block lowering the model or the effort,
// never raising the effort. Seen: a review on Opus, Jev complex (high), the
// sensitive-topic guard held, and the session stayed at medium.
// ---------------------------------------------------------------------------

const CLIENT_SITE: GuardContext = { ...CALM, text: "Read /x/brief.md and do what it says" };

test("F0 start: under a guard, a same-model effort raise still applies (max of configured and tier)", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "medium", guards: CLIENT_SITE });
  assert.equal(decision.model, "claude-opus-5-5");
  assert.equal(decision.effort, "high");
  assert.equal(decision.changed, true);
  assert.equal(decision.guard, "pointer-prompt");
});

test("F0 start: under a guard, a held model keeps the higher of its own effort and the tier's", () => {
  const higher = decideStart({ tiers: TIERS, jev: { tier: "complex", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "xhigh", guards: CLIENT_SITE });
  assert.equal(higher.effort, "xhigh");
  assert.equal(higher.changed, false);
  assert.equal(higher.reason, "held-by-guard");
  const downHeld = decideStart({ tiers: TIERS, jev: { tier: "standard", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "low", guards: CLIENT_SITE });
  assert.equal(downHeld.model, "claude-opus-5-5", "the model is not lowered");
  assert.equal(downHeld.effort, "medium", "the effort is still raised to the tier's");
  for (const configuredEffort of ["max", 32_000] as const) {
    const own = decideStart({ tiers: TIERS, jev: { tier: "frontier", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort, guards: CLIENT_SITE });
    assert.equal(own.effort, configuredEffort);
  }
});

// Review finding 4: real pointer phrasings that slipped through, and the
// known over-matches kept on purpose (they only keep the configured model).
test("finding 4: more pointer phrasings are caught", () => {
  for (const text of [
    "haz lo que dice /x/brief.md",
    "Do what /x/brief.md says",
    "Read /x/brief.md and implement it",
    "Implementa lo que pide docs/plan.md",
    "Lee /x/brief.md y ejecútalo",
    "Lee /x/brief.md y cúmplelo",
    "Read the brief at /x/brief.md and carry it out",
    "read BRIEF.MD and do it",
    '"/home/a/Application Support/b/brief.md"',
    "aplica lo que dice ./plan.txt",
    // Jev cannot see the plan, so this is a pointer too (it used to be a hooks
    // test's "standard" example before the extension match ignored case).
    "implement the plan in PLAN.md",
  ]) assert.equal(isPointerPrompt(text), true, text);
});

test("finding 4: accepted over-matches (they only keep the configured model; widening further is a choice)", () => {
  for (const text of [
    "Follow the TDD rules and fix the bug in /src/a.ts",
    "execute npm test in ./app",
    "read ./src/a.ts and fix the null check the instructions mention",
  ]) assert.equal(isPointerPrompt(text), true, text);
  assert.equal(isPointerPrompt("arregla el bug en src/a.ts"), false);
});

// ---------------------------------------------------------------------------
// 0.6.2 F9 (owner decision): Jev decides. previous-failure and
// sensitive-topic are facts Jev weighs, not vetoes; the hard guards are
// low-confidence (and a Jev failure) and a pointer prompt (F11 removed the
// client-site and scoped-policy guards).
// ---------------------------------------------------------------------------


const FAILED_TURN = { toolCalls: 3, filesEdited: 1, testsRun: 1, testsFailed: 1, errors: 0, mentions: "npm test" };

test("F9: a failing previous turn and a sensitive word are not guards any more", () => {
  assert.deepEqual(activeGuards({ ...CALM, text: "deploy the migration to production", activity: FAILED_TURN }), []);
});

test("F9: the remaining hard guards still hold", () => {
  assert.deepEqual(activeGuards({ ...CALM, text: "Read /x/brief.md and do what it says" }), ["pointer-prompt"]);
  assert.deepEqual(activeGuards({ ...CALM, confidence: 0.6 }), ["low-confidence"]);
  assert.deepEqual(activeGuards({ ...CALM, confidence: null }), ["low-confidence"]);
  assert.deepEqual(activeGuards({ ...CALM, text: "Read /x/brief.md and do what it says" }), ["pointer-prompt"]);
});

test("F9: a sensitive word is only a hint -- a confident simple judgment starts on Haiku", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: { ...CALM, text: "what does the deploy script print?" } });
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
  assert.equal(decision.guard, null);
});

test("F9: Jev's state carries the facts: previous_turn.failed and topic_flags (hints, capped, no prompt words beyond the list)", () => {
  const state = buildTierState({ promptText: "deploy the migration to production with the new API key", activity: FAILED_TURN, destinationKind: null, quotaBand: "normal" }) as Record<string, unknown>;
  assert.deepEqual((state.previous_turn as Record<string, unknown>).failed, true);
  assert.deepEqual(state.topic_flags, ["credentials", "deploy", "migration", "production"]);
  const clean = buildTierState({ promptText: "rename userId", activity: { ...FAILED_TURN, testsFailed: 0, mentions: "" }, destinationKind: null, quotaBand: "normal" }) as Record<string, unknown>;
  assert.equal((clean.previous_turn as Record<string, unknown>).failed, false);
  assert.deepEqual(clean.topic_flags, []);
});

test("F9: the tier question tells Jev to weigh both facts", () => {
  const instructions = (buildTierQuestions().tier as { instructions: string }).instructions;
  assert.match(instructions, /previous_turn\.failed/);
  assert.match(instructions, /stronger model/);
  assert.match(instructions, /topic_flags/);
  assert.match(instructions, /hints?, not rules/);
});

// ---------------------------------------------------------------------------
// 0.6.2 F11 (owner decision, overrides G6): client protection belongs to the
// Bash gate, not the router. A client site or a scoped policy is no guard;
// the destination kind stays a fact in Jev's state.
// ---------------------------------------------------------------------------

test("F11: a client site or a scoped policy is not a router guard", () => {
  assert.deepEqual(activeGuards({ ...CALM, destinationKind: "client-site", policyHit: true } as GuardContext), []);
});

test("F11: a trivial prompt in a client project is routed down", () => {
  const decision = decideStart({ tiers: TIERS, jev: { tier: "simple", confidence: 0.9 }, configuredModel: "claude-opus-5-5", configuredEffort: "high", guards: { ...CALM, destinationKind: "client-site", policyHit: true } as GuardContext });
  assert.equal(decision.model, "claude-haiku-4-5-20251001");
  assert.equal(decision.guard, null);
  const state = buildTierState({ promptText: "hola", activity: null, destinationKind: "client-site", quotaBand: "normal" }) as Record<string, unknown>;
  assert.equal(state.destination_kind, "client-site", "still a fact Jev reads");
});
