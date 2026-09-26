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

/** Sorted-ascending input required -- callers here always pass the array they just sorted themselves. */
function median(sortedAscending: readonly number[]): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const lower = sortedAscending[mid - 1];
  const upper = sortedAscending[mid];
  if (n % 2 === 1) return upper ?? null;
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/**
 * Nearest-rank percentile: for n sorted-ascending samples, the p-th
 * percentile is the value at 0-based index `ceil(p/100 * n) - 1`. Chosen
 * over interpolation so a percentile always names an actual recorded
 * latency, never a value nobody measured. Sorted-ascending input required,
 * same as {@link median}. Null, never 0, when there is no sample.
 */
function percentile(sortedAscending: readonly number[], p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAscending[index] ?? null;
}

interface MutableFamilyStat {
  total: number;
  byVerdict: GateVerdictCounts;
}

/**
 * Folds the gate's own decision log into a summary. Pure: same input
 * always yields the same output, no clock, no filesystem, no randomness.
 */
export function foldGateDecisions(records: readonly GateDecisionRecord[]): GateStatsSummary {
  let byVerdict = emptyVerdictCounts();
  const bySource: { "local-rule": number; cache: number; jev: number; none: number } = { "local-rule": 0, cache: 0, jev: 0, none: 0 };
  const familyStats = new Map<string, MutableFamilyStat>();
  const projectCounts = new Map<string | null, number>();
  const pluginVersionCounts = new Map<string, number>();
  let noPluginVersionCount = 0;
  const jevLatencies: number[] = [];

  for (const record of records) {
    byVerdict = incrementVerdict(byVerdict, record.verdict);
    bySource[record.source] += 1;

    const family: MutableFamilyStat = familyStats.get(record.commandFamily) ?? { total: 0, byVerdict: emptyVerdictCounts() };
    family.total += 1;
    family.byVerdict = incrementVerdict(family.byVerdict, record.verdict);
    familyStats.set(record.commandFamily, family);

    projectCounts.set(record.project, (projectCounts.get(record.project) ?? 0) + 1);

    if (record.pluginVersion === undefined) noPluginVersionCount += 1;
    else pluginVersionCounts.set(record.pluginVersion, (pluginVersionCounts.get(record.pluginVersion) ?? 0) + 1);

    if (record.source === "jev" && record.latencyMs !== null && Number.isFinite(record.latencyMs)) {
      jevLatencies.push(record.latencyMs);
    }
  }

  const sortedLatencies = [...jevLatencies].sort((a, b) => a - b);
  const lastLatency = sortedLatencies[sortedLatencies.length - 1];

  const byCommandFamily: GateCommandFamilyStat[] = [...familyStats.entries()]
    .map(([commandFamily, stat]) => ({
      commandFamily,
      total: stat.total,
      byVerdict: stat.byVerdict,
      interventions: stat.byVerdict.ask + stat.byVerdict.deny,
    }))
    .sort((a, b) => b.total - a.total);

  const familiesWithNoInterventions = byCommandFamily.filter((f) => f.interventions === 0).length;

  const byProject: GateProjectStat[] = [...projectCounts.entries()]
    .map(([project, total]) => ({ project, total }))
    .sort((a, b) => b.total - a.total);

  const byPluginVersion: GatePluginVersionStat[] = [...pluginVersionCounts.entries()]
    .map(([pluginVersion, total]) => ({ pluginVersion, total }))
    .sort((a, b) => b.total - a.total);

  return {
    totalDecisions: records.length,
    byVerdict,
    bySource,
    jevLatency: {
      sampleCount: sortedLatencies.length,
      medianMs: median(sortedLatencies),
      p95Ms: percentile(sortedLatencies, 95),
      maxMs: sortedLatencies.length > 0 && lastLatency !== undefined ? lastLatency : null,
    },
    byCommandFamily,
    familiesWithNoInterventions,
    byProject,
    byPluginVersion,
    noPluginVersionCount,
  };
}

// Re-exported only so read-measurements.mjs and tests can name the source/
// verdict types without reaching back into gate_measurement.ts themselves.
export type { GateDecisionRecord, GateSource, GateVerdict };
