import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import type { ScoreAnswer } from "./jev.ts";
import {
  DEFAULT_MODEL_REWRITE_CONFIDENCE,
  MODEL_QUESTION_KEY,
  MODEL_STATE_PROMPT_CHARS,
  COMPLEXITY_QUESTION_KEY,
  buildModelQuestion,
  buildModelQuestions,
  buildModelState,
  complexityTaskText,
  interpretComplexityAnswer,
  permissionModeAllowsRewrite,
  buildUpdatedAgentInput,
  decideModelRewrite,
  interpretModelAnswer,
  parseAgentToolInput,
  resolveRequestedEntry,
} from "./model_decisions.ts";

function entry(overrides: Partial<ModelEntry> & { id: string; rank: number | null; agentModel: string }): ModelEntry {
  return {
    provider: "anthropic",
    label: overrides.id,
    source: "https://example.test/doc",
    available: true,
    ...overrides,
  };
}

// Largest first, exactly like model_catalog.ts's availableLadder.
const ladder: readonly ModelEntry[] = [
  entry({ id: "claude-opus-5-5", rank: 1, agentModel: "opus", label: "Claude Opus 5.5", summary: "For long-running agentic coding" }),
  entry({ id: "claude-sonnet-5", rank: 2, agentModel: "sonnet", label: "Claude Sonnet 5", summary: "The best combination of speed and intelligence" }),
  entry({ id: "claude-haiku-4-5", rank: 3, agentModel: "haiku", label: "Claude Haiku 4.5" }),
];

function scoreAnswer(score: number, confidence = 0.9): ScoreAnswer {
  return { type: "score", score, legend: {}, probabilities: {}, confidence };
}

// ---------------------------------------------------------------------------
// parseAgentToolInput
// ---------------------------------------------------------------------------

test("parseAgentToolInput reads a well-formed Agent tool_input", () => {
  // subagent_type is snake_case in the real Agent tool schema, unlike every
  // other field this parser reads -- see the module comment.
  const raw = { prompt: "Find every caller of foo()", description: "map callers", subagent_type: "Explore", model: "sonnet" };
  const parsed = parseAgentToolInput(raw);
  assert.ok(parsed !== null);
  assert.equal(parsed?.prompt, "Find every caller of foo()");
  assert.equal(parsed?.description, "map callers");
  assert.equal(parsed?.subagentType, "Explore");
  assert.equal(parsed?.model, "sonnet");
  assert.deepEqual(parsed?.raw, raw);
});

test("parseAgentToolInput reads subagent_type, not a camelCase subagentType", () => {
  const parsed = parseAgentToolInput({ prompt: "task", subagentType: "Explore" });
  assert.equal(parsed?.subagentType, null);
});

test("parseAgentToolInput requires a non-empty string prompt", () => {
  assert.equal(parseAgentToolInput({ prompt: "" }), null);
  assert.equal(parseAgentToolInput({ prompt: "   " }), null);
  assert.equal(parseAgentToolInput({}), null);
  assert.equal(parseAgentToolInput({ prompt: 42 }), null);
  assert.equal(parseAgentToolInput(null), null);
  assert.equal(parseAgentToolInput("a prompt"), null);
  assert.equal(parseAgentToolInput([]), null);
});

test("parseAgentToolInput reads absent, non-string, or empty-string optional fields as null", () => {
  const parsed = parseAgentToolInput({ prompt: "do the thing", description: "", subagent_type: 7, model: undefined });
  assert.ok(parsed !== null);
  assert.equal(parsed?.description, null);
  assert.equal(parsed?.subagentType, null);
  assert.equal(parsed?.model, null);
});

test("parseAgentToolInput keeps the original raw object untouched, including unknown fields", () => {
  const raw = { prompt: "task", extraField: 123, nested: { a: 1 } };
  const parsed = parseAgentToolInput(raw);
  assert.deepEqual(parsed?.raw, raw);
  assert.equal(parsed?.raw, raw);
});

// ---------------------------------------------------------------------------
// buildModelQuestion
// ---------------------------------------------------------------------------

test("buildModelQuestion returns null for an empty ladder", () => {
  assert.equal(buildModelQuestion([]), null);
});

