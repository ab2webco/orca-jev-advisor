// ---------------------------------------------------------------------------
// Jev context steward (odd/tasks/jev-context-steward.md).
//
// Re-read context is most of what a long session costs, and a model switch
// barely touches it. At the end of a main-conversation turn whose context is
// at or above a threshold, Jev judges whether a unit of work just closed; on
// a confident yes the plugin compacts the session with instructions that keep
// the plan and the open work. On a topic change it also suggests /clear,
// which a plugin cannot run.
//
// Pure: the hooks module reads the usage, calls Jev, compacts and logs.
// ---------------------------------------------------------------------------

import { getChoiceAnswer } from "./jev.ts";
import type { Answer, JsonValue, Question } from "./jev.ts";
import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { CONTEXT_STEWARD_CATALOG } from "./i18n_context_steward.ts";
import { summarizeSinceLastPrompt } from "./model_router_stage.ts";
import type { ActivityMessage } from "./model_router_stage.ts";
import { redactSecretsForJev } from "./secret_redaction.ts";

export type StewardMode = "off" | "measure" | "active";
export const STEWARD_MODES: readonly StewardMode[] = ["off", "measure", "active"];
export const DEFAULT_STEWARD_MODE: StewardMode = "measure";

export const DEFAULT_STEWARD_THRESHOLD = 120_000;
export const MIN_STEWARD_THRESHOLD = 10_000;
export const MAX_STEWARD_THRESHOLD = 2_000_000;
/** At this share of the window the steward compacts whatever Jev says. */
export const HARD_LIMIT_PERCENT = 80;
/** Person turns that must pass between two compactions. */
export const STEWARD_COOLDOWN_TURNS = 3;
export const STEWARD_CONFIDENCE_FLOOR = 0.7;
export const STEWARD_PROMPT_CHARS = 600;

export function parseStewardMode(value: unknown): StewardMode {
  return typeof value === "string" && (STEWARD_MODES as readonly string[]).includes(value) ? (value as StewardMode) : DEFAULT_STEWARD_MODE;
}

/** A whole number of tokens within the accepted range, or the default. */
export function parseStewardThreshold(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_STEWARD_THRESHOLD && value <= MAX_STEWARD_THRESHOLD ? value : DEFAULT_STEWARD_THRESHOLD;
}

// ---------------------------------------------------------------------------
// The gate: whether Jev is asked at all
// ---------------------------------------------------------------------------

export interface StewardGateInput {
  readonly mode: StewardMode;
  readonly isSubagent: boolean;
  /** The live context (`$.session.usage().context.tokens`); null before any response reported one. */
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly threshold: number;
  /** Person turns since the last compaction this steward made (or would have, in measure mode); null when none. */
  readonly turnsSinceCompaction: number | null;
}

export type StewardSkipReason = "off" | "subagent" | "no-usage" | "below-threshold" | "cooldown";

export type StewardGate = { readonly ask: true; readonly hardLimit: boolean } | { readonly ask: false; readonly reason: StewardSkipReason };

export function stewardGate(input: StewardGateInput): StewardGate {
  if (input.mode === "off") return { ask: false, reason: "off" };
  if (input.isSubagent) return { ask: false, reason: "subagent" };
  if (input.contextTokens === null) return { ask: false, reason: "no-usage" };
  const hardLimit = (input.contextPercent ?? 0) >= HARD_LIMIT_PERCENT;
  if (input.contextTokens < input.threshold && !hardLimit) return { ask: false, reason: "below-threshold" };
  if (input.turnsSinceCompaction !== null && input.turnsSinceCompaction < STEWARD_COOLDOWN_TURNS) return { ask: false, reason: "cooldown" };
  return { ask: true, hardLimit };
}

// ---------------------------------------------------------------------------
// The Jev question
// ---------------------------------------------------------------------------

export type StewardVerdict = "boundary" | "mid-task" | "new-topic";
const VERDICTS: readonly StewardVerdict[] = ["boundary", "mid-task", "new-topic"];

