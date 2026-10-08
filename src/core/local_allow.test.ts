// Unit tests for local_allow.ts -- what a structurally qualifying command
// (Option D's own-branch push and guarded delete, T6's own-tree work) does
// to the cache and the record. Run with:
//   node --test --experimental-strip-types src/core/local_allow.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { localAllowReasonKey, localAllowStopReason, replaysCachedDecision, storesVerdict } from "./local_allow.ts";

test("each kind of local allow records its own stop reason", () => {
  assert.equal(localAllowStopReason("ownBranchPush"), "local-allow");
  assert.equal(localAllowStopReason("guardedGitDelete"), "local-allow");
  assert.equal(localAllowStopReason("ownTree"), "own-tree");
  assert.equal(localAllowStopReason("trusted"), "trusted");
});

test("each kind of local allow shows its own reason", () => {
  assert.equal(localAllowReasonKey("ownBranchPush"), "reason.ownBranchPush");
  assert.equal(localAllowReasonKey("guardedGitDelete"), "reason.guardedGitDelete");
  assert.equal(localAllowReasonKey("ownTree"), "reason.ownTree");
  assert.equal(localAllowReasonKey("trusted"), "reason.trusted");
});

test("a cached advise is a risk verdict: never replayed for a qualifying command, which only a policy may stop", () => {
  assert.equal(replaysCachedDecision("advise", true), false);
  assert.equal(replaysCachedDecision("advise", false), true);
  for (const decision of ["allow", "ask", "deny"] as const) assert.equal(replaysCachedDecision(decision, true), true, decision);
});

test("an allow that came from the structural qualification is never cached for the shape", () => {
  assert.equal(storesVerdict(true), false);
  assert.equal(storesVerdict(false), true);
});