test("buildModelQuestion orders criteria smallest first, opposite of the ladder's largest-first order", () => {
  const question = buildModelQuestion(ladder);
  assert.ok(question !== null);
  assert.equal(question?.type, "score");
  assert.deepEqual(question?.criteria, [
    "Claude Haiku 4.5",
    "Claude Sonnet 5: The best combination of speed and intelligence",
    "Claude Opus 5.5: For long-running agentic coding",
  ]);
});

test("buildModelQuestion omits the colon and summary when an entry has none", () => {
  const question = buildModelQuestion([entry({ id: "x", rank: 1, agentModel: "x", label: "Model X" })]);
  assert.deepEqual(question?.criteria, ["Model X"]);
});

test("buildModelQuestion instructions mention no numbers and describe smallest-first ordering", () => {
  const question = buildModelQuestion(ladder);
  assert.ok(question !== null);
  assert.doesNotMatch(question?.instructions ?? "", /\d/);
  assert.match(question?.instructions ?? "", /smallest/i);
});

test("MODEL_QUESTION_KEY is a stable key", () => {
  assert.equal(MODEL_QUESTION_KEY, "model_tier");
});

// ---------------------------------------------------------------------------
// buildModelState
// ---------------------------------------------------------------------------

test("buildModelState shapes task, requestedModel and smallest-first levels", () => {
  const input = parseAgentToolInput({ prompt: "Refactor the auth module", description: "auth cleanup", subagent_type: "general-purpose", model: "opus" });
  assert.ok(input !== null);
  const state = buildModelState(input as NonNullable<typeof input>, ladder);
  assert.deepEqual(state, {
    task: {
      description: "auth cleanup",
      subagentType: "general-purpose",
      prompt: "Refactor the auth module",
      promptTruncated: false,
    },
    requestedModel: "opus",
    levels: [
      { level: 0, label: "Claude Haiku 4.5", summary: null },
      { level: 1, label: "Claude Sonnet 5", summary: "The best combination of speed and intelligence" },
      { level: 2, label: "Claude Opus 5.5", summary: "For long-running agentic coding" },
    ],
  });
});

test("buildModelState caps the prompt at MODEL_STATE_PROMPT_CHARS and flags the truncation", () => {
  const longPrompt = "x".repeat(MODEL_STATE_PROMPT_CHARS + 500);
  const input = parseAgentToolInput({ prompt: longPrompt });
  assert.ok(input !== null);
  const state = buildModelState(input as NonNullable<typeof input>, ladder) as { task: { prompt: string; promptTruncated: boolean } };
  assert.equal(state.task.prompt.length, MODEL_STATE_PROMPT_CHARS);
  assert.equal(state.task.promptTruncated, true);
});

test("buildModelState does not flag truncation for a prompt exactly at the cap", () => {
  const prompt = "y".repeat(MODEL_STATE_PROMPT_CHARS);
  const input = parseAgentToolInput({ prompt });
  assert.ok(input !== null);
  const state = buildModelState(input as NonNullable<typeof input>, ladder) as { task: { prompt: string; promptTruncated: boolean } };
  assert.equal(state.task.prompt.length, MODEL_STATE_PROMPT_CHARS);
  assert.equal(state.task.promptTruncated, false);
});

// ---------------------------------------------------------------------------
// interpretModelAnswer
// ---------------------------------------------------------------------------

test("interpretModelAnswer is null when the answer is undefined, not a score, or the ladder is empty", () => {
  assert.equal(interpretModelAnswer(undefined, ladder), null);
  assert.equal(interpretModelAnswer({ type: "choice", choice: "x", probabilities: {}, confidence: 0.9 }, ladder), null);
  assert.equal(interpretModelAnswer(scoreAnswer(1), []), null);
});

test("interpretModelAnswer is null when the score is not finite", () => {
  assert.equal(interpretModelAnswer(scoreAnswer(Number.NaN), ladder), null);
  assert.equal(interpretModelAnswer(scoreAnswer(Number.POSITIVE_INFINITY), ladder), null);
});

test("interpretModelAnswer rounds the score to the nearest level, smallest-first, and clamps to range", () => {
  assert.equal(interpretModelAnswer(scoreAnswer(0), ladder)?.entry.id, "claude-haiku-4-5");
  assert.equal(interpretModelAnswer(scoreAnswer(0.4), ladder)?.entry.id, "claude-haiku-4-5");
  assert.equal(interpretModelAnswer(scoreAnswer(1.0), ladder)?.entry.id, "claude-sonnet-5");
  assert.equal(interpretModelAnswer(scoreAnswer(2.0), ladder)?.entry.id, "claude-opus-5-5");
  assert.equal(interpretModelAnswer(scoreAnswer(-5), ladder)?.entry.id, "claude-haiku-4-5");
  assert.equal(interpretModelAnswer(scoreAnswer(50), ladder)?.entry.id, "claude-opus-5-5");
});

