// Unit tests for push_own_branch.ts -- the own-branch-push /
// guarded-git-delete gate change. Real evidence: the owner's
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

import { qualifiesForLocalGitAllow } from "./push_own_branch.ts";

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
  assertQualifies("git push -u origin feature/x", NO_REPO_CWD, "ownBranchPush");
});

test("qualifies: cd <dir> && git push -u origin feature/x -- the explicit refspec, not cwd, decides the branch", () => {
  assertQualifies("cd repo && git push -u origin feature/x", NO_REPO_CWD, "ownBranchPush");
});

test("qualifies: no options at all, just remote and an explicit branch", () => {
  assertQualifies("git push origin feature/x", NO_REPO_CWD, "ownBranchPush");
});

test("qualifies: remote only, no refspec at all, resolves the CURRENT branch", () => {
  const repo = repoOnBranch("push-own-branch-remote-only-", "feature/x");
  assertQualifies("git push origin", repo, "ownBranchPush");
});

// ---------------------------------------------------------------------------
// Qualifies: implicit/HEAD refspec, resolved from a real repository.
// ---------------------------------------------------------------------------

test("qualifies: bare `git push`, resolves the current (non-shared) branch", () => {
  const repo = repoOnBranch("push-own-branch-bare-", "feature/x");
  assertQualifies("git push", repo, "ownBranchPush");
});

test("qualifies: `git push origin HEAD` resolves the current branch explicitly named HEAD", () => {
  const repo = repoOnBranch("push-own-branch-head-", "feature/x");
  assertQualifies("git push origin HEAD", repo, "ownBranchPush");
});

// ---------------------------------------------------------------------------
// Does not qualify: the resolved/explicit branch is shared/protected.
// ---------------------------------------------------------------------------

test("does not qualify: an explicit push to main", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin main", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: bare `git push` while ON main -- pushProtectedRule's own regex never even sees the word \"main\" here, so this module must catch it independently", () => {
  const repo = join(makeTempRoot("push-own-branch-on-main-"), "repo");
  initRepo(repo); // stays on whatever git's own default branch is -- forced to "main" explicitly below
  git(["branch", "-M", "main"], repo);
  assert.equal(qualifiesForLocalGitAllow({ command: "git push", cwd: repo }).qualifies, false);
});

test("does not qualify: master and production are protected too, same list pushProtectedRule uses", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin master", cwd: NO_REPO_CWD }).qualifies, false);
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin production", cwd: NO_REPO_CWD }).qualifies, false);
});

// ---------------------------------------------------------------------------
// Does not qualify: detached HEAD (no branch to resolve at all).
// ---------------------------------------------------------------------------

test("does not qualify: detached HEAD, bare `git push` -- nothing to resolve with certainty", () => {
  const root = join(makeTempRoot("push-own-branch-detached-"), "repo");
  initRepo(root);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  git(["checkout", "-q", sha], root);
  assert.equal(qualifiesForLocalGitAllow({ command: "git push", cwd: root }).qualifies, false);
});

test("does not qualify: detached HEAD, `git push origin HEAD`", () => {
  const root = join(makeTempRoot("push-own-branch-detached-head-"), "repo");
  initRepo(root);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  git(["checkout", "-q", sha], root);
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin HEAD", cwd: root }).qualifies, false);
});

test("does not qualify: no repository at all when the branch must be resolved from cwd", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push", cwd: NO_REPO_CWD }).qualifies, false);
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
    assert.equal(qualifiesForLocalGitAllow({ command, cwd: NO_REPO_CWD }).qualifies, false);
  });
}

// ---------------------------------------------------------------------------
// Does not qualify: a refspec that is not a plain branch name.
// ---------------------------------------------------------------------------

const DISALLOWED_REFSPEC_COMMANDS = [
  "git push origin +feature/x", // leading + -- also denied by forcePush now (a +refspec is a force push), but this module's own refspec rule rejects it independently too
  "git push origin feature/x:main", // src:dst
  "git push origin :feature/x", // :branch delete
  "git push origin refs/heads/feature/x", // a full ref path, not "a plain branch name"
  "git push origin 'feature/*'", // a glob
];

for (const command of DISALLOWED_REFSPEC_COMMANDS) {
  test(`does not qualify: not a plain branch refspec -- ${command}`, () => {
    assert.equal(qualifiesForLocalGitAllow({ command, cwd: NO_REPO_CWD }).qualifies, false);
  });
}

// ---------------------------------------------------------------------------
// Does not qualify: the remote is not a bare name.
// ---------------------------------------------------------------------------

