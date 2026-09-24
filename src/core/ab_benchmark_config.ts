// The A/B benchmark's own on/off switch: `<configDir>/ab-benchmark-config.json`.
//
// Measures Jev against the large model for real, out of band, so nobody has
// to estimate the difference. Same "worker writes a plain file, a process
// with no channel into Orca's own `storage` reads it directly" shape as
// src/core/mod_skills_config.ts and src/core/deny_tier_config.ts -- no panel
// UI ships with this pass (that is a separate, later piece of work), so
// today this file is created and edited by hand, or by the CLI's own
// `config` subcommand (adapters/cli/ab_benchmark_cli.ts).
//
// Fails open to OFF, like mod_skills_config.ts and unlike
// deny_tier_config.ts: this feature spends the person's own Jev and
// large-model usage (rate limits, not money -- see the module note on
// AbSampleEntry in ab_benchmark.ts for why the cap stopped being financial),
// so a missing, unreadable or malformed config must never turn it on by
// accident. A missing file, malformed JSON, or a wrong-typed/out-of-range
// field all fall back to DEFAULT_AB_BENCHMARK_CONFIG for the affected field
// only -- one field being wrong never disables a sibling that was fine.

export interface AbBenchmarkConfig {
  readonly enabled: boolean;
  /** Fraction of eligible gate decisions queued for comparison, in [0, 1]. */
  readonly sampleRate: number;
  /**
   * The most samples this benchmark will queue in one calendar day.
   * Rate-limit protection, not a budget: a real Jev/large-model call spends
   * the person's own usage allowance, and a run that queued without limit
   * could burn through it and rate-limit them out of their own editor.
   */
  readonly dailySampleCap: number;
}

// Off by default (see the module note above). sampleRate and dailySampleCap
// are deliberately conservative: this is real traffic through a paid
// account, and picking a large default "to get more signal faster" is
// exactly the kind of unmeasured confidence this plugin exists to remove.
export const DEFAULT_AB_BENCHMARK_CONFIG: AbBenchmarkConfig = {
  enabled: false,
  sampleRate: 0.02,
  dailySampleCap: 20,
};

function isValidSampleRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidDailySampleCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parses `<configDir>/ab-benchmark-config.json`'s content. Never throws: a
 * missing file (pass `""`), malformed JSON, a non-object payload, or a
 * field of the wrong type or out of range all fall back to
 * DEFAULT_AB_BENCHMARK_CONFIG for the affected field only.
 */
export function parseAbBenchmarkConfig(content: string): AbBenchmarkConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return DEFAULT_AB_BENCHMARK_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_AB_BENCHMARK_CONFIG;

  const record = parsed as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_AB_BENCHMARK_CONFIG.enabled;
  const sampleRate = isValidSampleRate(record.sampleRate) ? record.sampleRate : DEFAULT_AB_BENCHMARK_CONFIG.sampleRate;
  const dailySampleCap = isValidDailySampleCap(record.dailySampleCap) ? record.dailySampleCap : DEFAULT_AB_BENCHMARK_CONFIG.dailySampleCap;
  return { enabled, sampleRate, dailySampleCap };
}
