import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STEWARD_THRESHOLD,
  buildStewardQuestions,
  buildStewardState,
  collectStewardFacts,
  SETTLED_LIMIT_TOKENS,
  decideSteward,
  settledBoundary,
  settledInstructions,
  formatContextTokens,
  interpretSteward,
  parseStewardMode,
  parseStewardThreshold,
  stewardClearHint,
  stewardDecisionFileName,
  stewardDecisionRecord,
  stewardGate,
  stewardInstructions,
  stewardStatusPart,
  softTierFires,
  stewardTier,
  summarizeStewardActivity,
} from "./context_steward.ts";
import type { StewardGateInput } from "./context_steward.ts";
import type { ActivityMessage } from "./model_router_stage.ts";

// 0.6.15 T4: the gate reads the session's MAIN model window (`mainWindow`), not the current model's percentage.
const ABOVE: StewardGateInput = { mode: "active", isSubagent: false, contextTokens: 150_000, mainWindow: 1_000_000, threshold: DEFAULT_STEWARD_THRESHOLD, turnsSinceCompaction: null };

// ---------------------------------------------------------------------------
// The gate: whether Jev is asked at all
// ---------------------------------------------------------------------------

test("gate: above the threshold on the main conversation asks Jev", () => {
  assert.deepEqual(stewardGate(ABOVE), { ask: true, hardLimit: false, softLimit: false, settledLimit: false });
});

test("gate: measure mode asks too (it logs what it would do)", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, mode: "measure" }), { ask: true, hardLimit: false, softLimit: false, settledLimit: false });
});

test("gate: below the threshold asks nothing", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 119_999 }), { ask: false, reason: "below-threshold" });
});

test("gate: exactly at the threshold asks", () => {
  assert.equal(stewardGate({ ...ABOVE, contextTokens: DEFAULT_STEWARD_THRESHOLD }).ask, true);
});

test("gate: off mode and a subagent never ask", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, mode: "off" }), { ask: false, reason: "off" });
  assert.deepEqual(stewardGate({ ...ABOVE, isSubagent: true }), { ask: false, reason: "subagent" });
});

test("gate: no usage reading asks nothing", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: null }), { ask: false, reason: "no-usage" });
});

test("gate: 80% of the window is the hard limit, even under the threshold", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, threshold: 900_000, contextTokens: 160_000, mainWindow: 200_000 }), { ask: true, hardLimit: true, softLimit: false, settledLimit: false });
});

test("gate: never twice within 3 person turns, the hard limit included", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, turnsSinceCompaction: 2 }), { ask: false, reason: "cooldown" });
  assert.deepEqual(stewardGate({ ...ABOVE, turnsSinceCompaction: 0, contextTokens: 950_000 }), { ask: false, reason: "cooldown" });
  assert.equal(stewardGate({ ...ABOVE, turnsSinceCompaction: 3 }).ask, true);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("decision: a confident boundary compacts, no /clear hint", () => {
  assert.deepEqual(decideSteward({ jev: { verdict: "boundary", confidence: 0.82 }, hardLimit: false }), { decision: "boundary", compact: true, suggestClear: false, confidence: 0.82 });
});

test("decision: a confident new topic compacts and suggests /clear", () => {
  assert.deepEqual(decideSteward({ jev: { verdict: "new-topic", confidence: 0.7 }, hardLimit: false }), { decision: "new-topic", compact: true, suggestClear: true, confidence: 0.7 });
});

test("decision: mid-task does nothing", () => {
  assert.deepEqual(decideSteward({ jev: { verdict: "mid-task", confidence: 0.95 }, hardLimit: false }), { decision: "mid-task", compact: false, suggestClear: false, confidence: 0.95 });
});

test("decision: a boundary under 0.70 does nothing", () => {
  assert.deepEqual(decideSteward({ jev: { verdict: "boundary", confidence: 0.69 }, hardLimit: false }), { decision: "low-confidence", compact: false, suggestClear: false, confidence: 0.69 });
});

test("decision: a Jev failure does nothing", () => {
  assert.deepEqual(decideSteward({ jev: null, hardLimit: false }), { decision: "jev-failed", compact: false, suggestClear: false, confidence: null });
});

test("decision: the hard limit compacts on mid-task, low confidence and a Jev failure", () => {
  assert.deepEqual(decideSteward({ jev: { verdict: "mid-task", confidence: 0.9 }, hardLimit: true }), { decision: "hard-limit", compact: true, suggestClear: false, confidence: 0.9 });
  assert.deepEqual(decideSteward({ jev: { verdict: "boundary", confidence: 0.4 }, hardLimit: true }), { decision: "hard-limit", compact: true, suggestClear: false, confidence: 0.4 });
  assert.deepEqual(decideSteward({ jev: null, hardLimit: true }), { decision: "hard-limit", compact: true, suggestClear: false, confidence: null });
});

test("decision: at the hard limit a confident boundary is still named a boundary", () => {
  assert.equal(decideSteward({ jev: { verdict: "boundary", confidence: 0.9 }, hardLimit: true }).decision, "boundary");
});

