// JEVADV-111: advice that never changes the next command becomes a silent
// judgement.
//
// A risk advice refuses the model's attempt once and lets an identical retry
// through (gate_advice_retry.ts). When the model re-runs the very same text,
// the advice changed nothing: it only cost a step and stopped autonomy.
//
// This module learns, per project and ADVICE KEY, what each risk advice led
// to:
//   "same"    -- the identical command was retried inside the retry window;
//   "changed" -- the window closed with no identical retry, so the model ran
//                something else (or nothing).
// Once the last SILENT_AFTER outcomes of a (project, key) were all "same", a
// later risk advice there is judged silently: the command runs and the
// advice reaches the model as context, with no refused attempt. One "changed"
// outcome, or OUTCOME_TTL_MS with no outcome, ends that.
//
// The advice key (adviceKey below) is the program and its subcommand words of
// the ONE command that runs -- `gh pr view`, `git branch`, `orca game state`.
// It is not the command family of gate_measurement.ts: a family can be the
// first word of a compound line (`for`, `echo x && ...`) or a container that
// runs anything (`bash -c`, `ssh host`, `npx`, `make`, a package script), so
// it does not pin down what executes. A command without a key is never
// silenced: a compound line, a substitution, a container, a path, or a
// subcommand that writes outward or cannot be undone (git push, every gh
// subcommand but the reading ones, anything that deletes, merges, releases,
// deploys or publishes).
//
// Only risk-stage advice is ever learned or silenced. A deny, a local rule's
// advice, a policy (prohibits, requires_human, the queue) and the
// deploy/publish floor never reach this module's pass: the gate only consults
// it where it would otherwise emit a risk advice.
//
// Pure: the store is a plain value and every function returns a new one; the
// adapter (adapters/claude/gate-bash.ts) reads and writes the file.

import { ADVICE_RETRY_WINDOW_MS } from "./gate_advice_retry.ts";
import { canonicalCommandFamily, commandFamily, splitSegments, stripRunners, type GateDecisionRecord } from "./gate_measurement.ts";

/** The store's file name in the cache dir. */
export const ADVICE_OUTCOMES_FILE = "gate-advice-outcomes.json";

/** How many consecutive identical retries, and nothing else, make a (project, key) silent. */
export const SILENT_AFTER = 8;

/** How many recent outcomes each (project, key) keeps. */
export const RECENT_OUTCOMES = 20;

/** A (project, key) with no outcome for this long forgets what it learned and is advised again. */
export const OUTCOME_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Families whose advice is never silenced: the ones whose mistake cannot be
 * taken back (deletes, discards, infra, databases, piping a download into a
 * shell), the package scripts (a script runs anything), and `other`.
 */
export const NEVER_SILENT_FAMILIES: ReadonlySet<string> = new Set([
  "rm -rf",
  "git discard",
  "git push",
  "kubectl",
  "terraform",
  "docker",
  "sql drop/truncate",
  "db client",
  "aws cli",
  "curl | shell",
  "package script",
  "other",
]);

/**
 * Programs that run whatever they are given, so their name never pins down
 * what executes: shells, interpreters, shell keywords and builtins, remote
 * and wrapped execution, task runners. Also network transfer and deploy
 * tools, whose every use writes somewhere outside the machine.
 */
const NEVER_SILENT_PROGRAMS: ReadonlySet<string> = new Set([
  // shells
  "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd",
  // interpreters
  "python", "node", "deno", "bun", "ruby", "perl", "php", "lua", "rscript", "osascript", "java", "tsx", "ts-node", "awk", "gawk", "jq",
  // shell keywords and builtins
  "for", "while", "until", "if", "case", "select", "function", "do", "done", "then", "else", "fi", "esac", "time", "exec", "eval", "source", ".",
  "set", "unset", "export", "exit", "return", "read", "shift", "trap", "alias", "print", "echo", "printf", "test", "true", "false", "builtin", "command",
  // wrapped or remote execution
  "sudo", "doas", "su", "env", "nohup", "nice", "timeout", "watch", "xargs", "parallel", "ssh", "mosh", "script", "expect", "tmux", "screen",
  "npx", "pnpx", "bunx", "uvx", "pipx", "dlx",
  // task runners and package scripts
  "make", "gmake", "just", "task", "rake", "gradle", "gradlew", "mvn", "invoke", "nox", "tox",
  // network transfer and deploy tools
  "curl", "wget", "http", "https", "scp", "sftp", "ftp", "rsync", "nc", "ncat", "socat", "telnet",
  "helm", "pulumi", "vercel", "netlify", "fly", "flyctl", "heroku", "firebase", "wrangler", "serverless", "sls", "sam", "cdk", "ansible", "ansible-playbook",
]);

