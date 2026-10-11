// The verify-done module (odd/tasks/verify-done-module.md, V1): the pure rules
// behind the shadow measure of "it said it was done and it was not". The hook
// wiring is covered in adapters/claude/mod-skills/hooks.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  VERIFY_DONE_CONFIDENCE_FLOOR,
  VERIFY_DONE_DECISIONS_FILE_PATTERN,
  VERIFY_DONE_MESSAGE_CHARS,
  buildVerifyDoneQuestions,
  buildVerifyDoneState,
  decideVerifyDone,
  interpretVerifyDone,
  isVerifyDoneCandidate,
  summarizeVerifyDoneDecisions,
  verifyDoneDecisionFileName,
  verifyDoneRecord,
} from "./verify_done.ts";
import type { StewardActivity } from "./context_steward.ts";
import { STEWARD_CONFIDENCE_FLOOR } from "./context_steward.ts";

const EDITED: StewardActivity = { toolCalls: 4, filesEdited: 2, testsRun: 0, testsPassed: null, committed: false, pushed: false, openedPr: false };

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./verify_done.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The candidate rule: whether Jev is asked at all
// ---------------------------------------------------------------------------

test("candidate: edits with no test run is a candidate", () => {
  assert.equal(isVerifyDoneCandidate(EDITED), true);
});

test("candidate: edits with a failing test is a candidate", () => {
  assert.equal(isVerifyDoneCandidate({ ...EDITED, testsRun: 2, testsPassed: false }), true);
});

test("candidate: edits with every test passing is not", () => {
  assert.equal(isVerifyDoneCandidate({ ...EDITED, testsRun: 1, testsPassed: true }), false);
});

test("candidate: no edits is never a candidate, whatever the tests say", () => {
  for (const tests of [{ testsRun: 0, testsPassed: null }, { testsRun: 1, testsPassed: false }, { testsRun: 1, testsPassed: true }] as const) {
    assert.equal(isVerifyDoneCandidate({ ...EDITED, filesEdited: 0, ...tests }), false, JSON.stringify(tests));
  }
});

// ---------------------------------------------------------------------------
// The Jev question and state
// ---------------------------------------------------------------------------

test("state: the final message redacted and cut, and the turn's counts; nothing else", () => {
  const secret = "sk-ant-api03-" + "a".repeat(40);
  const state = buildVerifyDoneState({ finalMessage: `Done, the key ${secret} is wired. ${"x".repeat(5000)}`, activity: EDITED }) as Record<string, unknown>;
  const message = state.final_message as string;
  assert.ok(!message.includes(secret), "the secret is redacted");
  assert.ok(message.startsWith("Done, the key "), "the start of the message is kept");
  assert.ok(message.length <= VERIFY_DONE_MESSAGE_CHARS);
  assert.deepEqual(state.turn, { tool_calls: 4, files_edited: 2, tests_run: 0, tests_passed: null, committed: false, pushed: false, opened_pr: false });
  assert.deepEqual(Object.keys(state).sort(), ["final_message", "turn"]);
});

test("state: a long message keeps its start and its end, where a claim of done usually sits", () => {
  const message = `I changed the parser. ${"detail ".repeat(800)}All tests pass now.`;
  const sent = (buildVerifyDoneState({ finalMessage: message, activity: EDITED }) as Record<string, unknown>).final_message as string;
  assert.ok(sent.startsWith("I changed the parser."));
  assert.ok(sent.endsWith("All tests pass now."));
  assert.ok(sent.length <= VERIFY_DONE_MESSAGE_CHARS);
});

test("state: a secret cut in half by the cap never reaches the state (redacted before the cut)", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const head = "y".repeat(VERIFY_DONE_MESSAGE_CHARS - 10);
  const sent = (buildVerifyDoneState({ finalMessage: `${head}${secret}`, activity: EDITED }) as Record<string, unknown>).final_message as string;
  assert.ok(!sent.includes("ghp_abc"), sent.slice(-40));
});

test("state: a short message is sent whole", () => {
  assert.equal((buildVerifyDoneState({ finalMessage: "Listo, ya funciona.", activity: EDITED }) as Record<string, unknown>).final_message, "Listo, ya funciona.");
});

test("question: one choice, `claim`, with the three answers, and unsure leans not-claimed", () => {
  const questions = buildVerifyDoneQuestions();
  assert.deepEqual(Object.keys(questions), ["claim"]);
  const claim = questions.claim;
  assert.ok(claim !== undefined && claim.type === "choice");
  assert.deepEqual(Object.keys(claim.criteria), ["claimed-done", "not-claimed", "no-claim"]);
  assert.match(claim.instructions, /unsure, choose not-claimed/);
});

