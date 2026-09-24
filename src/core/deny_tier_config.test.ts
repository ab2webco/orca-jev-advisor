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

test("all three switches default to on (still denying)", () => {
  assert.deepEqual(DEFAULT_DENY_TIER_SWITCHES, { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: true });
});

test("an empty string (file never written) fails closed to all three on", () => {
  assert.deepEqual(parseDenyTierConfig(""), { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: true });
});

test("malformed JSON fails closed to all three on, never throws", () => {
  assert.deepEqual(parseDenyTierConfig("{not json"), { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: true });
});

test("a JSON array (valid JSON, wrong shape) fails closed to all three on", () => {
  assert.deepEqual(parseDenyTierConfig("[1,2,3]"), { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: true });
});

test("JSON null fails closed to all three on", () => {
  assert.deepEqual(parseDenyTierConfig("null"), { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: true });
});

test("reads all three switches when explicitly turned off", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":false,"denyDropTable":false,"denyTerraformDestroy":false}'),
    { denyRmRf: false, denyDropTable: false, denyTerraformDestroy: false },
  );
});

test("reads each switch independently, the rest staying at their fail-closed default", () => {
  assert.deepEqual(parseDenyTierConfig('{"denyRmRf":false}'), { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true });
  assert.deepEqual(parseDenyTierConfig('{"denyDropTable":false}'), { denyRmRf: true, denyDropTable: false, denyTerraformDestroy: true });
  assert.deepEqual(parseDenyTierConfig('{"denyTerraformDestroy":false}'), { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: false });
});

test("a wrong-typed field falls back to on (denying) for that field only, never throws", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":"no","denyDropTable":0,"denyTerraformDestroy":false}'),
    { denyRmRf: true, denyDropTable: true, denyTerraformDestroy: false },
  );
});

test("an unknown extra field is ignored", () => {
  assert.deepEqual(
    parseDenyTierConfig('{"denyRmRf":false,"somethingElse":123}'),
    { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true },
  );
});