// ---------------------------------------------------------------------------
// The Jev question and state
// ---------------------------------------------------------------------------

function bash(command: string, text = "", id = "t1"): ActivityMessage["toolUses"][number] {
  return { tool_use_id: id, tool: "Bash", input: { command }, text };
}

const PROMPT = (text: string): ActivityMessage => ({ role: "user", text, toolUses: [] });

test("question: one choice with the three verdicts", () => {
  const questions = buildStewardQuestions();
  assert.deepEqual(Object.keys(questions), ["verdict"]);
  const verdict = questions.verdict;
  assert.ok(verdict !== undefined && verdict.type === "choice");
  assert.deepEqual(Object.keys(verdict.criteria), ["boundary", "mid-task", "new-topic"]);
});

test("interpret: a known verdict with its confidence; anything else is a failure", () => {
  assert.deepEqual(interpretSteward({ verdict: { type: "choice", choice: "boundary", probabilities: {}, confidence: 0.8 } }), { verdict: "boundary", confidence: 0.8 });
  assert.equal(interpretSteward({ verdict: { type: "choice", choice: "maybe", probabilities: {}, confidence: 0.8 } }), null);
  assert.equal(interpretSteward({}), null);
});

test("activity: counts the turn's tools and reads commit, push, PR and test outcome", () => {
  const messages: ActivityMessage[] = [
    PROMPT("earlier"),
    { role: "assistant", text: "", toolUses: [bash("npm test", "ℹ pass 12\nℹ fail 0", "a")] },
    PROMPT("fix it and commit"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "b", tool: "Edit", input: { file_path: "src/a.ts" } }] },
    { role: "assistant", text: "", toolUses: [bash("npm test", "ℹ pass 13\nℹ fail 0", "c")] },
    { role: "assistant", text: "", toolUses: [bash("git commit -m 'fix: a'", "[feat-x 1a2b3c4] fix: a", "d")] },
    { role: "assistant", text: "", toolUses: [bash("git push -u origin feat-x", "", "e")] },
    { role: "assistant", text: "", toolUses: [bash("gh pr create --fill", "https://github.com/acme/repo/pull/42", "f")] },
  ];
  assert.deepEqual(summarizeStewardActivity(messages), { toolCalls: 5, filesEdited: 1, testsRun: 1, testsPassed: true, committed: true, pushed: true, openedPr: true });
});

test("activity: a failing test reads as not passed; no test reads as unknown", () => {
  const failing: ActivityMessage[] = [PROMPT("go"), { role: "assistant", text: "", toolUses: [bash("npm test", "ℹ fail 2", "a")] }];
  assert.equal(summarizeStewardActivity(failing).testsPassed, false);
  const none: ActivityMessage[] = [PROMPT("go"), { role: "assistant", text: "ok", toolUses: [] }];
  assert.deepEqual(summarizeStewardActivity(none), { toolCalls: 0, filesEdited: 0, testsRun: 0, testsPassed: null, committed: false, pushed: false, openedPr: false });
});

test("state: the two last prompts redacted and capped, the activity, the size and the turns; no file contents", () => {
  const secret = "sk-ant-api03-" + "a".repeat(40);
  const state = buildStewardState({
    lastPrompt: `commit this with key ${secret} ${"x".repeat(2000)}`,
    previousPrompt: "earlier topic",
    activity: { toolCalls: 3, filesEdited: 1, testsRun: 1, testsPassed: true, committed: true, pushed: false, openedPr: false },
    contextTokens: 150_000,
    turnsSinceCompaction: null,
  }) as Record<string, unknown>;
  const last = state.last_prompt as string;
  assert.ok(!last.includes(secret), "the secret is redacted");
  assert.ok(last.length <= 600);
  assert.equal(state.previous_prompt, "earlier topic");
  assert.deepEqual(state.turn, { tool_calls: 3, files_edited: 1, tests_run: 1, tests_passed: true, committed: true, pushed: false, opened_pr: false });
  assert.equal(state.context_tokens, 150_000);
  assert.equal(state.person_turns_since_compaction, null);
  assert.deepEqual(Object.keys(state).sort(), ["context_tokens", "last_prompt", "person_turns_since_compaction", "previous_prompt", "turn"]);
});

// ---------------------------------------------------------------------------
// What the compaction keeps
// ---------------------------------------------------------------------------

test("facts: feature documents, branches, commits and PR numbers seen in the conversation", () => {
  const messages: ActivityMessage[] = [
    PROMPT("follow odd/tasks/feature-a.md"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "a", tool: "Read", input: { file_path: "/home/dev/repo/odd/tasks/feature-b.md" } }] },
    { role: "assistant", text: "", toolUses: [bash("git checkout -b feat-x", "Switched to a new branch 'feat-x'", "b")] },
    { role: "assistant", text: "", toolUses: [bash("git commit -m 'feat: one'", "[feat-x 1a2b3c4] feat: one\n 1 file changed", "c")] },
    { role: "assistant", text: "", toolUses: [bash("gh pr create --fill", "https://github.com/acme/repo/pull/42\n", "d")] },
  ];
  assert.deepEqual(collectStewardFacts(messages), {
    featureDocs: ["odd/tasks/feature-a.md", "odd/tasks/feature-b.md"],
    branches: ["feat-x"],
    commits: ["1a2b3c4 feat: one (feat-x)"],
    prs: ["#42"],
  });
});

