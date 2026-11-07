// ---------------------------------------------------------------------------
// The CI watcher (odd/tasks/ci-watcher.md, improvement I-6).
//
// Over a week of the owner's sessions the main thread spent about 580 tool
// calls polling CI (`gh run list|view|watch`, `gh pr checks`) and about 800
// `sleep` calls waiting for it. After a successful `git push`, `gh pr create`
// or `gh pr merge` the mod watches the run itself: it polls `gh run list` at a
// slowing pace, shows a band row and a toast, and in Active tells the agent
// once. In Shadow it only counts the agent's own polls and long sleeps made
// during the watch -- the calls a note would have replaced.
//
// This file is the pure part: the parser of `gh run list --json`, what counts
// as a trigger (the engine's own `gitOperation` first, the command second),
// what counts as the agent's own wait, the poll schedule and the step that
// decides wait / done / stop, the texts, the decision row and its summary. No
// I/O and no node: import, so the mod sandbox can load it. Time is never read
// here: the step counts the delays it scheduled, so the cap is deterministic.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { callDirectory } from "./agent_place.ts";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";
import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { CI_WATCH_CATALOG } from "./i18n_ci_watch.ts";

/** The fields asked of `gh run list --json`; the parser reads exactly these. */
export const CI_RUN_FIELDS = "databaseId,status,conclusion,headBranch,headSha,workflowName,url,createdAt,updatedAt";

// ---------------------------------------------------------------------------
// gh run list --json
// ---------------------------------------------------------------------------