export interface StewardJudgment {
  readonly verdict: StewardVerdict;
  readonly confidence: number;
}

/** What the turn that just ended did: counts and yes/no facts only, never text. */
export interface StewardActivity {
  readonly toolCalls: number;
  readonly filesEdited: number;
  readonly testsRun: number;
  /** null when no test ran. */
  readonly testsPassed: boolean | null;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly openedPr: boolean;
}

const COMMIT_COMMAND = /\bgit\b[^\n]*\bcommit\b/;
const PUSH_COMMAND = /\bgit\b[^\n]*\bpush\b/;
const PR_COMMAND = /\bgh\s+pr\s+create\b/;

/** The work since the person's last prompt: the turn that just ended. */
export function summarizeStewardActivity(messages: readonly ActivityMessage[]): StewardActivity {
  const activity = summarizeSinceLastPrompt(messages);
  if (activity === null) return { toolCalls: 0, filesEdited: 0, testsRun: 0, testsPassed: null, committed: false, pushed: false, openedPr: false };
  const mentions = activity.mentions;
  return {
    toolCalls: activity.toolCalls,
    filesEdited: activity.filesEdited,
    testsRun: activity.testsRun,
    testsPassed: activity.testsRun === 0 ? null : activity.testsFailed === 0,
    committed: COMMIT_COMMAND.test(mentions),
    pushed: PUSH_COMMAND.test(mentions),
    openedPr: PR_COMMAND.test(mentions),
  };
}

export interface StewardStateInput {
  readonly lastPrompt: string;
  readonly previousPrompt: string | null;
  readonly activity: StewardActivity;
  readonly contextTokens: number;
  readonly turnsSinceCompaction: number | null;
}

/** A prompt redacted first and cut second, as the router does, so a cut never leaves half a secret. */
function promptExcerpt(text: string): string {
  return redactSecretsForJev(text).text.slice(0, STEWARD_PROMPT_CHARS);
}

export function buildStewardState(input: StewardStateInput): JsonValue {
  const activity = input.activity;
  return {
    last_prompt: promptExcerpt(input.lastPrompt),
    previous_prompt: input.previousPrompt === null ? null : promptExcerpt(input.previousPrompt),
    turn: {
      tool_calls: activity.toolCalls,
      files_edited: activity.filesEdited,
      tests_run: activity.testsRun,
      tests_passed: activity.testsPassed,
      committed: activity.committed,
      pushed: activity.pushed,
      opened_pr: activity.openedPr,
    },
    context_tokens: input.contextTokens,
    person_turns_since_compaction: input.turnsSinceCompaction,
  };
}

const VERDICT_CRITERIA: Readonly<Record<StewardVerdict, string>> = {
  boundary:
    "A unit of work just closed: a commit, a pull request or a release was made, tests went green after a fix, a question was fully answered, or the person said the task is done. What comes next can start from a summary.",
  "mid-task":
    "The work is still in progress: something was started and not finished, a test still fails, the assistant asked the person a question or is waiting on them, or the next step needs the detail just read.",
  "new-topic":
    "The person's latest request is about a different subject from the earlier work (compare `last_prompt` with `previous_prompt`), and the earlier work is closed: almost nothing of the earlier context is needed any more.",
};

export function buildStewardQuestions(): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const verdict of VERDICTS) criteria[verdict] = VERDICT_CRITERIA[verdict];
  return {
    verdict: {
      type: "choice",
      instructions:
        "A coding assistant just finished a turn. `last_prompt` is the person's latest request (Spanish or English), `previous_prompt` the one before it, `turn` what the assistant did on this turn (tool calls, edits, tests and whether they passed, whether it committed, pushed or opened a pull request). The conversation is long (`context_tokens`), so it may be compacted into a summary now. Judge whether this is a task boundary. When unsure, choose mid-task: compacting in the middle of work loses detail the next step needs.",
      criteria,
    },
  };
}

