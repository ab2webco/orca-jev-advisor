// Unit tests for linked_worktree.ts -- JEVADV-3 (odd/tasks/release-0.5.1.md
// T3). Uses REAL temporary git repositories and `git worktree add`, never a
// mock: the whole point of this module is reading the exact files git
// itself writes (`.git` file, `gitdir:` line, `commondir`), so a fake
// filesystem would only prove this module agrees with its own assumptions
// about that shape, not that the shape is real.
//
// Run with: node --test src/core/linked_worktree.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";

import { matchDestinationForCwd, resolveGitDirForConfig, resolveLinkedWorktreeMainCheckout } from "./linked_worktree.ts";
import type { MatchableDestination } from "./destination_match.ts";

/** Every temp root this file creates, removed once after every test has run. */
const TEMP_ROOTS: string[] = [];

/** realpath'd immediately: macOS resolves `$TMPDIR` through a `/var` -> `/private/var` symlink, and git itself resolves it too when it writes an absolute `gitdir:` line -- comparing against the unresolved path would fail on that platform alone. */
function makeTempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP_ROOTS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Isolated from the developer's own global/system git config (a `commit.gpgsign=true` or a template dir would otherwise break these fixtures on another machine) -- same discipline as this project's other tests never touching real user state. `os.devNull` rather than the POSIX literal, so this stays correct on Windows (`NUL`) too. */
function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
  });
}

/** A real repo with one commit, so `git worktree add -b <branch>` has a HEAD to branch from. */
function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(["init", "-q"], root);
  git(["config", "user.email", "test@test.com"], root);
  git(["config", "user.name", "test"], root);
  git(["commit", "--allow-empty", "-q", "-m", "init"], root);
}

function destination(id: string, worktreePath: string): MatchableDestination {
  return { id, worktreePath };
}

// ===========================================================================
// resolveLinkedWorktreeMainCheckout
// ===========================================================================

test("a linked worktree resolves to its main checkout root", () => {
  const base = makeTempRoot("jevadv3-linked-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling-123");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);

  assert.equal(resolveLinkedWorktreeMainCheckout(sibling), main);
});

test("resolves from a directory nested inside the linked worktree, not just its root", () => {
  const base = makeTempRoot("jevadv3-nested-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling-456");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);
  const nested = join(sibling, "src", "core");
  mkdirSync(nested, { recursive: true });

  assert.equal(resolveLinkedWorktreeMainCheckout(nested), main);
});

test("a relative gitdir is resolved against the .git file's own directory", () => {
  const base = makeTempRoot("jevadv3-relative-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling-rel");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);

  // git always writes an absolute gitdir; rewrite the worktree's own `.git`
  // file to a relative one -- the shape this module must also handle --
  // resolved the same way a real one would be, against the `.git` file's
  // own directory.
  const worktreeGitDir = join(main, ".git", "worktrees", "main-repo-sibling-rel");
  const relativeGitDir = relative(sibling, worktreeGitDir);
  writeFileSync(join(sibling, ".git"), `gitdir: ${relativeGitDir}\n`);

  assert.equal(resolveLinkedWorktreeMainCheckout(sibling), main);
});

test("a missing commondir falls back to the worktrees/<name> pattern in gitdir", () => {
  const base = makeTempRoot("jevadv3-nocommondir-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling-nc");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);
  rmSync(join(main, ".git", "worktrees", "main-repo-sibling-nc", "commondir"));

  assert.equal(resolveLinkedWorktreeMainCheckout(sibling), main);
});

test("an ordinary (non-worktree) checkout resolves to null -- its own .git is a directory", () => {
  const base = makeTempRoot("jevadv3-ordinary-");
  const main = join(base, "main-repo");
  initRepo(main);

  assert.equal(resolveLinkedWorktreeMainCheckout(main), null);
});

