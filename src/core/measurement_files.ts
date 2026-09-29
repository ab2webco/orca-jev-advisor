// The skill- and tool-selection measurement logs, one file per UTC hour.
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
