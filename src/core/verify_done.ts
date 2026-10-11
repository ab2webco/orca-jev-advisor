// ---------------------------------------------------------------------------
// Verify the "done" (odd/tasks/verify-done-module.md, candidate M1).
//
// The failure Rule 7 exists for: the agent ends a turn saying the work is
// done, and the turn's own run facts show it was not verified -- it edited
// files and no test passed. After a main-conversation turn that ended with an
// answer, and only on such a candidate turn, Jev reads the final message once
// and says whether it claims the work is finished; one local row records it.
// Shadow only: nothing is blocked and no answer changes. A week of rows
// decides whether a blocking state is worth building.
//
// The run facts are the steward's (summarizeStewardActivity): counts and
// yes/no only, never text. Pure: the hooks module reads the messages, calls
// Jev and writes the row.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { STEWARD_CONFIDENCE_FLOOR } from "./context_steward.ts";
import type { StewardActivity } from "./context_steward.ts";
import { answerMargin, getChoiceAnswer } from "./jev.ts";
import type { Answer, JsonValue, Question } from "./jev.ts";
import { redactSecretsForJev } from "./secret_redaction.ts";

/** How sure Jev must be that the message claims done for the turn to count as one a blocking state would stop. Starts at the steward's. */
export const VERIFY_DONE_CONFIDENCE_FLOOR = STEWARD_CONFIDENCE_FLOOR;
/** The most of the final message Jev reads. */
export const VERIFY_DONE_MESSAGE_CHARS = 1200;
/** Of a longer message, how much of its end is kept: a summary often closes on "all tests pass". */
const MESSAGE_TAIL_CHARS = 400;
const ELISION = " … ";

// ---------------------------------------------------------------------------
// The candidate rule: whether Jev is asked at all
// ---------------------------------------------------------------------------

/** A turn that edited files and has no passing test to show for it. Every other turn makes no Jev call and writes no row. */
export function isVerifyDoneCandidate(activity: StewardActivity): boolean {
  return activity.filesEdited > 0 && !(activity.testsRun > 0 && activity.testsPassed === true);
}

// ---------------------------------------------------------------------------
// The Jev question
// ---------------------------------------------------------------------------

export type VerifyDoneClaim = "claimed-done" | "not-claimed" | "no-claim";
const CLAIMS: readonly VerifyDoneClaim[] = ["claimed-done", "not-claimed", "no-claim"];

export interface VerifyDoneJudgment {
  readonly claim: VerifyDoneClaim;
  readonly confidence: number;
  /** Top probability minus runner-up; absent when Jev's probabilities give none. Log only. */
  readonly margin?: number;
}

export interface VerifyDoneStateInput {
  /** The assistant's final visible text of the turn (`turn.complete`'s `answer`). */
  readonly finalMessage: string;
  readonly activity: StewardActivity;
}

/**
 * The final message redacted first and cut second, as the steward does with
 * a prompt, so a cut never leaves half a secret. A long one keeps its start
 * and its end, where a claim of done usually sits.
 */
function messageExcerpt(text: string): string {
  const redacted = redactSecretsForJev(text).text;
  if (redacted.length <= VERIFY_DONE_MESSAGE_CHARS) return redacted;
  const head = VERIFY_DONE_MESSAGE_CHARS - MESSAGE_TAIL_CHARS - ELISION.length;
  return `${redacted.slice(0, head)}${ELISION}${redacted.slice(-MESSAGE_TAIL_CHARS)}`;
}

/** What Jev reads: the final message and the turn's counts. Never file contents, commands or paths. */
export function buildVerifyDoneState(input: VerifyDoneStateInput): JsonValue {
  const activity = input.activity;
  return {
    final_message: messageExcerpt(input.finalMessage),
    turn: {
      tool_calls: activity.toolCalls,
      files_edited: activity.filesEdited,
      tests_run: activity.testsRun,
      tests_passed: activity.testsPassed,
      committed: activity.committed,
      pushed: activity.pushed,
      opened_pr: activity.openedPr,
    },
  };
}

const CLAIM_CRITERIA: Readonly<Record<VerifyDoneClaim, string>> = {
  "claimed-done":
    "The message says the work is finished, working, fixed, passing or ready: it presents the change as complete (for example \"done\", \"it works now\", \"all tests pass\", \"listo\", \"ya funciona\").",
  "not-claimed":
    "The message says the work is partial, blocked, failing, untested or only proposed: it lists what is left, asks the person to check or decide, or says it could not verify.",
  "no-claim":
    "The message is not about work done: it answers a question, explains something or reports findings, with no statement that a change is finished.",
};