test("a plain sibling directory with no .git at all resolves to null, never throws", () => {
  const base = makeTempRoot("jevadv3-sibling-");
  const plain = join(base, "just-a-folder");
  mkdirSync(plain, { recursive: true });

  assert.doesNotThrow(() => resolveLinkedWorktreeMainCheckout(plain));
  assert.equal(resolveLinkedWorktreeMainCheckout(plain), null);
});

test("a corrupt .git file (no gitdir: line at all) resolves to null, never throws", () => {
  const base = makeTempRoot("jevadv3-corrupt-");
  const dir = join(base, "corrupt-worktree");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), "not a gitdir line\n");

  assert.doesNotThrow(() => resolveLinkedWorktreeMainCheckout(dir));
  assert.equal(resolveLinkedWorktreeMainCheckout(dir), null);
});

test("a .git file pointing at a gitdir that doesn't exist resolves to null, never throws", () => {
  const base = makeTempRoot("jevadv3-missinggitdir-");
  const dir = join(base, "dangling-worktree");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${join(base, "nowhere", "worktrees", "x")}\n`);

  assert.doesNotThrow(() => resolveLinkedWorktreeMainCheckout(dir));
  assert.equal(resolveLinkedWorktreeMainCheckout(dir), null);
});

// odd/tasks/release-0.5.1.md JEVADV-35 (review-3ca73b9da09b0927, R1): this
// module used to trust ANY `.git` FILE found walking up, as long as its
// `gitdir:` line and that gitdir's `commondir` both resolved on disk --
// never checking that the MAIN checkout's own worktree registry actually
// names this exact `.git` file back. A `.git` file is five lines of plain
// text; copying a real linked worktree's own `.git` file into an unrelated
// directory reproduces a real, resolvable `gitdir`/`commondir` pair for a
// directory git never created as a worktree at all, and this module used to
// resolve it to the real main checkout anyway -- borrowing that checkout's
// destination (its policies, its consequence-ceiling override) for a
// directory with no real relationship to it.
test("a forged .git file (a byte-for-byte copy of a real worktree's) does not resolve -- the main checkout's own back-pointer names the real worktree, not this copy", () => {
  const base = makeTempRoot("jevadv35-forged-");
  const main = join(base, "main-repo");
  initRepo(main);
  const realSibling = join(base, "main-repo-sibling-real");
  git(["worktree", "add", "-q", realSibling, "-b", "feature-branch"], main);

  // The forgery: the REAL sibling's `.git` file, byte-for-byte, placed in a
  // directory git never touched. Its `gitdir:` line and that gitdir's
  // `commondir` both still resolve on disk -- they point at real, valid
  // git-internal state -- so the pre-JEVADV-35 checks alone would have
  // accepted it.
  const forgedDir = join(base, "unrelated-directory");
  mkdirSync(forgedDir, { recursive: true });
  writeFileSync(join(forgedDir, ".git"), readFileSync(join(realSibling, ".git"), "utf8"));

  assert.equal(
    resolveLinkedWorktreeMainCheckout(forgedDir),
    null,
    "the main checkout's worktrees/<name>/gitdir names the REAL sibling's .git file, never this forged copy",
  );
  // The real sibling itself must be entirely unaffected by the forgery
  // existing alongside it.
  assert.equal(resolveLinkedWorktreeMainCheckout(realSibling), main);
});

// ===========================================================================
// matchDestinationForCwd -- composes the resolver with destination_match.ts's
// own pure matcher, which stays completely untouched (still no filesystem).
// ===========================================================================

test("matchDestinationForCwd: a linked worktree matches its main repository's destination, with the worktree's OWN root as treeRoot", () => {
  const base = makeTempRoot("jevadv3-match-linked-");
  const main = join(base, "cineco-frontend");
  initRepo(main);
  const sibling = join(base, "cineco-frontend-cin-985");
  git(["worktree", "add", "-q", sibling, "-b", "cin-985"], main);

  const clientSite = destination("cineco-frontend", main);
  const result = matchDestinationForCwd(sibling, [clientSite]);
  assert.equal(result?.destination, clientSite);
  // treeRoot must be the SIBLING's own root, never the main checkout: the
  // main is not an ancestor of cwd, so using it here would misclassify
  // every ordinary in-tree target run inside the worktree as out-of-tree.
  assert.equal(result?.treeRoot, sibling);
});

test("matchDestinationForCwd: a nested (direct) match still wins over the linked-worktree fallback", () => {
  const base = makeTempRoot("jevadv3-match-nested-");
  const main = join(base, "cineco-frontend");
  initRepo(main);
  const sibling = join(base, "cineco-frontend-cin-985");
  git(["worktree", "add", "-q", sibling, "-b", "cin-985"], main);

  const clientSite = destination("cineco-frontend", main);
  // The worktree itself is ALSO separately catalogued here -- its own entry,
  // the longer/more specific prefix, must win over falling back to `main`.
  const worktreeItself = destination("cineco-frontend-cin-985", sibling);
  const result = matchDestinationForCwd(sibling, [clientSite, worktreeItself]);
  assert.equal(result?.destination, worktreeItself);
  assert.equal(result?.treeRoot, sibling);
});

test("matchDestinationForCwd: a plain sibling directory that is NOT a linked worktree does not match", () => {
  const base = makeTempRoot("jevadv3-match-sibling-");
  const main = join(base, "cineco-frontend");
  initRepo(main);
  const plainSibling = join(base, "cineco-frontend-notes");
  mkdirSync(plainSibling, { recursive: true });

  const clientSite = destination("cineco-frontend", main);
  assert.equal(matchDestinationForCwd(plainSibling, [clientSite]), null);
});

test("matchDestinationForCwd: with no destinations at all, a linked worktree resolves to null, never throws", () => {
  const base = makeTempRoot("jevadv3-match-empty-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling-empty");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);

  assert.doesNotThrow(() => matchDestinationForCwd(sibling, []));
  assert.equal(matchDestinationForCwd(sibling, []), null);
});

test("matchDestinationForCwd: a direct/nested match uses the destination's own worktreePath as treeRoot", () => {
  const base = makeTempRoot("jevadv3-match-direct-treeroot-");
  const main = join(base, "orca-oss");
  initRepo(main);
  const nested = join(main, "src", "core");
  mkdirSync(nested, { recursive: true });

  const oss = destination("orca-oss", main);
  const result = matchDestinationForCwd(nested, [oss]);
  assert.equal(result?.destination, oss);
  assert.equal(result?.treeRoot, main);
});

// ===========================================================================
// resolveGitDirForConfig -- JEVADV-39 (odd/tasks/release-0.5.1.md T-lane-a):
// where push_remote.ts's resolvePushRemoteIsLocal reads `.git/config` from,
// for whatever repository `cwd` sits inside.
// ===========================================================================

test("resolveGitDirForConfig: an ordinary checkout resolves to its own .git directory", () => {
  const base = makeTempRoot("jevadv39-gitdir-ordinary-");
  const main = join(base, "main-repo");
  initRepo(main);

  assert.equal(resolveGitDirForConfig(main), join(main, ".git"));
});

test("resolveGitDirForConfig: a linked worktree resolves to the MAIN checkout's shared .git directory, not its own admin directory", () => {
  const base = makeTempRoot("jevadv39-gitdir-worktree-");
  const main = join(base, "main-repo");
  initRepo(main);
  const sibling = join(base, "main-repo-sibling");
  git(["worktree", "add", "-q", sibling, "-b", "feature-branch"], main);

  assert.equal(resolveGitDirForConfig(sibling), join(main, ".git"));
});

test("resolveGitDirForConfig: nothing findable resolves to null, never throws", () => {
  const base = makeTempRoot("jevadv39-gitdir-none-");
  const plain = join(base, "just-a-folder");
  mkdirSync(plain, { recursive: true });

  assert.doesNotThrow(() => resolveGitDirForConfig(plain));
  assert.equal(resolveGitDirForConfig(plain), null);
});
