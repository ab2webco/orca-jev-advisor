// Unit tests for push_own_branch.ts --
// odd/tasks/release-0.5.1-push-own-branch.md. Real evidence: the owner's
// gate log showed a plain, non-force push of the agent's own branch
// (`git push -u origin fabolivark/release-0.5.1`) asked once out of five
// identical runs, purely from Jev's own repeat-call noise on the
// consequence axis -- see decisions.ts's CONSEQUENCE_NOISE_MARGIN.
//
// Cases that only need an EXPLICIT, non-HEAD refspec never touch a real
// repository at all (the branch name is right there in the command). Cases
// that resolve the CURRENT branch (an omitted or explicit `HEAD` refspec,
// with no `cd` prefix) use a real temp git repository, same discipline as
// this project's other git-reading modules (linked_worktree.test.ts,
// push_remote.test.ts): the whole point is reading exactly what git itself
// writes to `.git/HEAD`, so a fake filesystem would only prove this module
// agrees with its own assumptions.
//
// Run with: node --test src/core/push_own_branch.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { qualifiesForOwnBranchPush } from "./push_own_branch.ts";

const TEMP_ROOTS: string[] = [];
function makeTempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP_ROOTS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull } });
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(["init", "-q"], root);
  git(["config", "user.email", "test@test.com"], root);
  git(["config", "user.name", "test"], root);
  git(["commit", "--allow-empty", "-q", "-m", "init"], root);
}

/** A repo checked out on `branch` (never main's own default name), for cases that resolve the current branch from `cwd`. */
function repoOnBranch(prefix: string, branch: string): string {
  const root = join(makeTempRoot(prefix), "repo");
  initRepo(root);
  git(["checkout", "-q", "-b", branch], root);
  return root;
}

// A cwd outside any git repository at all -- used for every case whose
// branch comes from an EXPLICIT refspec, so a HEAD read is never needed and
// never accidentally masks a bug in the shape-parsing itself.
const NO_REPO_CWD = "/nonexistent/not-a-repository";

// ---------------------------------------------------------------------------
// Qualifies: explicit refspec, no repository needed at all.
// ---------------------------------------------------------------------------

test("qualifies: a plain push with -u, origin and an explicit feature branch", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push -u origin feature/x", cwd: NO_REPO_CWD }), true);
});

test("qualifies: cd <dir> && git push -u origin feature/x -- the explicit refspec, not cwd, decides the branch", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo && git push -u origin feature/x", cwd: NO_REPO_CWD }), true);
});

test("qualifies: no options at all, just remote and an explicit branch", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin feature/x", cwd: NO_REPO_CWD }), true);
});

test("qualifies: remote only, no refspec at all, resolves the CURRENT branch", () => {
  const repo = repoOnBranch("push-own-branch-remote-only-", "feature/x");
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin", cwd: repo }), true);
});

// ---------------------------------------------------------------------------
// Qualifies: implicit/HEAD refspec, resolved from a real repository.
// ---------------------------------------------------------------------------

test("qualifies: bare `git push`, resolves the current (non-shared) branch", () => {
  const repo = repoOnBranch("push-own-branch-bare-", "feature/x");
  assert.equal(qualifiesForOwnBranchPush({ command: "git push", cwd: repo }), true);
});

test("qualifies: `git push origin HEAD` resolves the current branch explicitly named HEAD", () => {
  const repo = repoOnBranch("push-own-branch-head-", "feature/x");
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin HEAD", cwd: repo }), true);
});

// ---------------------------------------------------------------------------
// Does not qualify: the resolved/explicit branch is shared/protected.
// ---------------------------------------------------------------------------

test("does not qualify: an explicit push to main", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin main", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: bare `git push` while ON main -- pushProtectedRule's own regex never even sees the word \"main\" here, so this module must catch it independently", () => {
  const repo = join(makeTempRoot("push-own-branch-on-main-"), "repo");
  initRepo(repo); // stays on whatever git's own default branch is -- forced to "main" explicitly below
  git(["branch", "-M", "main"], repo);
  assert.equal(qualifiesForOwnBranchPush({ command: "git push", cwd: repo }), false);
});

test("does not qualify: master and production are protected too, same list pushProtectedRule uses", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin master", cwd: NO_REPO_CWD }), false);
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin production", cwd: NO_REPO_CWD }), false);
});

// ---------------------------------------------------------------------------
// Does not qualify: detached HEAD (no branch to resolve at all).
// ---------------------------------------------------------------------------

test("does not qualify: detached HEAD, bare `git push` -- nothing to resolve with certainty", () => {
  const root = join(makeTempRoot("push-own-branch-detached-"), "repo");
  initRepo(root);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  git(["checkout", "-q", sha], root);
  assert.equal(qualifiesForOwnBranchPush({ command: "git push", cwd: root }), false);
});

test("does not qualify: detached HEAD, `git push origin HEAD`", () => {
  const root = join(makeTempRoot("push-own-branch-detached-head-"), "repo");
  initRepo(root);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  git(["checkout", "-q", sha], root);
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin HEAD", cwd: root }), false);
});