test("instructions: keep the feature documents' open items and next step, branches, commits, PRs, decisions, constraints and pending work", () => {
  const text = stewardInstructions({ featureDocs: ["odd/tasks/feature-a.md"], branches: ["feat-x"], commits: ["1a2b3c4 feat: one (feat-x)"], prs: ["#42"] });
  for (const needle of ["odd/tasks/feature-a.md", "open checklist items", "next step", "feat-x", "1a2b3c4 feat: one (feat-x)", "#42", "decisions", "constraints", "pending"]) {
    assert.ok(text.includes(needle), `instructions mention ${needle}`);
  }
});

test("instructions: with no facts seen, still ask for them by kind", () => {
  const text = stewardInstructions({ featureDocs: [], branches: [], commits: [], prs: [] });
  for (const needle of ["odd/tasks/", "branch", "commits", "pull request", "pending"]) assert.ok(text.includes(needle), `instructions mention ${needle}`);
});

// ---------------------------------------------------------------------------
// Settings, record, status line
// ---------------------------------------------------------------------------

test("mode: measure by default; only the three modes parse", () => {
  assert.equal(parseStewardMode(undefined), "measure");
  assert.equal(parseStewardMode("active"), "active");
  assert.equal(parseStewardMode("off"), "off");
  assert.equal(parseStewardMode("on"), "measure");
});

test("threshold: 120k by default; a whole number of tokens between 10k and 2M", () => {
  assert.equal(parseStewardThreshold(undefined), 120_000);
  assert.equal(parseStewardThreshold(30_000), 30_000);
  assert.equal(parseStewardThreshold(9_999), 120_000);
  assert.equal(parseStewardThreshold(2_000_001), 120_000);
  assert.equal(parseStewardThreshold(30_000.5), 120_000);
  assert.equal(parseStewardThreshold("30000"), 120_000);
});

test("record: hourly file, the brief's fields and no prompt text", () => {
  assert.equal(stewardDecisionFileName("2026-09-28T14:05:00.000Z"), "context-steward-decisions-2026-09-28T14.jsonl");
  // 0.6.15 T4: the record also carries Jev's verdict, the session, the turn, the main window, the current model and the tier.
  const record = stewardDecisionRecord({ at: "2026-09-28T14:05:00.000Z", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: { decision: "boundary", compact: true, suggestClear: false, confidence: 0.8 }, applied: true, contextAfter: 30_000, notApplied: null, verdict: "boundary", sessionId: "s-1", turnIndex: 7, mainWindow: 1_000_000, currentModel: "claude-opus-5-5", wouldFire: null });
  assert.deepEqual(record, { at: "2026-09-28T14:05:00.000Z", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: "boundary", confidence: 0.8, compact: true, applied: true, contextAfter: 30_000, notApplied: null, verdict: "boundary", sessionId: "s-1", turnIndex: 7, mainWindow: 1_000_000, currentModel: "claude-opus-5-5", tier: "boundary", wouldFire: null });
});

test("tokens read as k", () => {
  assert.equal(formatContextTokens(312_400), "312k");
  assert.equal(formatContextTokens(38_000), "38k");
  assert.equal(formatContextTokens(900), "900");
});

test("status: applied reads before → after and why; measure says it only measures", () => {
  assert.equal(stewardStatusPart("es", { mode: "active", decision: "boundary", applied: true, before: 312_000, after: 38_000 }), "contexto 312k → 38k (tarea cerrada)");
  assert.equal(stewardStatusPart("es", { mode: "active", decision: "new-topic", applied: true, before: 312_000, after: null }), "contexto 312k → compactado (tema nuevo)");
  assert.equal(stewardStatusPart("es", { mode: "measure", decision: "boundary", applied: false, before: 312_000, after: null }), "contexto 312k → compactaría (tarea cerrada · solo mide)");
  assert.equal(stewardStatusPart("en", { mode: "active", decision: "hard-limit", applied: true, before: 170_000, after: 40_000 }), "context 170k → 40k (context limit)");
  assert.equal(stewardStatusPart("en", { mode: "measure", decision: "new-topic", applied: false, before: 170_000, after: null }), "context 170k → would compact (new topic · measuring only)");
});

test("status: nothing to say when nothing was or would be compacted", () => {
  assert.equal(stewardStatusPart("es", { mode: "active", decision: "mid-task", applied: false, before: 150_000, after: null }), null);
  assert.equal(stewardStatusPart("es", { mode: "active", decision: "boundary", applied: false, before: 150_000, after: null }), null);
});

test("clear hint, both locales", () => {
  assert.equal(stewardClearHint("es"), "tarea cerrada: /clear libera todo el contexto");
  assert.equal(stewardClearHint("en"), "task closed: /clear frees the whole context");
});

