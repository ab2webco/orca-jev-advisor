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
  readonly maxMs: number | null;
}

export interface GateCommandFamilyStat {
  readonly commandFamily: string;
  readonly total: number;
  readonly byVerdict: GateVerdictCounts;
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
  /** Sorted by total, descending -- "donde se ha usado mas". */
  readonly byCommandFamily: readonly GateCommandFamilyStat[];
  /** Sorted by total, descending. */
  readonly byProject: readonly GateProjectStat[];
}

function emptyVerdictCounts(): GateVerdictCounts {
  return { allow: 0, ask: 0, deny: 0 };
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
  const jevLatencies: number[] = [];

  for (const record of records) {
    byVerdict = incrementVerdict(byVerdict, record.verdict);
    bySource[record.source] += 1;

    const family: MutableFamilyStat = familyStats.get(record.commandFamily) ?? { total: 0, byVerdict: emptyVerdictCounts() };
    family.total += 1;
    family.byVerdict = incrementVerdict(family.byVerdict, record.verdict);
    familyStats.set(record.commandFamily, family);

    projectCounts.set(record.project, (projectCounts.get(record.project) ?? 0) + 1);

    if (record.source === "jev" && record.latencyMs !== null && Number.isFinite(record.latencyMs)) {
      jevLatencies.push(record.latencyMs);
    }
  }

  const sortedLatencies = [...jevLatencies].sort((a, b) => a - b);
  const lastLatency = sortedLatencies[sortedLatencies.length - 1];

  const byCommandFamily: GateCommandFamilyStat[] = [...familyStats.entries()]
    .map(([commandFamily, stat]) => ({ commandFamily, total: stat.total, byVerdict: stat.byVerdict }))
    .sort((a, b) => b.total - a.total);

  const byProject: GateProjectStat[] = [...projectCounts.entries()]
    .map(([project, total]) => ({ project, total }))
    .sort((a, b) => b.total - a.total);

  return {
    totalDecisions: records.length,
    byVerdict,
    bySource,
    jevLatency: {
      sampleCount: sortedLatencies.length,
      medianMs: median(sortedLatencies),
      maxMs: sortedLatencies.length > 0 && lastLatency !== undefined ? lastLatency : null,
    },
    byCommandFamily,
    byProject,
  };
}

// Re-exported only so read-measurements.mjs and tests can name the source/
// verdict types without reaching back into gate_measurement.ts themselves.
export type { GateDecisionRecord, GateSource, GateVerdict };
