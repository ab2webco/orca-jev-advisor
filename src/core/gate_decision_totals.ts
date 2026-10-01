// 0.6.21 T1 (JEVADV-98): the running totals the gate's old decision files
// are folded into before they are deleted.
//
// Since 0.6.17 the gate writes one decision file per UTC hour (about 77 KB an
// active hour) and nothing pruned them, because three readers count every
// decision ever made: the board's Gate tab (read-measurements.mjs: the "all
// time" and "this version" windows, the status card, the latest decisions,
// the unreadable-line count), the Activity tab's unreadable-line count
// (read-activity.mjs) and the A/B report's count of real Jev decisions
// (ab_benchmark_cli.ts). The day and week windows and the Activity tab's
// seven days never reach a file old enough to be folded.
//
// So a file whose hour is more than 8 days old is folded into these totals,
// which hold exactly what those readers derive and nothing more, and then
// deleted (adapters/orca/gate-log-fold.mjs). A reader continues the totals
// with the files still on disk, so every number is the one it would read
// from every file. Continuing totals with later decisions gives the totals
// of all of them (the tests check every split point), which is what makes a
// fold invisible.
//
// `files` names the folded files that may still be on disk, with the size
// and modification time each had when it was folded: a reader skips a file
// that still matches, so a crash between writing the totals and deleting a
// file never counts it twice, and the next fold deletes it. A file written
// again under the same name (an older copy of the plugin recreating the
// legacy file) no longer matches and is read as the new file it is.
//
// Pure: no I/O, no clock.
import type { GateDecisionRecord, GateSource, GateVerdict } from "./gate_measurement.ts";
import { emptyGateTally, tallyGateDecisions } from "./gate_stats.ts";
import type { GateFamilyTally, GateTally, GateVerdictCounts } from "./gate_stats.ts";

export const GATE_DECISION_TOTALS_FILE = "gate-decisions-totals.json";
/** Held while a fold runs, so two folds never write the totals from the same starting point. */
export const GATE_DECISION_TOTALS_LOCK_FILE = "gate-decisions-totals.lock";

const HOUR_MS = 60 * 60 * 1000;
/** A file is folded once everything in it is older than this. The Activity tab reads seven local days; nothing it reads is folded. */
export const GATE_FOLD_AFTER_MS = 8 * 24 * HOUR_MS;
/** The fold looks for new files at most this often. */
export const GATE_FOLD_INTERVAL_MS = 24 * HOUR_MS;
/** How many of the latest decisions the board lists. */
export const GATE_RECENT_KEPT = 10;

/** One of the latest decisions, as the board lists it: never the record's id. */
export interface GateRecentDecision {
  readonly at: string;
  readonly project: string | null;
  readonly commandFamily: string;
  readonly source: GateSource;
  readonly verdict: GateVerdict;
  readonly latencyMs: number | null;
}

export interface GateVersionTotals {
  readonly tally: GateTally;
  /** The earliest readable time among this build's decisions; null when none has one. */
  readonly firstAtMs: number | null;
}

/** Is Jev answering: the last answer, the last failure, and the failures after the last answer. */
export interface GateHealthTotals {
  readonly lastJevMs: number | null;
  readonly lastJevAt: string | null;
  readonly lastFailureMs: number | null;
  readonly lastFailureAt: string | null;
  readonly failuresAfterLastJev: number;
}

/** The build that wrote the latest stamped decision. `atMs` null: that decision's time does not read. */
export interface GateLatestStamped {
  readonly atMs: number | null;
  readonly pluginVersion: string;
}

