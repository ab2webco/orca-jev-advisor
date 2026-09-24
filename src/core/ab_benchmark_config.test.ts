// parseAbBenchmarkConfig is the pure half of the A/B-benchmark switch
// (`<configDir>/ab-benchmark-config.json`). Same "worker writes a plain
// file, a process with no channel into Orca's own storage reads it
// directly" shape as src/core/mod_skills_config.ts and
// src/core/deny_tier_config.ts.
//
// This one follows mod_skills_config.ts's fail-open-to-OFF contract, not
// deny_tier_config.ts's fail-closed-to-protective one: the benchmark spends
// the person's own Jev/big-model usage and does nothing unless deliberately
// turned on (same reasoning as ModSkillsSwitches -- an experimental feature
// defaults to off, not to on-with-a-guess). A missing file, malformed JSON,
// or a wrong-typed field all fall back to DEFAULT_AB_BENCHMARK_CONFIG for
// the affected field, exactly like parseModSkillsConfig.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AB_BENCHMARK_CONFIG, parseAbBenchmarkConfig } from "./ab_benchmark_config.ts";

test("default config is disabled, with a conservative sample rate and daily cap", () => {
  assert.deepEqual(DEFAULT_AB_BENCHMARK_CONFIG, { enabled: false, sampleRate: 0.02, dailySampleCap: 20 });
});

test("an empty string (file never written) falls back to the default, disabled", () => {
  assert.deepEqual(parseAbBenchmarkConfig(""), DEFAULT_AB_BENCHMARK_CONFIG);
});

test("malformed JSON falls back to the default, never throws", () => {
  assert.deepEqual(parseAbBenchmarkConfig("{not json"), DEFAULT_AB_BENCHMARK_CONFIG);
});

test("a JSON array (valid JSON, wrong shape) falls back to the default", () => {
  assert.deepEqual(parseAbBenchmarkConfig("[1,2,3]"), DEFAULT_AB_BENCHMARK_CONFIG);
});

test("JSON null falls back to the default", () => {
  assert.deepEqual(parseAbBenchmarkConfig("null"), DEFAULT_AB_BENCHMARK_CONFIG);
});

test("reads a fully-specified, valid config through unchanged", () => {
  assert.deepEqual(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":0.1,"dailySampleCap":5}'), {
    enabled: true,
    sampleRate: 0.1,
    dailySampleCap: 5,
  });
});

test("a wrong-typed 'enabled' falls back to false for that field only, sibling fields still read", () => {
  assert.deepEqual(parseAbBenchmarkConfig('{"enabled":"yes","sampleRate":0.1,"dailySampleCap":5}'), {
    enabled: false,
    sampleRate: 0.1,
    dailySampleCap: 5,
  });
});

test("a sampleRate outside [0, 1] falls back to the default sample rate, never a silent clamp", () => {
  assert.equal(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":1.5,"dailySampleCap":5}').sampleRate, DEFAULT_AB_BENCHMARK_CONFIG.sampleRate);
  assert.equal(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":-0.1,"dailySampleCap":5}').sampleRate, DEFAULT_AB_BENCHMARK_CONFIG.sampleRate);
});

test("a non-integer or negative dailySampleCap falls back to the default cap", () => {
  assert.equal(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":0.1,"dailySampleCap":2.5}').dailySampleCap, DEFAULT_AB_BENCHMARK_CONFIG.dailySampleCap);
  assert.equal(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":0.1,"dailySampleCap":-1}').dailySampleCap, DEFAULT_AB_BENCHMARK_CONFIG.dailySampleCap);
});

test("dailySampleCap of exactly 0 is valid -- it means 'sampled but never queued', not 'unset'", () => {
  assert.equal(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":0.1,"dailySampleCap":0}').dailySampleCap, 0);
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(parseAbBenchmarkConfig('{"enabled":true,"sampleRate":0.1,"dailySampleCap":5,"somethingElse":123}'), {
    enabled: true,
    sampleRate: 0.1,
    dailySampleCap: 5,
  });
});