// ---------------------------------------------------------------------------
// The board's summary
// ---------------------------------------------------------------------------

import { STEWARD_DECISIONS_FILE_PATTERN, summarizeStewardDecisions } from "./context_steward.ts";

// freedPerStep is what one later step of a compacted session no longer
// re-reads: the AVERAGE over applied compactions (120k and 160k here), never
// their sum -- a sum across sessions is not something any one step saves.
test("summary: compactions applied, the ones measure mode would have made, and the average context freed per later step", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  const row = (at: string, extra: Record<string, unknown>): Record<string, unknown> => ({ at, account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: "boundary", confidence: 0.9, compact: true, applied: true, contextAfter: 30_000, ...extra });
  const rows: unknown[] = [
    row("2026-09-28T11:00:00.000Z", {}),
    row("2026-09-28T10:00:00.000Z", { contextBefore: 200_000, contextAfter: 40_000 }),
    row("2026-09-28T09:00:00.000Z", { applied: false, contextAfter: null }),
    row("2026-09-28T08:00:00.000Z", { mode: "measure", applied: false, contextAfter: null }),
    row("2026-09-28T07:00:00.000Z", { decision: "mid-task", compact: false, applied: false, contextAfter: null }),
    row("2026-09-26T07:00:00.000Z", {}),
    "not a row",
    { at: "garbage" },
  ];
  assert.deepEqual(summarizeStewardDecisions(rows, now, 24 * 3600_000), { decisions: 5, applied: 2, wouldCompact: 1, freedPerStep: 140_000 });
});

test("summary: nothing applied reads freed as unknown, not zero", () => {
  assert.deepEqual(summarizeStewardDecisions([], Date.now(), 3600_000), { decisions: 0, applied: 0, wouldCompact: 0, freedPerStep: null });
});

test("file pattern: the hourly steward logs only", () => {
  assert.equal(STEWARD_DECISIONS_FILE_PATTERN.exec("context-steward-decisions-2026-09-28T14.jsonl")?.[1], "2026-09-28T14");
  assert.equal(STEWARD_DECISIONS_FILE_PATTERN.exec("model-router-decisions-2026-09-28T14.jsonl"), null);
});

// ---------------------------------------------------------------------------
// 0.6.15 T4 (JEVADV-87, odd/research/steward-1m.md): two tiers for 1M windows.
// ---------------------------------------------------------------------------

test("gate: the hard limit is 80% of the session's MAIN window, capped at 600k", () => {
  assert.equal((stewardGate({ ...ABOVE, contextTokens: 600_000 }) as { hardLimit: boolean }).hardLimit, true);
  assert.equal((stewardGate({ ...ABOVE, contextTokens: 599_999 }) as { hardLimit: boolean }).hardLimit, false);
  // The measured defect: a router drop to a 200k model in a 1M session compacted at 160-230k.
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 180_000, mainWindow: 1_000_000 }), { ask: true, hardLimit: false, softLimit: false, settledLimit: false });
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 160_000, mainWindow: 200_000 }), { ask: true, hardLimit: true, softLimit: false, settledLimit: false });
  assert.deepEqual(stewardGate({ ...ABOVE, threshold: 900_000, contextTokens: 500_000, mainWindow: null }), { ask: false, reason: "below-threshold" });
});

test("gate: the soft tier runs from 400k up to the hard limit, only where the window is larger", () => {
  assert.deepEqual(stewardGate({ ...ABOVE, threshold: 900_000, contextTokens: 400_000 }), { ask: true, hardLimit: false, softLimit: true, settledLimit: true });
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 399_999 }), { ask: true, hardLimit: false, softLimit: false, settledLimit: true });
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 700_000 }), { ask: true, hardLimit: true, softLimit: false, settledLimit: false });
});

test("soft tier: fires unless Jev says mid-task with confidence at least 0.8", () => {
  assert.equal(softTierFires({ jev: { verdict: "mid-task", confidence: 0.8 }, softLimit: true }), false);
  assert.equal(softTierFires({ jev: { verdict: "mid-task", confidence: 0.79 }, softLimit: true }), true);
  assert.equal(softTierFires({ jev: { verdict: "boundary", confidence: 0.5 }, softLimit: true }), true);
  assert.equal(softTierFires({ jev: null, softLimit: true }), true);
  assert.equal(softTierFires({ jev: { verdict: "mid-task", confidence: 0.2 }, softLimit: false }), false);
});

test("decision: the soft tier compacts only when switched on; measure-only leaves the decision as it was", () => {
  const midTask = { verdict: "mid-task" as const, confidence: 0.7 };
  assert.deepEqual(decideSteward({ jev: midTask, hardLimit: false, softLimit: true, softActive: true }), { decision: "soft-limit", compact: true, suggestClear: false, confidence: 0.7 });
  assert.deepEqual(decideSteward({ jev: midTask, hardLimit: false, softLimit: true, softActive: false }), { decision: "mid-task", compact: false, suggestClear: false, confidence: 0.7 });
  assert.deepEqual(decideSteward({ jev: { verdict: "mid-task", confidence: 0.9 }, hardLimit: false, softLimit: true, softActive: true }), { decision: "mid-task", compact: false, suggestClear: false, confidence: 0.9 });
  assert.equal(decideSteward({ jev: { verdict: "boundary", confidence: 0.9 }, hardLimit: false, softLimit: true, softActive: true }).decision, "boundary");
});