/** A folded file, as it was when it was folded. */
export interface GateFoldedFile {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface GateDecisionTotals {
  readonly schema: 1;
  /** Folded files that may still be on disk; readers skip them while they still match. */
  readonly files: readonly GateFoldedFile[];
  /** How many files have ever been folded. */
  readonly foldedFiles: number;
  /** When the fold last looked for files to fold. */
  readonly checkedAt: string | null;
  /** Lines that were not a JSON object. */
  readonly corruptLines: number;
  /** Gate decision rows that failed the readers' guard. */
  readonly malformedRows: number;
  /** `source: "jev"` records as the A/B report parses them (parseGateDecisionRecords). */
  readonly jevRecordsForAb: number;
  readonly all: GateTally;
  /** Per build, in the order each was first seen. */
  readonly byVersion: readonly (readonly [string, GateVersionTotals])[];
  readonly latestStamped: GateLatestStamped | null;
  readonly health: GateHealthTotals;
  /** The last GATE_RECENT_KEPT decisions, oldest first. */
  readonly recent: readonly GateRecentDecision[];
}

/** What one file (or the live files together) adds: its guarded records, in log order, and its own counts. */
export interface GateDecisionBatch {
  readonly records: readonly GateDecisionRecord[];
  readonly corruptLines: number;
  readonly malformedRows: number;
  readonly jevRecordsForAb: number;
}

export function emptyGateDecisionTotals(): GateDecisionTotals {
  return {
    schema: 1,
    files: [],
    foldedFiles: 0,
    checkedAt: null,
    corruptLines: 0,
    malformedRows: 0,
    jevRecordsForAb: 0,
    all: emptyGateTally(),
    byVersion: [],
    latestStamped: null,
    health: { lastJevMs: null, lastJevAt: null, lastFailureMs: null, lastFailureAt: null, failuresAfterLastJev: 0 },
    recent: [],
  };
}

function atMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `health` continued with `records`. The last answer and the last failure are
 * the latest by time (the first one seen on a tie); the streak counts the
 * failures after the last answer, as read-measurements.mjs always has.
 * Earlier failures are kept only as a count, so a newer answer in `records`
 * ends the streak: the fold only ever folds files older than every file it
 * leaves, so no folded failure comes after a live answer.
 */
function continueHealth(health: GateHealthTotals, records: readonly GateDecisionRecord[]): GateHealthTotals {
  let lastJevMs = health.lastJevMs;
  let lastJevAt = health.lastJevAt;
  let lastFailureMs = health.lastFailureMs;
  let lastFailureAt = health.lastFailureAt;
  const failures: number[] = [];
  for (const record of records) {
    if (record.source !== "jev" && record.source !== "none") continue;
    const ms = atMs(record.at);
    if (ms === null) continue;
    if (record.source === "jev") {
      if (lastJevMs === null || ms > lastJevMs) {
        lastJevMs = ms;
        lastJevAt = record.at;
      }
    } else {
      failures.push(ms);
      if (lastFailureMs === null || ms > lastFailureMs) {
        lastFailureMs = ms;
        lastFailureAt = record.at;
      }
    }
  }
  const earlier = lastJevMs === health.lastJevMs ? health.failuresAfterLastJev : 0;
  const after = failures.filter((ms) => lastJevMs === null || ms > lastJevMs).length;
  return { lastJevMs, lastJevAt, lastFailureMs, lastFailureAt, failuresAfterLastJev: earlier + after };
}

/** `totals` continued with `batch`, which comes after everything they already hold. Pure. */
export function addGateDecisions(totals: GateDecisionTotals, batch: GateDecisionBatch): GateDecisionTotals {
  const { records } = batch;

  let latestStamped = totals.latestStamped;
  const ofVersion = new Map<string, GateDecisionRecord[]>();
  for (const record of records) {
    if (record.pluginVersion === undefined) continue;
    const ms = atMs(record.at);
    if (latestStamped === null || (ms ?? -Infinity) >= (latestStamped.atMs ?? -Infinity)) {
      latestStamped = { atMs: ms, pluginVersion: record.pluginVersion };
    }
    const list = ofVersion.get(record.pluginVersion) ?? [];
    list.push(record);
    ofVersion.set(record.pluginVersion, list);
  }

  const byVersion = new Map<string, GateVersionTotals>(totals.byVersion);
  for (const [version, list] of ofVersion) {
    const previous = byVersion.get(version) ?? { tally: emptyGateTally(), firstAtMs: null };
    let firstAtMs = previous.firstAtMs;
    for (const record of list) {
      const ms = atMs(record.at);
      if (ms !== null && (firstAtMs === null || ms < firstAtMs)) firstAtMs = ms;
    }
    byVersion.set(version, { tally: tallyGateDecisions(previous.tally, list), firstAtMs });
  }

  const recent: GateRecentDecision[] = [
    ...totals.recent,
    ...records.slice(-GATE_RECENT_KEPT).map((d) => ({
      at: d.at,
      project: d.project,
      commandFamily: d.commandFamily,
      source: d.source,
      verdict: d.verdict,
      latencyMs: d.latencyMs,
    })),
  ].slice(-GATE_RECENT_KEPT);

  return {
    ...totals,
    corruptLines: totals.corruptLines + batch.corruptLines,
    malformedRows: totals.malformedRows + batch.malformedRows,
    jevRecordsForAb: totals.jevRecordsForAb + batch.jevRecordsForAb,
    all: tallyGateDecisions(totals.all, records),
    byVersion: [...byVersion.entries()],
    latestStamped,
    health: continueHealth(totals.health, records),
    recent,
  };
}

/**
 * True when the file `name`, as `seen` now (null: gone, or it cannot be
 * looked at), is one the totals already hold, so a reader must skip it.
 */
export function isFoldedFile(totals: GateDecisionTotals, name: string, seen: { readonly size: number; readonly mtimeMs: number } | null): boolean {
  const folded = totals.files.find((file) => file.name === name);
  if (folded === undefined) return false;
  return seen === null || (seen.size === folded.size && seen.mtimeMs === folded.mtimeMs);
}

/** The board's "is the gate working" figures. */
export function gateHealthOf(totals: GateDecisionTotals): { lastJevAt: string | null; consecutiveFailures: number; lastFailureAt: string | null } {
  return { lastJevAt: totals.health.lastJevAt, consecutiveFailures: totals.health.failuresAfterLastJev, lastFailureAt: totals.health.lastFailureAt };
}

const GATE_HOUR_FILE = /^gate-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** The UTC hour `ms` falls in ends after `cutoff`. */
function hourEndsBy(hourStartMs: number, cutoffMs: number): boolean {
  return hourStartMs + HOUR_MS <= cutoffMs;
}

/** True when `name` is a gate hour file whose whole hour is more than GATE_FOLD_AFTER_MS before `nowMs`. A name that does not date is never folded. */
export function gateHourFileFoldable(name: string, nowMs: number): boolean {
  const match = GATE_HOUR_FILE.exec(name);
  if (match === null) return false;
  const hourMs = Date.parse(`${match[1]}:00:00.000Z`);
  if (Number.isNaN(hourMs) || new Date(hourMs).toISOString().slice(0, 13) !== match[1]) return false;
  return hourEndsBy(hourMs, nowMs - GATE_FOLD_AFTER_MS);
}

/**
 * True when the single file written before 0.6.17 can be folded: the hour of
 * its newest readable decision (`newestAtMs`, null when none reads) ended more
 * than GATE_FOLD_AFTER_MS before `nowMs`. Until then it is read whole, as before.
 */
export function legacyGateFileFoldable(newestAtMs: number | null, nowMs: number): boolean {
  if (newestAtMs === null) return true;
  return hourEndsBy(newestAtMs - (newestAtMs % HOUR_MS), nowMs - GATE_FOLD_AFTER_MS);
}

// ---------------------------------------------------------------------------
// Reading the totals file back. A hand edit or a half-written file is
// `unknown`: any field of another shape refuses the whole file, never a guess.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSource(value: unknown): value is GateSource {
  return value === "local-rule" || value === "cache" || value === "jev" || value === "none";
}

