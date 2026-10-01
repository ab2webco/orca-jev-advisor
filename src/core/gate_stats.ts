// Pure fold over gate-bash.ts's own JSONL records (see gate_measurement.ts
// for the record shape) into the summary the advisor panel renders.
//
// This exists because the panel used to show a raw dump of the gate's
// measurement log -- readable only as a pile of ids -- instead of an
// answer to the two questions the owner actually asked: "what does Jev
// suggest to the big model, what does it save me or block for me" and
// "donde se ha usado mas". No I/O here, same discipline as
// commandFamily() in gate_measurement.ts: adapters/orca/read-measurements.mjs
// does the file read (outside this plugin's own permission sandbox, via a
// clean child process -- see that file's own header comment) and hands
// the parsed rows to foldGateDecisions(), which is pure and unit-tested
// without touching a filesystem.
//
// Every field here is either a count, a percentage of a count, or a
// latency figure actually present on a `source: "jev"` record. Nothing
// here estimates a dollar, a token, or a time "saved" -- gate-bash.ts
// itself only ever records latencyMs for the one source that makes a
// network call (see gate_measurement.ts's own comment on that field), and
// this module honors that: local-rule and cache decisions never enter the
// latency sample.

import type { GateDecisionRecord, GateSource, GateVerdict } from "./gate_measurement.ts";

export interface GateVerdictCounts {
  readonly allow: number;
  readonly ask: number;
  readonly deny: number;
  /**
   * The advise-model release's third verdict: the model was refused this ONE
   * attempt and handed a concrete reason, but nobody was interrupted -- see
   * gate_measurement.ts's own GateVerdict doc. Kept OUT of
   * GateCommandFamilyStat.interventions below on purpose: an intervention
   * counts a human being asked, and advise never asks one.
   */
  readonly advise: number;
}

export interface GateSourceCounts {
  readonly "local-rule": number;
  readonly cache: number;
  readonly jev: number;
  /** `"none"` records: Jev was asked but never answered, so the command passed unjudged. See gate_measurement.ts's GateSource. */
  readonly none: number;
}