test("tier: the one that fired, named as the research names it", () => {
  assert.equal(stewardTier("boundary"), "boundary");
  assert.equal(stewardTier("new-topic"), "new-topic");
  assert.equal(stewardTier("soft-limit"), "soft-400k");
  assert.equal(stewardTier("hard-limit"), "hard-600k");
  assert.equal(stewardTier("mid-task"), null);
  assert.equal(stewardTier("low-confidence"), null);
  assert.equal(stewardTier("jev-failed"), null);
});

test("status: the soft tier reads as such, both locales", () => {
  assert.equal(stewardStatusPart("es", { mode: "active", decision: "soft-limit", applied: true, before: 420_000, after: 70_000 }), "contexto 420k → 70k (límite suave de 400k)");
  assert.equal(stewardStatusPart("en", { mode: "active", decision: "soft-limit", applied: true, before: 420_000, after: 70_000 }), "context 420k → 70k (400k soft limit)");
});

test("0.6.22 T1 steward answer and record: the margin is written when Jev gave one, and the key is absent otherwise", () => {
  const answered = interpretSteward({ verdict: { type: "choice", choice: "boundary", probabilities: { boundary: 0.7, "mid-task": 0.3 }, confidence: 0.7 } });
  assert.deepEqual(answered, { verdict: "boundary", confidence: 0.7, margin: 0.7 - 0.3 });
  const bare = interpretSteward({ verdict: { type: "choice", choice: "boundary", probabilities: { boundary: 1 }, confidence: 0.9 } });
  assert.ok(bare !== null && !("margin" in bare));
  const input = { at: "2026-09-28T14:05:00.000Z", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: { decision: "boundary", compact: true, suggestClear: false, confidence: 0.7 }, applied: true, contextAfter: 30_000, notApplied: null, verdict: "boundary", sessionId: "s-1", turnIndex: 7, mainWindow: 1_000_000, currentModel: "m", wouldFire: null } as const;
  assert.equal(stewardDecisionRecord({ ...input, margin: 0.4 }).margin, 0.4);
  assert.ok(!JSON.stringify(stewardDecisionRecord(input)).includes("margin"));
});

// ---------------------------------------------------------------------------
// 0.6.27 T1: the saving, verified against real usage
// ---------------------------------------------------------------------------

import { verifyStewardSaving } from "./context_steward.ts";

const VERIFY_NOW = Date.parse("2026-10-06T12:00:00.000Z");
const VERIFY_WEEK = 7 * 24 * 3600_000;
// A main step whose context is `ctx`, split across the three input kinds; output is large and must never count.
const mainStep = (sessionId: string, at: string, ctx: number): Record<string, unknown> => ({ at, agent: "main", sessionId, turnId: "t", index: 0, agentId: null, model: "m", input: 1_000, output: 999_999, cacheRead: ctx - 3_000, cacheWrite: 2_000, account: "acct-a", project: "project-c" });
const compaction = (sessionId: string | undefined, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ at, account: "acct-a", project: "project-c", mode: "active", contextBefore: 300_000, decision: "boundary", confidence: 0.9, compact: true, applied: true, contextAfter: 40_000, ...(sessionId === undefined ? {} : { sessionId }), ...extra });

test("verified saving rule 1: a step's context is input + cacheRead + cacheWrite of the MAIN agent, never output or subagents", () => {
  const usage: unknown[] = [
    mainStep("s1", "2026-10-06T10:00:00.000Z", 300_000),
    { ...mainStep("s1", "2026-10-06T10:14:00.000Z", 900_000), agent: "subagent" },
    { ...mainStep("s1", "2026-10-06T10:16:00.000Z", 5_000), agent: "subagent" },
    mainStep("s1", "2026-10-06T10:20:00.000Z", 100_000),
    mainStep("s1", "2026-10-06T10:30:00.000Z", 110_000),
    { ...mainStep("s1", "2026-10-06T10:35:00.000Z", 50_000), sessionId: null },
  ];
  const result = verifyStewardSaving([compaction("s1", "2026-10-06T10:15:00.000Z")], usage, VERIFY_NOW, VERIFY_WEEK);
  // The main step without a session id cannot be placed against a compaction, but it is still context the main agent read.
  assert.deepEqual(result, { compactions: 1, verified: 1, steps: 2, tokensNotReread: 400_000, mainContextTokens: 560_000, share: 400_000 / 960_000 });
});

