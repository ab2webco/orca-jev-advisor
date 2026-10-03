// Unit tests for branch_effect.ts. Run with:
//   node --test src/core/branch_effect.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { detectBranchEffect, syncActingDirectories } from "./branch_effect.ts";
import { buildActionGateState } from "./decisions.ts";

test("gh pr update-branch, with or without a number or --rebase, says it writes only the pull request's branch", () => {
  for (const command of ["gh pr update-branch", "gh pr update-branch 821", "gh pr update-branch 821 --rebase", "cd app && gh pr update-branch https://github.com/acme/web/pull/7"]) {
    const effect = detectBranchEffect(command, null);
    assert.ok(effect !== null, command);
    assert.match(effect, /pull request's own branch/);
    assert.match(effect, /never writes to the base branch/);
  }
});

test("a mention of update-branch, or another gh pr subcommand, is no fact", () => {
  assert.equal(detectBranchEffect(`grep -rn "gh pr update-branch" docs/`, null), null);
  assert.equal(detectBranchEffect(`git commit -m "run gh pr update-branch 821"`, null), null);
  assert.equal(detectBranchEffect("gh pr merge 821 --squash", null), null);
  assert.equal(detectBranchEffect("gh pr view 821", null), null);
});

test("the fact reaches Jev's state beside the command, and is absent when there is none", () => {
  const withFact = buildActionGateState("gh pr update-branch 821", "", undefined, undefined, undefined, { branchEffect: detectBranchEffect("gh pr update-branch 821", "main") ?? undefined });
  assert.match(String(withFact["branchEffect"]), /pull request's own branch/);
  assert.equal("branchEffect" in buildActionGateState("ls", ""), false);
});

const SYNC_FACT = /only the commits that already exist on its own remote branch/;

test("syncing the current branch with its own remote branch carries the sync fact", () => {
  for (const command of [
    "git pull",
    "git pull --ff-only",
    "git pull --rebase",
    "git pull --no-rebase",
    "git pull origin",
    "git pull origin main",
    "git pull --ff-only origin main",
    "git merge origin/main",
    "git merge --ff-only origin/main",
    "git merge @{u}",
    "git merge --ff-only @{upstream}",
    "git rebase origin/main",
    "git rebase @{u}",
    "cd app && git pull",
    "git -C app pull origin main",
    "git fetch origin && git merge --ff-only origin/main",
  ]) {
    assert.match(detectBranchEffect(command, "main") ?? "", SYNC_FACT, command);
  }
});

test("pulling or merging ANOTHER branch into the current one is not described", () => {
  for (const command of ["git pull origin feature-x", "git merge origin/feature-x", "git merge feature-x", "git merge --ff-only origin/feature-x", "git rebase origin/feature-x", "git pull origin feature-x:main", "git merge dev/main", "git pull https://example.com/other.git main", "git pull other main"]) {
    assert.equal(detectBranchEffect(command, "main"), null, command);
  }
});

test("flags that change what the command does are not described, nor are other writes in the same command", () => {
  for (const command of ["git pull --force", "git merge --squash origin/main", "git rebase --abort", "git pull && git push origin main", "git merge origin/main && git commit -am x", "echo $(git pull origin feature-x)", "git pull origin main | xargs git push"]) {
    assert.equal(detectBranchEffect(command, "main"), null, command);
  }
  assert.match(detectBranchEffect("git pull && git pull origin main", "main") ?? "", SYNC_FACT);
  assert.equal(detectBranchEffect("git pull && git pull origin feature-x", "main"), null);
});

test("a mention of a sync command is data", () => {
  assert.equal(detectBranchEffect(`git commit -m "git pull origin main"`, "main"), null);
  assert.equal(detectBranchEffect(`grep -rn "git merge origin/main" docs/`, "main"), null);
  assert.equal(detectBranchEffect(`echo git pull`, "main"), null);
});

test("without the current branch only the forms that cannot name another branch count", () => {
  for (const command of ["git pull", "git pull --ff-only", "git merge @{u}", "git rebase @{upstream}", "git pull origin"]) {
    assert.match(detectBranchEffect(command, null) ?? "", SYNC_FACT, command);
  }
  for (const command of ["git pull origin main", "git merge origin/main", "git rebase origin/main"]) {
    assert.equal(detectBranchEffect(command, null), null, command);
  }
});

test("the remote must be one of the repository's own remotes", () => {
  assert.match(detectBranchEffect("git pull upstream main", "main", ["origin", "upstream"]) ?? "", SYNC_FACT);
  assert.match(detectBranchEffect("git merge upstream/main", "main", ["origin", "upstream"]) ?? "", SYNC_FACT);
  assert.equal(detectBranchEffect("git merge upstream/main", "main", ["origin"]), null);
  assert.equal(detectBranchEffect("git merge feature/main", "main", ["origin"]), null);
  assert.equal(detectBranchEffect("git pull origin main", "main", []), null);
});

test("syncActingDirectories reads the directory a sync acts in, and none for other commands", () => {
  assert.deepEqual(syncActingDirectories("cd /srv/app && git pull", "/work", "/home/dev"), ["/srv/app"]);
  assert.deepEqual(syncActingDirectories("git -C ../other merge @{u}", "/work/app", "/home/dev"), ["/work/other"]);
  assert.deepEqual(syncActingDirectories("git status", "/work", "/home/dev"), []);
  assert.deepEqual(syncActingDirectories(`git commit -m "git pull"`, "/work", "/home/dev"), []);
});

test("the state carries the sync fact", () => {
  const state = buildActionGateState("git pull", "", undefined, undefined, undefined, { branchEffect: detectBranchEffect("git pull", "main") ?? undefined });
  assert.match(String(state["branchEffect"]), /^This command brings into the current branch only the commits that already exist on its own remote branch/);
});