test("interpretModelAnswer carries the raw score, rounded level and confidence through", () => {
  const rec = interpretModelAnswer(scoreAnswer(1.7, 0.83), ladder);
  assert.ok(rec !== null);
  assert.equal(rec?.level, 2);
  assert.equal(rec?.score, 1.7);
  assert.equal(rec?.confidence, 0.83);
  assert.equal(rec?.entry.id, "claude-opus-5-5");
});

// ---------------------------------------------------------------------------
// resolveRequestedEntry
// ---------------------------------------------------------------------------

test("resolveRequestedEntry matches agentModel first, then id, and is null for no match or a null request", () => {
  const catalog = [...ladder].reverse();
  assert.equal(resolveRequestedEntry(null, catalog), null);
  assert.equal(resolveRequestedEntry("does-not-exist", catalog), null);
  assert.equal(resolveRequestedEntry("opus", catalog)?.id, "claude-opus-5-5");
  assert.equal(resolveRequestedEntry("claude-sonnet-5", catalog)?.id, "claude-sonnet-5");
});

test("resolveRequestedEntry prefers an agentModel match when id and agentModel collide across rows", () => {
  const collidingCatalog = [
    entry({ id: "sonnet", rank: 1, agentModel: "not-sonnet" }),
    entry({ id: "claude-sonnet-5", rank: 2, agentModel: "sonnet" }),
  ];
  assert.equal(resolveRequestedEntry("sonnet", collidingCatalog)?.id, "claude-sonnet-5");
});

// ---------------------------------------------------------------------------
// decideModelRewrite
// ---------------------------------------------------------------------------

function recommendationFor(entryRow: ModelEntry, score = 1, confidence = 0.9) {
  return { entry: entryRow, level: 1, score, confidence };
}

test("decideModelRewrite never rewrites in measurement mode", () => {
  const decision = decideModelRewrite({
    mode: "measurement",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.99),
    requestedModel: "haiku",
    minConfidence: DEFAULT_MODEL_REWRITE_CONFIDENCE,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(decision, { rewrite: false, reason: "measurement" });
});

test("decideModelRewrite refuses when not ready, even in active mode with high confidence", () => {
  const decision = decideModelRewrite({
    mode: "active",
    ready: false,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.99),
    requestedModel: "haiku",
    minConfidence: DEFAULT_MODEL_REWRITE_CONFIDENCE,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(decision, { rewrite: false, reason: "not-ready" });
});

test("decideModelRewrite refuses below the confidence threshold, but exactly-at-threshold is enough", () => {
  const below = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.69),
    requestedModel: "haiku",
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(below, { rewrite: false, reason: "low-confidence" });

  const atThreshold = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.7),
    requestedModel: "haiku",
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(atThreshold, { rewrite: true, reason: "rewrite" });
});

test("decideModelRewrite refuses when the requested model is already the recommended one, by agentModel or id", () => {
  const byAgentModel = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.9),
    requestedModel: "sonnet",
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(byAgentModel, { rewrite: false, reason: "same-model" });

  const byId = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.9),
    requestedModel: "claude-sonnet-5",
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(byId, { rewrite: false, reason: "same-model" });
});

test("decideModelRewrite rewrites when nothing was requested -- Jev decides independently", () => {
  const decision = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[1] as ModelEntry, 1, 0.9),
    requestedModel: null,
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(decision, { rewrite: true, reason: "rewrite" });
});

test("decideModelRewrite rewrites when everything clears and the model actually differs", () => {
  const decision = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[2] as ModelEntry, 2, 0.95),
    requestedModel: "opus",
    minConfidence: 0.7,
    permissionAllowsRewrite: true,
  });
  assert.deepEqual(decision, { rewrite: true, reason: "rewrite" });
});

// ---------------------------------------------------------------------------
// buildUpdatedAgentInput
// ---------------------------------------------------------------------------

test("buildUpdatedAgentInput echoes every original field, including unknown ones, and overrides model", () => {
  const raw = { prompt: "task", description: "d", subagent_type: "Explore", model: "haiku", weirdExtraField: { nested: true } };
  const updated = buildUpdatedAgentInput(raw, "opus");
  assert.deepEqual(updated, { prompt: "task", description: "d", subagent_type: "Explore", model: "opus", weirdExtraField: { nested: true } });
});

