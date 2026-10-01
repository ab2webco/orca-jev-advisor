// Unit tests for buildCrossRepoSentence and pickStricterDestination -- pure
// input to pure output. The replay case named in the task (2026-09-26,
// 20:08Z): cwd on main in repo A, `rm <file in repo B on a feature branch>`
// -> the context must say repo B, feature branch.

import assert from "node:assert/strict";
import test from "node:test";

import { buildCrossRepoSentence, buildGhMergeSentence, buildPushDestinationSentence, pickStricterDestination, renderRepoContext } from "./cross_repo_context.ts";
import { createJevPseudonyms, IDENTITY_NAMES } from "./jev_pseudonyms.ts";

const REPO_A = "/home/dev/Projects/orca-supervisor";
const REPO_B = "/home/dev/Projects/orca-oss-plugin-nav-close";

test("no targets resolved at all -- the ordinary case for almost every command -- yields no sentence", () => {
  assert.equal(buildCrossRepoSentence({ repoRoot: REPO_A, branch: "main" }, []), null);
});

test("every target agrees with the session's own repository -- no sentence, even on a different branch reading (branch is not part of the comparison)", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [{ path: "/x", repoRoot: REPO_A, branch: "main" }];
  assert.equal(buildCrossRepoSentence(session, targets), null);
});

test("the replay case: cwd on main in repo A, rm a file in repo B on a feature branch -- the sentence names repo B and its branch", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [{ path: `${REPO_B}/tmp-file.txt`, repoRoot: REPO_B, branch: "fix/plugin-nav-page-close" }];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.equal(
    sentence,
    `The command acts on files in the repository at ${REPO_B} on branch fix/plugin-nav-page-close, not in the session's current repository (${REPO_A} on main).`,
  );
});

test("a target outside any repository is named as such, never guessed at a branch", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [{ path: "/tmp/scratch.tmp", repoRoot: null, branch: null }];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.equal(
    sentence,
    `The command acts on files outside any repository, not in the session's current repository (${REPO_A} on main).`,
  );
});

test("a target with an unresolved (detached) branch never invents a branch name", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [{ path: `${REPO_B}/f`, repoRoot: REPO_B, branch: null }];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.match(sentence ?? "", /on branch an unknown branch/);
});

test("several targets in the SAME other repository are named only once", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [
    { path: `${REPO_B}/a`, repoRoot: REPO_B, branch: "fix/plugin-nav-page-close" },
    { path: `${REPO_B}/b`, repoRoot: REPO_B, branch: "fix/plugin-nav-page-close" },
  ];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.equal((sentence?.match(/The command acts on files/g) ?? []).length, 1);
});

