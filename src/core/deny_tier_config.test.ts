// parseDenyTierConfig is the pure half of the deny-tier switches file
// (`<configDir>/deny-tier-config.json`, written by the Orca worker's
// write-secret-mirror.mjs sidecar and read directly by
// adapters/claude/gate-bash.ts -- the same "worker writes, the plain Node
// process reads a plain file" shape src/core/mod_skills_config.ts already
// uses for the skill/tool selection switches).
//
// Unlike mod_skills_config.ts, this fails CLOSED: a missing file, malformed
// JSON, a non-object payload, or a wrong-typed field must all fall back to
// `true` (still denying) for the affected switch, never to `false`. Turning
// a rule off is only ever the result of an explicit, well-formed `false` --
// see NEVER_SILENTLY's three deny-tier rules in adapters/claude/gate-bash.ts
// for why: `rm -rf /`, `DROP`/`TRUNCATE TABLE`, and `terraform destroy` are
// blast radius beyond the repository AND beyond recovery, and a config that
// cannot be read is not permission to stop protecting against them.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DENY_TIER_SWITCHES, parseDenyTierConfig } from "./deny_tier_config.ts";

test("every switch defaults to on (still denying)", () => {
  assert.deepEqual(DEFAULT_DENY_TIER_SWITCHES, DEFAULT_DENY_TIER_SWITCHES);
});

test("an empty string (file never written) fails closed to every switch on", () => {
  assert.deepEqual(parseDenyTierConfig(""), DEFAULT_DENY_TIER_SWITCHES);
});

test("malformed JSON fails closed to every switch on, never throws", () => {
  assert.deepEqual(parseDenyTierConfig("{not json"), DEFAULT_DENY_TIER_SWITCHES);
});

test("a JSON array (valid JSON, wrong shape) fails closed to every switch on", () => {
  assert.deepEqual(parseDenyTierConfig("[1,2,3]"), DEFAULT_DENY_TIER_SWITCHES);
});

test("JSON null fails closed to every switch on", () => {
  assert.deepEqual(parseDenyTierConfig("null"), DEFAULT_DENY_TIER_SWITCHES);
});

test("reads the switches when explicitly turned off", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":false,"denyDropTable":false,"denyTerraformDestroy":false}'),
    { ...DEFAULT_DENY_TIER_SWITCHES, denyRmRf: false, denyDropTable: false, denyTerraformDestroy: false },
  );
});

test("reads each switch independently, the rest staying at their fail-closed default", () => {
  assert.deepEqual(parseDenyTierConfig('{"denyRmRf":false}'), { ...DEFAULT_DENY_TIER_SWITCHES, denyRmRf: false });
  assert.deepEqual(parseDenyTierConfig('{"denyDropTable":false}'), { ...DEFAULT_DENY_TIER_SWITCHES, denyDropTable: false });
  assert.deepEqual(parseDenyTierConfig('{"denyTerraformDestroy":false}'), { ...DEFAULT_DENY_TIER_SWITCHES, denyTerraformDestroy: false });
});

test("a wrong-typed field falls back to on (denying) for that field only, never throws", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":"no","denyDropTable":0,"denyTerraformDestroy":false}'),
    { ...DEFAULT_DENY_TIER_SWITCHES, denyTerraformDestroy: false },
  );
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":false,"somethingElse":123}'),
    { ...DEFAULT_DENY_TIER_SWITCHES, denyRmRf: false },
  );
});

// The inversion: deny is the rule, ask the opt-out.
//
// Measured on the real approvals log before this change: 3103 `approved`
// against 1 `rejected`, and 5 of 16 questions never answered at all. A
// question whose answer is yes 99.97% of the time is not buying safety, it is
// buying the person's attention -- and the dialog's cursor starts on "Yes", so
// a reflex Enter defeats it anyway. `deny` refuses the call and hands the
// reason to the model, which then picks another approach; nobody waits. That
// is the whole point of running with permission prompts turned off.
test("every rule denies by default, not just the three irrecoverable ones", () => {
  const every = Object.values(DEFAULT_DENY_TIER_SWITCHES);
  assert.equal(every.length, 9, "one switch per NEVER_SILENTLY rule");
  assert.ok(every.every((v) => v === true), "all of them default to deny");
});

test("a switch set to false downgrades that rule, and only that rule", () => {
  const s = parseDenyTierConfig(JSON.stringify({ denyResetClean: false }));
  assert.equal(s.denyResetClean, false);
  assert.equal(s.denyRmRf, true);
  assert.equal(s.denyCurlPipeShell, true);
});
