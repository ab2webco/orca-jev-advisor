// Unit tests for push_remote.ts -- JEVADV-39 (odd/tasks/release-0.5.1.md
// T-lane-a). The pure/text-parsing pieces (remote-argument extraction, the
// local/shared classifier, the `.git/config` parser) are exercised directly
// here with an injected reader/fixture text, no real git repository needed;
// gate-bash.test.mjs separately exercises resolvePushRemoteIsLocal wired
// into the actual hook against REAL temp git repos.
//
// Run with: node --test src/core/push_remote.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { extractPushRemoteArg, isLocalRemoteReference, parseGitConfigRemoteUrl, resolvePushRemoteIsLocal } from "./push_remote.ts";

// ---------------------------------------------------------------------------
// A bare remote NAME resolved through a REAL `.git/config` -- same fixture
// discipline as linked_worktree.test.ts: the whole point of that lookup is
// reading the exact file `git remote add` writes, so a fake filesystem here
// would only prove this module agrees with its own assumptions about that
// shape, not that the shape is real.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// extractPushRemoteArg
// ---------------------------------------------------------------------------

test("extractPushRemoteArg: the first non-option token after push", () => {
  assert.equal(extractPushRemoteArg("git push origin main"), "origin");
  assert.equal(extractPushRemoteArg("git push -u origin main"), "origin", "a leading flag must be skipped");
  assert.equal(extractPushRemoteArg("git push --force origin main"), "origin");
});

test("extractPushRemoteArg: defaults to empty (caller defaults to origin) when only flags follow push", () => {
  assert.equal(extractPushRemoteArg("git push --force"), "");
});

test("extractPushRemoteArg: null when there is no git push invocation at all", () => {
  assert.equal(extractPushRemoteArg("git status"), null);
});

test("extractPushRemoteArg: a direct URL/path given as the arg is returned unchanged", () => {
  assert.equal(extractPushRemoteArg("git push file:///tmp/bare.git main"), "file:///tmp/bare.git");
  assert.equal(extractPushRemoteArg("git push /Users/dev/bare.git main"), "/Users/dev/bare.git");
});

test("extractPushRemoteArg: stops at the next command, never reading into a later stage of a compound command", () => {
  assert.equal(extractPushRemoteArg("git push origin main && rm -rf /"), "origin");
  assert.equal(extractPushRemoteArg("cd repo && git push -u origin main"), "origin");
});

// ---------------------------------------------------------------------------
// isLocalRemoteReference
// ---------------------------------------------------------------------------

test("isLocalRemoteReference: file:// URLs are local", () => {
  assert.equal(isLocalRemoteReference("file:///tmp/bare.git"), true);
  assert.equal(isLocalRemoteReference("FILE:///tmp/bare.git"), true, "scheme comparison is case-insensitive");
});

test("isLocalRemoteReference: absolute, relative and home-relative paths are local", () => {
  assert.equal(isLocalRemoteReference("/Users/dev/bare.git"), true);
  assert.equal(isLocalRemoteReference("../bare.git"), true);
  assert.equal(isLocalRemoteReference("./bare.git"), true);
  assert.equal(isLocalRemoteReference("~/bare.git"), true);
  assert.equal(isLocalRemoteReference("bare.git"), true);
});

test("isLocalRemoteReference: any other URL scheme is not local", () => {
  assert.equal(isLocalRemoteReference("https://github.com/org/repo.git"), false);
  assert.equal(isLocalRemoteReference("http://gitlab.example.com/org/repo.git"), false);
  assert.equal(isLocalRemoteReference("ssh://git@example.com/org/repo.git"), false);
  assert.equal(isLocalRemoteReference("git://example.com/org/repo.git"), false);
});

test("isLocalRemoteReference: git's own SCP-like ssh shorthand is not local", () => {
  assert.equal(isLocalRemoteReference("git@github.com:org/repo.git"), false);
  assert.equal(isLocalRemoteReference("example.com:org/repo.git"), false);
});

test("isLocalRemoteReference: a Windows drive-letter path is local, not SCP-like shorthand", () => {
  assert.equal(isLocalRemoteReference("C:/Repo"), true);
  assert.equal(isLocalRemoteReference("C:\\Repo"), true);
});