test("does not qualify: the remote positional is a URL, not a bare remote name", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push https://github.com/example/repo.git feature/x", cwd: NO_REPO_CWD }).qualifies, false);
});

// ---------------------------------------------------------------------------
// Does not qualify: anything beyond exactly one push segment (optionally cd-prefixed).
// ---------------------------------------------------------------------------

test("does not qualify: a second command chained after the push", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin feature/x && rm -rf build", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: a mention, not a run -- the push text sits inside another program's own argument", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: 'echo "git push origin feature/x"', cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: command substitution present anywhere in the line", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push origin $(echo feature/x)", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: three segments -- more than one cd prefix", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd a && cd b && git push origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: a stray leading separator before the first segment", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "; git push -u origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
});

// ---------------------------------------------------------------------------
// Does not qualify: the cd-prefix's own constraints.
// ---------------------------------------------------------------------------

test("does not qualify: cd prefix with an omitted refspec -- must not resolve HEAD from the wrong directory", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd repo && git push origin", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: cd prefix with an explicit HEAD refspec -- HEAD would still resolve from cwd, not from the cd target", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd repo && git push origin HEAD", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: cd joined by ';' instead of '&&'", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd repo ; git push -u origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: cd joined by '||'", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd repo || git push -u origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
});

test("does not qualify: a 'cd' segment with flags or more than one argument", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "cd -L repo && git push -u origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
  assert.equal(qualifiesForLocalGitAllow({ command: "cd repo extra && git push -u origin feature/x", cwd: NO_REPO_CWD }).qualifies, false);
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
  const result = qualifiesForLocalGitAllow({ command: "git push", cwd: root, readFile });
  assert.equal(result.qualifies, true);
  assert.equal(result.reasonKind, "ownBranchPush");
  assert.ok(reads.some((p) => p.endsWith("HEAD")), "the injected reader must actually be consulted for HEAD");
});

// ===========================================================================
// qualifiesForLocalGitAllow -- the guarded-deletes extension. Real evidence,
// 2026-09-26: the owner had to confirm by hand
//   `git worktree remove ../orca-supervisor-lane-m && git branch -d
//   fabolivark/release-0.5.1-lane-m && git worktree add -q -b <new>
//   ../lane-s 9ebb862`
// -- Jev's reason was "no automatic way to undo it", but none of it can
// actually lose work: `git worktree remove` without `--force` already
// refuses a worktree with uncommitted/untracked changes, and
// `git branch -d` already refuses an unmerged branch.
// ===========================================================================

function assertQualifies(command: string, cwd: string | undefined, expectedReasonKind: "ownBranchPush" | "guardedGitDelete"): void {
  const result = qualifiesForLocalGitAllow({ command, cwd: cwd ?? NO_REPO_CWD });
  assert.equal(result.qualifies, true, `expected "${command}" to qualify`);
  assert.equal(result.reasonKind, expectedReasonKind);
}

function assertDoesNotQualify(command: string, cwd?: string): void {
  const result = qualifiesForLocalGitAllow({ command, cwd: cwd ?? NO_REPO_CWD });
  assert.equal(result.qualifies, false, `expected "${command}" NOT to qualify`);
}