/** Interpreters with a version in the name: python3, python3.12, node22, ruby3.2, perl5, php8. */
const VERSIONED_INTERPRETER = /^(?:python|node|ruby|perl|php|lua)\d+(?:\.\d+)*$/;

/** Programs whose subcommand words name what runs; the value is how many words. Every other program keys on its name alone. */
const SUBCOMMAND_DEPTH: Readonly<Record<string, number>> = {
  gh: 2,
  orca: 2,
  gcloud: 2,
  az: 2,
  git: 1,
  npm: 1,
  pnpm: 1,
  yarn: 1,
  cargo: 1,
  go: 1,
  pip: 1,
  pip3: 1,
  uv: 1,
  poetry: 1,
  brew: 1,
  systemctl: 1,
};

/** The only gh subcommands that may go silent: they read, or act only on this machine. Everything else in gh writes to GitHub. */
const GH_LOCAL_VERBS: ReadonlySet<string> = new Set(["view", "list", "ls", "status", "checks", "diff", "checkout", "watch", "download", "search"]);

/** A key word that names an outward or irreversible action. */
const OUTWARD_WORD = /^(?:push|publish|deploy|release|merge|delete|destroy|remove|rm|close|apply|drop|purge|prune|upload|send|post|submit|rollout|promote|run|exec|install|uninstall|restart|start|stop|reload|kill|enable|disable|mask)$/;

const KEY_WORD = /^[a-z][a-z0-9-]{0,30}$/;
const PROGRAM_WORD = /^[a-z][a-z0-9._+-]{0,23}$/;

/** A word that only changes directory: never counted as the command that runs. */
function onlyChangesDirectory(segment: string): boolean {
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(segment);
}

/**
 * The advice key of `command`: the program and subcommand words of the ONE
 * command it runs, or null when the command may never be silenced. Only plain
 * lowercase words go into a key -- never an argument, a path or anything that
 * could hold a secret -- so it is as safe to log as the command family.
 */
