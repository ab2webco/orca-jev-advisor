// Unit tests for branch_effect.ts. Run with:
//   node --test src/core/branch_effect.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { detectBranchEffect } from "./branch_effect.ts";
import { buildActionGateState } from "./decisions.ts";

test("gh pr update-branch, with or without a number or --rebase, says it writes only the pull request's branch", () => {
  for (const command of ["gh pr update-branch", "gh pr update-branch 821", "gh pr update-branch 821 --rebase", "cd app && gh pr update-branch https://github.com/acme/web/pull/7"]) {
    const effect = detectBranchEffect(command);
    assert.ok(effect !== null, command);
    assert.match(effect, /pull request's own branch/);
    assert.match(effect, /never writes to the base branch/);
  }
});

test("a mention of update-branch, or another gh pr subcommand, is no fact", () => {
  assert.equal(detectBranchEffect(`grep -rn "gh pr update-branch" docs/`), null);
  assert.equal(detectBranchEffect(`git commit -m "run gh pr update-branch 821"`), null);
  assert.equal(detectBranchEffect("gh pr merge 821 --squash"), null);
  assert.equal(detectBranchEffect("gh pr view 821"), null);
});

test("the fact reaches Jev's state beside the command, and is absent when there is none", () => {
  const withFact = buildActionGateState("gh pr update-branch 821", "", undefined, undefined, undefined, { branchEffect: detectBranchEffect("gh pr update-branch 821") ?? undefined });
  assert.match(String(withFact["branchEffect"]), /pull request's own branch/);
  assert.equal("branchEffect" in buildActionGateState("ls", ""), false);
});
