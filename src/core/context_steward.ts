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

import { isRecord } from "../guards.ts";
import { answerMargin, getChoiceAnswer } from "./jev.ts";
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
/**
 * 0.6.15 T4 (odd/research/steward-1m.md): the hard limit never waits past
 * 600k tokens. On a 1M window 80% was 800k, and sessions ran on to Claude
 * Code's own auto-compact at ~967k, which fires mid-turn (median 145 s);
 * calls at 400k and above were 68% of the account's spend.
 */
export const HARD_LIMIT_TOKENS = 600_000;
/** The soft tier: from here up to the hard limit, compact at turn end unless Jev is sure the work is mid-task. */
export const SOFT_LIMIT_TOKENS = 400_000;
/** How sure Jev must be that the work is mid-task for the soft tier to wait. */
export const SOFT_MID_TASK_FLOOR = 0.8;

/** Whether the soft tier compacts (`active`) or only logs what it would do (`measure`, the default). */
export type StewardSoftMode = "measure" | "active";
export const STEWARD_SOFT_MODES: readonly StewardSoftMode[] = ["measure", "active"];
export const DEFAULT_STEWARD_SOFT_MODE: StewardSoftMode = "measure";

export function parseStewardSoftMode(value: unknown): StewardSoftMode {
  return typeof value === "string" && (STEWARD_SOFT_MODES as readonly string[]).includes(value) ? (value as StewardSoftMode) : DEFAULT_STEWARD_SOFT_MODE;
}

/** The hard limit for a session whose main model has `mainWindow` tokens: 80% of it, never past HARD_LIMIT_TOKENS. */
export function hardLimitTokens(mainWindow: number): number {
  return Math.min(Math.floor((mainWindow * HARD_LIMIT_PERCENT) / 100), HARD_LIMIT_TOKENS);
}
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
  /**
   * The context window of the session's MAIN model, in tokens (0.6.15 T4),
   * or null when unknown. Not the current model's: a router step on a 200k
   * model in a 1M session compacted it at 160-230k, nine times in one session.
   */
  readonly mainWindow: number | null;
  readonly threshold: number;
  /** Person turns since the last compaction this steward made (or would have, in measure mode); null when none. */
  readonly turnsSinceCompaction: number | null;
}

export type StewardSkipReason = "off" | "subagent" | "no-usage" | "below-threshold" | "cooldown";

export type StewardGate = { readonly ask: true; readonly hardLimit: boolean; readonly softLimit: boolean } | { readonly ask: false; readonly reason: StewardSkipReason };

export function stewardGate(input: StewardGateInput): StewardGate {
  if (input.mode === "off") return { ask: false, reason: "off" };
  if (input.isSubagent) return { ask: false, reason: "subagent" };
  if (input.contextTokens === null) return { ask: false, reason: "no-usage" };
  const limit = input.mainWindow === null ? null : hardLimitTokens(input.mainWindow);
  const hardLimit = limit !== null && input.contextTokens >= limit;
  const softLimit = limit !== null && !hardLimit && input.contextTokens >= SOFT_LIMIT_TOKENS;
  if (input.contextTokens < input.threshold && !hardLimit && !softLimit) return { ask: false, reason: "below-threshold" };
  if (input.turnsSinceCompaction !== null && input.turnsSinceCompaction < STEWARD_COOLDOWN_TURNS) return { ask: false, reason: "cooldown" };
  return { ask: true, hardLimit, softLimit };
}

// ---------------------------------------------------------------------------
// The Jev question
// ---------------------------------------------------------------------------

export type StewardVerdict = "boundary" | "mid-task" | "new-topic";
const VERDICTS: readonly StewardVerdict[] = ["boundary", "mid-task", "new-topic"];

