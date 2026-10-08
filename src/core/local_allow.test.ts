// Unit tests for local_allow.ts -- what a structurally qualifying command
// (Option D's own-branch push and guarded delete, T6's own-tree work, T7's
// trusted programs) does
// to the record. Run with:
//   node --test --experimental-strip-types src/core/local_allow.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { localAllowReasonKey, localAllowStopReason } from "./local_allow.ts";

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