test("targets in TWO different other repositories each get their own sentence", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const repoC = "/home/dev/Projects/some-other-repo";
  const targets = [
    { path: `${REPO_B}/a`, repoRoot: REPO_B, branch: "fix/plugin-nav-page-close" },
    { path: `${repoC}/b`, repoRoot: repoC, branch: "develop" },
  ];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.match(sentence ?? "", new RegExp(REPO_B.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sentence ?? "", new RegExp(repoC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("several targets outside any repository collapse into ONE sentence, not one per path", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [
    { path: "/tmp/a", repoRoot: null, branch: null },
    { path: "/tmp/b", repoRoot: null, branch: null },
  ];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.equal((sentence?.match(/outside any repository/g) ?? []).length, 1);
});

test("a session itself outside any repository is described the same honest way in the parenthetical", () => {
  const session = { repoRoot: null, branch: null };
  const targets = [{ path: `${REPO_B}/f`, repoRoot: REPO_B, branch: "main" }];
  const sentence = buildCrossRepoSentence(session, targets);
  assert.match(sentence ?? "", /\(outside any repository\)/);
});

// ---------------------------------------------------------------------------
// pickStricterDestination
// ---------------------------------------------------------------------------

function destination(id: string, ceiling: number | undefined) {
  return { destination: { id, worktreePath: `/repos/${id}`, autonomy: ceiling === undefined ? undefined : { consequenceCeiling: ceiling } }, treeRoot: `/repos/${id}` };
}

test("the lower consequenceCeiling wins -- less autonomy granted is the stricter reading", () => {
  const loose = destination("loose", 80);
  const strict = destination("strict", 20);
  assert.equal(pickStricterDestination([loose, strict])?.destination.id, "strict");
  assert.equal(pickStricterDestination([strict, loose])?.destination.id, "strict", "order must not matter");
});

test("a destination with no override loses to one that has any", () => {
  const noOverride = destination("no-override", undefined);
  const withOverride = destination("with-override", 50);
  assert.equal(pickStricterDestination([noOverride, withOverride])?.destination.id, "with-override");
});

test("null (no destination matched there) is the least strict -- chosen only when every candidate is null", () => {
  const withOverride = destination("with-override", 50);
  assert.equal(pickStricterDestination([null, withOverride])?.destination.id, "with-override");
  assert.equal(pickStricterDestination([null, null]), null);
});

test("an empty candidate list resolves to null, never throws", () => {
  assert.doesNotThrow(() => pickStricterDestination([]));
  assert.equal(pickStricterDestination([]), null);
});

test("a tie keeps the first candidate encountered", () => {
  const first = destination("first", 50);
  const second = destination("second", 50);
  assert.equal(pickStricterDestination([first, second])?.destination.id, "first");
});

// 0.6.11 T3: the copy sent to Jev names no repository, branch or path in
// clear; the local copy (the verdict-cache key) stays exactly as it was.
test("with a Jev pseudonym table, the sentence says the same thing without naming a path or a feature branch", () => {
  const session = { repoRoot: REPO_A, branch: "main" };
  const targets = [{ path: `${REPO_B}/tmp-file.txt`, repoRoot: REPO_B, branch: "fix/plugin-nav-page-close" }];
  const sentence = buildCrossRepoSentence(session, targets, createJevPseudonyms());
  assert.equal(
    sentence,
    "The command acts on files in the repository at <path-1> on branch <branch-1>, not in the session's current repository (<path-2> on main).",
  );
});

test("renderRepoContext in clear is the exact text the cache key has always used", () => {
  assert.equal(
    renderRepoContext({ remote: "orca-supervisor", branch: "fix/x", dirty: true }, IDENTITY_NAMES),
    "repository orca-supervisor, branch fix/x, this is a working branch, with uncommitted changes",
  );
  assert.equal(renderRepoContext({ remote: "", branch: "", dirty: false }, IDENTITY_NAMES), "no remote, unknown branch, this is a working branch, clean");
  assert.equal(renderRepoContext({ remote: "r", branch: "main", dirty: false }, IDENTITY_NAMES), "repository r, branch main, this is the shared main branch, clean");
});

test("renderRepoContext for Jev swaps the repository and a feature branch for placeholders, and keeps main in clear", () => {
  assert.equal(
    renderRepoContext({ remote: "acme-shop", branch: "feat/login", dirty: false }, createJevPseudonyms()),
    "repository <repo-1>, branch <branch-1>, this is a working branch, clean",
  );
  assert.equal(
    renderRepoContext({ remote: "acme-shop", branch: "master", dirty: false }, createJevPseudonyms()),
    "repository <repo-1>, branch master, this is the shared main branch, clean",
  );
});

// 0.6.15 T3 (N-06): the exact destination of a push, in the context Jev reads.
test("buildPushDestinationSentence: names the branch and remote a push updates, and whether that is the shared branch", () => {
  const names = createJevPseudonyms();
  assert.equal(buildPushDestinationSentence([], names), null);
  assert.equal(
    buildPushDestinationSentence([{ remote: "origin", branch: "main", remoteIsLocal: true }], names),
    "The command pushes commits to branch main of remote origin, a repository on this machine; main is a shared branch there, whatever branch the checkout is on.",
  );
  assert.equal(
    buildPushDestinationSentence([{ remote: "client-acme", branch: "feature/acme-login", remoteIsLocal: false }], names),
    "The command pushes commits to branch <branch-1> of remote <repo-1>, a repository on another machine.",
  );
  assert.equal(
    buildPushDestinationSentence([{ remote: null, branch: "feature/acme-login", remoteIsLocal: false }], names),
    "The command pushes commits to branch <branch-1> of its default remote, a repository on another machine.",
  );
});

// 0.6.17 T1 (JEVADV-93): a pull request merged on the server goes through
// its review whatever the checkout is on; an API branch merge skips it.
test("buildGhMergeSentence: a pull request merge is the reviewed path, an API branch merge is a direct write", () => {
  const names = createJevPseudonyms();
  assert.equal(buildGhMergeSentence([], names), null);
  assert.equal(
    buildGhMergeSentence([{ kind: "pull-request", admin: false, auto: false }], names),
    "The command asks the hosting service to merge a pull request: the service lands the pull request's commits on its base branch only through that branch's own protection (its required reviews and checks). That is the reviewed path into a shared branch, not a direct write on it, and it changes nothing in the local checkout, so the branch the checkout is on plays no part.",
  );
  assert.equal(
    buildGhMergeSentence([{ kind: "pull-request", admin: true, auto: false }], names),
    "The command asks the hosting service to merge a pull request with --admin, which merges it even when the base branch's required reviews or checks have not passed: it bypasses the review that makes a pull request merge the reviewed path, so it writes the pull request's commits on its base branch as directly as a push to it would. It changes nothing in the local checkout, so the branch the checkout is on plays no part.",
  );
  assert.equal(
    buildGhMergeSentence([{ kind: "branch", base: "main", head: "feature/acme-login" }], names),
    "The command asks the hosting service's API to merge branch <branch-1> directly into branch main on the remote, with no pull request and no review; that writes commits on main, whatever branch the checkout is on.",
  );
  assert.equal(
    buildGhMergeSentence([{ kind: "branch", base: null, head: null }], names),
    "The command asks the hosting service's API to merge one branch directly into another on the remote, with no pull request and no review.",
  );
});