test("qualifiesForLocalGitAllow: a plain git branch -d qualifies as a guarded delete", () => {
  assertQualifies("git branch -d feature/old", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: --delete is the same flag as -d", () => {
  assertQualifies("git branch --delete feature/old", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: branch -d accepts more than one name", () => {
  assertQualifies("git branch -d feature/old feature/older", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git branch -D (force-delete, skips the merged check)", () => {
  assertDoesNotQualify("git branch -D feature/old");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git branch -d -f (force alongside -d)", () => {
  assertDoesNotQualify("git branch -d -f feature/old");
});

test("qualifiesForLocalGitAllow: a plain git worktree remove qualifies", () => {
  assertQualifies("git worktree remove ../some-worktree", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git worktree remove --force", () => {
  assertDoesNotQualify("git worktree remove --force ../some-worktree");
});

test("qualifiesForLocalGitAllow: git worktree prune with no arguments qualifies", () => {
  assertQualifies("git worktree prune", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git worktree prune with an extra argument", () => {
  assertDoesNotQualify("git worktree prune --verbose");
});

test("qualifiesForLocalGitAllow: git worktree add with -q and -b <name> qualifies", () => {
  assertQualifies("git worktree add -q -b new-branch ../new-worktree", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git worktree add -B (force-resets an existing branch)", () => {
  assertDoesNotQualify("git worktree add -B new-branch ../new-worktree");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git worktree add --force", () => {
  assertDoesNotQualify("git worktree add --force ../new-worktree");
});

test("qualifiesForLocalGitAllow: the owner's own real three-segment sequence qualifies as a guarded delete", () => {
  assertQualifies(
    "git worktree remove ../orca-supervisor-lane-m && git branch -d fabolivark/release-0.5.1-lane-m && git worktree add -q -b release-0.5.1-lane-s ../lane-s 9ebb862",
    undefined,
    "guardedGitDelete",
  );
});

test("qualifiesForLocalGitAllow: segments may be joined by ';' too, not only '&&'", () => {
  assertQualifies("git worktree remove ../a ; git worktree prune", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- git branch -d x && rm -rf build", () => {
  assertDoesNotQualify("git branch -d feature/old && rm -rf build");
});

test("qualifiesForLocalGitAllow: does NOT qualify -- a cd appearing mid-sequence, not as the leading prefix", () => {
  assertDoesNotQualify("git worktree remove ../a && cd elsewhere && git branch -d feature/old");
});

test("qualifiesForLocalGitAllow: a mix of push and guarded delete qualifies, with the delete reason winning", () => {
  assertQualifies("git push -u origin feature/x && git branch -d feature/old", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: a mix of push and an already tier-1a-safe segment qualifies, with the push reason", () => {
  assertQualifies("git push -u origin feature/x && git status", undefined, "ownBranchPush");
});

test("qualifiesForLocalGitAllow: cd prefix before a guarded delete needs no branch resolution -- it does not touch cwd at all", () => {
  assertQualifies("cd repo && git worktree prune", undefined, "guardedGitDelete");
});

test("qualifiesForLocalGitAllow: a requires_human policy is not this module's concern -- gate-bash.ts checks that itself before ever calling in", () => {
  // Documented here rather than asserted: qualifiesForLocalGitAllow has no
  // knowledge of destination policies at all (see gate-bash.ts's own
  // hasBlockingCommandPolicy check, tested end-to-end in
  // adapters/claude/gate-bash.test.mjs). This module always answers the
  // same way regardless of what policies are configured.
  assertQualifies("git branch -d feature/old", undefined, "guardedGitDelete");
});

// ---------------------------------------------------------------------------
// A trailing separator with nothing real after it -- most notably a bare
// `&`, which BACKGROUNDS the last segment instead of joining it to anything.
// Found during review: neither function checked CommandSeparatorSplit's own
// `trailing` field, so `git push -u origin feature/x &` qualified as if the
// `&` were not there at all.
// ---------------------------------------------------------------------------

test("does not qualify: a trailing '&' backgrounds the push instead of joining it to anything", () => {
  assert.equal(qualifiesForLocalGitAllow({ command: "git push -u origin feature/x &", cwd: NO_REPO_CWD }).qualifies, false);
  assertDoesNotQualify("git push -u origin feature/x &");
});

test("does not qualify: a trailing ';' after the only segment", () => {
  // Inert in a real shell (an empty statement), but still rejected: no
  // "does this really run" analysis is worth building for zero benefit.
  assert.equal(qualifiesForLocalGitAllow({ command: "git push -u origin feature/x ;", cwd: NO_REPO_CWD }).qualifies, false);
  assertDoesNotQualify("git branch -d feature/old ;");
});

// ---------------------------------------------------------------------------
// An unexpanded shell variable or a glob in a guarded-delete/worktree
// positional: its REAL value is unknown at gate time. `BRANCH='-D main'`
// would make `git branch -d $BRANCH` actually run `git branch -d -D main`.
// git push's own remote/refspec positions are already covered by
// isBareRemoteName/isPlainBranchRefspec's stricter regexes (see the
// existing "not a plain branch refspec" cases above) -- this is the same
// discipline for the three guarded-delete/worktree classifiers.
// ---------------------------------------------------------------------------

test("does not qualify: git branch -d $BRANCH -- an unexpanded variable, not a plain name", () => {
  assertDoesNotQualify("git branch -d $BRANCH");
});

test("does not qualify: git worktree remove $PATH_VAR -- an unexpanded variable", () => {
  assertDoesNotQualify("git worktree remove $PATH_VAR");
});

test("does not qualify: git worktree remove * -- a glob, not one specific path", () => {
  assertDoesNotQualify("git worktree remove *");
});

test("does not qualify: git worktree add -b $NAME ../w -- the -b value is a variable too", () => {
  assertDoesNotQualify("git worktree add -b $NAME ../w");
});

test("does not qualify: git worktree add $DEST -- a variable path", () => {
  assertDoesNotQualify("git worktree add $DEST");
});