test("does not qualify: no repository at all when the branch must be resolved from cwd", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push", cwd: NO_REPO_CWD }), false);
});

// ---------------------------------------------------------------------------
// Does not qualify: disallowed options.
// ---------------------------------------------------------------------------

const DISALLOWED_OPTION_COMMANDS = [
  "git push --force origin feature/x",
  "git push -f origin feature/x",
  "git push --force-with-lease origin feature/x",
  "git push --force-if-includes origin feature/x",
  "git push --delete origin feature/x",
  "git push -d origin feature/x",
  "git push --mirror",
  "git push --all",
  "git push --tags",
  "git push --prune origin",
  "git push --follow-tags origin feature/x",
  "git push -o ci.skip origin feature/x",
  "git push --push-option=ci.skip origin feature/x",
  "git push --repo=origin feature/x",
  "git push --no-verify origin feature/x",
  "git push -uq origin feature/x", // a clustered short flag, not an exact allowlisted token
  "git push --set-upstream=origin feature/x", // a --flag=value form
  "git push -- origin feature/x", // a bare --
];

for (const command of DISALLOWED_OPTION_COMMANDS) {
  test(`does not qualify: disallowed option -- ${command}`, () => {
    assert.equal(qualifiesForOwnBranchPush({ command, cwd: NO_REPO_CWD }), false);
  });
}

// ---------------------------------------------------------------------------
// Does not qualify: a refspec that is not a plain branch name.
// ---------------------------------------------------------------------------

const DISALLOWED_REFSPEC_COMMANDS = [
  "git push origin +feature/x", // leading + -- not denied by forcePush today either (verified live: someSegmentMatches returns null), but still not a plain branch name
  "git push origin feature/x:main", // src:dst
  "git push origin :feature/x", // :branch delete
  "git push origin refs/heads/feature/x", // a full ref path, not "a plain branch name"
  "git push origin 'feature/*'", // a glob
];

for (const command of DISALLOWED_REFSPEC_COMMANDS) {
  test(`does not qualify: not a plain branch refspec -- ${command}`, () => {
    assert.equal(qualifiesForOwnBranchPush({ command, cwd: NO_REPO_CWD }), false);
  });
}

// ---------------------------------------------------------------------------
// Does not qualify: the remote is not a bare name.
// ---------------------------------------------------------------------------

test("does not qualify: the remote positional is a URL, not a bare remote name", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push https://github.com/example/repo.git feature/x", cwd: NO_REPO_CWD }), false);
});

// ---------------------------------------------------------------------------
// Does not qualify: anything beyond exactly one push segment (optionally cd-prefixed).
// ---------------------------------------------------------------------------

test("does not qualify: a second command chained after the push", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin feature/x && rm -rf build", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: a mention, not a run -- the push text sits inside another program's own argument", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: 'echo "git push origin feature/x"', cwd: NO_REPO_CWD }), false);
});

test("does not qualify: command substitution present anywhere in the line", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "git push origin $(echo feature/x)", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: three segments -- more than one cd prefix", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd a && cd b && git push origin feature/x", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: a stray leading separator before the first segment", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "; git push -u origin feature/x", cwd: NO_REPO_CWD }), false);
});

// ---------------------------------------------------------------------------
// Does not qualify: the cd-prefix's own constraints.
// ---------------------------------------------------------------------------

test("does not qualify: cd prefix with an omitted refspec -- must not resolve HEAD from the wrong directory", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo && git push origin", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: cd prefix with an explicit HEAD refspec -- HEAD would still resolve from cwd, not from the cd target", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo && git push origin HEAD", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: cd joined by ';' instead of '&&'", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo ; git push -u origin feature/x", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: cd joined by '||'", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo || git push -u origin feature/x", cwd: NO_REPO_CWD }), false);
});

test("does not qualify: a 'cd' segment with flags or more than one argument", () => {
  assert.equal(qualifiesForOwnBranchPush({ command: "cd -L repo && git push -u origin feature/x", cwd: NO_REPO_CWD }), false);
  assert.equal(qualifiesForOwnBranchPush({ command: "cd repo extra && git push -u origin feature/x", cwd: NO_REPO_CWD }), false);
});

// ---------------------------------------------------------------------------
// Injected readFile: proves the HEAD-reading path itself, independent of a
// real repository's exact on-disk shape.
// ---------------------------------------------------------------------------

test("injected readFile: an ordinary checkout's HEAD is read straight through", () => {
  const reads: string[] = [];
  const readFile = (path: string): string => {
    reads.push(path);
    return "ref: refs/heads/feature/y\n";
  };
  const root = join(makeTempRoot("push-own-branch-injected-"), "repo");
  initRepo(root);
  assert.equal(qualifiesForOwnBranchPush({ command: "git push", cwd: root, readFile }), true);
  assert.ok(reads.some((p) => p.endsWith("HEAD")), "the injected reader must actually be consulted for HEAD");
});