export interface CiRun {
  readonly id: number;
  readonly status: string;
  /** null while the run is not finished (gh prints an empty string). */
  readonly conclusion: string | null;
  readonly branch: string;
  readonly sha: string;
  readonly workflow: string;
  readonly url: string;
  readonly createdAtMs: number;
  /** When the run last changed: for a finished run, about when it ended. 0 when gh did not say. */
  readonly updatedAtMs: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The runs in `gh run list --json <CI_RUN_FIELDS>`'s output; null when it is not a list at all (a failed poll). An entry missing its id, status or sha is skipped. */
export function parseCiRuns(stdout: string): readonly CiRun[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const runs: CiRun[] = [];
  for (const entry of parsed as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const id = entry["databaseId"];
    const status = entry["status"];
    const sha = entry["headSha"];
    if (typeof id !== "number" || typeof status !== "string" || typeof sha !== "string") continue;
    const conclusion = text(entry["conclusion"]);
    const createdAtMs = Date.parse(text(entry["createdAt"]));
    const updatedAtMs = Date.parse(text(entry["updatedAt"]));
    runs.push({
      id,
      status,
      conclusion: conclusion.length > 0 ? conclusion : null,
      branch: text(entry["headBranch"]),
      sha,
      workflow: text(entry["workflowName"]),
      url: text(entry["url"]),
      createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
      updatedAtMs: Number.isNaN(updatedAtMs) ? 0 : updatedAtMs,
    });
  }
  return runs;
}

/** The fields asked of the one lookup of how long a workflow usually takes. */
export const CI_TYPICAL_FIELDS = "createdAt,updatedAt";
/** Fewer finished runs than this are not a history to quote a usual time from. */
const TYPICAL_MIN_RUNS = 3;

/**
 * How long a workflow usually takes, in seconds: the median duration of the
 * successful runs in `gh run list --workflow <name> --status success --json
 * createdAt,updatedAt`. Null with fewer than TYPICAL_MIN_RUNS usable runs or
 * an answer that is not a list: an unknown time is left out, never guessed.
 */
export function parseTypicalSeconds(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seconds: number[] = [];
  for (const entry of parsed as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const span = (Date.parse(text(entry["updatedAt"])) - Date.parse(text(entry["createdAt"]))) / 1000;
    if (Number.isFinite(span) && span > 0) seconds.push(span);
  }
  if (seconds.length < TYPICAL_MIN_RUNS) return null;
  seconds.sort((a, b) => a - b);
  const middle = Math.floor(seconds.length / 2);
  return seconds.length % 2 === 1 ? (seconds[middle] ?? 0) : ((seconds[middle - 1] ?? 0) + (seconds[middle] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// Triggers: what starts a watch
// ---------------------------------------------------------------------------

export type CiTriggerKind = "push" | "pr-create" | "pr-merge";

export interface CiTrigger {
  readonly kind: CiTriggerKind;
  /** The branch pushed, when the command or the engine named one. */
  readonly branch: string | null;
  /** The directory the command ran in (the repository to ask), or null when unknown. */
  readonly dir: string | null;
  readonly pr: number | null;
  readonly url: string | null;
}

/** A finished Bash call, as the tool.call hook sees it after `next`. */
export interface CiBashCall {
  readonly command: string;
  readonly isError: boolean;
  /** stdout and stderr as the model reads them. */
  readonly output: string;
  /** The Bash result's `gitOperation`, untyped on purpose: it is read defensively. */
  readonly gitOperation: unknown;
}

const LEADING_KEYWORDS: ReadonlySet<string> = new Set(["until", "while", "if", "then", "do", "else", "elif", "!", "{", "time", "command", "exec", "nohup"]);
const PUSH_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** The words a simple command runs: its leading `NAME=value` assignments, shell keywords and a subshell's parentheses skipped. */
function runWords(segment: string): readonly string[] {
  const words = tokenize(segment).map((word, index, all) => {
    let cut = word;
    if (index === 0) cut = cut.replace(/^\(+/, "");
    if (index === all.length - 1) cut = cut.replace(/\)+$/, "");
    return cut;
  });
  let at = 0;
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "") || LEADING_KEYWORDS.has(words[at] ?? "") || (words[at] ?? "") === "")) at += 1;
  return words.slice(at);
}

function programName(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

/** The words after `git`'s own global options, starting at the subcommand; null when `words` runs no git. */
function gitSubcommand(words: readonly string[]): readonly string[] | null {
  if (programName(words[0]) !== "git") return null;
  let at = 1;
  while (at < words.length && (words[at] ?? "").startsWith("-")) {
    const option = words[at] ?? "";
    at += option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree" || option === "--namespace" ? 2 : 1;
  }
  return words.slice(at);
}

interface PushRead {
  readonly branch: string | null;
}

/** What a `git push`'s arguments push: null when it is a dry run, a delete, or tags alone. */
function readPush(args: readonly string[]): PushRead | null {
  const positional: string[] = [];
  let tags = false;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg === "--dry-run" || arg === "-n" || arg === "--delete" || arg === "-d") return null;
    if (arg === "--tags") {
      tags = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (PUSH_FLAGS_WITH_VALUE.has(arg)) at += 1;
      continue;
    }
    positional.push(arg);
  }
  const refspec = positional[1];
  if (refspec === undefined) return tags ? null : { branch: null };
  if (refspec.startsWith(":")) return null;
  const destination = refspec.replace(/^\+/, "").split(":").pop() ?? "";
  if (destination === "HEAD" || destination.length === 0) return { branch: null };
  return { branch: destination.replace(/^refs\/heads\//, "") };
}

function pullNumber(value: string): number | null {
  const match = /\/pull\/(\d+)/.exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
}

interface CommandTrigger {
  readonly kind: CiTriggerKind;
  readonly branch: string | null;
  readonly dir: string | null;
  readonly pr: number | null;
}

/** The pushes and pull-request commands a command line contains, each with the directory it ran in. */
function commandTriggers(command: string, base: string | null, home: string | null): readonly CommandTrigger[] {
  const segments = splitOnCommandSeparators(command);
  const found: CommandTrigger[] = [];
  segments.forEach((segment, index) => {
    const words = runWords(segment);
    const dirOf = (): string | null => callDirectory("Bash", { command: segments.slice(0, index + 1).join(" && ") }, base, home) ?? base;
    const git = gitSubcommand(words);
    if (git !== null && git[0] === "push") {
      const push = readPush(git.slice(1));
      if (push !== null) found.push({ kind: "push", branch: push.branch, dir: dirOf(), pr: null });
      return;
    }
    if (programName(words[0]) !== "gh" || words[1] !== "pr") return;
    const args = words.slice(3);
    if (words[2] === "create" && !args.includes("--dry-run")) found.push({ kind: "pr-create", branch: null, dir: dirOf(), pr: null });
    if (words[2] === "merge" && !args.includes("--auto") && !args.includes("--disable-auto")) {
      const target = args.find((arg) => !arg.startsWith("-"));
      const pr = target === undefined ? null : /^\d+$/.test(target) ? Number(target) : pullNumber(target);
      found.push({ kind: "pr-merge", branch: null, dir: dirOf(), pr });
    }
  });
  return found;
}

interface EngineReport {
  readonly pushBranch: string | null | undefined;
  readonly pr: { readonly number: number | null; readonly url: string | null; readonly action: string } | undefined;
}

/** What the engine's own `gitOperation` says: `pushBranch` undefined when it reports no push; `pr` undefined when it reports no pull-request action. */
function engineReport(value: unknown): EngineReport {
  if (!isRecord(value)) return { pushBranch: undefined, pr: undefined };
  const push = value["push"];
  const pr = value["pr"];
  return {
    pushBranch: isRecord(push) && typeof push["branch"] === "string" ? push["branch"] : undefined,
    pr: isRecord(pr) && typeof pr["action"] === "string" ? { number: typeof pr["number"] === "number" ? pr["number"] : null, url: typeof pr["url"] === "string" ? pr["url"] : null, action: pr["action"] } : undefined,
  };
}

/**
 * The watches a finished Bash call starts. The engine's `gitOperation` is the
 * primary signal -- it also tells a queued auto-merge from a merge -- and the
 * command's own words the fallback for a category the engine did not report.
 * A failed call, a dry run, a delete and a push that changed nothing start
 * none. `base` is the session's directory and `home` the person's, to work out
 * where a `cd` or `git -C` ran the command.
 */
export function detectCiTriggers(call: CiBashCall, base: string | null, home: string | null): readonly CiTrigger[] {
  if (call.isError) return [];
  const engine = engineReport(call.gitOperation);
  const fromCommand = commandTriggers(call.command, base, home);
  const upToDate = /Everything up-to-date/.test(call.output);
  const triggers: CiTrigger[] = [];

  const commandPush = fromCommand.find((trigger) => trigger.kind === "push");
  if (!upToDate) {
    if (engine.pushBranch !== undefined) triggers.push({ kind: "push", branch: engine.pushBranch, dir: commandPush?.dir ?? base, pr: null, url: null });
    else if (commandPush !== undefined) triggers.push({ kind: "push", branch: commandPush.branch, dir: commandPush.dir, pr: null, url: null });
  }

  if (engine.pr !== undefined) {
    if (engine.pr.action === "created") {
      const dir = fromCommand.find((trigger) => trigger.kind === "pr-create")?.dir ?? base;
      triggers.push({ kind: "pr-create", branch: null, dir, pr: engine.pr.number, url: engine.pr.url });
    } else if (engine.pr.action === "merged") {
      const dir = fromCommand.find((trigger) => trigger.kind === "pr-merge")?.dir ?? base;
      triggers.push({ kind: "pr-merge", branch: null, dir, pr: engine.pr.number, url: engine.pr.url });
    }
    return triggers;
  }
  for (const trigger of fromCommand) {
    if (trigger.kind === "push") continue;
    const url = /https:\/\/[^\s]+\/pull\/\d+/.exec(call.output)?.[0] ?? null;
    triggers.push({ kind: trigger.kind, branch: null, dir: trigger.dir, pr: trigger.pr ?? (url === null ? null : pullNumber(url)), url: trigger.kind === "pr-create" ? url : null });
  }
  return triggers;
}

/** A cheap test, before any lookup, of whether a Bash call can start a watch at all: a push or pull-request command in it, or the engine reporting a git operation. */
export function couldStartCiWatch(command: string, hasGitOperation: boolean): boolean {
  return hasGitOperation || /\bgit\b[^\n]*\bpush\b/.test(command) || /\bgh\b[^\n]*\bpr\b[^\n]*\b(create|merge)\b/.test(command);
}

/**
 * A finished Bash call from what `next(e)` resolved to (`{ result, text,
 * isError }` from core); null when the call was refused or the answer is not
 * a tool result at all. The model's own text is the output; failing that,
 * the result's stdout and stderr.
 */
export function ciBashCallFrom(command: string, outcome: unknown): CiBashCall | null {
  if (!isRecord(outcome) || typeof outcome["deny"] === "string") return null;
  const result = outcome["result"];
  const body = isRecord(result) ? result : null;
  const output = typeof outcome["text"] === "string" ? outcome["text"] : body === null ? "" : [body["stdout"], body["stderr"]].filter((part): part is string => typeof part === "string").join("\n");
  return { command, isError: outcome["isError"] === true, output, gitOperation: body === null ? undefined : body["gitOperation"] };
}

/** The merge commit and the branch it landed on, from `gh pr view --json mergeCommit,baseRefName`; null while there is no merge commit (a merge still queued). */
export function parsePrMergeView(stdout: string): { readonly sha: string; readonly branch: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const merge = parsed["mergeCommit"];
  const oid = isRecord(merge) ? merge["oid"] : undefined;
  if (typeof oid !== "string" || oid.length === 0) return null;
  const branch = parsed["baseRefName"];
  return { sha: oid, branch: typeof branch === "string" && branch.length > 0 ? branch : null };
}

// ---------------------------------------------------------------------------
// The agent's own waiting: what a notice would replace
// ---------------------------------------------------------------------------

/** A sleep shorter than this is not waiting for CI, so shadow does not count it as replaceable. */
export const CI_LONG_SLEEP_SECONDS = 10;

/**
 * Whether a command polls CI the way the 580-a-week baseline counted it:
 * `gh run list`, `gh run view`, `gh run watch` or `gh pr checks` as a command
 * of its own, wherever it sits in the line (a loop's condition included). A
 * narrower reading than step_phase.ts's CI_WAIT, which also takes `gh pr
 * view|status` and `gh api` because it labels a step's phase, not a count.
 */
export function isCiPollCommand(command: string): boolean {
  for (const segment of splitOnCommandSeparators(command)) {
    const words = runWords(segment);
    if (programName(words[0]) !== "gh") continue;
    if (words[1] === "run" && (words[2] === "list" || words[2] === "view" || words[2] === "watch")) return true;
    if (words[1] === "pr" && words[2] === "checks") return true;
  }
  return false;
}

const SLEEP_UNIT_SECONDS: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** The longest `sleep` of the command in seconds; null when it runs none. */
export function sleepSeconds(command: string): number | null {
  let longest: number | null = null;
  for (const segment of splitOnCommandSeparators(command)) {
    const words = runWords(segment);
    if (programName(words[0]) !== "sleep") continue;
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(words[1] ?? "");
    if (match === null) continue;
    const seconds = Number(match[1]) * (SLEEP_UNIT_SECONDS[match[2] ?? ""] ?? 1);
    if (longest === null || seconds > longest) longest = seconds;
  }
  return longest;
}

export type AgentWaitCall = "ci-poll" | "sleep";

/** What one main-thread tool call is, for the count: a CI poll (a command that also sleeps counts once, as the poll), a sleep of CI_LONG_SLEEP_SECONDS or more, or neither. */
export function classifyAgentCall(tool: string, command: string | null): AgentWaitCall | null {
  if (tool !== "Bash" || command === null) return null;
  if (isCiPollCommand(command)) return "ci-poll";
  const seconds = sleepSeconds(command);
  return seconds !== null && seconds >= CI_LONG_SLEEP_SECONDS ? "sleep" : null;
}

// ---------------------------------------------------------------------------
// The poll schedule and the watch step
// ---------------------------------------------------------------------------

/** The delay before each of the first polls; after them the steady one. */
const POLL_DELAYS_MS: readonly number[] = [10_000, 15_000, 20_000, 30_000, 45_000, 60_000];
const STEADY_DELAY_MS = 90_000;
/** After a poll that found every run finished, the confirming poll is this far away, not a whole back-off. */
const CONFIRM_DELAY_MS = 10_000;
/** The longest a watch lasts. */
export const CI_WATCH_CAP_MS = 60 * 60_000;
/** No run for the sha after this long: no CI runs for it, the watch ends quietly. */
export const CI_NO_RUN_MS = 4 * 60_000;
/** A watch cannot end sooner than this after its last trigger: the runs of a push and of its pull request appear one by one. */
export const CI_SETTLE_MS = 30_000;
/** A run created this long before the trigger still counts: the clocks of GitHub and this machine differ. */
const CLOCK_SLACK_MS = 2 * 60_000;
/** Polls failing this many times in a row (offline, not signed in) end the watch quietly. */
const MAX_FAILED_POLLS = 3;

function pollDelayMs(polls: number): number {
  return POLL_DELAYS_MS[polls] ?? STEADY_DELAY_MS;
}

/** The most `gh run list` calls one watch can make: the schedule's ceiling, which the card states. */
export const CI_WATCH_MAX_POLLS: number = (() => {
  let polls = 1;
  let elapsed = 0;
  while (elapsed + pollDelayMs(polls - 1) <= CI_WATCH_CAP_MS) {
    elapsed += pollDelayMs(polls - 1);
    polls += 1;
  }
  return polls;
})();

export interface CiWatchTarget {
  readonly sha: string;
  /** When the watch was triggered, in epoch milliseconds. */
  readonly sinceMs: number;
}

export interface CiWatchProgress {
  /** Polls made so far. */
  readonly polls: number;
  /** The scheduled time of the next poll, from the start: the sum of the delays chosen, never a clock. */
  readonly elapsedMs: number;
  /** Where the settle window counts from: the start, or the last trigger. */
  readonly settleFromMs: number;
  /** The last poll's runs when all were finished, to compare with the next. */
  readonly signature: string | null;
  readonly failedPolls: number;
  /** `gh` calls made besides the polls (the usual-time lookup): they share the polls' ceiling. */
  readonly lookups: number;
}

export function newCiWatchProgress(): CiWatchProgress {
  return { polls: 0, elapsedMs: 0, settleFromMs: 0, signature: null, failedPolls: 0, lookups: 0 };
}

/** One more `gh` call that is not a poll was made: the watch ends one poll sooner, so the ceiling holds. */
export function noteCiLookup(progress: CiWatchProgress): CiWatchProgress {
  return { ...progress, lookups: progress.lookups + 1 };
}

/** A later trigger on the same sha (a pull request after the push): the settle window starts again and the last agreement is forgotten. */
export function extendCiWatch(progress: CiWatchProgress): CiWatchProgress {
  return { ...progress, settleFromMs: progress.elapsedMs, signature: null, failedPolls: 0 };
}

/**
 * How a watched sha's runs ended. A newer head on the same branch makes the
 * sha superseded whatever its runs said (a merge queue or a push cancels
 * them); with no newer head a failed run is failure, a cancelled one with no
 * failure is cancelled, and only success, skipped and neutral are success.
 */
export type CiVerdictOutcome = "success" | "failure" | "cancelled" | "superseded";

export interface CiVerdict {
  readonly outcome: CiVerdictOutcome;
  readonly url: string;
  readonly workflows: number;
  /** The failed workflows on failure, the cancelled ones on cancelled; empty otherwise. */
  readonly failed: readonly string[];
  /** The newer head's sha7 when superseded, null otherwise. */
  readonly supersededBy: string | null;
  /** From the first run created to the last one updated; null when gh gave no times. */
  readonly durationMs: number | null;
}

export type CiStopReason = "cap" | "no-runs" | "gh-failed";

export type CiWatchStep =
  | { readonly kind: "wait"; readonly delayMs: number; readonly progress: CiWatchProgress; readonly seen: number; readonly running: number; readonly runningNames: readonly string[] }
  | { readonly kind: "done"; readonly verdict: CiVerdict; readonly progress: CiWatchProgress }
  | { readonly kind: "stop"; readonly reason: CiStopReason; readonly progress: CiWatchProgress };

const SUCCESS_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

function shaMatches(runSha: string, target: string): boolean {
  const shorter = Math.min(runSha.length, target.length);
  return shorter >= 7 && runSha.slice(0, shorter).toLowerCase() === target.slice(0, shorter).toLowerCase();
}

function durationOf(runs: readonly CiRun[]): number | null {
  const ends = runs.map((run) => run.updatedAtMs).filter((at) => at > 0);
  const starts = runs.map((run) => run.createdAtMs).filter((at) => at > 0);
  if (ends.length === 0 || starts.length === 0) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/** The newest run on the watched runs' branch for another sha, created after them: a newer head. Null when the branch is unknown or there is none. */
function newerHead(mine: readonly CiRun[], all: readonly CiRun[], target: string): CiRun | null {
  const branch = mine.find((run) => run.branch.length > 0)?.branch;
  if (branch === undefined) return null;
  const latest = Math.max(...mine.map((run) => run.createdAtMs));
  let newest: CiRun | null = null;
  for (const run of all) {
    if (run.branch !== branch || shaMatches(run.sha, target) || run.createdAtMs <= latest) continue;
    if (newest === null || run.createdAtMs > newest.createdAtMs) newest = run;
  }
  return newest;
}

function verdictOf(mine: readonly CiRun[], all: readonly CiRun[], target: string): CiVerdict {
  const base = { workflows: mine.length, durationMs: durationOf(mine) };
  const newer = newerHead(mine, all, target);
  if (newer !== null) return { ...base, outcome: "superseded", url: mine[0]?.url ?? "", failed: [], supersededBy: newer.sha.slice(0, 7) };
  const notPassed = mine.filter((run) => !SUCCESS_CONCLUSIONS.has(run.conclusion ?? ""));
  const failed = notPassed.filter((run) => run.conclusion !== "cancelled");
  const shown = failed.length > 0 ? failed : notPassed;
  return {
    ...base,
    outcome: failed.length > 0 ? "failure" : notPassed.length > 0 ? "cancelled" : "success",
    url: (shown[0] ?? mine[0])?.url ?? "",
    failed: shown.map((run) => run.workflow),
    supersededBy: null,
  };
}

/**
 * One poll's answer to what happens next. `runs` is `gh run list`'s parsed
 * answer, null when the poll failed. A watch is done when every run of the sha
 * is finished, two polls in a row agree on that, and the settle window since
 * the last trigger has passed; it stops quietly after the cap, when no run for
 * the sha appears, or after repeated failed polls. Elapsed time is the sum of
 * the delays this scheduled, so the cap also bounds the number of polls.
 */
export function ciWatchStep(progress: CiWatchProgress, runs: readonly CiRun[] | null, target: CiWatchTarget): CiWatchStep {
  const polls = progress.polls + 1;
  const at: CiWatchProgress = { ...progress, polls };
  if (runs === null) {
    const failedPolls = progress.failedPolls + 1;
    if (failedPolls >= MAX_FAILED_POLLS) return { kind: "stop", reason: "gh-failed", progress: { ...at, failedPolls } };
    return schedule({ ...at, failedPolls, signature: null }, pollDelayMs(progress.polls), 0, 0, []);
  }
  const mine = runs.filter((run) => shaMatches(run.sha, target.sha) && run.createdAtMs >= target.sinceMs - CLOCK_SLACK_MS);
  const open = mine.filter((run) => run.status !== "completed");
  const base: CiWatchProgress = { ...at, failedPolls: 0 };
  if (mine.length === 0) {
    if (progress.elapsedMs >= CI_NO_RUN_MS) return { kind: "stop", reason: "no-runs", progress: { ...base, signature: null } };
    return schedule({ ...base, signature: null }, pollDelayMs(progress.polls), 0, 0, []);
  }
  if (open.length > 0) return schedule({ ...base, signature: null }, pollDelayMs(progress.polls), mine.length, open.length, open.map((run) => run.workflow));
  const signature = mine.map((run) => `${run.id}:${run.conclusion ?? ""}`).sort().join(",");
  if (signature === progress.signature && progress.elapsedMs - progress.settleFromMs >= CI_SETTLE_MS) return { kind: "done", verdict: verdictOf(mine, runs, target.sha), progress: { ...base, signature } };
  return schedule({ ...base, signature }, CONFIRM_DELAY_MS, mine.length, 0, []);
}

/** The wait step for `delayMs` more, or the cap's stop when that would pass it. */
function schedule(progress: CiWatchProgress, delayMs: number, seen: number, running: number, runningNames: readonly string[]): CiWatchStep {
  if (progress.elapsedMs + delayMs > CI_WATCH_CAP_MS || progress.polls + progress.lookups >= CI_WATCH_MAX_POLLS) return { kind: "stop", reason: "cap", progress };
  return { kind: "wait", delayMs, seen, running, runningNames, progress: { ...progress, elapsedMs: progress.elapsedMs + delayMs } };
}

// ---------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------

/** The most failed workflows the note names. */
const NOTE_FAILED_NAMES = 3;

export interface CiLabel {
  readonly sha7: string;
  readonly branch: string | null;
}

function namedList(names: readonly string[]): string {
  if (names.length <= NOTE_FAILED_NAMES) return names.join(", ");
  return `${names.slice(0, NOTE_FAILED_NAMES).join(", ")} and ${names.length - NOTE_FAILED_NAMES} more`;
}

/** The one line the agent reads when the run has ended. English on purpose: it is for the model. */
export function ciNoteText(label: CiLabel, verdict: CiVerdict): string {
  const where = label.branch === null ? "" : ` on ${label.branch}`;
  const outcome =
    verdict.outcome === "superseded" && verdict.supersededBy !== null
      ? `superseded by ${verdict.supersededBy}`
      : (verdict.outcome === "failure" || verdict.outcome === "cancelled") && verdict.failed.length > 0
        ? `${verdict.outcome} (${namedList(verdict.failed)})`
        : verdict.outcome;
  return `CI for ${label.sha7}${where}: ${outcome}, ${verdict.url}`;
}

/** Whether a prompt's text is the note ciNoteText writes. The hook also checks the prompt came from a plugin. */
export function isCiWatchNote(text: string): boolean {
  return /^CI for [0-9a-f]{7}( on \S+)?: (success|failure|cancelled|superseded)\b/.test(text);
}

/** One row of the band: a watch, running or lately ended. Plain data, kept in `$.state`. */
export interface CiBandRow {
  readonly id: string;
  readonly sha7: string;
  readonly branch: string | null;
  readonly status: "watching" | CiVerdictOutcome;
  readonly startedAtMs: number;
  readonly done: number;
  readonly total: number;
  readonly failed: readonly string[];
  /** The workflows still running (empty while none has appeared, and once finished). */
  readonly running: readonly string[];
  /** How long `typicalWorkflow` usually takes, from its last successful runs; both null when unknown. */
  readonly typicalWorkflow: string | null;
  readonly typicalSeconds: number | null;
  /** How long the runs took, once finished; null when gh gave no times (the watch's own clock is used). */
  readonly durationMs: number | null;
  readonly finishedAtMs: number | null;
  /** The newer head's sha7 on a superseded row; absent on every other row. */
  readonly supersededBy?: string;
}

const BAND_STATUSES: ReadonlySet<unknown> = new Set(["watching", "success", "failure", "cancelled", "superseded"]);

/** How long a finished row stays in the band. */
export const CI_ROW_KEEP_MS = 120_000;

function isNames(value: unknown): boolean {
  return Array.isArray(value) && (value as readonly unknown[]).every((name) => typeof name === "string");
}

function isBandRow(value: unknown): value is CiBandRow {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["sha7"] === "string" &&
    (value["branch"] === null || typeof value["branch"] === "string") &&
    BAND_STATUSES.has(value["status"]) &&
    (value["supersededBy"] === undefined || typeof value["supersededBy"] === "string") &&
    typeof value["startedAtMs"] === "number" &&
    typeof value["done"] === "number" &&
    typeof value["total"] === "number" &&
    Array.isArray(value["failed"]) &&
    (value["failed"] as readonly unknown[]).every((name) => typeof name === "string") &&
    isNames(value["running"]) &&
    (value["typicalWorkflow"] === null || typeof value["typicalWorkflow"] === "string") &&
    (value["typicalSeconds"] === null || typeof value["typicalSeconds"] === "number") &&
    (value["durationMs"] === null || typeof value["durationMs"] === "number") &&
    (value["finishedAtMs"] === null || typeof value["finishedAtMs"] === "number")
  );
}

/** The rows in the `ciWatches` state value (`{ rows }`); anything malformed is an empty list, a bad row is dropped. */
export function parseCiBandRows(value: unknown): readonly CiBandRow[] {
  if (!isRecord(value) || !Array.isArray(value["rows"])) return [];
  return (value["rows"] as readonly unknown[]).filter(isBandRow);
}

/** `branch (sha7)`, the sha alone when the branch is unknown. */
function labelOf(row: CiBandRow): string {
  return row.branch === null ? row.sha7 : `${row.branch} (${row.sha7})`;
}

/** A duration for a person: seconds under a minute, then minutes, then hours and minutes. Not locale-bound: the units are the same in es and en. */
export function formatCiDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/** A run is "slower than usual" when it passed the usual time by a quarter and by at least this long: a short job's ratio alone says little. */
const SLOW_MIN_OVERRUN_MS = 3 * 60_000;
const SLOW_RATIO = 1.25;

export function ciIsSlow(typicalSeconds: number, elapsedMs: number): boolean {
  const typicalMs = typicalSeconds * 1000;
  return elapsedMs >= typicalMs * SLOW_RATIO && elapsedMs - typicalMs >= SLOW_MIN_OVERRUN_MS;
}

function quoted(locale: Locale, name: string): string {
  return locale === "es" ? `«${name}»` : `"${name}"`;
}

function quotedList(locale: Locale, names: readonly string[]): string {
  return names.map((name) => quoted(locale, name)).join(", ");
}

/** The line for a watch that ended: passed in so long, failed or cancelled with the workflows named and when, or superseded by the newer head. */
export function ciFinishedText(locale: Locale, row: CiBandRow): string {
  const elapsed = formatCiDuration(row.durationMs ?? Math.max(0, (row.finishedAtMs ?? row.startedAtMs) - row.startedAtMs));
  if (row.status === "success") return translate(CI_WATCH_CATALOG, locale, "band.passed", { label: labelOf(row), elapsed });
  if (row.status === "superseded") return translate(CI_WATCH_CATALOG, locale, "band.superseded", { label: labelOf(row), sha7: row.supersededBy ?? "?", elapsed });
  if (row.status === "cancelled") return translate(CI_WATCH_CATALOG, locale, "band.cancelled", { label: labelOf(row), workflows: row.failed.length > 0 ? ` ${quotedList(locale, row.failed)}` : "", elapsed });
  return translate(CI_WATCH_CATALOG, locale, "band.failed", { label: labelOf(row), workflows: row.failed.length > 0 ? ` ${quotedList(locale, row.failed)}` : "", elapsed });
}

/** The line for a watch still running: what runs and for how long, how many are done, and how long it usually takes. */
function ciRunningText(locale: Locale, row: CiBandRow, nowMs: number): string {
  const label = labelOf(row);
  const elapsedMs = Math.max(0, nowMs - row.startedAtMs);
  const elapsed = formatCiDuration(elapsedMs);
  if (row.total === 0) return translate(CI_WATCH_CATALOG, locale, "band.waiting", { label, elapsed, limit: String(CI_NO_RUN_MS / 60_000) });
  let line = translate(CI_WATCH_CATALOG, locale, "band.running", { label, names: quotedList(locale, row.running), elapsed });
  if (row.total > 1) line += translate(CI_WATCH_CATALOG, locale, "band.part.done", { done: String(row.done), total: String(row.total) });
  if (row.typicalWorkflow !== null && row.typicalSeconds !== null && row.running.includes(row.typicalWorkflow)) {
    const typical = formatCiDuration(row.typicalSeconds * 1000);
    line += row.running.length > 1 ? translate(CI_WATCH_CATALOG, locale, "band.part.typicalOf", { name: quoted(locale, row.typicalWorkflow), typical }) : translate(CI_WATCH_CATALOG, locale, "band.part.typical", { typical });
    if (ciIsSlow(row.typicalSeconds, elapsedMs)) line += translate(CI_WATCH_CATALOG, locale, "band.part.slow");
  }
  return line;
}

function fitLine(line: string, columns: number): string {
  if (line.length <= columns) return line;
  return columns <= 1 ? line.slice(0, Math.max(columns, 0)) : `${line.slice(0, columns - 1)}…`;
}

/**
 * The band lines for the watches kept in state, each within `columns`. A
 * running watch older than the cap is dropped (a reload left it behind and
 * nothing polls it), and a finished row after CI_ROW_KEEP_MS.
 */
export function ciBandRows(locale: Locale, rows: readonly CiBandRow[], nowMs: number, columns: number): readonly string[] {
  return ciShownRows(locale, rows, nowMs).map(({ text }) => fitLine(text, columns));
}

/** The rows the band shows now, each with its line at full length: a watch past its cap and a finished row past CI_ROW_KEEP_MS are left out. */
export function ciShownRows(locale: Locale, rows: readonly CiBandRow[], nowMs: number): readonly { readonly row: CiBandRow; readonly text: string }[] {
  const shown: { readonly row: CiBandRow; readonly text: string }[] = [];
  for (const row of rows) {
    if (row.status === "watching") {
      if (nowMs - row.startedAtMs > CI_WATCH_CAP_MS) continue;
      shown.push({ row, text: ciRunningText(locale, row, nowMs) });
    } else {
      if (row.finishedAtMs === null || nowMs - row.finishedAtMs > CI_ROW_KEEP_MS) continue;
      shown.push({ row, text: ciFinishedText(locale, row) });
    }
  }
  return shown;
}

// ---------------------------------------------------------------------------
// The decision row and its summary
// ---------------------------------------------------------------------------

/** `ci-watch-decisions-YYYY-MM-DDTHH.jsonl`, one file per UTC hour like the other decision logs. */
export const CI_WATCH_DECISIONS_FILE_PATTERN = /^ci-watch-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

export function ciWatchDecisionFileName(atIso: string): string {
  return `ci-watch-decisions-${atIso.slice(0, 13)}.jsonl`;
}

export type CiWatchOutcome = CiVerdictOutcome | "no-runs" | "cap" | "gh-failed" | "gh-missing";

export interface CiWatchRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly mode: "shadow" | "active";
  readonly trigger: CiTriggerKind;
  readonly outcome: CiWatchOutcome;
  readonly watchedMs: number;
  readonly ghCalls: number;
  readonly agentPolls: number;
  readonly agentSleeps: number;
  /** The person saw the toast. */
  readonly notified: boolean;
  /** The note was submitted to the agent (Active only). */
  readonly injected: boolean;
}

export interface CiWatchRecord {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly mode: "shadow" | "active";
  readonly trigger: CiTriggerKind;
  readonly outcome: CiWatchOutcome;
  readonly watchedSeconds: number;
  readonly ghCalls: number;
  readonly agentPolls: number;
  readonly agentSleeps: number;
  readonly notified: boolean;
  readonly injected: boolean;
}

/** One log line, written when a watch ends: numbers and names only, never a command, a path, a branch, a sha or a url. */
export function ciWatchRecord(input: CiWatchRecordInput): CiWatchRecord {
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    sessionId: input.sessionId,
    mode: input.mode,
    trigger: input.trigger,
    outcome: input.outcome,
    watchedSeconds: Math.round(input.watchedMs / 1000),
    ghCalls: input.ghCalls,
    agentPolls: input.agentPolls,
    agentSleeps: input.agentSleeps,
    notified: input.notified,
    injected: input.injected,
  };
}

