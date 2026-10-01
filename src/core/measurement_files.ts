// The skill- and tool-selection measurement logs, and the gate's decision
// log (below), one file per UTC hour.
//
// A hooks module's `$.fs` has no append: every record rewrites the whole
// file, and `$.fs.read`/`write` reject above 4 MiB. A single ever-growing
// file therefore stops recording for good once it nears 4 MiB (JEVADV-62:
// mod-tools-measurements.jsonl did, at 4,194,231 bytes, on 2026-09-29). The
// busiest hour measured was 666 KB and the busiest day 2.2 MB, so hours, not
// days. The single file written before 0.6.11 is still read, never written.

export type MeasurementLog = "mod-skills" | "mod-tools";

const HOUR_FILE = /^(mod-skills|mod-tools)-measurements-(\d{4}-\d{2}-\d{2})T\d{2}\.jsonl$/;

export function measurementLegacyFileName(log: MeasurementLog): string {
  return `${log}-measurements.jsonl`;
}

/** The file for the UTC hour `atIso` (an ISO instant) falls in. */
export function measurementFileName(log: MeasurementLog, atIso: string): string {
  return `${log}-measurements-${atIso.slice(0, 13)}.jsonl`;
}

/**
 * The names out of `names` (a cache directory listing) that hold `log`'s
 * records, legacy file first and then the hours in order, so a decision is
 * always read before the observations that follow it. With `day`
 * (`YYYY-MM-DD`), only that day's hours, plus the legacy file.
 */
export function measurementFilesToRead(log: MeasurementLog, names: readonly string[], day?: string): string[] {
  const legacy = measurementLegacyFileName(log);
  const hours = names
    .filter((name) => {
      const match = HOUR_FILE.exec(name);
      return match !== null && match[1] === log && (day === undefined || match[2] === day);
    })
    .sort();
  return names.includes(legacy) ? [legacy, ...hours] : hours;
}

// 0.6.17 T4 (JEVADV-92): the gate's decision log, one file per UTC hour like
// the logs above. The gate appends with Node (no 4 MiB rewrite limit), but a
// single file only ever grew, and every reader read all of it. The single
// file written before 0.6.17 is still read first, never written.

export const GATE_DECISIONS_LEGACY_FILE = "gate-decisions.jsonl";

const GATE_HOUR_FILE = /^gate-decisions-\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/;

/** The gate decision file for the UTC hour `atIso` (an ISO instant) falls in. */
export function gateDecisionFileName(atIso: string): string {
  return `gate-decisions-${atIso.slice(0, 13)}.jsonl`;
}

/** The names out of `names` (a cache directory listing) that hold gate decisions: the legacy file first, then the hours in order. */
export function gateDecisionFilesToRead(names: readonly string[]): string[] {
  const hours = names.filter((name) => GATE_HOUR_FILE.test(name)).sort();
  return names.includes(GATE_DECISIONS_LEGACY_FILE) ? [GATE_DECISIONS_LEGACY_FILE, ...hours] : hours;
}

/** How many gate decisions could not be written, and when the last one was: the board shows it. */
export const GATE_DECISIONS_APPEND_FAILURES_FILE = "gate-decisions-append-failures.json";

export interface AppendFailures {
  readonly count: number;
  readonly lastAt: string | null;
}

export function parseAppendFailures(raw: unknown): AppendFailures {
  if (typeof raw !== "object" || raw === null) return { count: 0, lastAt: null };
  const record = raw as Record<string, unknown>;
  const count = record["count"];
  const lastAt = record["lastAt"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return { count: 0, lastAt: null };
  return { count, lastAt: typeof lastAt === "string" ? lastAt : null };
}

export function nextAppendFailures(previous: AppendFailures, atIso: string): AppendFailures {
  return { count: previous.count + 1, lastAt: atIso };
}