test("buildUpdatedAgentInput does not mutate the original raw object", () => {
  const raw = { prompt: "task", model: "haiku" };
  const frozen = Object.freeze({ ...raw });
  const updated = buildUpdatedAgentInput(frozen, "opus");
  assert.deepEqual(frozen, { prompt: "task", model: "haiku" });
  assert.equal(updated.model, "opus");
});

// ---------------------------------------------------------------------------
// Permission mode: an active rewrite returns permissionDecision "allow"
// ---------------------------------------------------------------------------

test("permissionModeAllowsRewrite only trusts modes that would have allowed the Agent call anyway", () => {
  assert.equal(permissionModeAllowsRewrite("bypassPermissions"), true);
  assert.equal(permissionModeAllowsRewrite("acceptEdits"), false, "acceptEdits covers edits, not subagent spawns");
  assert.equal(permissionModeAllowsRewrite("auto"), false, "auto reviews a subagent task with its classifier first");
  assert.equal(permissionModeAllowsRewrite("dontAsk"), false);
  assert.equal(permissionModeAllowsRewrite("default"), false);
  assert.equal(permissionModeAllowsRewrite("plan"), false);
  assert.equal(permissionModeAllowsRewrite(null), false);
  assert.equal(permissionModeAllowsRewrite("somethingNew"), false);
});

test("decideModelRewrite measures only when the permission mode could have asked or denied", () => {
  const decision = decideModelRewrite({
    mode: "active",
    ready: true,
    recommendation: recommendationFor(ladder[0] as ModelEntry, 2, 0.99),
    requestedModel: "haiku",
    minConfidence: 0.7,
    permissionAllowsRewrite: false,
  });
  assert.deepEqual(decision, { rewrite: false, reason: "permission-mode" });
});

test("decideModelRewrite checks readiness before the permission mode", () => {
  const decision = decideModelRewrite({
    mode: "active",
    ready: false,
    recommendation: recommendationFor(ladder[0] as ModelEntry, 2, 0.99),
    requestedModel: "haiku",
    minConfidence: 0.7,
    permissionAllowsRewrite: false,
  });
  assert.equal(decision.reason, "not-ready");
});

// ---------------------------------------------------------------------------
// The complexity tier, recorded next to the ladder question (measurement only)
// ---------------------------------------------------------------------------

test("buildModelQuestions asks the ladder question and the complexity tier in one request", () => {
  const input = parseAgentToolInput({ prompt: "Refactor the parser", description: "refactor parser" });
  assert.ok(input !== null);
  const questions = buildModelQuestions(ladder, input);
  assert.ok(questions !== null);
  assert.deepEqual(Object.keys(questions).sort(), [COMPLEXITY_QUESTION_KEY, MODEL_QUESTION_KEY].sort());
  assert.equal(questions[MODEL_QUESTION_KEY]?.type, "score");
  assert.equal(questions[COMPLEXITY_QUESTION_KEY]?.type, "score");
});

test("buildModelQuestions is null for an empty ladder: nothing to choose from", () => {
  const input = parseAgentToolInput({ prompt: "task" });
  assert.ok(input !== null);
  assert.equal(buildModelQuestions([], input), null);
});

test("complexityTaskText prefers the description and falls back to the capped prompt", () => {
  const withDescription = parseAgentToolInput({ prompt: "long prompt", description: "short summary" });
  const withoutDescription = parseAgentToolInput({ prompt: "x".repeat(MODEL_STATE_PROMPT_CHARS + 5) });
  assert.ok(withDescription !== null && withoutDescription !== null);
  assert.equal(complexityTaskText(withDescription), "short summary");
  assert.equal(complexityTaskText(withoutDescription).length, MODEL_STATE_PROMPT_CHARS);
});

test("interpretComplexityAnswer reads the tier from scoreComplexity and never decides anything", () => {
  const reading = interpretComplexityAnswer({ [COMPLEXITY_QUESTION_KEY]: { type: "score", score: 2.2, legend: { "2": "Advanced" }, probabilities: {}, confidence: 0.8 } });
  assert.deepEqual(reading, { tier: "advanced", tierIndex: 2, score: 2.2 });
  assert.equal(interpretComplexityAnswer({}), null);
});