export function adviceKey(command: string): string | null {
  if (NEVER_SILENT_FAMILIES.has(canonicalCommandFamily(commandFamily(command)))) return null;
  // A substitution, a process substitution or a heredoc runs or feeds
  // something the key cannot name.
  if (/\$\(|`|<\(|>\(|<</.test(command)) return null;
  const segments = splitSegments(command)
    .map((segment) => stripRunners(segment.trim()))
    .filter((segment) => segment.length > 0 && !onlyChangesDirectory(segment));
  if (segments.length !== 1) return null;
  const words = (segments[0] ?? "").split(/\s+/);
  const program = words[0] ?? "";
  if (!PROGRAM_WORD.test(program) || NEVER_SILENT_PROGRAMS.has(program) || VERSIONED_INTERPRETER.test(program)) return null;
  const depth = SUBCOMMAND_DEPTH[program] ?? 0;
  const subcommands = words.slice(1, 1 + depth);
  if (subcommands.length !== depth || !subcommands.every((word) => KEY_WORD.test(word))) return null;
  // gh: only the reading verbs, whatever the group (`gh run view` reads,
  // `gh workflow run` dispatches a workflow). Every other program: no word
  // that names an outward or irreversible action.
  if (program === "gh") {
    if (subcommands[0] === "api" || !GH_LOCAL_VERBS.has(subcommands[1] ?? "")) return null;
  } else if (subcommands.some((word) => OUTWARD_WORD.test(word))) return null;
  return [program, ...subcommands].join(" ");
}

export type AdviceOutcome = "same" | "changed";

export interface KeyOutcomes {
  /** Oldest first, at most RECENT_OUTCOMES. */
  readonly recent: readonly AdviceOutcome[];
  /** When the newest outcome was recorded (ISO). */
  readonly lastAt: string;
}

/** An advice issued and not yet resolved: its (project, key) store key and when it was issued (ms). */
export interface PendingAdvice {
  readonly key: string;
  readonly at: number;
}

export interface AdviceOutcomeStore {
  readonly version: 2;
  /** Keyed by outcomeKey(project, adviceKey). */
  readonly keys: Readonly<Record<string, KeyOutcomes>>;
  /** Keyed by the advice-retry key (gate_advice_retry.ts's adviceRetryKey). */
  readonly pending: Readonly<Record<string, PendingAdvice>>;
}

export const EMPTY_ADVICE_OUTCOMES: AdviceOutcomeStore = { version: 2, keys: {}, pending: {} };

/** The (project, advice key) store key. A NUL keeps `("a", "b c")` apart from `("a b", "c")`. */
export function outcomeKey(project: string | null, key: string): string {
  return `${project ?? ""}\u0000${key}`;
}

/** Never throws: anything malformed (or a store from another version) is dropped, which only means advising again. */
export function parseAdviceOutcomes(raw: unknown): AdviceOutcomeStore {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 2) return EMPTY_ADVICE_OUTCOMES;
  const keys: Record<string, KeyOutcomes> = {};
  const rawKeys = (raw as { keys?: unknown }).keys;
  if (typeof rawKeys === "object" && rawKeys !== null) {
    for (const [key, value] of Object.entries(rawKeys as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { recent, lastAt } = value as { recent?: unknown; lastAt?: unknown };
      if (!Array.isArray(recent) || typeof lastAt !== "string" || !Number.isFinite(Date.parse(lastAt))) continue;
      const outcomes = recent.filter((item): item is AdviceOutcome => item === "same" || item === "changed").slice(-RECENT_OUTCOMES);
      keys[key] = { recent: outcomes, lastAt };
    }
  }
  const pending: Record<string, PendingAdvice> = {};
  const rawPending = (raw as { pending?: unknown }).pending;
  if (typeof rawPending === "object" && rawPending !== null) {
    for (const [id, value] of Object.entries(rawPending as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { key, at } = value as { key?: unknown; at?: unknown };
      if (typeof key === "string" && typeof at === "number" && Number.isFinite(at)) pending[id] = { key, at };
    }
  }
  return { version: 2, keys, pending };
}

function withOutcome(keys: Readonly<Record<string, KeyOutcomes>>, key: string, outcome: AdviceOutcome, now: number): Record<string, KeyOutcomes> {
  const previous = keys[key]?.recent ?? [];
  return { ...keys, [key]: { recent: [...previous, outcome].slice(-RECENT_OUTCOMES), lastAt: new Date(now).toISOString() } };
}

/**
 * Resolves every pending advice whose retry window has closed as "changed",
 * and forgets every (project, key) with no outcome for OUTCOME_TTL_MS.
 */
export function settleAdviceOutcomes(store: AdviceOutcomeStore, now: number): AdviceOutcomeStore {
  let keys: Record<string, KeyOutcomes> = { ...store.keys };
  const pending: Record<string, PendingAdvice> = {};
  for (const [id, advice] of Object.entries(store.pending)) {
    if (now - advice.at < ADVICE_RETRY_WINDOW_MS) pending[id] = advice;
    else keys = withOutcome(keys, advice.key, "changed", advice.at + ADVICE_RETRY_WINDOW_MS);
  }
  for (const [key, outcomes] of Object.entries(keys)) {
    if (now - Date.parse(outcomes.lastAt) >= OUTCOME_TTL_MS) delete keys[key];
  }
  return { version: 2, keys, pending };
}

/** A risk advice was just issued for the command behind `retryKey`, whose advice key is `key`. */
export function recordAdviceIssued(store: AdviceOutcomeStore, retryKey: string, project: string | null, key: string, now: number): AdviceOutcomeStore {
  const settled = settleAdviceOutcomes(store, now);
  return { ...settled, pending: { ...settled.pending, [retryKey]: { key: outcomeKey(project, key), at: now } } };
}

/** The identical command behind `retryKey` was retried. Only a pending risk advice counts; anything else returns the store unchanged. */
export function recordIdenticalRetry(store: AdviceOutcomeStore, retryKey: string, now: number): AdviceOutcomeStore {
  const advice = store.pending[retryKey];
  if (advice === undefined || now - advice.at >= ADVICE_RETRY_WINDOW_MS) return settleAdviceOutcomes(store, now);
  const pending = { ...store.pending };
  delete pending[retryKey];
  return settleAdviceOutcomes({ version: 2, keys: withOutcome(store.keys, advice.key, "same", now), pending }, now);
}

/** Whether a risk advice for (project, key) is judged silently: its last SILENT_AFTER outcomes were all identical retries. */
export function isSilentKey(store: AdviceOutcomeStore, project: string | null, key: string, now: number): boolean {
  const outcomes = settleAdviceOutcomes(store, now).keys[outcomeKey(project, key)];
  if (outcomes === undefined || outcomes.recent.length < SILENT_AFTER) return false;
  return outcomes.recent.slice(-SILENT_AFTER).every((outcome) => outcome === "same");
}

// ---------------------------------------------------------------------------
// Measurement and replay over the decision log (gate-decisions-*.jsonl).
// The log keeps neither the command nor the session, so an advice is linked
// to its identical retry the way the gate itself records one: an
// `advice-retry` allow in the same project with the same advice key inside the
// retry window. A record written before the advice key existed carries none:
// it can never be silenced, and the replay counts it apart.
// ---------------------------------------------------------------------------

export interface KeyAdviceMeasure {
  readonly key: string;
  /** Risk advices issued. */
  readonly advised: number;
  /** Of those, followed by an identical retry: the advice changed nothing. */
  readonly retried: number;
  /** Risk advices a replay of the learning rule would have judged silently. */
  readonly wouldBeSilent: number;
  /** Of those, advices whose next command was NOT the same: silencing them would have hidden an advice that mattered. */
  readonly wouldBeSilentChanged: number;
  /** Judged silently by the live gate. */
  readonly silent: number;
}

export interface AdviceReplay {
  readonly keys: readonly KeyAdviceMeasure[];
  readonly advised: number;
  readonly retried: number;
  readonly wouldBeSilent: number;
  readonly wouldBeSilentChanged: number;
  /** Risk advices with no advice key: a compound line, a container, an outward subcommand, or a record from before the key existed. Never silenced. */
  readonly unkeyed: number;
  /** Of those, how many were re-run unchanged. */
  readonly unkeyedRetried: number;
  /** Decisions the replay leaves exactly as they were: every deny, ask, policy, queue, local rule and allow. */
  readonly untouched: number;
  /** Risk advices the live gate already judged silently (stopReason "silent"). */
  readonly silentLive: number;
}

function isRiskAdvice(record: GateDecisionRecord): boolean {
  return record.verdict === "advise" && record.stopReason === "risk";
}

function isRiskRetry(record: GateDecisionRecord): boolean {
  return record.verdict === "allow" && record.stopReason === "advice-retry" && record.source !== "local-rule";
}

function linkKey(record: GateDecisionRecord): string {
  return record.adviceKey ?? `family:${canonicalCommandFamily(record.commandFamily)}`;
}

/**
 * Replays the decision log in time order through the learning rule above.
 * Each risk advice is linked to the first unclaimed identical retry in its
 * project with the same advice key (the family, for an unkeyed record) inside
 * the window ("same"), else it is "changed". A keyed risk advice the rule
 * would have silenced at that moment is counted in `wouldBeSilent`, and in
 * `wouldBeSilentChanged` when its next command was not the same; it still
 * teaches the rule what really happened.
 */
export function replayAdviceOutcomes(records: readonly GateDecisionRecord[]): AdviceReplay {
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const claimed = new Set<number>();
  const outcomeOf = new Map<number, AdviceOutcome>();
  sorted.forEach((record, index) => {
    if (!isRiskAdvice(record)) return;
    const at = Date.parse(record.at);
    const link = linkKey(record);
    let outcome: AdviceOutcome = "changed";
    for (let next = index + 1; next < sorted.length; next++) {
      const candidate = sorted[next]!;
      if (Date.parse(candidate.at) - at >= ADVICE_RETRY_WINDOW_MS) break;
      if (claimed.has(next) || !isRiskRetry(candidate)) continue;
      if (candidate.project !== record.project || linkKey(candidate) !== link) continue;
      claimed.add(next);
      outcome = "same";
      break;
    }
    outcomeOf.set(index, outcome);
  });

  let store = EMPTY_ADVICE_OUTCOMES;
  const byKey = new Map<string, { advised: number; retried: number; wouldBeSilent: number; wouldBeSilentChanged: number; silent: number }>();
  const countsFor = (key: string) => {
    const counts = byKey.get(key) ?? { advised: 0, retried: 0, wouldBeSilent: 0, wouldBeSilentChanged: 0, silent: 0 };
    byKey.set(key, counts);
    return counts;
  };
  let untouched = 0;
  let unkeyed = 0;
  let unkeyedRetried = 0;
  let silentLive = 0;
  sorted.forEach((record, index) => {
    const outcome = outcomeOf.get(index);
    if (record.stopReason === "silent") {
      silentLive++;
      if (record.adviceKey !== undefined) countsFor(record.adviceKey).silent++;
    }
    if (outcome === undefined) {
      untouched++;
      return;
    }
    if (record.adviceKey === undefined) {
      unkeyed++;
      if (outcome === "same") unkeyedRetried++;
      return;
    }
    const at = Date.parse(record.at);
    const counts = countsFor(record.adviceKey);
    counts.advised++;
    if (outcome === "same") counts.retried++;
    if (isSilentKey(store, record.project, record.adviceKey, at)) {
      counts.wouldBeSilent++;
      if (outcome === "changed") counts.wouldBeSilentChanged++;
    }
    const id = `replay-${index}`;
    store = recordAdviceIssued(store, id, record.project, record.adviceKey, at);
    store = outcome === "same" ? recordIdenticalRetry(store, id, at) : settleAdviceOutcomes(store, at + ADVICE_RETRY_WINDOW_MS);
  });

  const keys = [...byKey.entries()]
    .map(([key, counts]) => ({ key, ...counts }))
    .filter((item) => item.advised > 0 || item.silent > 0)
    .sort((a, b) => b.advised - a.advised || a.key.localeCompare(b.key));
  const sum = (pick: (item: KeyAdviceMeasure) => number) => keys.reduce((total, item) => total + pick(item), 0);
  return {
    keys,
    advised: sum((item) => item.advised),
    retried: sum((item) => item.retried),
    wouldBeSilent: sum((item) => item.wouldBeSilent),
    wouldBeSilentChanged: sum((item) => item.wouldBeSilentChanged),
    unkeyed,
    unkeyedRetried,
    untouched,
    silentLive,
  };
}

/** What the decision files cover, so a range with nothing in it can say what the files do hold. */
export interface ReplayCoverage {
  readonly from: string | null;
  readonly to: string | null;
  readonly filesRead: number;
  readonly recordsInRange: number;
  readonly oldest: string | null;
  readonly newest: string | null;
}

/** The replay as Markdown: a line of totals, then one row per advice key (keep that table local: it names the commands that ran). */
export function formatAdviceReplayMarkdown(replay: AdviceReplay, coverage: ReplayCoverage, { totalsOnly = false }: { readonly totalsOnly?: boolean } = {}): string {
  const range = `${coverage.from ?? "the start"} to ${coverage.to ?? "now"}`;
  if (coverage.filesRead === 0) return `No gate decision files were found, so there is nothing to replay for ${range}.\n`;
  if (coverage.recordsInRange === 0) {
    return `No gate decisions fall in ${range}. The files read (${coverage.filesRead}) hold decisions from ${coverage.oldest ?? "?"} to ${coverage.newest ?? "?"}.\n`;
  }
  const share = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);
  const lines = [
    `Decisions ${range}: ${coverage.recordsInRange} (files hold ${coverage.oldest ?? "?"} to ${coverage.newest ?? "?"}).`,
    `Keyed risk advices: ${replay.advised}, re-run unchanged ${replay.retried} (${share(replay.retried, replay.advised)}), would be silent ${replay.wouldBeSilent}, of which the next command changed ${replay.wouldBeSilentChanged}.`,
    `Unkeyed risk advices (never silenced: compound, container, outward, or written before the key existed): ${replay.unkeyed}, re-run unchanged ${replay.unkeyedRetried}.`,
    `Judged silently by the live gate: ${replay.silentLive}. Decisions left exactly as they were (every deny, ask, policy, queue, local rule and allow): ${replay.untouched}.`,
  ];
  if (!totalsOnly && replay.keys.length > 0) {
    lines.push(
      "",
      "| advice key | risk advices | re-run unchanged | would be silent | would be silent, next command changed | silent (live) |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...replay.keys.map((item) => `| ${item.key} | ${item.advised} | ${item.retried} (${share(item.retried, item.advised)}) | ${item.wouldBeSilent} | ${item.wouldBeSilentChanged} | ${item.silent} |`),
    );
  }
  return `${lines.join("\n")}\n`;
}
