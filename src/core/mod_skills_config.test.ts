// parseModSkillsConfig is the pure half of the mod-skills switches file
// (`<configDir>/mod-skills-config.json`, written by the Orca worker's
// write-secret-mirror.mjs sidecar and read directly by
// adapters/claude/mod-skills/hooks/runtime.ts -- the same "worker writes,
// hooks sandbox reads a plain file" shape src/core/i18n.ts already uses for
// the locale mirror).
//
// See odd/tasks/panel-worker-wakeup.md, T10: `active`/`activeTools` were
// wired only to Claude Code's `options`, which this repo never populates
// (no `userConfig` declared anywhere), so both switches were permanently
// unreachable. This file is their new, actually-reachable home.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MOD_SKILLS_SWITCHES, parseModSkillsConfig } from "./mod_skills_config.ts";

test("both switches default to off", () => {
  assert.deepEqual(DEFAULT_MOD_SKILLS_SWITCHES, { active: false, activeTools: false });
});

test("an empty string (file never written) falls back to both off", () => {
  assert.deepEqual(parseModSkillsConfig(""), { active: false, activeTools: false });
});

test("malformed JSON falls back to both off, never throws", () => {
  assert.deepEqual(parseModSkillsConfig("{not json"), { active: false, activeTools: false });
});

test("a JSON array (valid JSON, wrong shape) falls back to both off", () => {
  assert.deepEqual(parseModSkillsConfig("[1,2,3]"), { active: false, activeTools: false });
});

test("JSON null falls back to both off", () => {
  assert.deepEqual(parseModSkillsConfig("null"), { active: false, activeTools: false });
});

test("reads both switches when both are true", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true,"activeTools":true}'), { active: true, activeTools: true });
});

test("reads each switch independently", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true}'), { active: true, activeTools: false });
  assert.deepEqual(parseModSkillsConfig('{"activeTools":true}'), { active: false, activeTools: true });
});

test("a wrong-typed field falls back to off for that field only, never throws", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":"yes","activeTools":1}'), { active: false, activeTools: false });
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true,"somethingElse":123}'), { active: true, activeTools: false });
});
