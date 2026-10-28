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
//
// odd/tasks/tool-selection-off.md, T1: tool selection's switch is a
// three-way `toolsMode` (`off | measure | active`), `off` by default; a
// legacy `activeTools` boolean is still read when `toolsMode` is absent.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MOD_SKILLS_SWITCHES, TOOLS_MODES, parseModSkillsConfig, parseToolsMode, toolsModeFromSwitch } from "./mod_skills_config.ts";

test("skills default to measurement and tools to off", () => {
  assert.deepEqual(DEFAULT_MOD_SKILLS_SWITCHES, { active: false, toolsMode: "off" });
});

test("an empty string (file never written) falls back to the defaults", () => {
  assert.deepEqual(parseModSkillsConfig(""), { active: false, toolsMode: "off" });
});

test("malformed JSON falls back to the defaults, never throws", () => {
  assert.deepEqual(parseModSkillsConfig("{not json"), { active: false, toolsMode: "off" });
});

test("a JSON array (valid JSON, wrong shape) falls back to the defaults", () => {
  assert.deepEqual(parseModSkillsConfig("[1,2,3]"), { active: false, toolsMode: "off" });
});

test("JSON null falls back to the defaults", () => {
  assert.deepEqual(parseModSkillsConfig("null"), { active: false, toolsMode: "off" });
});

test("reads each of the three tool modes", () => {
  for (const mode of ["off", "measure", "active"] as const) {
    assert.deepEqual(parseModSkillsConfig(`{"active":true,"toolsMode":"${mode}"}`), { active: true, toolsMode: mode });
  }
});

test("a legacy activeTools boolean is kept when toolsMode is absent: true is active, false is measure", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true,"activeTools":true}'), { active: true, toolsMode: "active" });
  assert.deepEqual(parseModSkillsConfig('{"activeTools":false}'), { active: false, toolsMode: "measure" });
});

test("toolsMode wins over a legacy activeTools in the same file", () => {
  assert.deepEqual(parseModSkillsConfig('{"activeTools":true,"toolsMode":"off"}'), { active: false, toolsMode: "off" });
});

test("neither tool field reads as off", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true}'), { active: true, toolsMode: "off" });
});

test("a wrong-typed field falls back for that field only, never throws", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":"yes","activeTools":1}'), { active: false, toolsMode: "off" });
  // An unknown toolsMode reads as absent, so a legacy boolean beside it still counts.
  assert.deepEqual(parseModSkillsConfig('{"active":true,"toolsMode":"on","activeTools":true}'), { active: true, toolsMode: "active" });
  assert.deepEqual(parseModSkillsConfig('{"toolsMode":7}'), { active: false, toolsMode: "off" });
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(parseModSkillsConfig('{"active":true,"somethingElse":123}'), { active: true, toolsMode: "off" });
});

test("parseToolsMode accepts exactly the three modes", () => {
  assert.deepEqual(TOOLS_MODES, ["off", "measure", "active"]);
  assert.equal(parseToolsMode("measure"), "measure");
  for (const value of ["measurement", "ON", "", null, undefined, true, 1, {}]) assert.equal(parseToolsMode(value), null);
});

test("toolsModeFromSwitch maps a boolean switch and nothing else", () => {
  assert.equal(toolsModeFromSwitch(true), "active");
  assert.equal(toolsModeFromSwitch(false), "measure");
  for (const value of ["true", 1, null, undefined]) assert.equal(toolsModeFromSwitch(value), null);
});