export interface CiWatchSummary {
  /** Watches that ended in the window, whatever the way. */
  readonly watches: number;
  /** Of them, the ones whose run ended with a verdict: success, failure, cancelled or superseded. */
  readonly finished: number;
  readonly failed: number;
  readonly ghCalls: number;
  /** The agent's own CI polls made during a watch: what a notice would have replaced. */
  readonly pollsReplaced: number;
  readonly sleepsReplaced: number;
  readonly injected: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What the module measured over the `windowMs` before `nowMs`. Rows are read tolerantly: anything malformed is skipped. */
export function summarizeCiWatchRows(rows: readonly unknown[], nowMs: number, windowMs: number): CiWatchSummary {
  let watches = 0;
  let finished = 0;
  let failed = 0;
  let ghCalls = 0;
  let pollsReplaced = 0;
  let sleepsReplaced = 0;
  let injected = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row["at"] !== "string") continue;
    const atMs = Date.parse(row["at"]);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    watches += 1;
    if (row["outcome"] === "success" || row["outcome"] === "failure" || row["outcome"] === "cancelled" || row["outcome"] === "superseded") finished += 1;
    if (row["outcome"] === "failure") failed += 1;
    ghCalls += count(row["ghCalls"]);
    pollsReplaced += count(row["agentPolls"]);
    sleepsReplaced += count(row["agentSleeps"]);
    if (row["injected"] === true) injected += 1;
  }
  return { watches, finished, failed, ghCalls, pollsReplaced, sleepsReplaced, injected };
}