test("verified saving rule 2: only applied compactions with a session id, inside the window, are checked; all applied ones in the window are counted", () => {
  const usage: unknown[] = [mainStep("s1", "2026-10-06T10:00:00.000Z", 300_000), mainStep("s1", "2026-10-06T10:20:00.000Z", 100_000)];
  const steward: unknown[] = [
    compaction("s1", "2026-10-06T10:15:00.000Z"),
    compaction(undefined, "2026-10-06T10:16:00.000Z"),
    compaction("s1", "2026-10-06T10:17:00.000Z", { applied: false, contextAfter: null }),
    compaction("s1", "2026-09-20T10:15:00.000Z"),
    compaction("s1", "2026-10-06T13:00:00.000Z"),
    "not a row",
    { at: "garbage", applied: true },
  ];
  const result = verifyStewardSaving(steward, usage, VERIFY_NOW, VERIFY_WEEK);
  assert.equal(result?.compactions, 2);
  assert.equal(result?.verified, 1);
  assert.equal(result?.tokensNotReread, 200_000);
});

test("verified saving rule 3: drop = last main step before minus first after, same session; skipped when a side is missing or the drop is not positive", () => {
  const usage: unknown[] = [
    mainStep("other", "2026-10-06T09:00:00.000Z", 500_000),
    mainStep("a", "2026-10-06T10:20:00.000Z", 100_000),
    mainStep("b", "2026-10-06T10:00:00.000Z", 200_000),
    mainStep("c", "2026-10-06T10:00:00.000Z", 100_000),
    mainStep("c", "2026-10-06T10:20:00.000Z", 120_000),
    mainStep("d", "2026-10-06T10:00:00.000Z", 250_000),
    mainStep("d", "2026-10-06T10:10:00.000Z", 300_000),
    mainStep("d", "2026-10-06T10:20:00.000Z", 60_000),
    mainStep("d", "2026-10-06T10:30:00.000Z", 900_000),
  ];
  const steward: unknown[] = ["a", "b", "c", "d"].map((sid) => compaction(sid, "2026-10-06T10:15:00.000Z"));
  const result = verifyStewardSaving(steward, usage, VERIFY_NOW, VERIFY_WEEK);
  assert.equal(result?.compactions, 4);
  assert.equal(result?.verified, 1);
  assert.equal(result?.steps, 2);
  assert.equal(result?.tokensNotReread, (300_000 - 60_000) * 2);
});

test("verified saving rule 4: the steps run up to the next applied compaction in the same session only", () => {
  const usage: unknown[] = [
    mainStep("s1", "2026-10-06T10:00:00.000Z", 300_000),
    mainStep("s1", "2026-10-06T10:20:00.000Z", 100_000),
    mainStep("s1", "2026-10-06T10:30:00.000Z", 250_000),
    mainStep("s1", "2026-10-06T10:50:00.000Z", 50_000),
    mainStep("s1", "2026-10-06T11:00:00.000Z", 60_000),
    mainStep("s1", "2026-10-06T11:10:00.000Z", 70_000),
  ];
  const steward: unknown[] = [compaction("s1", "2026-10-06T10:15:00.000Z"), compaction("other", "2026-10-06T10:25:00.000Z"), compaction("s1", "2026-10-06T10:40:00.000Z")];
  const result = verifyStewardSaving(steward, usage, VERIFY_NOW, VERIFY_WEEK);
  assert.equal(result?.verified, 2);
  assert.equal(result?.steps, 2 + 3);
  assert.equal(result?.tokensNotReread, (300_000 - 100_000) * 2 + (250_000 - 50_000) * 3);
});

test("verified saving rule 5: times compare as instants, not as strings", () => {
  // 12:10+02:00 is 10:10Z: before the compaction, though it sorts after it as a string.
  const usage: unknown[] = [mainStep("s1", "2026-10-06T12:10:00+02:00", 300_000), mainStep("s1", "2026-10-06T10:20:00.000Z", 100_000)];
  const result = verifyStewardSaving([compaction("s1", "2026-10-06T10:15:00.000Z")], usage, VERIFY_NOW, VERIFY_WEEK);
  assert.equal(result?.verified, 1);
  assert.equal(result?.tokensNotReread, 200_000);
});

test("verified saving rule 6: null without an applied compaction in the window; share null when there is nothing to divide by", () => {
  assert.equal(verifyStewardSaving([], [mainStep("s1", "2026-10-06T10:00:00.000Z", 1)], VERIFY_NOW, VERIFY_WEEK), null);
  assert.equal(verifyStewardSaving([compaction("s1", "2026-10-06T10:15:00.000Z", { applied: false })], [], VERIFY_NOW, VERIFY_WEEK), null);
  assert.deepEqual(verifyStewardSaving([compaction("s1", "2026-10-06T10:15:00.000Z")], [], VERIFY_NOW, VERIFY_WEEK), { compactions: 1, verified: 0, steps: 0, tokensNotReread: 0, mainContextTokens: 0, share: null });
});

test("verified saving: main context counts only steps inside the window", () => {
  const usage: unknown[] = [mainStep("s1", "2026-09-01T10:00:00.000Z", 999_000), mainStep("s1", "2026-10-06T10:00:00.000Z", 300_000), mainStep("s1", "2026-10-06T10:20:00.000Z", 100_000)];
  assert.equal(verifyStewardSaving([compaction("s1", "2026-10-06T10:15:00.000Z")], usage, VERIFY_NOW, VERIFY_WEEK)?.mainContextTokens, 400_000);
});