export function buildVerifyDoneQuestions(): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const claim of CLAIMS) criteria[claim] = CLAIM_CRITERIA[claim];
  return {
    claim: {
      type: "choice",
      instructions:
        "A coding assistant just finished a turn. `final_message` is its last message to the person (Spanish or English, possibly cut in the middle), `turn` what it did on this turn (tool calls, files edited, tests run and whether they passed, whether it committed, pushed or opened a pull request). Judge only what the message claims about the work, not whether the claim is true. When unsure, choose not-claimed: this is a measurement that must undercount, never overcount.",
      criteria,
    },
  };
}

/** Jev's claim and confidence, or null for anything malformed: a failure, never a guess. */
export function interpretVerifyDone(answers: Record<string, Answer>): VerifyDoneJudgment | null {
  const answer = getChoiceAnswer(answers, "claim");
  if (answer === null || !(CLAIMS as readonly string[]).includes(answer.choice)) return null;
  const margin = answerMargin(answer.probabilities);
  return { claim: answer.choice as VerifyDoneClaim, confidence: answer.confidence, ...(margin === undefined ? {} : { margin }) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type VerifyDoneDecisionKind = "would-block" | "claimed-unverified-low-confidence" | "not-claimed" | "no-claim" | "jev-failed";

export interface VerifyDoneDecision {
  readonly decision: VerifyDoneDecisionKind;
  /** Whether a blocking state would have stopped this turn's end. Shadow never does. */
  readonly wouldBlock: boolean;
  readonly confidence: number | null;
}

/** The decision on a candidate turn: a confident claim of done is the one a blocking state would stop. */
export function decideVerifyDone(jev: VerifyDoneJudgment | null): VerifyDoneDecision {
  if (jev === null) return { decision: "jev-failed", wouldBlock: false, confidence: null };
  if (jev.claim === "claimed-done") {
    return jev.confidence >= VERIFY_DONE_CONFIDENCE_FLOOR
      ? { decision: "would-block", wouldBlock: true, confidence: jev.confidence }
      : { decision: "claimed-unverified-low-confidence", wouldBlock: false, confidence: jev.confidence };
  }
  return { decision: jev.claim, wouldBlock: false, confidence: jev.confidence };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/** The hourly verify-done logs, the hour captured: listed, read and pruned like the steward's. */
export const VERIFY_DONE_DECISIONS_FILE_PATTERN = /^verify-done-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** `verify-done-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function verifyDoneDecisionFileName(atIso: string): string {
  return `verify-done-decisions-${atIso.slice(0, 13)}.jsonl`;
}

export interface VerifyDoneRecord {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  /** The module's state when the row was written: shadow is the only one that writes. */
  readonly mode: "shadow";
  readonly sessionId: string | null;
  readonly decision: VerifyDoneDecisionKind;
  /** Jev's claim on every row, a low-confidence one included; null when Jev failed. */
  readonly claim: VerifyDoneClaim | null;
  readonly confidence: number | null;
  readonly wouldBlock: boolean;
  readonly filesEdited: number;
  readonly testsRun: number;
  readonly testsPassed: boolean | null;
  /** How long the Jev call took, failure included, for measure-module-cost's p50/p90; null when no call was made. */
  readonly latencyMs: number | null;
  /** The claim's top-two probability gap; absent when there is none. */
  readonly margin?: number;
}

export interface VerifyDoneRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly activity: StewardActivity;
  readonly decision: VerifyDoneDecision;
  readonly claim: VerifyDoneClaim | null;
  readonly latencyMs: number | null;
  readonly margin?: number;
}

/** One log line: numbers and names only, never message text. */
export function verifyDoneRecord(input: VerifyDoneRecordInput): VerifyDoneRecord {
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    mode: "shadow",
    sessionId: input.sessionId,
    decision: input.decision.decision,
    claim: input.claim,
    confidence: input.decision.confidence,
    wouldBlock: input.decision.wouldBlock,
    filesEdited: input.activity.filesEdited,
    testsRun: input.activity.testsRun,
    testsPassed: input.activity.testsPassed,
    latencyMs: input.latencyMs,
    ...(input.margin === undefined ? {} : { margin: input.margin }),
  };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface VerifyDoneSummary {
  /** Logged decisions in the window (each one a candidate turn). */
  readonly decisions: number;
  /** Turns whose final message Jev read as a claim of done, at any confidence. */
  readonly claims: number;
  /** Claims of done at or above the floor: the turns a blocking state would have stopped. */
  readonly wouldBlock: number;
  readonly jevFailed: number;
}

/** What the module measured over the `windowMs` before `nowMs`. Rows are parsed tolerantly: anything malformed is skipped. */
export function summarizeVerifyDoneDecisions(rows: readonly unknown[], nowMs: number, windowMs: number): VerifyDoneSummary {
  let decisions = 0;
  let claims = 0;
  let wouldBlock = 0;
  let jevFailed = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    decisions += 1;
    if (row.claim === "claimed-done") claims += 1;
    if (row.decision === "would-block") wouldBlock += 1;
    if (row.decision === "jev-failed") jevFailed += 1;
  }
  return { decisions, claims, wouldBlock, jevFailed };
}