// ---------------------------------------------------------------------------
// parseGitConfigRemoteUrl
// ---------------------------------------------------------------------------

test("parseGitConfigRemoteUrl: reads the url out of the exact shape `git remote add` writes", () => {
  const configText = [
    "[core]",
    "\trepositoryformatversion = 0",
    '[remote "origin"]',
    "\turl = ../jev-sandbox-remote.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
  assert.equal(parseGitConfigRemoteUrl(configText, "origin"), "../jev-sandbox-remote.git");
});

test("parseGitConfigRemoteUrl: null when the named remote section does not exist", () => {
  const configText = '[remote "origin"]\n\turl = https://github.com/org/repo.git\n';
  assert.equal(parseGitConfigRemoteUrl(configText, "upstream"), null);
});

test("parseGitConfigRemoteUrl: null when the section exists but carries no url", () => {
  const configText = '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  assert.equal(parseGitConfigRemoteUrl(configText, "origin"), null);
});

test("parseGitConfigRemoteUrl: picks the right remote among several", () => {
  const configText = [
    '[remote "origin"]',
    "\turl = https://github.com/org/repo.git",
    '[remote "upstream"]',
    "\turl = /Users/dev/bare.git",
    "",
  ].join("\n");
  assert.equal(parseGitConfigRemoteUrl(configText, "upstream"), "/Users/dev/bare.git");
});

// ---------------------------------------------------------------------------
// resolvePushRemoteIsLocal (orchestrator) -- with an injected reader/fixture
// filesystem, no real git repository needed for this file's own coverage.
// ---------------------------------------------------------------------------

function fakeReader(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  };
}

test("resolvePushRemoteIsLocal: a bare remote name resolved through a REAL .git/config to a local bare directory is local", () => {
  const base = makeTempRoot("orca-jev-push-remote-test-");
  const bareRemote = join(base, "sandbox-remote.git");
  git(["init", "-q", "--bare", bareRemote], base);
  const repo = join(base, "sandbox-app");
  initRepo(repo);
  git(["remote", "add", "origin", bareRemote], repo);

  assert.equal(resolvePushRemoteIsLocal({ command: "git push -u origin main", cwd: repo }), true);
});

test("resolvePushRemoteIsLocal: a bare remote name resolved through a REAL .git/config to a github.com url is not local", () => {
  const base = makeTempRoot("orca-jev-push-remote-test-");
  const repo = join(base, "sandbox-app");
  initRepo(repo);
  git(["remote", "add", "origin", "https://github.com/example/repo.git"], repo);

  assert.equal(resolvePushRemoteIsLocal({ command: "git push -u origin main", cwd: repo }), false);
});

test("resolvePushRemoteIsLocal: an unknown remote name (not in .git/config) fails closed to false", () => {
  const base = makeTempRoot("orca-jev-push-remote-test-");
  const repo = join(base, "sandbox-app");
  initRepo(repo);

  assert.equal(resolvePushRemoteIsLocal({ command: "git push -u upstream main", cwd: repo }), false);
});

test("resolvePushRemoteIsLocal: unresolvable git dir (no .git anywhere findable) fails closed to false", () => {
  const readFile = fakeReader({});
  const result = resolvePushRemoteIsLocal({ command: "git push origin main", cwd: "/nowhere-with-no-git", readFile });
  assert.equal(result, false);
});

test("resolvePushRemoteIsLocal: no git push in the command at all fails closed to false", () => {
  const result = resolvePushRemoteIsLocal({ command: "git status", cwd: "/repo" });
  assert.equal(result, false);
});

test("resolvePushRemoteIsLocal: a direct file:// URL given as the push arg needs no config read at all", () => {
  const result = resolvePushRemoteIsLocal({ command: "git push file:///tmp/bare.git main", cwd: "/repo", readFile: fakeReader({}) });
  assert.equal(result, true);
});

test("resolvePushRemoteIsLocal: a direct github.com URL given as the push arg is not local", () => {
  const result = resolvePushRemoteIsLocal({ command: "git push https://github.com/org/repo.git main", cwd: "/repo", readFile: fakeReader({}) });
  assert.equal(result, false);
});
