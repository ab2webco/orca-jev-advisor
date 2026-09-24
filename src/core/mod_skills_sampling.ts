// The skills mod's own sampling switch: `<configDir>/mod-skills-sampling-config.json`.
//
// mod-skills' measurement mode makes two Jev calls per prompt -- rank every
// skill and gate, then re-read the shortlist with the opening of their
// SKILL.md -- on every prompt of every session, indefinitely, purely for
// calibration data (see src/core/mod_skills_readiness.ts for what "the
// calibration is done" now means as code, rather than a vibe). That is a
// permanent latency and API cost with no stated finish line. Same "worker
// writes a plain file, a process with no channel into Orca's own `storage`
// reads it directly" shape as src/core/ab_benchmark_config.ts and
// src/core/mod_skills_config.ts -- no panel UI ships with this pass, so
// today this file is created and edited by hand.
//
// Unlike ab_benchmark_config.ts (fails open to OFF: that feature spends a
// person's own large-model usage they have to opt into), this fails open to
// a REDUCED rate, not to OFF and not to the old unlimited behaviour: the
// unsampled behaviour this file replaces (every prompt, no cap) is exactly
// the bug this file exists to fix, so a missing, unreadable or malformed
// config must fall back to something SAFER than what shipped before, never
// to it. A missing file, malformed JSON, or a wrong-typed/out-of-range
// field all fall back to DEFAULT_MOD_SKILLS_SAMPLING_CONFIG for the
// affected field only -- one field being wrong-typed never invalidates a
// sibling that was fine.

export interface ModSkillsSamplingConfig {
  readonly enabled: boolean;
  /** Fraction of eligible measurement-mode prompts sampled for a Jev call, in [0, 1]. */
  readonly sampleRate: number;
  /** The most prompts this mod will sample for measurement in one calendar day. */
  readonly dailyPromptCap: number;
}

// On by default, but at a conservative rate and cap -- see the module note
// above: the previous, unsampled behaviour (effectively rate 1.0, no cap)
// is the problem this file exists to fix, so the default must reduce it,
// not preserve it.
export const DEFAULT_MOD_SKILLS_SAMPLING_CONFIG: ModSkillsSamplingConfig = {
  enabled: true,
  sampleRate: 0.25,
  dailyPromptCap: 40,
};

function isValidSampleRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidDailyPromptCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parses `<configDir>/mod-skills-sampling-config.json`'s content. Never
 * throws: a missing file (pass `""`), malformed JSON, a non-object payload,
 * or a field of the wrong type or out of range all fall back to
 * DEFAULT_MOD_SKILLS_SAMPLING_CONFIG for the affected field only.
 */
export function parseModSkillsSamplingConfig(content: string): ModSkillsSamplingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return DEFAULT_MOD_SKILLS_SAMPLING_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_MOD_SKILLS_SAMPLING_CONFIG;

  const record = parsed as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.enabled;
  const sampleRate = isValidSampleRate(record.sampleRate) ? record.sampleRate : DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.sampleRate;
  const dailyPromptCap = isValidDailyPromptCap(record.dailyPromptCap) ? record.dailyPromptCap : DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.dailyPromptCap;
  return { enabled, sampleRate, dailyPromptCap };
}

/**
 * Whether to spend this prompt's two Jev calls on measurement-mode
 * calibration. `random` and `promptsSampledToday` are supplied by the
 * caller (Math.random() and a same-day count read from the mod's own
 * measurement log) so this stays pure and trivially testable -- same
 * signature shape as src/core/ab_benchmark.ts's own shouldSample.
 */
export function shouldSamplePrompt(config: ModSkillsSamplingConfig, promptsSampledToday: number, random: number): boolean {
  if (!config.enabled) return false;
  if (promptsSampledToday >= config.dailyPromptCap) return false;
  return random < config.sampleRate;
}