export interface GateLatencyStats {
  /** How many jev-sourced records actually carried a numeric latencyMs. */
  readonly sampleCount: number;
  readonly medianMs: number | null;
  /**
   * The 95th percentile, using the nearest-rank convention (the same
   * convention every percentile in this module uses, should another be
   * added later): for n samples sorted ascending, p95 is the value at
   * index `ceil(0.95 * n) - 1`. That always names an ACTUAL recorded
   * latency, never a value interpolated between two samples that never
   * happened. A single sample's p95 is that sample, same as its median
   * and its max -- there is nothing else it could honestly be. Null,
   * never 0, when there is no sample at all: a latency of "0ms" would
   * read as a real, suspiciously fast measurement, not as "no data".
   */
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface GateCommandFamilyStat {
  readonly commandFamily: string;
  readonly total: number;
  readonly byVerdict: GateVerdictCounts;
  /** `byVerdict.ask + byVerdict.deny` -- how often this family actually needed a HUMAN, independent of how often it merely ran. An `advise` verdict is deliberately excluded: it interrupts the coding model, never a person. */
  readonly interventions: number;
}

export interface GatePluginVersionStat {
  readonly pluginVersion: string;
  readonly total: number;
}

export interface GateProjectStat {
  /** null for a record whose project could not be resolved (gate-bash.ts's own projectName() returning null). */
  readonly project: string | null;
  readonly total: number;
}

export interface GateStatsSummary {
  readonly totalDecisions: number;
  readonly byVerdict: GateVerdictCounts;
  readonly bySource: GateSourceCounts;
  /** Latency is only ever meaningful for the `jev` source -- see gate_measurement.ts. */
  readonly jevLatency: GateLatencyStats;
  /** Sorted by total, descending -- "donde se ha usado mas". The fold stays complete; a caller sorts or filters for "where it actually intervened" itself. */
  readonly byCommandFamily: readonly GateCommandFamilyStat[];
  /** How many entries in {@link byCommandFamily} have `interventions === 0` -- everything the gate ever saw for them, it allowed. */
  readonly familiesWithNoInterventions: number;
  /** Sorted by total, descending. */
  readonly byProject: readonly GateProjectStat[];
  /**
   * Which plugin builds appear in this folded set, sorted by total
   * descending. See gate_measurement.ts's own doc on `pluginVersion` for
   * why this exists: an accumulated count across builds can look like a
   * broken deny tier when it is really an old build that predates the
   * deny tier entirely, and a time window cannot tell the two apart.
   */
  readonly byPluginVersion: readonly GatePluginVersionStat[];
  /** How many folded records carry no `pluginVersion` at all -- written before that field existed. */
  readonly noPluginVersionCount: number;
}

function emptyVerdictCounts(): GateVerdictCounts {
  return { allow: 0, ask: 0, deny: 0, advise: 0 };
}

function incrementVerdict(counts: GateVerdictCounts, verdict: GateVerdict): GateVerdictCounts {
  return { ...counts, [verdict]: counts[verdict] + 1 };
}

/** How many latency samples a counted list holds. */
function sampleCount(latencies: readonly (readonly [number, number])[]): number {
  return latencies.reduce((sum, [, count]) => sum + count, 0);
}

/** The sample at 0-based `index` of the ascending list `latencies` stands for, counting each value as many times as it was seen. */
function sampleAt(latencies: readonly (readonly [number, number])[], index: number): number | undefined {
  let seen = 0;
  for (const [value, count] of latencies) {
    seen += count;
    if (index < seen) return value;
  }
  return undefined;
}

/** The middle sample, or the mean of the two middle ones; null when there is none. Ascending input. */
function median(latencies: readonly (readonly [number, number])[]): number | null {
  const n = sampleCount(latencies);
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const upper = sampleAt(latencies, mid);
  if (n % 2 === 1) return upper ?? null;
  const lower = sampleAt(latencies, mid - 1);
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/**
 * Nearest-rank percentile: for n sorted-ascending samples, the p-th
 * percentile is the value at 0-based index `ceil(p/100 * n) - 1`. Chosen
 * over interpolation so a percentile always names an actual recorded
 * latency, never a value nobody measured. Ascending input, same as
 * {@link median}. Null, never 0, when there is no sample.
 */
function percentile(latencies: readonly (readonly [number, number])[], p: number): number | null {
  const n = sampleCount(latencies);
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sampleAt(latencies, index) ?? null;
}

export interface GateFamilyTally {
  readonly total: number;
  readonly byVerdict: GateVerdictCounts;
}

/**
 * 0.6.21 T1 (JEVADV-98): the fold as a running tally, so the decisions of a
 * log file that has been deleted still count. Everything a summary needs and
 * nothing else; continuing a tally with later records gives exactly the
 * tally of all of them. Lists, not objects, keep the order in which each
 * family, project and build was first seen: a summary sorts by total, and
 * ties keep that order, as a fold of the records themselves does. A JSON
 * round trip leaves it unchanged.
 */
export interface GateTally {
  readonly totalDecisions: number;
  readonly byVerdict: GateVerdictCounts;
  readonly bySource: GateSourceCounts;
  readonly families: readonly (readonly [string, GateFamilyTally])[];
  readonly projects: readonly (readonly [string | null, number])[];
  readonly pluginVersions: readonly (readonly [string, number])[];
  readonly noPluginVersionCount: number;
  /** `[latencyMs, how many jev records had it]`, ascending by latency. */
  readonly jevLatencies: readonly (readonly [number, number])[];
}

export function emptyGateTally(): GateTally {
  return {
    totalDecisions: 0,
    byVerdict: emptyVerdictCounts(),
    bySource: { "local-rule": 0, cache: 0, jev: 0, none: 0 },
    families: [],
    projects: [],
    pluginVersions: [],
    noPluginVersionCount: 0,
    jevLatencies: [],
  };
}

/** `tally` continued with `records`, which come after everything it already holds. Pure. */
export function tallyGateDecisions(tally: GateTally, records: readonly GateDecisionRecord[]): GateTally {
  let byVerdict = tally.byVerdict;
  const bySource: { "local-rule": number; cache: number; jev: number; none: number } = { ...tally.bySource };
  const families = new Map<string, GateFamilyTally>(tally.families);
  const projects = new Map<string | null, number>(tally.projects);
  const pluginVersions = new Map<string, number>(tally.pluginVersions);
  let noPluginVersionCount = tally.noPluginVersionCount;
  const latencies = new Map<number, number>(tally.jevLatencies);

  for (const record of records) {
    byVerdict = incrementVerdict(byVerdict, record.verdict);
    bySource[record.source] += 1;

    const family = families.get(record.commandFamily) ?? { total: 0, byVerdict: emptyVerdictCounts() };
    families.set(record.commandFamily, { total: family.total + 1, byVerdict: incrementVerdict(family.byVerdict, record.verdict) });

    projects.set(record.project, (projects.get(record.project) ?? 0) + 1);

    if (record.pluginVersion === undefined) noPluginVersionCount += 1;
    else pluginVersions.set(record.pluginVersion, (pluginVersions.get(record.pluginVersion) ?? 0) + 1);

    if (record.source === "jev" && record.latencyMs !== null && Number.isFinite(record.latencyMs)) {
      latencies.set(record.latencyMs, (latencies.get(record.latencyMs) ?? 0) + 1);
    }
  }

  return {
    totalDecisions: tally.totalDecisions + records.length,
    byVerdict,
    bySource,
    families: [...families.entries()],
    projects: [...projects.entries()],
    pluginVersions: [...pluginVersions.entries()],
    noPluginVersionCount,
    jevLatencies: [...latencies.entries()].sort((a, b) => a[0] - b[0]),
  };
}

/** The summary the board renders, from a tally. Pure. */
export function summarizeGateTally(tally: GateTally): GateStatsSummary {
  const byCommandFamily: GateCommandFamilyStat[] = tally.families
    .map(([commandFamily, stat]) => ({
      commandFamily,
      total: stat.total,
      byVerdict: stat.byVerdict,
      interventions: stat.byVerdict.ask + stat.byVerdict.deny,
    }))
    .sort((a, b) => b.total - a.total);

  const familiesWithNoInterventions = byCommandFamily.filter((f) => f.interventions === 0).length;

  const byProject: GateProjectStat[] = tally.projects
    .map(([project, total]) => ({ project, total }))
    .sort((a, b) => b.total - a.total);

  const byPluginVersion: GatePluginVersionStat[] = tally.pluginVersions
    .map(([pluginVersion, total]) => ({ pluginVersion, total }))
    .sort((a, b) => b.total - a.total);

  const last = tally.jevLatencies[tally.jevLatencies.length - 1];

  return {
    totalDecisions: tally.totalDecisions,
    byVerdict: tally.byVerdict,
    bySource: tally.bySource,
    jevLatency: {
      sampleCount: sampleCount(tally.jevLatencies),
      medianMs: median(tally.jevLatencies),
      p95Ms: percentile(tally.jevLatencies, 95),
      maxMs: last !== undefined ? last[0] : null,
    },
    byCommandFamily,
    familiesWithNoInterventions,
    byProject,
    byPluginVersion,
    noPluginVersionCount: tally.noPluginVersionCount,
  };
}

/**
 * Folds the gate's own decision log into a summary. Pure: same input
 * always yields the same output, no clock, no filesystem, no randomness.
 */
export function foldGateDecisions(records: readonly GateDecisionRecord[]): GateStatsSummary {
  return summarizeGateTally(tallyGateDecisions(emptyGateTally(), records));
}

// Re-exported only so read-measurements.mjs and tests can name the source/
// verdict types without reaching back into gate_measurement.ts themselves.
export type { GateDecisionRecord, GateSource, GateVerdict };