// ---------------------------------------------------------------------------
// Track S (odd/tasks/steward-pre-cold.md): the pre-cold tier's rows, tier and instructions

import { preColdInstructions } from "./context_steward.ts";

test("pre-cold: its tier, and a status line that says nothing (the person is away)", () => {
  assert.equal(stewardTier("pre-cold"), "pre-cold");
  assert.equal(stewardTier("pre-cold-skip"), null);
  assert.equal(stewardStatusPart("en", { mode: "active", decision: "pre-cold", applied: true, before: 150_000, after: 10_000 }), null);
});

test("pre-cold record: trigger, skip reason, idle time, engine zone and cost ride on the row; a turn-end row carries none of them", () => {
  const input = { at: "2026-10-12T14:05:00.000Z", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: { decision: "pre-cold", compact: true, suggestClear: false, confidence: null }, applied: true, contextAfter: 9_000, notApplied: null, verdict: null, sessionId: "s-1", turnIndex: 7, mainWindow: 1_000_000, currentModel: "m", wouldFire: null } as const;
  const record = stewardDecisionRecord({ ...input, preCold: { coldSkip: null, idleMs: 3_060_000, engineZone: false, compactCost: 21_000 } });
  assert.equal(record.trigger, "pre-cold");
  assert.equal(record.tier, "pre-cold");
  assert.equal(record.coldSkip, null);
  assert.equal(record.idleMs, 3_060_000);
  assert.equal(record.engineZone, false);
  assert.equal(record.compactCost, 21_000);
  const plain = JSON.stringify(stewardDecisionRecord(input));
  for (const key of ["trigger", "coldSkip", "idleMs", "engineZone", "compactCost"]) assert.ok(!plain.includes(key), key);
});

test("pre-cold rows and event rows stay out of the turn-end summary", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const rows: unknown[] = [
    { at: "2026-10-12T11:00:00.000Z", mode: "measure", decision: "pre-cold", compact: true, applied: false, trigger: "pre-cold", contextBefore: 150_000 },
    { at: "2026-10-12T11:00:00.000Z", mode: "active", decision: "pre-cold", compact: true, applied: true, trigger: "pre-cold", contextBefore: 150_000, contextAfter: 10_000 },
    { at: "2026-10-12T11:00:00.000Z", event: "engine-idle-compact" },
    { at: "2026-10-12T11:00:00.000Z", mode: "measure", decision: "boundary", compact: true, applied: false },
  ];
  assert.deepEqual(summarizeStewardDecisions(rows, now, 24 * 3600_000), { decisions: 1, applied: 0, wouldCompact: 1, freedPerStep: null });
});

test("pre-cold instructions: say why it compacts now and keep what the turn-end ones keep", () => {
  const facts = { featureDocs: ["odd/tasks/steward-pre-cold.md"], branches: ["feat/steward-pre-cold"], commits: [], prs: ["#54"] };
  const text = preColdInstructions(facts);
  assert.ok(text.startsWith("The session went idle"), text);
  assert.ok(!text.includes("A unit of work just closed"));
  assert.ok(text.includes("odd/tasks/steward-pre-cold.md"));
  assert.ok(text.includes("feat/steward-pre-cold"));
  assert.ok(text.includes("#54"));
  assert.deepEqual(text.split("\n").slice(1), stewardInstructions(facts).split("\n").slice(1));
});

// ---------------------------------------------------------------------------
// JEVADV-109: the settled tier and its boundary rule
// ---------------------------------------------------------------------------

const TURN_PROMPT: ActivityMessage = { role: "user", text: "fix the flaky test", toolUses: [] };
function turnStep(...toolUses: ActivityMessage["toolUses"]): ActivityMessage {
  return { role: "assistant", text: "", toolUses };
}
const READ_DONE = { tool_use_id: "r1", tool: "Read", input: { file_path: "src/a.ts" }, text: "export const a = 1" };
const EDIT_DONE = { tool_use_id: "e1", tool: "Edit", input: { file_path: "src/a.ts" }, text: "The file src/a.ts has been updated." };
const EDIT_FAILED = { tool_use_id: "e2", tool: "Edit", input: { file_path: "src/a.ts" }, text: "String to replace not found", isError: true as const };
const TEST_PASSED = { tool_use_id: "t1", tool: "Bash", input: { command: "npm test" }, text: "# pass 12\n# fail 0" };
const TEST_FAILED = { tool_use_id: "t2", tool: "Bash", input: { command: "npm test" }, text: "✖ a fails\n# fail 1" };

test("gate: the settled tier opens at 200k, never at the hard limit", () => {
  assert.equal(SETTLED_LIMIT_TOKENS, 200_000);
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 199_999 }), { ask: true, hardLimit: false, softLimit: false, settledLimit: false });
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 200_000 }), { ask: true, hardLimit: false, softLimit: false, settledLimit: true });
  assert.deepEqual(stewardGate({ ...ABOVE, contextTokens: 650_000 }), { ask: true, hardLimit: true, softLimit: false, settledLimit: false });
  // A threshold above 200k keeps the turn unasked, so the tier stays quiet too.
  assert.deepEqual(stewardGate({ ...ABOVE, threshold: 300_000, contextTokens: 250_000 }), { ask: false, reason: "below-threshold" });
});