export interface StewardJudgment {
  readonly verdict: StewardVerdict;
  readonly confidence: number;
  /** 0.6.22 T1 (JEVADV-97): top probability minus runner-up; absent when Jev's probabilities give none. Log only. */
  readonly margin?: number;
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
  const margin = answerMargin(answer.probabilities);
  return { verdict: answer.choice as StewardVerdict, confidence: answer.confidence, ...(margin === undefined ? {} : { margin }) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type StewardDecisionKind = "boundary" | "new-topic" | "hard-limit" | "soft-limit" | "mid-task" | "low-confidence" | "jev-failed";

export interface StewardDecision {
  readonly decision: StewardDecisionKind;
  /** Whether to compact (in measure mode: whether it would). */
  readonly compact: boolean;
  /** A confident topic change: /clear would be cheaper still. */
  readonly suggestClear: boolean;
  readonly confidence: number | null;
}

/** Whether the soft tier would compact: above it, unless Jev says mid-task with confidence at least SOFT_MID_TASK_FLOOR (a failure included). */
export function softTierFires(input: { readonly jev: StewardJudgment | null; readonly softLimit: boolean }): boolean {
  if (!input.softLimit) return false;
  return !(input.jev !== null && input.jev.verdict === "mid-task" && input.jev.confidence >= SOFT_MID_TASK_FLOOR);
}

/**
 * The decision. `softActive` is the soft tier's own switch (0.6.15 T4,
 * measure by default): off, a soft-tier turn is decided as before and only
 * its log says the tier would have fired.
 */
export function decideSteward(input: { readonly jev: StewardJudgment | null; readonly hardLimit: boolean; readonly softLimit?: boolean; readonly softActive?: boolean }): StewardDecision {
  const jev = input.jev;
  const confidence = jev?.confidence ?? null;
  const confident = jev !== null && jev.confidence >= STEWARD_CONFIDENCE_FLOOR;
  if (confident && jev.verdict === "boundary") return { decision: "boundary", compact: true, suggestClear: false, confidence };
  if (confident && jev.verdict === "new-topic") return { decision: "new-topic", compact: true, suggestClear: true, confidence };
  if (input.hardLimit) return { decision: "hard-limit", compact: true, suggestClear: false, confidence };
  if (input.softActive === true && softTierFires({ jev, softLimit: input.softLimit === true })) return { decision: "soft-limit", compact: true, suggestClear: false, confidence };
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

/** The tier that fires a compaction, as the research names them (odd/research/steward-1m.md §6). */
export type StewardTier = "boundary" | "new-topic" | "soft-400k" | "hard-600k";

/** The tier behind a decision that compacts (or, measuring, would), or null. */
export function stewardTier(decision: StewardDecisionKind): StewardTier | null {
  if (decision === "boundary" || decision === "new-topic") return decision;
  if (decision === "soft-limit") return "soft-400k";
  if (decision === "hard-limit") return "hard-600k";
  return null;
}

/** The hourly steward logs, the hour captured: listed, read and pruned like the router's. */
export const STEWARD_DECISIONS_FILE_PATTERN = /^context-steward-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** `context-steward-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function stewardDecisionFileName(atIso: string): string {
  return `context-steward-decisions-${atIso.slice(0, 13)}.jsonl`;
}

/**
 * Why a compaction the decision called for did not happen: measure mode;
 * a new turn had started; the engine rejected it; a headless (-p / SDK)
 * session, where the engine does not offer it; or a hook skipped it.
 */
export type StewardNotApplied = "measure" | "turn-running" | "rejected" | "headless" | "skipped";

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
  readonly notApplied: StewardNotApplied | null;
  /** 0.6.15 T4: Jev's verdict on every row, a low-confidence one included; null when Jev failed. */
  readonly verdict: StewardVerdict | null;
  readonly sessionId: string | null;
  /** The person turn this decision closed (the cooldown's count). */
  readonly turnIndex: number;
  /** The main model's window, in tokens, the hard limit was measured against; null when unknown. */
  readonly mainWindow: number | null;
  /** The model the turn ran on, when known. */
  readonly currentModel: string | null;
  /** The tier that fired, or would have in measure mode. */
  readonly tier: StewardTier | null;
  /** A tier that would have fired but is only measured: the soft tier while its switch is on measure. */
  readonly wouldFire: StewardTier | null;
  /** 0.6.22 T1 (JEVADV-97): the verdict's top-two probability gap; absent when there is none. */
  readonly margin?: number;
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
  readonly notApplied: StewardNotApplied | null;
  readonly verdict: StewardVerdict | null;
  readonly sessionId: string | null;
  readonly turnIndex: number;
  readonly mainWindow: number | null;
  readonly currentModel: string | null;
  readonly wouldFire: StewardTier | null;
  readonly margin?: number;
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
    notApplied: input.notApplied,
    verdict: input.verdict,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    mainWindow: input.mainWindow,
    currentModel: input.currentModel,
    tier: stewardTier(input.decision.decision),
    wouldFire: input.wouldFire,
    ...(input.margin === undefined ? {} : { margin: input.margin }),
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
  if (input.decision !== "boundary" && input.decision !== "new-topic" && input.decision !== "hard-limit" && input.decision !== "soft-limit") return null;
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

// ---------------------------------------------------------------------------
// The board's summary
// ---------------------------------------------------------------------------

export interface StewardSummary {
  /** Logged decisions in the window (each one a turn at or above the threshold). */
  readonly decisions: number;
  /** Compactions active mode made. */
  readonly applied: number;
  /** Compactions measure mode would have made. */
  readonly wouldCompact: number;
  /**
   * An ESTIMATE: the context each applied compaction took off every later
   * step of its session (before − after), averaged over those compactions
   * and rounded. Never summed: the sum across sessions is not what any one
   * step saves. Per step, not multiplied by the steps that followed: the
   * logs carry no session id, and an account often runs several sessions
   * at once. null when no applied compaction recorded its size afterwards.
   */
  readonly freedPerStep: number | null;
}

/** What the steward did over the `windowMs` before `nowMs`. Rows are parsed tolerantly: anything malformed is skipped. */
export function summarizeStewardDecisions(rows: readonly unknown[], nowMs: number, windowMs: number): StewardSummary {
  let decisions = 0;
  let applied = 0;
  let wouldCompact = 0;
  let freedTotal = 0;
  let measured = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    decisions += 1;
    if (row.applied === true) {
      applied += 1;
      if (typeof row.contextBefore === "number" && typeof row.contextAfter === "number" && row.contextBefore > row.contextAfter) {
        freedTotal += row.contextBefore - row.contextAfter;
        measured += 1;
      }
    } else if (row.mode === "measure" && row.compact === true) {
      wouldCompact += 1;
    }
  }
  return { decisions, applied, wouldCompact, freedPerStep: measured === 0 ? null : Math.round(freedTotal / measured) };
}
