// States mod-skills' activation metric as code, so "not ready yet" stops
// being a vibe with no finish line -- see adapters/claude/mod-skills/hooks/
// index.ts's own module note: "active mode does not turn on until a week of
// measurement-mode data exists to set these thresholds from." That sentence
// had no metric and no date attached to it anywhere in the codebase; this
// file is that metric.
//
// Pure function over the two numbers adapters/orca/read-measurements.mjs's
// aggregateModSkills already produces from the real measurement log
// (`comparableCount`, `matchRate`) -- no file IO here, so the CLI and any
// future panel read the exact same verdict rather than each growing its own
// copy of the threshold logic.

export interface ModSkillsReadinessThresholds {
  readonly minComparable: number;
  readonly minMatchRate: number;
}

// A week of real measurement-mode traffic is what the mod's own module note
// asks for; 1000 comparable decisions and a 0.7 match rate are this file's
// stated stand-in for "enough of that week actually landed, and Jev's
// picks were usually right" -- deliberately explicit constants, not a
// number buried in a panel string, so they can be revisited from one place.
export const DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS: ModSkillsReadinessThresholds = {
  minComparable: 1000,
  minMatchRate: 0.7,
};

export interface ModSkillsReadinessInput {
  readonly comparableCount: number;
  readonly matchRate: number | null;
}

export type ModSkillsReadinessReason = "not-enough-samples" | "match-rate-too-low" | "ready";

export interface ModSkillsReadiness {
  readonly ready: boolean;
  /** How many more comparable decisions are needed to meet the count threshold; 0 once it is met. */
  readonly comparableShortfall: number;
  /**
   * Whether the match rate clears its threshold. `null` while there is no
   * comparable evidence yet (either the count threshold isn't met, or --
   * for a caller that passes a null matchRate anyway -- there is simply
   * nothing to judge) -- never fabricated as `false`, which would report a
   * failed threshold that was never actually evaluated.
   */
  readonly matchRateMet: boolean | null;
  readonly reason: ModSkillsReadinessReason;
}

/**
 * Evaluates whether mod-skills has gathered enough measurement-mode
 * evidence, and evidence good enough, to consider turning active mode on.
 * The count threshold gates first: a `matchRate` computed from too few
 * comparable decisions is not trustworthy, so this never reports a
 * match-rate verdict until `comparableCount` alone clears `minComparable`.
 * The rate threshold is inclusive -- exactly `minMatchRate` counts as met.
 */
export function evaluateModSkillsReadiness(input: ModSkillsReadinessInput, thresholds: ModSkillsReadinessThresholds): ModSkillsReadiness {
  const comparableShortfall = Math.max(0, thresholds.minComparable - input.comparableCount);
  if (comparableShortfall > 0 || input.matchRate === null) {
    return { ready: false, comparableShortfall, matchRateMet: null, reason: "not-enough-samples" };
  }

  const matchRateMet = input.matchRate >= thresholds.minMatchRate;
  return {
    ready: matchRateMet,
    comparableShortfall: 0,
    matchRateMet,
    reason: matchRateMet ? "ready" : "match-rate-too-low",
  };
}