/** Jev's verdict and confidence, or null for anything malformed: a failure, never a guess. */
export function interpretSteward(answers: Record<string, Answer>): StewardJudgment | null {
  const answer = getChoiceAnswer(answers, "verdict");
  if (answer === null || !(VERDICTS as readonly string[]).includes(answer.choice)) return null;
  return { verdict: answer.choice as StewardVerdict, confidence: answer.confidence };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type StewardDecisionKind = "boundary" | "new-topic" | "hard-limit" | "mid-task" | "low-confidence" | "jev-failed";

export interface StewardDecision {
  readonly decision: StewardDecisionKind;
  /** Whether to compact (in measure mode: whether it would). */
  readonly compact: boolean;
  /** A confident topic change: /clear would be cheaper still. */
  readonly suggestClear: boolean;
  readonly confidence: number | null;
}

export function decideSteward(input: { readonly jev: StewardJudgment | null; readonly hardLimit: boolean }): StewardDecision {
  const jev = input.jev;
  const confidence = jev?.confidence ?? null;
  const confident = jev !== null && jev.confidence >= STEWARD_CONFIDENCE_FLOOR;
  if (confident && jev.verdict === "boundary") return { decision: "boundary", compact: true, suggestClear: false, confidence };
  if (confident && jev.verdict === "new-topic") return { decision: "new-topic", compact: true, suggestClear: true, confidence };
  if (input.hardLimit) return { decision: "hard-limit", compact: true, suggestClear: false, confidence };
  if (jev === null) return { decision: "jev-failed", compact: false, suggestClear: false, confidence };
  return { decision: confident ? "mid-task" : "low-confidence", compact: false, suggestClear: false, confidence };
}

// ---------------------------------------------------------------------------
// What the compaction keeps
// ---------------------------------------------------------------------------

export interface StewardFacts {
  readonly featureDocs: readonly string[];
  readonly branches: readonly string[];
  readonly commits: readonly string[];
  readonly prs: readonly string[];
}

const FEATURE_DOC = /odd\/tasks\/[\w.-]+\.md/g;
const BRANCH_COMMAND = /\bgit\s+(?:checkout\s+-[bB]|switch(?:\s+-[cC])?|worktree\s+add\s+\S+\s+-[bB])\s+([\w./-]+)/g;
const BRANCH_SWITCHED = /Switched to (?:a new )?branch '([^']+)'/g;
const COMMIT_LINE = /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const PR_URL = /\/pull\/(\d+)\b/g;

function addUnique(list: string[], value: string): void {
  const at = list.indexOf(value);
  if (at !== -1) list.splice(at, 1);
  list.push(value);
}

/** Every string a message carries: its text, each tool call's string inputs and each result's text. */
function messageTexts(message: ActivityMessage): { readonly texts: readonly string[]; readonly commands: readonly string[]; readonly outputs: readonly string[] } {
  const texts = [message.text];
  const commands: string[] = [];
  const outputs: string[] = [];
  for (const use of message.toolUses) {
    for (const value of Object.values(use.input)) if (typeof value === "string") texts.push(value);
    if (typeof use.input.command === "string") commands.push(use.input.command);
    if (use.text !== undefined) outputs.push(use.text);
  }
  return { texts: [...texts, ...outputs], commands, outputs };
}

/** The feature documents, branches, last commits and pull requests seen in the conversation, most recent last. */
export function collectStewardFacts(messages: readonly ActivityMessage[]): StewardFacts {
  const featureDocs: string[] = [];
  const branches: string[] = [];
  const commits: string[] = [];
  const prs: string[] = [];
  for (const message of messages) {
    const { texts, commands, outputs } = messageTexts(message);
    for (const text of texts) {
      for (const match of text.matchAll(FEATURE_DOC)) addUnique(featureDocs, match[0]);
      for (const match of text.matchAll(PR_URL)) addUnique(prs, `#${match[1] as string}`);
    }
    for (const command of commands) for (const match of command.matchAll(BRANCH_COMMAND)) if (!(match[1] as string).startsWith("-")) addUnique(branches, match[1] as string);
    for (const output of outputs) {
      for (const match of output.matchAll(BRANCH_SWITCHED)) addUnique(branches, match[1] as string);
      for (const match of output.matchAll(COMMIT_LINE)) {
        const branch = match[1] as string;
        addUnique(branches, branch);
        addUnique(commits, `${match[2] as string} ${(match[3] as string).trim()} (${branch})`);
      }
    }
  }
  return { featureDocs: featureDocs.slice(-8), branches: branches.slice(-5), commits: commits.slice(-5), prs: prs.slice(-5) };
}

