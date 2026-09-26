// Unit tests for git_recoverability.ts -- pure input (already-fetched git
// status) to pure output, no filesystem, no git subprocess.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRecoverabilityPath,
  isProtectedRecoverabilityWhy,
  resolveRecoverabilityTargets,
} from "./git_recoverability.ts";
import type { GitStatusSets } from "./git_recoverability.ts";

const REPO_ROOT = "/repo";

function status(overrides: Partial<{ modified: string[]; untracked: string[]; ignored: string[]; tracked: string[] }> = {}): GitStatusSets {
  return {
    modified: new Set(overrides.modified ?? []),
    untracked: new Set(overrides.untracked ?? []),
    ignored: new Set(overrides.ignored ?? []),
    tracked: new Set(overrides.tracked ?? []),
  };
}

test("classifyRecoverabilityPath: a secret-shaped file is protected, regardless of git status", () => {
  assert.equal(classifyRecoverabilityPath(".env", status()).why, "secret");
  assert.equal(classifyRecoverabilityPath(".env.production", status()).why, "secret");
  assert.equal(classifyRecoverabilityPath("keys/id_rsa", status()).why, "secret");
  assert.equal(classifyRecoverabilityPath("secrets/service.pem", status()).why, "secret");
});

test("classifyRecoverabilityPath: a top-level build/temp directory is safe, and names the matched directory", () => {
  const c = classifyRecoverabilityPath("dist/main.js", status());
  assert.equal(c.why, "build-or-temp");
  assert.equal(c.matchedBuildTempName, "dist");
});

test("classifyRecoverabilityPath: a tracked, clean file is safe", () => {
  assert.equal(classifyRecoverabilityPath("README.md", status({ tracked: ["README.md"] })).why, "committed-clean");
});

test("classifyRecoverabilityPath: an uncommitted (modified tracked) file is protected", () => {
  assert.equal(classifyRecoverabilityPath("src/a.ts", status({ tracked: ["src/a.ts"], modified: ["src/a.ts"] })).why, "uncommitted-changes");
});

test("classifyRecoverabilityPath: an untracked file is protected", () => {
  assert.equal(classifyRecoverabilityPath("src/notes-draft.ts", status({ untracked: ["src/notes-draft.ts"] })).why, "untracked");
});

test("classifyRecoverabilityPath: a path git knows nothing about at all is safe (nothing to lose)", () => {
  assert.equal(classifyRecoverabilityPath("nonexistent.txt", status()).why, "unknown-or-nonexistent");
});

test("isProtectedRecoverabilityWhy: only uncommitted-changes/untracked/secret protect", () => {
  assert.equal(isProtectedRecoverabilityWhy("uncommitted-changes"), true);
  assert.equal(isProtectedRecoverabilityWhy("untracked"), true);
  assert.equal(isProtectedRecoverabilityWhy("secret"), true);
  assert.equal(isProtectedRecoverabilityWhy("build-or-temp"), false);
  assert.equal(isProtectedRecoverabilityWhy("committed-clean"), false);
  assert.equal(isProtectedRecoverabilityWhy("unknown-or-nonexistent"), false);
});

// ---------------------------------------------------------------------------
// resolveRecoverabilityTargets -- the real scenario from the task: an rm
// mixing build output with real, unrecoverable work.
// ---------------------------------------------------------------------------

test("rm: classifies each target on its own -- dist is safe, an uncommitted file and .env are protected", () => {
  const st = status({ tracked: ["src/a.ts"], modified: ["src/a.ts"], untracked: [".env", "src/notes-draft.ts"] });
  const [result] = resolveRecoverabilityTargets("rm -rf dist src/a.ts .env", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.shape, "rm");
  const byPath = Object.fromEntries(result.classified.map((c) => [c.path, c.why]));
  assert.equal(byPath["dist"], "build-or-temp");
  assert.equal(byPath["src/a.ts"], "uncommitted-changes");
  assert.equal(byPath[".env"], "secret");
  assert.equal(result.unresolvedTargets.length, 0);
});

test("rm: a target through a shell variable or a glob is UNRESOLVED, never guessed", () => {
  const [result] = resolveRecoverabilityTargets("rm -rf $TMP *.log", REPO_ROOT, REPO_ROOT, status());
  assert.equal(result.shape, "rm");
  assert.equal(result.classified.length, 0);
  assert.deepEqual(result.unresolvedTargets, ["$TMP", "*.log"]);
});

test("rm: a relative target resolves against cwd, not the repo root, when they differ", () => {
  const st = status({ untracked: ["pkg/notes.md"] });
  const [result] = resolveRecoverabilityTargets("rm -rf notes.md", `${REPO_ROOT}/pkg`, REPO_ROOT, st);
  assert.equal(result.classified[0]?.path, "pkg/notes.md");
  assert.equal(result.classified[0]?.why, "untracked");
});

test("a leading cd prefix moves where later relative targets resolve from", () => {
  const st = status({ untracked: ["pkg/notes.md"] });
  const [result] = resolveRecoverabilityTargets("cd pkg && rm -rf notes.md", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.classified[0]?.path, "pkg/notes.md");
  assert.equal(result.classified[0]?.why, "untracked");
});

test("git checkout -- <path>: resolves and classifies the named path", () => {
  const st = status({ tracked: ["src/app.ts"], modified: ["src/app.ts"] });
  const [result] = resolveRecoverabilityTargets("git checkout -- src/app.ts", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.shape, "git checkout");
  assert.equal(result.classified[0]?.path, "src/app.ts");
  assert.equal(result.classified[0]?.why, "uncommitted-changes");
});

test("git checkout .: resolves to every currently modified path", () => {
  const st = status({ tracked: ["a.ts", "b.ts"], modified: ["a.ts", "b.ts"] });
  const [result] = resolveRecoverabilityTargets("git checkout .", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.classified.length, 2);
});

test("git restore <path>: resolves and classifies the named path", () => {
  const st = status({ untracked: ["notes.md"] });
  const [result] = resolveRecoverabilityTargets("git restore notes.md", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.shape, "git restore");
  assert.equal(result.classified[0]?.why, "untracked");
});

test("git reset --hard: resolves to every modified path, ignoring any argument", () => {
  const st = status({ tracked: ["a.ts"], modified: ["a.ts"] });
  const [result] = resolveRecoverabilityTargets("git reset --hard", REPO_ROOT, REPO_ROOT, st);
  assert.equal(result.shape, "git reset --hard");
  assert.equal(result.classified[0]?.path, "a.ts");
});

test("git clean -fd: resolves to untracked files, never ignored ones without -x", () => {
  const st = status({ untracked: ["scratch.log"], ignored: ["dist/x.js"] });
  const [result] = resolveRecoverabilityTargets("git clean -fd", REPO_ROOT, REPO_ROOT, st);
  const paths = result.classified.map((c) => c.path);
  assert.ok(paths.includes("scratch.log"));
  assert.ok(!paths.includes("dist/x.js"));
});

test("git clean -fdx: -x also includes ignored files", () => {
  const st = status({ untracked: ["scratch.log"], ignored: ["dist/x.js"] });
  const [result] = resolveRecoverabilityTargets("git clean -fdx", REPO_ROOT, REPO_ROOT, st);
  const paths = result.classified.map((c) => c.path);
  assert.ok(paths.includes("dist/x.js"));
});

test("a command with none of the five shapes resolves to no segments at all", () => {
  const results = resolveRecoverabilityTargets("npm test", REPO_ROOT, REPO_ROOT, status());
  assert.deepEqual(results, []);
});