test("interpret: a known claim with its confidence and margin; anything else is a failure", () => {
  assert.deepEqual(interpretVerifyDone({ claim: { type: "choice", choice: "claimed-done", probabilities: {}, confidence: 0.8 } }), { claim: "claimed-done", confidence: 0.8 });
  assert.deepEqual(interpretVerifyDone({ claim: { type: "choice", choice: "no-claim", probabilities: { "no-claim": 0.6, "not-claimed": 0.3, "claimed-done": 0.1 }, confidence: 0.6 } }), { claim: "no-claim", confidence: 0.6, margin: 0.3 });
  assert.equal(interpretVerifyDone({ claim: { type: "choice", choice: "maybe", probabilities: {}, confidence: 0.8 } }), null);
  assert.equal(interpretVerifyDone({ verdict: { type: "choice", choice: "claimed-done", probabilities: {}, confidence: 0.8 } }), null);
  assert.equal(interpretVerifyDone({}), null);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("decision: the floor starts at the steward's", () => {
  assert.equal(VERIFY_DONE_CONFIDENCE_FLOOR, STEWARD_CONFIDENCE_FLOOR);
  assert.equal(VERIFY_DONE_CONFIDENCE_FLOOR, 0.7);
});

test("decision: claimed done at or above the floor would block", () => {
  assert.deepEqual(decideVerifyDone({ claim: "claimed-done", confidence: 0.7 }), { decision: "would-block", wouldBlock: true, confidence: 0.7 });
  assert.deepEqual(decideVerifyDone({ claim: "claimed-done", confidence: 0.95 }), { decision: "would-block", wouldBlock: true, confidence: 0.95 });
});

test("decision: claimed done just under the floor is only logged as low confidence", () => {
  assert.deepEqual(decideVerifyDone({ claim: "claimed-done", confidence: 0.69 }), { decision: "claimed-unverified-low-confidence", wouldBlock: false, confidence: 0.69 });
});

test("decision: not claimed and no claim never would block, at any confidence", () => {
  for (const confidence of [0.2, 0.7, 0.99]) {
    assert.deepEqual(decideVerifyDone({ claim: "not-claimed", confidence }), { decision: "not-claimed", wouldBlock: false, confidence });
    assert.deepEqual(decideVerifyDone({ claim: "no-claim", confidence }), { decision: "no-claim", wouldBlock: false, confidence });
  }
});

test("decision: a Jev failure is a failure, never a guess", () => {
  assert.deepEqual(decideVerifyDone(null), { decision: "jev-failed", wouldBlock: false, confidence: null });
});

// ---------------------------------------------------------------------------
// Record, file name and summary
// ---------------------------------------------------------------------------

test("record: numbers and names only, never message text", () => {
  const record = verifyDoneRecord({
    at: "2026-10-11T14:05:00.000Z",
    account: "acct-a",
    project: "project-c",
    sessionId: "s-1",
    activity: EDITED,
    decision: { decision: "would-block", wouldBlock: true, confidence: 0.8 },
    claim: "claimed-done",
    latencyMs: 412,
  });
  assert.deepEqual(record, {
    at: "2026-10-11T14:05:00.000Z",
    account: "acct-a",
    project: "project-c",
    mode: "shadow",
    sessionId: "s-1",
    decision: "would-block",
    claim: "claimed-done",
    confidence: 0.8,
    wouldBlock: true,
    filesEdited: 2,
    testsRun: 0,
    testsPassed: null,
    latencyMs: 412,
  });
});

test("record: a failure names no claim, and a margin rides along when Jev gave one", () => {
  const failed = verifyDoneRecord({ at: "2026-10-11T14:05:00.000Z", account: "a", project: "p", sessionId: null, activity: EDITED, decision: decideVerifyDone(null), claim: null, latencyMs: null });
  assert.equal(failed.decision, "jev-failed");
  assert.equal(failed.claim, null);
  assert.equal(failed.confidence, null);
  assert.equal("margin" in failed, false);
  assert.equal(failed.latencyMs, null, "a latency the caller did not have stays null");
  const withMargin = verifyDoneRecord({ at: "2026-10-11T14:05:00.000Z", account: "a", project: "p", sessionId: null, activity: EDITED, decision: decideVerifyDone({ claim: "no-claim", confidence: 0.6 }), claim: "no-claim", latencyMs: 380, margin: 0.3 });
  assert.equal(withMargin.margin, 0.3);
});

test("file name: hourly, `verify-done-decisions-<YYYY-MM-DDTHH>.jsonl`, and the pattern reads only those", () => {
  assert.equal(verifyDoneDecisionFileName("2026-10-11T14:05:00.000Z"), "verify-done-decisions-2026-10-11T14.jsonl");
  assert.equal(VERIFY_DONE_DECISIONS_FILE_PATTERN.exec("verify-done-decisions-2026-10-11T14.jsonl")?.[1], "2026-10-11T14");
  for (const name of ["context-steward-decisions-2026-10-11T14.jsonl", "verify-done-decisions-2026-10-11.jsonl", "verify-done-decisions-2026-10-11T14.jsonl.bak"]) {
    assert.equal(VERIFY_DONE_DECISIONS_FILE_PATTERN.test(name), false, name);
  }
});

test("summary: decisions, claims of done, would-block and Jev failures over the window; malformed rows skipped", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const row = (at: string, decision: string, claim: string | null): Record<string, unknown> => ({ at, account: "a", project: "p", mode: "shadow", decision, claim, wouldBlock: decision === "would-block" });
  const rows: unknown[] = [
    row("2026-10-11T11:00:00.000Z", "would-block", "claimed-done"),
    row("2026-10-11T10:00:00.000Z", "would-block", "claimed-done"),
    row("2026-10-11T09:00:00.000Z", "claimed-unverified-low-confidence", "claimed-done"),
    row("2026-10-11T08:00:00.000Z", "not-claimed", "not-claimed"),
    row("2026-10-11T07:00:00.000Z", "no-claim", "no-claim"),
    row("2026-10-11T06:00:00.000Z", "jev-failed", null),
    row("2026-10-09T06:00:00.000Z", "would-block", "claimed-done"),
    row("2026-10-11T13:00:00.000Z", "would-block", "claimed-done"),
    "not a row",
    { at: "garbage", decision: "would-block" },
  ];
  assert.deepEqual(summarizeVerifyDoneDecisions(rows, now, 24 * 3600_000), { decisions: 6, claims: 3, wouldBlock: 2, jevFailed: 1 });
});

test("summary: an empty window is all zeros", () => {
  assert.deepEqual(summarizeVerifyDoneDecisions([], Date.now(), 3600_000), { decisions: 0, claims: 0, wouldBlock: 0, jevFailed: 0 });
});
