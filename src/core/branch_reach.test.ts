// Unit tests for branch_reach.ts -- pure text in, facts out. Run with:
//   node --test --experimental-strip-types src/core/branch_reach.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { branchReachPlaces, namesProtectedBranch } from "./branch_reach.ts";

const PROTECTED: ReadonlySet<string> = new Set(["main", "master", "production", "develop", "staging"]);

test("namesProtectedBranch: a protected branch named as a word, a refspec side or a remote branch", () => {
  for (const command of [
    "git push origin main",
    'git push origin "main"',
    "git push origin HEAD:main",
    "git push origin +main",
    "git push origin refs/heads/main",
    "git checkout master",
    "git merge develop",
    "git rebase origin/main",
    "git switch Main",
    "git add x && git push origin staging 2>&1 | tail -3",
  ]) {
    assert.equal(namesProtectedBranch(command, PROTECTED), true, command);
  }
});

test("namesProtectedBranch: a file or a message that only contains the word does not name the branch", () => {
  for (const command of [
    "git add src/main.ts",
    "git add adapters/orca/main.mjs",
    'git commit -m "fix main menu"',
    "git add x",
    "git push origin feat/x",
    "node build.mjs --target=mainline",
  ]) {
    assert.equal(namesProtectedBranch(command, PROTECTED), false, command);
  }
});

test("namesProtectedBranch: a gh command that writes is read as reaching a protected branch, since its base is not in the text", () => {
  assert.equal(namesProtectedBranch("gh pr merge 12 --squash", PROTECTED), true);
  assert.equal(namesProtectedBranch("gh api -X PUT repos/o/r/pulls/12/merge", PROTECTED), true);
  assert.equal(namesProtectedBranch("gh pr view 12 --json state", PROTECTED), false);
});

test("namesProtectedBranch: an obviously safe segment never counts", () => {
  assert.equal(namesProtectedBranch("git log main..HEAD && git add x", PROTECTED), false);
});

test("branchReachPlaces: a plain write acts in the session's directory", () => {
  assert.deepEqual(branchReachPlaces("git add x", "/work/repo", "/Users/someone"), ["/work/repo"]);
});

test("branchReachPlaces: git -C and cd move the place, and the session no longer counts for that segment", () => {
  assert.deepEqual(branchReachPlaces("git -C /work/wt push origin feat/x", "/work/repo", "/Users/someone"), ["/work/wt"]);
  assert.deepEqual(branchReachPlaces("cd /work/wt && git commit -m x", "/work/repo", "/Users/someone"), ["/work/wt"]);
});

test("branchReachPlaces: a mixed command keeps the session's own place too", () => {
  assert.deepEqual([...branchReachPlaces("git commit -m x && git -C /work/wt push origin feat/x", "/work/repo", "/Users/someone")].sort(), ["/work/repo", "/work/wt"]);
});

test("branchReachPlaces: a place that cannot be known is null", () => {
  assert.deepEqual(branchReachPlaces('cd "$X" && git commit -m x', "/work/repo", "/Users/someone"), [null]);
});

test("branchReachPlaces: an obviously safe command reaches no place", () => {
  assert.deepEqual(branchReachPlaces("git status", "/work/repo", "/Users/someone"), []);
});
