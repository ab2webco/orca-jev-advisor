// evaluateModSkillsReadiness turns the two numbers
// adapters/orca/read-measurements.mjs's aggregateModSkills already produces
// (comparableCount, matchRate) into the activation metric
// adapters/claude/mod-skills/hooks/index.ts's own module note promised but
// never stated as code: "active mode does not turn on until a week of
// measurement-mode data exists to set these thresholds from." Pure: no
// file IO, no defaults baked separately into the panel or the CLI -- one
// source of truth for "not ready yet" that a panel can render without
// duplicating the logic.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS, evaluateModSkillsReadiness } from "./mod_skills_readiness.ts";

test("default thresholds require 1000 comparable samples and a 0.7 match rate", () => {
  assert.deepEqual(DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS, { minComparable: 1000, minMatchRate: 0.7 });
});

test("zero samples: not ready, full shortfall, no match-rate evidence yet", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 0, matchRate: null }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: false, comparableShortfall: 1000, matchRateMet: null, reason: "not-enough-samples" });
});

test("samples below the count threshold: not ready, reports the exact shortfall, matchRateMet stays null even when a rate happens to be present", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 400, matchRate: 0.9 }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: false, comparableShortfall: 600, matchRateMet: null, reason: "not-enough-samples" });
});

test("count met but matchRate null: not ready, reason stays not-enough-samples -- never a fabricated false", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 1000, matchRate: null }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: false, comparableShortfall: 0, matchRateMet: null, reason: "not-enough-samples" });
});

test("count met, rate below threshold: not ready, matchRateMet is false", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 1000, matchRate: 0.5 }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: false, comparableShortfall: 0, matchRateMet: false, reason: "match-rate-too-low" });
});

test("count met, rate exactly at the threshold: ready -- the boundary is inclusive", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 1000, matchRate: 0.7 }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: true, comparableShortfall: 0, matchRateMet: true, reason: "ready" });
});

test("both thresholds comfortably met: ready", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 2000, matchRate: 0.95 }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS);
  assert.deepEqual(result, { ready: true, comparableShortfall: 0, matchRateMet: true, reason: "ready" });
});

test("custom thresholds are honored, not just the default constant", () => {
  const result = evaluateModSkillsReadiness({ comparableCount: 50, matchRate: 0.6 }, { minComparable: 50, minMatchRate: 0.6 });
  assert.deepEqual(result, { ready: true, comparableShortfall: 0, matchRateMet: true, reason: "ready" });
});
