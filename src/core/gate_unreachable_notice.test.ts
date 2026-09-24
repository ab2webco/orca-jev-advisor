// Unit tests for decideUnreachableNotice -- pure input to pure output, no
// filesystem, no process, no network. Run with:
//   node --test --experimental-strip-types src/core/gate_unreachable_notice.test.ts
//
// The defect this closes: adapters/claude/gate-bash.ts's 'none' JevOutcome
// (askJev could not reach the backend at all -- network, timeout, budget)
// silently passed the command through with no record anywhere. The gate log
// kept filling with 'cache' and 'local-rule' rows, so it looked healthy
// while the Jev-backed half of the gate was in fact disarmed. This is the
// pure decision behind a warn-after-N-consecutive-failures notice: it warns
// exactly once, on the call where the run of failures reaches the
// threshold, and stays silent afterward until a reached backend resets it.

import assert from "node:assert/strict";
import test from "node:test";

import { decideUnreachableNotice } from "./gate_unreachable_notice.ts";

test("backend reached -- resets the counter to 0 and never warns, regardless of prior failures", () => {
  const decision = decideUnreachableNotice(true, 5, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 0);
});

test("backend reached with a zero counter -- still resets (no-op) and never warns", () => {
  const decision = decideUnreachableNotice(true, 0, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 0);
});

test("unreached, one below threshold -- increments but does not warn yet", () => {
  const decision = decideUnreachableNotice(false, 1, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 2);
});

test("unreached, reaching the threshold exactly -- warns on this exact call", () => {
  const decision = decideUnreachableNotice(false, 2, 3);
  assert.equal(decision.shouldWarn, true);
  assert.equal(decision.nextConsecutiveFailures, 3);
});

test("unreached, one past the threshold -- stays silent, the warning does not repeat every command", () => {
  const decision = decideUnreachableNotice(false, 3, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 4);
});

test("unreached, far past the threshold -- still silent without an intervening success", () => {
  const decision = decideUnreachableNotice(false, 10, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 11);
});

test("a success after the threshold resets the counter, so a later run of failures warns again", () => {
  const afterWarning = decideUnreachableNotice(false, 2, 3);
  assert.equal(afterWarning.shouldWarn, true);
  const afterSuccess = decideUnreachableNotice(true, afterWarning.nextConsecutiveFailures, 3);
  assert.equal(afterSuccess.shouldWarn, false);
  assert.equal(afterSuccess.nextConsecutiveFailures, 0);
  const nextFailure = decideUnreachableNotice(false, afterSuccess.nextConsecutiveFailures, 3);
  assert.equal(nextFailure.shouldWarn, false);
  assert.equal(nextFailure.nextConsecutiveFailures, 1);
});

test("the very first failure from a zero counter never warns by itself for a threshold of 3", () => {
  const decision = decideUnreachableNotice(false, 0, 3);
  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.nextConsecutiveFailures, 1);
});

test("a threshold below 1 is treated as 1 -- the very first failure warns", () => {
  const zero = decideUnreachableNotice(false, 0, 0);
  assert.equal(zero.shouldWarn, true);
  assert.equal(zero.nextConsecutiveFailures, 1);

  const negative = decideUnreachableNotice(false, 0, -5);
  assert.equal(negative.shouldWarn, true);
  assert.equal(negative.nextConsecutiveFailures, 1);
});

test("a threshold below 1 still only warns once per run of failures, not on every subsequent one", () => {
  const first = decideUnreachableNotice(false, 0, 1);
  assert.equal(first.shouldWarn, true);
  const second = decideUnreachableNotice(false, first.nextConsecutiveFailures, 1);
  assert.equal(second.shouldWarn, false);
  assert.equal(second.nextConsecutiveFailures, 2);
});