function listed(values: readonly string[], none: string): string {
  return values.length === 0 ? none : values.join(", ");
}

/** The instructions the compaction runs with: what the summary must keep for the work to go on. */
export function stewardInstructions(facts: StewardFacts): string {
  return [
    "A unit of work just closed. Summarize so the work can continue without re-reading anything, and keep, verbatim where they are names:",
    `- The active feature documents (${listed(facts.featureDocs, "any odd/tasks/*.md path seen in the conversation")}): for each, its path, its open checklist items (the unchecked ones, with their ids) and its next step.`,
    `- The branch names (${listed(facts.branches, "every branch named in the conversation")}), the last commits (${listed(facts.commits, "the last commits made, hash and message")}) and the pull request numbers (${listed(facts.prs, "any pull request opened or discussed")}).`,
    "- The decisions made and why, and the person's standing constraints and rules (what they asked always or never to do).",
    "- Anything the person said is pending or still to do, and what was about to happen next.",
    "Drop tool output, file contents and exploration already acted on.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Record and status line
// ---------------------------------------------------------------------------

/** `context-steward-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function stewardDecisionFileName(atIso: string): string {
  return `context-steward-decisions-${atIso.slice(0, 13)}.jsonl`;
}

export interface StewardRecord {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly mode: StewardMode;
  readonly contextBefore: number;
  readonly decision: StewardDecisionKind;
  readonly confidence: number | null;
  readonly compact: boolean;
  readonly applied: boolean;
  readonly contextAfter: number | null;
}

export interface StewardRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly mode: StewardMode;
  readonly contextBefore: number;
  readonly decision: StewardDecision;
  readonly applied: boolean;
  readonly contextAfter: number | null;
}

/** One log line: numbers and names only, never prompt text. */
export function stewardDecisionRecord(input: StewardRecordInput): StewardRecord {
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    mode: input.mode,
    contextBefore: input.contextBefore,
    decision: input.decision.decision,
    confidence: input.decision.confidence,
    compact: input.decision.compact,
    applied: input.applied,
    contextAfter: input.contextAfter,
  };
}

export function formatContextTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`;
}

export interface StewardStatusInput {
  readonly mode: "measure" | "active";
  readonly decision: StewardDecisionKind;
  readonly applied: boolean;
  readonly before: number;
  readonly after: number | null;
}

/** The steward's part of the status line, or null when nothing was (or, measuring, would be) compacted. */
export function stewardStatusPart(locale: Locale, input: StewardStatusInput): string | null {
  if (input.decision !== "boundary" && input.decision !== "new-topic" && input.decision !== "hard-limit") return null;
  const why = translate(CONTEXT_STEWARD_CATALOG, locale, `why.${input.decision}`);
  const before = formatContextTokens(input.before);
  if (input.mode === "measure") return translate(CONTEXT_STEWARD_CATALOG, locale, "status.measure", { before, why });
  if (!input.applied) return null;
  if (input.after === null) return translate(CONTEXT_STEWARD_CATALOG, locale, "status.applied.unknownAfter", { before, why });
  return translate(CONTEXT_STEWARD_CATALOG, locale, "status.applied", { before, after: formatContextTokens(input.after), why });
}

export function stewardClearHint(locale: Locale): string {
  return translate(CONTEXT_STEWARD_CATALOG, locale, "clearHint");
}