test("boundary: a turn whose tool calls all came back, with the last edit landed and its tests passing, is settled", () => {
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(READ_DONE, EDIT_DONE), turnStep(TEST_PASSED), { role: "assistant", text: "Fixed.", toolUses: [] }]), { settled: true });
  assert.deepEqual(settledBoundary([TURN_PROMPT, { role: "assistant", text: "Here is the plan.", toolUses: [] }]), { settled: true });
});

test("boundary: a tool call with no result yet is never settled", () => {
  const pending = { tool_use_id: "p1", tool: "Bash", input: { command: "npm run build" } };
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(EDIT_DONE, pending)]), { settled: false, hold: "pending-tool" });
  // Its result in a later tool_result row counts as an answer.
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(pending), { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "p1", isError: false }] }]), { settled: true });
});

test("boundary: an edit in flight is never settled: a failed last edit, or tests failing after it", () => {
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(EDIT_DONE, EDIT_FAILED)]), { settled: false, hold: "edit-failed" });
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(EDIT_DONE), turnStep(TEST_FAILED)]), { settled: false, hold: "tests-failing" });
  // An error only in the tool_result row is still a failed edit.
  const edit = { tool_use_id: "e3", tool: "Write", input: { file_path: "src/b.ts" } };
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(edit), { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "e3", isError: true }] }]), { settled: false, hold: "edit-failed" });
});

test("boundary: a failed edit redone, or failing tests fixed and rerun green, is settled again", () => {
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(EDIT_FAILED), turnStep(EDIT_DONE)]), { settled: true });
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(TEST_FAILED), turnStep(EDIT_DONE), turnStep(TEST_PASSED)]), { settled: true });
});

test("boundary: a call sent to the background is not settled (its result is still to come)", () => {
  const background = { tool_use_id: "b1", tool: "Bash", input: { command: "npm run dev", run_in_background: true }, text: "Command running in background" };
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(background)]), { settled: false, hold: "background-task" });
});

test("boundary: only the current turn counts; no prompt at all is a hold", () => {
  assert.deepEqual(settledBoundary([TURN_PROMPT, turnStep(EDIT_FAILED), { role: "user", text: "never mind, explain it", toolUses: [] }, { role: "assistant", text: "Sure.", toolUses: [] }]), { settled: true });
  assert.deepEqual(settledBoundary([]), { settled: false, hold: "no-turn" });
});

test("decision: above 200k a settled turn compacts on mid-task, low confidence and a Jev failure", () => {
  const settled = { hardLimit: false, settledLimit: true, settled: true } as const;
  for (const jev of [{ verdict: "mid-task" as const, confidence: 0.95 }, { verdict: "boundary" as const, confidence: 0.4 }, null]) {
    assert.deepEqual(decideSteward({ ...settled, jev }), { decision: "settled-limit", compact: true, suggestClear: false, confidence: jev?.confidence ?? null });
  }
  // A confident boundary keeps its own name.
  assert.equal(decideSteward({ ...settled, jev: { verdict: "boundary", confidence: 0.9 } }).decision, "boundary");
});

test("decision: an unsettled turn, or one under 200k, never compacts on the settled tier", () => {
  const midTask = { verdict: "mid-task" as const, confidence: 0.9 };
  assert.deepEqual(decideSteward({ jev: midTask, hardLimit: false, settledLimit: true, settled: false }), { decision: "mid-task", compact: false, suggestClear: false, confidence: 0.9 });
  assert.deepEqual(decideSteward({ jev: midTask, hardLimit: false, settledLimit: false, settled: true }), { decision: "mid-task", compact: false, suggestClear: false, confidence: 0.9 });
  // The hard limit still compacts whatever the boundary says.
  assert.equal(decideSteward({ jev: midTask, hardLimit: true, settledLimit: false, settled: false }).decision, "hard-limit");
});

test("settled tier: tier name, status line, log hold and the keep-list for unfinished work", () => {
  assert.equal(stewardTier("settled-limit"), "settled-200k");
  assert.equal(stewardStatusPart("en", { mode: "active", decision: "settled-limit", applied: true, before: 240_000, after: 60_000 }), "context 240k → 60k (over 200k, between two steps)");
  assert.equal(stewardStatusPart("es", { mode: "measure", decision: "settled-limit", applied: false, before: 240_000, after: null }), "contexto 240k → compactaría (más de 200k, entre dos pasos · solo mide)");
  const instructions = settledInstructions({ featureDocs: ["odd/tasks/x.md"], branches: ["feat/x"], commits: [], prs: [] });
  assert.match(instructions, /NOT finished/);
  assert.match(instructions, /exact next action/);
  assert.match(instructions, /odd\/tasks\/x\.md/);
});
