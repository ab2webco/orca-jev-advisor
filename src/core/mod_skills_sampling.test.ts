// parseModSkillsSamplingConfig and shouldSamplePrompt are the pure halves of
// mod-skills' own sampling switch (`<configDir>/mod-skills-sampling-config.json`).
// Same "worker writes a plain file, a process with no channel into Orca's
// own storage reads it directly" shape as src/core/ab_benchmark_config.ts
// and src/core/mod_skills_config.ts.
//
// Unlike ab_benchmark_config.ts's fail-open-to-OFF contract, this fails
// open to a REDUCED rate, not to OFF and not to unlimited: the unsampled
// behaviour this file replaces (every prompt, no cap -- two Jev calls each
// time) is exactly the bug being fixed, so a missing, unreadable or
// malformed config must never fall back to it. A missing file, malformed
// JSON, or a wrong-typed/out-of-range field all fall back to
// DEFAULT_MOD_SKILLS_SAMPLING_CONFIG for the affected field only -- one
// field being wrong never disables a sibling that was fine.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, parseModSkillsSamplingConfig, shouldSamplePrompt } from "./mod_skills_sampling.ts";

// ---------------------------------------------------------------------------
// parseModSkillsSamplingConfig
// ---------------------------------------------------------------------------

test("default config samples at a conservative rate with a daily cap, not the old unlimited behaviour", () => {
  assert.deepEqual(DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, { enabled: true, sampleRate: 0.25, dailyPromptCap: 40 });
});

test("an empty string (file never written) falls back to the default", () => {
  assert.deepEqual(parseModSkillsSamplingConfig(""), DEFAULT_MOD_SKILLS_SAMPLING_CONFIG);
});

test("malformed JSON falls back to the default, never throws", () => {
  assert.deepEqual(parseModSkillsSamplingConfig("{not json"), DEFAULT_MOD_SKILLS_SAMPLING_CONFIG);
});

test("a JSON array (valid JSON, wrong shape) falls back to the default", () => {
  assert.deepEqual(parseModSkillsSamplingConfig("[1,2,3]"), DEFAULT_MOD_SKILLS_SAMPLING_CONFIG);
});

test("JSON null falls back to the default", () => {
  assert.deepEqual(parseModSkillsSamplingConfig("null"), DEFAULT_MOD_SKILLS_SAMPLING_CONFIG);
});

test("reads a fully-specified, valid config through unchanged", () => {
  assert.deepEqual(parseModSkillsSamplingConfig('{"enabled":false,"sampleRate":0.1,"dailyPromptCap":5}'), {
    enabled: false,
    sampleRate: 0.1,
    dailyPromptCap: 5,
  });
});

test("a wrong-typed 'enabled' falls back to the default for that field only, sibling fields still read", () => {
  assert.deepEqual(parseModSkillsSamplingConfig('{"enabled":"yes","sampleRate":0.1,"dailyPromptCap":5}'), {
    enabled: true,
    sampleRate: 0.1,
    dailyPromptCap: 5,
  });
});

test("a sampleRate outside [0, 1] falls back to the default sample rate, never a silent clamp", () => {
  assert.equal(parseModSkillsSamplingConfig('{"sampleRate":1.5}').sampleRate, DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.sampleRate);
  assert.equal(parseModSkillsSamplingConfig('{"sampleRate":-0.1}').sampleRate, DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.sampleRate);
});

test("a non-integer or negative dailyPromptCap falls back to the default cap", () => {
  assert.equal(parseModSkillsSamplingConfig('{"dailyPromptCap":2.5}').dailyPromptCap, DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.dailyPromptCap);
  assert.equal(parseModSkillsSamplingConfig('{"dailyPromptCap":-1}').dailyPromptCap, DEFAULT_MOD_SKILLS_SAMPLING_CONFIG.dailyPromptCap);
});

test("dailyPromptCap of exactly 0 is valid -- it means 'sampled but never queued', not 'unset'", () => {
  assert.equal(parseModSkillsSamplingConfig('{"dailyPromptCap":0}').dailyPromptCap, 0);
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(parseModSkillsSamplingConfig('{"enabled":true,"sampleRate":0.1,"dailyPromptCap":5,"somethingElse":123}'), {
    enabled: true,
    sampleRate: 0.1,
    dailyPromptCap: 5,
  });
});

// ---------------------------------------------------------------------------
// shouldSamplePrompt
// ---------------------------------------------------------------------------

test("shouldSamplePrompt: disabled config never samples, regardless of the random draw", () => {
  const config = { ...DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, enabled: false, sampleRate: 1 };
  assert.equal(shouldSamplePrompt(config, 0, 0), false);
});

test("shouldSamplePrompt: at or past the daily cap, never samples even when enabled and the draw is favorable", () => {
  const config = { ...DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, enabled: true, sampleRate: 1, dailyPromptCap: 5 };
  assert.equal(shouldSamplePrompt(config, 5, 0), false);
  assert.equal(shouldSamplePrompt(config, 6, 0), false);
});

test("shouldSamplePrompt: below the cap, samples exactly when random < sampleRate", () => {
  const config = { ...DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, enabled: true, sampleRate: 0.1, dailyPromptCap: 20 };
  assert.equal(shouldSamplePrompt(config, 0, 0.05), true);
  assert.equal(shouldSamplePrompt(config, 0, 0.1), false);
  assert.equal(shouldSamplePrompt(config, 0, 0.5), false);
});

test("shouldSamplePrompt: the default config samples less than the old unsampled behaviour (rate 1.0, no cap) -- regression guard for the bug this file fixes", () => {
  assert.equal(shouldSamplePrompt(DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, 0, 0.5), false);
  assert.equal(shouldSamplePrompt(DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, 0, 0.1), true);
});
