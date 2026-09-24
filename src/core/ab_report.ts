// Pure fold over ab_benchmark.ts's own AbComparisonResult rows (the
// records adapters/cli/ab_benchmark_cli.ts appends to
// ab-benchmark-results.jsonl) into the summary the advisor panel renders.
//
// Same discipline as gate_stats.ts's foldGateDecisions: no clock, no
// filesystem, no randomness, pure input to pure output. Reuses
// ab_benchmark.ts's own exported types (AbComparisonResult, GateLikeVerdict,
// BigModelVerdict) rather than redeclaring them -- there is exactly one
// definition of what a comparison result looks like in this codebase.
//
// Why this is a separate fold from ab_benchmark.ts's own buildReport():
// buildReport() groups by model id (one LatencyStats per model, never
// averaged across models) for the CLI's own summary report. The panel
// needs a flatter shape instead -- a single latency comparison between
// Jev and the big model, the distinct model ids actually seen (so the
// panel can NAME the model), and disagreements bucketed by the verdict
// pair, so it can render "Jev allow / model ask, 9 times" as one bar
// rather than a table. Reimplementing that shape inside buildReport()
// would have forced every existing consumer of AbBenchmarkReport to
// change; this module exists instead.
//
// A failed comparison (bigModel.failureReason !== null) is still a real
// signal -- a large-model call that could not be judged -- so it is always
// counted in failureCount. It is excluded only from the big-model latency
// statistics and from agreement/disagreement, since neither statistic has
// an honest value to report for a call that never produced one. Jev's own
// latency and token counts are unaffected: Jev ran and returned a verdict
// regardless of what happened to the big-model side afterward.

import type { AbComparisonResult, BigModelVerdict, GateLikeVerdict } from "./ab_benchmark.ts";

export interface AbLatencyStats {
  readonly sampleCount: number;
  readonly medianMs: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

export interface AbTokenTotals {
  readonly inputTotal: number;
  readonly outputTotal: number;
}

/**
 * The big model's own token totals. Cache tokens are kept apart from
 * `inputTotal` deliberately -- see this module's header note and
 * ab_benchmark.ts's own ClaudeCliEnvelope doc comment: cache creation/read
 * tokens are a different kind of spend than a fresh input token, and
 * folding them together would overstate what the comparison actually
 * cost relative to Jev's own (cache-free) input count.
 */
export interface AbBigModelTokenTotals extends AbTokenTotals {
  readonly cacheCreationInputTotal: number;
  readonly cacheReadInputTotal: number;
}

/** One (Jev verdict, big-model verdict) pair that disagreed, and how many times. */
export interface AbDisagreement {
  readonly jevVerdict: GateLikeVerdict;
  readonly bigModelVerdict: BigModelVerdict | null;
  readonly count: number;
}

export interface AbReportSummary {
  readonly sampleCount: number;
  readonly jevLatency: AbLatencyStats;
  /** Excludes rows whose bigModel.failureReason is set -- see this module's header note. */
  readonly bigModelLatency: AbLatencyStats;
  /** Distinct non-null bigModel.modelId values actually seen, sorted, so the panel can name the model. */
  readonly modelIds: readonly string[];
  readonly agreementCount: number;
  readonly disagreementCount: number;
  /** Null when no comparison was conclusive -- never a fabricated 0. */
  readonly agreementRate: number | null;
  /** Sorted by count, descending. */
  readonly disagreements: readonly AbDisagreement[];
  /** Rows where bigModel.failureReason !== null -- counted here even though excluded from latency/agreement above. */
  readonly failureCount: number;
  readonly jevTokens: AbTokenTotals;
  readonly bigModelTokens: AbBigModelTokenTotals;
}

/** Sorted-ascending input required -- same convention as gate_stats.ts's own median(). */
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

function latencyStats(samplesMs: readonly number[]): AbLatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    medianMs: median(sorted),
    minMs: sorted.length > 0 ? (sorted[0] as number) : null,
    maxMs: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : null,
  };
}

function disagreementKey(jevVerdict: GateLikeVerdict, bigModelVerdict: BigModelVerdict | null): string {
  return `${jevVerdict}|${bigModelVerdict ?? "(none)"}`;
}

/**
 * Folds a batch of A/B comparison results into the summary the panel
 * renders. Pure: same input always yields the same output, no clock, no
 * filesystem, no randomness.
 */
export function foldAbResults(results: readonly AbComparisonResult[]): AbReportSummary {
  const jevLatencies: number[] = [];
  const bigModelLatencies: number[] = [];
  const modelIds = new Set<string>();
  const disagreements = new Map<string, { jevVerdict: GateLikeVerdict; bigModelVerdict: BigModelVerdict | null; count: number }>();

  let agreementCount = 0;
  let disagreementCount = 0;
  let failureCount = 0;

  let jevInputTotal = 0;
  let jevOutputTotal = 0;
  let bigModelInputTotal = 0;
  let bigModelOutputTotal = 0;
  let cacheCreationInputTotal = 0;
  let cacheReadInputTotal = 0;

  for (const result of results) {
    // Jev ran and returned a verdict for every sampled entry -- its own
    // latency and token counts are real regardless of what happened on
    // the big-model side afterward, so they are never excluded here.
    jevLatencies.push(result.jev.latencyMs);
    jevInputTotal += result.jev.inputTokens;
    jevOutputTotal += result.jev.outputTokens;

    if (result.bigModel.modelId !== null) modelIds.add(result.bigModel.modelId);

    // Token spend is real even on a failed call (a partially-spent large-
    // model invocation is still a real cost), so totals include every row.
    bigModelInputTotal += result.bigModel.inputTokens ?? 0;
    bigModelOutputTotal += result.bigModel.outputTokens ?? 0;
    cacheCreationInputTotal += result.bigModel.cacheCreationInputTokens ?? 0;
    cacheReadInputTotal += result.bigModel.cacheReadInputTokens ?? 0;

    if (result.bigModel.failureReason !== null) {
      failureCount += 1;
      continue;
    }

    if (result.bigModel.latencyMs !== null) bigModelLatencies.push(result.bigModel.latencyMs);

    if (result.agree === true) {
      agreementCount += 1;
    } else if (result.agree === false) {
      disagreementCount += 1;
      const key = disagreementKey(result.jev.verdict, result.bigModel.verdict);
      const existing = disagreements.get(key);
      if (existing) existing.count += 1;
      else disagreements.set(key, { jevVerdict: result.jev.verdict, bigModelVerdict: result.bigModel.verdict, count: 1 });
    }
  }

  return {
    sampleCount: results.length,
    jevLatency: latencyStats(jevLatencies),
    bigModelLatency: latencyStats(bigModelLatencies),
    modelIds: [...modelIds].sort(),
    agreementCount,
    disagreementCount,
    agreementRate: agreementCount + disagreementCount > 0 ? agreementCount / (agreementCount + disagreementCount) : null,
    disagreements: [...disagreements.values()].sort((a, b) => b.count - a.count),
    failureCount,
    jevTokens: { inputTotal: jevInputTotal, outputTotal: jevOutputTotal },
    bigModelTokens: {
      inputTotal: bigModelInputTotal,
      outputTotal: bigModelOutputTotal,
      cacheCreationInputTotal,
      cacheReadInputTotal,
    },
  };
}
