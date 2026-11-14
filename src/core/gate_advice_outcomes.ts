// JEVADV-111: advice that never changes the next command becomes a silent
// judgement.
//
// A risk advice refuses the model's attempt once and lets an identical retry
// through (gate_advice_retry.ts). When the model re-runs the very same text,
// the advice changed nothing: it only cost a step and stopped autonomy. On
// one real machine 92% of advices were followed by the same command family
// within minutes.
//
// This module learns, per project and command family, what each risk advice
// led to:
//   "same"    -- the identical command was retried inside the retry window;
//   "changed" -- the window closed with no identical retry, so the model ran
//                something else (or nothing).
// Once the last SILENT_AFTER outcomes of a (project, family) were all "same",
// a later risk advice there is judged silently: the command runs and the
// advice reaches the model as context, with no refused attempt. One "changed"
// outcome, or OUTCOME_TTL_MS with no outcome, ends that.
//
// Only risk-stage advice is ever learned or silenced. A deny, a local rule's
// advice, a policy (prohibits, requires_human, the queue), the deploy/publish
// floor and the families in NEVER_SILENT_FAMILIES never reach this module's
// pass: the gate only consults it where it would otherwise emit a risk advice.
//
// Pure: the store is a plain value and every function returns a new one; the
// adapter (adapters/claude/gate-bash.ts) reads and writes the file.

import { ADVICE_RETRY_WINDOW_MS } from "./gate_advice_retry.ts";
import { canonicalCommandFamily, type GateDecisionRecord } from "./gate_measurement.ts";

/** The store's file name in the cache dir. */
export const ADVICE_OUTCOMES_FILE = "gate-advice-outcomes.json";

/** How many consecutive identical retries, and nothing else, make a (project, family) silent. */
export const SILENT_AFTER = 8;

/** How many recent outcomes each (project, family) keeps. */
export const RECENT_OUTCOMES = 20;

/** A (project, family) with no outcome for this long forgets what it learned and is advised again. */
export const OUTCOME_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Families whose advice is never silenced, however often it was retried:
 * the ones whose mistake cannot be taken back (deletes, discards, infra,
 * databases, piping a download into a shell) and `other`, which is not one
 * family but every command whose first word is not a plain program name.
 */
export const NEVER_SILENT_FAMILIES: ReadonlySet<string> = new Set([
  "rm -rf",
  "git discard",
  "kubectl",
  "terraform",
  "docker",
  "sql drop/truncate",
  "db client",
  "aws cli",
  "curl | shell",
  "other",
]);

export type AdviceOutcome = "same" | "changed";

export interface FamilyOutcomes {
  /** Oldest first, at most RECENT_OUTCOMES. */
  readonly recent: readonly AdviceOutcome[];
  /** When the newest outcome was recorded (ISO). */
  readonly lastAt: string;
}

/** An advice issued and not yet resolved: its (project, family) key and when it was issued (ms). */
export interface PendingAdvice {
  readonly key: string;
  readonly at: number;
}

export interface AdviceOutcomeStore {
  readonly version: 1;
  /** Keyed by familyKey(project, family). */
  readonly families: Readonly<Record<string, FamilyOutcomes>>;
  /** Keyed by the advice-retry key (gate_advice_retry.ts's adviceRetryKey). */
  readonly pending: Readonly<Record<string, PendingAdvice>>;
}

export const EMPTY_ADVICE_OUTCOMES: AdviceOutcomeStore = { version: 1, families: {}, pending: {} };

/** The (project, family) key. A NUL keeps `("a", "b c")` apart from `("a b", "c")`. */
export function familyKey(project: string | null, family: string): string {
  return `${project ?? ""}\u0000${canonicalCommandFamily(family)}`;
}

export function isSilenceableFamily(family: string): boolean {
  return !NEVER_SILENT_FAMILIES.has(canonicalCommandFamily(family));
}

