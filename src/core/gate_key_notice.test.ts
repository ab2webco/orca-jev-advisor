// Unit tests for decideNoKeyNotice -- pure input to pure output, no
// filesystem, no process, no network. Run with:
//   node --test src/core/gate_key_notice.test.ts
//
// The defect this closes: adapters/claude/gate-bash.ts silently passed
// commands through whenever resolveApiKey() returned null, with no signal
// to the developer that the Jev-backed half of the gate had stopped judging
// anything. This is the pure decision behind the one-time warning: warn
// exactly once per absence, stay silent on every following command while
// the key is still missing, and reset as soon as a key is seen again so a
// LATER disappearance earns a fresh warning instead of permanent silence.

import assert from "node:assert/strict";
import test from "node:test";

import { decideNoKeyNotice } from "./gate_key_notice.ts";

test("no key, never warned before -- warns now and marks warned", () => {
  const decision = decideNoKeyNotice(false, false);
  assert.equal(decision.shouldWarn, true);
  assert.equal(decision.nextWarned, true);
});

test("no key, already warned -- stays silent, marker stays warned", () => {
  const decision = decideNoKeyNotice(false, true);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextWarned, true);
});

test("key present, marker was warned -- resets silently so a later absence warns again", () => {
  const decision = decideNoKeyNotice(true, true);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextWarned, false);
});

test("key present, marker was never warned -- no-op, stays unwarned", () => {
  const decision = decideNoKeyNotice(true, false);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextWarned, false);
});
