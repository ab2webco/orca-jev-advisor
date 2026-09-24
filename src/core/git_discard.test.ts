import { strict as assert } from "node:assert";
import { test } from "node:test";

import { discardsUncommittedWork, startsWithGitDiscard } from "./git_discard.ts";

// Each of these overwrites the working tree from the index or a commit, and
// uncommitted changes to those paths are gone: no reflog, no stash, nothing
// to recover them from.
const DISCARDS: readonly string[] = [
  "git checkout -- src/app.ts",
  "git checkout -- .",
  "git checkout .",
  "git checkout ./",
  "git checkout main -- src/app.ts",
  "git checkout HEAD~2 -- README.md",
  "git checkout -f",
  "git checkout --force",
  "git checkout -f main",
  "git checkout --force feature/x",
  "git checkout -qf main",
  "git checkout --pathspec-from-file=paths.txt",
  "git restore src/app.ts",
  "git restore .",
  "git restore --worktree src/app.ts",
  "git restore -W src/app.ts",
  "git restore --staged --worktree src/app.ts",
  "git restore -SW src/app.ts",
  "git restore --source=HEAD~1 src/app.ts",
  "git restore -s HEAD~1 src/app.ts",
  "git -C ../other checkout -- .",
  "git -c core.pager=cat restore src/app.ts",
  "git --no-pager checkout .",
  "cd repo && git checkout -- src/app.ts",
  "npm test; git restore .",
  "bash -c \"git checkout -- src/app.ts\"",
  "(git restore .)",
];

// None of these touches uncommitted work in the working tree.
const KEEPS: readonly string[] = [
  "git checkout main",
  "git checkout feature/login",
  "git checkout -b new-branch",
  "git checkout -b new-branch origin/main",
  // `-B` moves a branch pointer; like any checkout it carries local changes
  // over (or refuses on a conflict) rather than overwriting them.
  "git checkout -B rebuilt origin/main",
  "git checkout -q main",
  "git checkout -",
  // Branch-or-path ambiguity: git resolves a bare name as a branch first.
  // Left to the ordinary path on purpose -- see git_discard.ts.
  "git checkout src/app.ts",
  "git switch main",
  "git switch -c new-branch",
  "git restore --staged src/app.ts",
  "git restore -S src/app.ts",
  "git restore --staged .",
  "git status",
  "git log --oneline -- .",
  "git diff -- src/app.ts",
  "git checkout main && ls .",
  "grep -rn restore src",
  "echo git",
  "",
];

for (const command of DISCARDS) {
  test(`discards uncommitted work: ${command}`, () => {
    assert.equal(discardsUncommittedWork(command), true);
  });
}

for (const command of KEEPS) {
  test(`does not discard uncommitted work: ${JSON.stringify(command)}`, () => {
    assert.equal(discardsUncommittedWork(command), false);
  });
}

test("startsWithGitDiscard only looks at the start of one segment", () => {
  assert.equal(startsWithGitDiscard("git checkout -- src/app.ts"), true);
  assert.equal(startsWithGitDiscard("git restore ."), true);
  assert.equal(startsWithGitDiscard("git checkout main"), false);
  // A mention inside another program's arguments is not a family match.
  assert.equal(startsWithGitDiscard("bash -c \"git restore .\""), false);
});