function isVerdict(value: unknown): value is GateVerdict {
  return value === "allow" || value === "ask" || value === "deny" || value === "advise";
}

function parseVerdictCounts(raw: unknown): GateVerdictCounts | null {
  if (!isObject(raw)) return null;
  const { allow, ask, deny, advise } = raw;
  if (!isCount(allow) || !isCount(ask) || !isCount(deny) || !isCount(advise)) return null;
  return { allow, ask, deny, advise };
}

/** A list of `[key, value]` pairs, each read by `entry`; null when any is of another shape. */
function parsePairs<K, V>(raw: unknown, key: (value: unknown) => value is K, value: (raw: unknown) => V | null): (readonly [K, V])[] | null {
  if (!Array.isArray(raw)) return null;
  const pairs: (readonly [K, V])[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [k, v] = item;
    if (!key(k)) return null;
    const parsed = value(v);
    if (parsed === null) return null;
    pairs.push([k, parsed]);
  }
  return pairs;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function countOrNull(raw: unknown): number | null {
  return isCount(raw) && raw > 0 ? raw : null;
}

function parseFamily(raw: unknown): GateFamilyTally | null {
  if (!isObject(raw) || !isCount(raw.total)) return null;
  const byVerdict = parseVerdictCounts(raw.byVerdict);
  return byVerdict === null ? null : { total: raw.total, byVerdict };
}

function parseTally(raw: unknown): GateTally | null {
  if (!isObject(raw)) return null;
  const byVerdict = parseVerdictCounts(raw.byVerdict);
  const source = raw.bySource;
  if (!isObject(source)) return null;
  const localRule = source["local-rule"];
  const { cache, jev, none } = source;
  const families = parsePairs(raw.families, isString, parseFamily);
  const projects = parsePairs(raw.projects, isNullableString, (v) => (isCount(v) ? v : null));
  const pluginVersions = parsePairs(raw.pluginVersions, isString, (v) => (isCount(v) ? v : null));
  const jevLatencies = parsePairs(raw.jevLatencies, isFiniteNumber, countOrNull);
  if (
    !isCount(raw.totalDecisions) ||
    byVerdict === null ||
    !isCount(localRule) || !isCount(cache) || !isCount(jev) || !isCount(none) ||
    families === null || projects === null || pluginVersions === null || jevLatencies === null ||
    !isCount(raw.noPluginVersionCount)
  ) {
    return null;
  }
  return {
    totalDecisions: raw.totalDecisions,
    byVerdict,
    bySource: { "local-rule": localRule, cache, jev, none },
    families,
    projects,
    pluginVersions,
    noPluginVersionCount: raw.noPluginVersionCount,
    jevLatencies,
  };
}

function parseVersionTotals(raw: unknown): GateVersionTotals | null {
  if (!isObject(raw) || !isNullableNumber(raw.firstAtMs)) return null;
  const tally = parseTally(raw.tally);
  return tally === null ? null : { tally, firstAtMs: raw.firstAtMs };
}

function parseHealth(raw: unknown): GateHealthTotals | null {
  if (!isObject(raw)) return null;
  const { lastJevMs, lastJevAt, lastFailureMs, lastFailureAt, failuresAfterLastJev } = raw;
  if (!isNullableNumber(lastJevMs) || !isNullableString(lastJevAt) || !isNullableNumber(lastFailureMs) || !isNullableString(lastFailureAt) || !isCount(failuresAfterLastJev)) return null;
  return { lastJevMs, lastJevAt, lastFailureMs, lastFailureAt, failuresAfterLastJev };
}

function parseRecent(raw: unknown): GateRecentDecision[] | null {
  if (!Array.isArray(raw)) return null;
  const recent: GateRecentDecision[] = [];
  for (const item of raw) {
    if (!isObject(item)) return null;
    const { at, project, commandFamily, source, verdict, latencyMs } = item;
    if (typeof at !== "string" || !isNullableString(project) || typeof commandFamily !== "string" || !isSource(source) || !isVerdict(verdict) || !isNullableNumber(latencyMs)) return null;
    recent.push({ at, project, commandFamily, source, verdict, latencyMs });
  }
  return recent;
}

function parseFoldedFile(raw: unknown): GateFoldedFile | null {
  if (!isObject(raw) || typeof raw.name !== "string" || !isCount(raw.size) || !isFiniteNumber(raw.mtimeMs)) return null;
  return { name: raw.name, size: raw.size, mtimeMs: raw.mtimeMs };
}

function parseLatestStamped(raw: unknown): GateLatestStamped | null | undefined {
  if (raw === null) return null;
  if (!isObject(raw) || !isNullableNumber(raw.atMs) || typeof raw.pluginVersion !== "string") return undefined;
  return { atMs: raw.atMs, pluginVersion: raw.pluginVersion };
}

/** The totals file's content, or null when it is not exactly this shape. */
export function parseGateDecisionTotals(raw: unknown): GateDecisionTotals | null {
  if (!isObject(raw) || raw.schema !== 1) return null;
  const { foldedFiles, checkedAt, corruptLines, malformedRows, jevRecordsForAb } = raw;
  if (!Array.isArray(raw.files)) return null;
  const files: GateFoldedFile[] = [];
  for (const item of raw.files) {
    const file = parseFoldedFile(item);
    if (file === null) return null;
    files.push(file);
  }
  if (!isCount(foldedFiles) || !isNullableString(checkedAt) || !isCount(corruptLines) || !isCount(malformedRows) || !isCount(jevRecordsForAb)) return null;
  const all = parseTally(raw.all);
  const byVersion = parsePairs(raw.byVersion, isString, parseVersionTotals);
  const latestStamped = parseLatestStamped(raw.latestStamped);
  const health = parseHealth(raw.health);
  const recent = parseRecent(raw.recent);
  if (all === null || byVersion === null || latestStamped === undefined || health === null || recent === null) return null;
  return { schema: 1, files, foldedFiles, checkedAt, corruptLines, malformedRows, jevRecordsForAb, all, byVersion, latestStamped, health, recent };
}