/** Never throws: anything malformed is dropped, which only means advising again. */
export function parseAdviceOutcomes(raw: unknown): AdviceOutcomeStore {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) return EMPTY_ADVICE_OUTCOMES;
  const families: Record<string, FamilyOutcomes> = {};
  const rawFamilies = (raw as { families?: unknown }).families;
  if (typeof rawFamilies === "object" && rawFamilies !== null) {
    for (const [key, value] of Object.entries(rawFamilies as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { recent, lastAt } = value as { recent?: unknown; lastAt?: unknown };
      if (!Array.isArray(recent) || typeof lastAt !== "string" || !Number.isFinite(Date.parse(lastAt))) continue;
      const outcomes = recent.filter((item): item is AdviceOutcome => item === "same" || item === "changed").slice(-RECENT_OUTCOMES);
      families[key] = { recent: outcomes, lastAt };
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
  return { version: 1, families, pending };
}

function withOutcome(families: Readonly<Record<string, FamilyOutcomes>>, key: string, outcome: AdviceOutcome, now: number): Record<string, FamilyOutcomes> {
  const previous = families[key]?.recent ?? [];
  return { ...families, [key]: { recent: [...previous, outcome].slice(-RECENT_OUTCOMES), lastAt: new Date(now).toISOString() } };
}

/**
 * Resolves every pending advice whose retry window has closed as "changed",
 * and forgets every (project, family) with no outcome for OUTCOME_TTL_MS.
 */
export function settleAdviceOutcomes(store: AdviceOutcomeStore, now: number): AdviceOutcomeStore {
  let families: Record<string, FamilyOutcomes> = { ...store.families };
  const pending: Record<string, PendingAdvice> = {};
  for (const [id, advice] of Object.entries(store.pending)) {
    if (now - advice.at < ADVICE_RETRY_WINDOW_MS) pending[id] = advice;
    else families = withOutcome(families, advice.key, "changed", advice.at + ADVICE_RETRY_WINDOW_MS);
  }
  for (const [key, outcomes] of Object.entries(families)) {
    if (now - Date.parse(outcomes.lastAt) >= OUTCOME_TTL_MS) delete families[key];
  }
  return { version: 1, families, pending };
}

/** A risk advice was just issued for the command behind `retryKey`. */
export function recordAdviceIssued(store: AdviceOutcomeStore, retryKey: string, project: string | null, family: string, now: number): AdviceOutcomeStore {
  const settled = settleAdviceOutcomes(store, now);
  return { ...settled, pending: { ...settled.pending, [retryKey]: { key: familyKey(project, family), at: now } } };
}

/** The identical command behind `retryKey` was retried. Only a pending risk advice counts; anything else returns the store unchanged. */
export function recordIdenticalRetry(store: AdviceOutcomeStore, retryKey: string, now: number): AdviceOutcomeStore {
  const advice = store.pending[retryKey];
  if (advice === undefined || now - advice.at >= ADVICE_RETRY_WINDOW_MS) return settleAdviceOutcomes(store, now);
  const pending = { ...store.pending };
  delete pending[retryKey];
  return settleAdviceOutcomes({ version: 1, families: withOutcome(store.families, advice.key, "same", now), pending }, now);
}

/** Whether a risk advice for (project, family) is judged silently: the family may be silenced and its last SILENT_AFTER outcomes were all identical retries. */
export function isSilentFamily(store: AdviceOutcomeStore, project: string | null, family: string, now: number): boolean {
  if (!isSilenceableFamily(family)) return false;
  const key = familyKey(project, family);
  const outcomes = settleAdviceOutcomes(store, now).families[key];
  if (outcomes === undefined || outcomes.recent.length < SILENT_AFTER) return false;
  return outcomes.recent.slice(-SILENT_AFTER).every((outcome) => outcome === "same");
}

// ---------------------------------------------------------------------------
// Measurement and replay over the decision log (gate-decisions-*.jsonl).
// The log keeps neither the command nor the session, so an advice is linked
// to its identical retry the way the gate itself records one: an
// `advice-retry` allow in the same project and family inside the retry window.
// ---------------------------------------------------------------------------

export interface FamilyAdviceMeasure {
  readonly family: string;
  /** Risk advices issued. */
  readonly advised: number;
  /** Of those, followed by an identical retry: the advice changed nothing. */
  readonly retried: number;
  /** Risk advices a replay of the learning rule would have judged silently. */
  readonly wouldBeSilent: number;
  /** Judged silently by the live gate. */
  readonly silent: number;
  readonly silenceable: boolean;
}

export interface AdviceReplay {
  readonly families: readonly FamilyAdviceMeasure[];
  readonly advised: number;
  readonly retried: number;
  readonly wouldBeSilent: number;
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

/**
 * Replays the decision log in time order through the learning rule above.
 * Each risk advice is linked to the first unclaimed identical retry in its
 * project and family inside the window ("same"), else it is "changed". A
 * risk advice the rule would have silenced at that moment is counted in
 * `wouldBeSilent`; it still teaches the rule what really happened, which is
 * conservative (a silenced advice could never have been "changed" live).
 */
export function replayAdviceOutcomes(records: readonly GateDecisionRecord[]): AdviceReplay {
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const claimed = new Set<number>();
  const outcomeOf = new Map<number, AdviceOutcome>();
  sorted.forEach((record, index) => {
    if (!isRiskAdvice(record)) return;
    const at = Date.parse(record.at);
    const family = canonicalCommandFamily(record.commandFamily);
    let outcome: AdviceOutcome = "changed";
    for (let next = index + 1; next < sorted.length; next++) {
      const candidate = sorted[next]!;
      if (Date.parse(candidate.at) - at >= ADVICE_RETRY_WINDOW_MS) break;
      if (claimed.has(next) || !isRiskRetry(candidate)) continue;
      if (candidate.project !== record.project || canonicalCommandFamily(candidate.commandFamily) !== family) continue;
      claimed.add(next);
      outcome = "same";
      break;
    }
    outcomeOf.set(index, outcome);
  });

  let store = EMPTY_ADVICE_OUTCOMES;
  const byFamily = new Map<string, { advised: number; retried: number; wouldBeSilent: number; silent: number }>();
  const countsFor = (family: string) => {
    const counts = byFamily.get(family) ?? { advised: 0, retried: 0, wouldBeSilent: 0, silent: 0 };
    byFamily.set(family, counts);
    return counts;
  };
  let untouched = 0;
  sorted.forEach((record, index) => {
    const outcome = outcomeOf.get(index);
    const family = canonicalCommandFamily(record.commandFamily);
    if (record.stopReason === "silent") countsFor(family).silent++;
    if (outcome === undefined) {
      untouched++;
      return;
    }
    const at = Date.parse(record.at);
    const counts = countsFor(family);
    counts.advised++;
    if (outcome === "same") counts.retried++;
    if (isSilentFamily(store, record.project, family, at)) counts.wouldBeSilent++;
    const id = `replay-${index}`;
    store = recordAdviceIssued(store, id, record.project, family, at);
    store = outcome === "same" ? recordIdenticalRetry(store, id, at) : settleAdviceOutcomes(store, at + ADVICE_RETRY_WINDOW_MS);
  });

  const families = [...byFamily.entries()]
    .map(([family, counts]) => ({ family, ...counts, silenceable: isSilenceableFamily(family) }))
    .sort((a, b) => b.advised - a.advised || a.family.localeCompare(b.family));
  return {
    families,
    advised: families.reduce((sum, item) => sum + item.advised, 0),
    retried: families.reduce((sum, item) => sum + item.retried, 0),
    wouldBeSilent: families.reduce((sum, item) => sum + item.wouldBeSilent, 0),
    untouched,
    silentLive: families.reduce((sum, item) => sum + item.silent, 0),
  };
}

/** The replay as a Markdown table, one row per family, most advised first. */
export function formatAdviceReplayMarkdown(replay: AdviceReplay): string {
  const share = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);
  const lines = [
    "| family | risk advices | re-run unchanged | would be silent | silent (live) | may go silent |",
    "| --- | ---: | ---: | ---: | ---: | :---: |",
    ...replay.families.map((item) => `| ${item.family} | ${item.advised} | ${item.retried} (${share(item.retried, item.advised)}) | ${item.wouldBeSilent} | ${item.silent} | ${item.silenceable ? "yes" : "no"} |`),
    `| **all** | ${replay.advised} | ${replay.retried} (${share(replay.retried, replay.advised)}) | ${replay.wouldBeSilent} | ${replay.silentLive} | |`,
    "",
    `Decisions left exactly as they were (every deny, ask, policy, queue, local rule and allow): ${replay.untouched}.`,
  ];
  return `${lines.join("\n")}\n`;
}
