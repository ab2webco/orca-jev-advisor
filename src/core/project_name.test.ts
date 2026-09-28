import assert from "node:assert/strict";
import test from "node:test";

import { modSkillsProjectName } from "./project_name.ts";

test("modSkillsProjectName: proyecto not starting with repo: -> last path segment, .git stripped", () => {
  assert.equal(modSkillsProjectName({ proyecto: "github:owner/name.git", worktree: null }), "name");
  assert.equal(modSkillsProjectName({ proyecto: "owner/name", worktree: null }), "name");
});

test("modSkillsProjectName: repo:-prefixed proyecto falls through to basename(worktree)", () => {
  assert.equal(
    modSkillsProjectName({ proyecto: "repo:abc123", worktree: "/home/dev/Projects/my-app" }),
    "my-app",
  );
});

test("modSkillsProjectName: repo:-prefixed proyecto with no worktree -> null", () => {
  assert.equal(modSkillsProjectName({ proyecto: "repo:abc123", worktree: null }), null);
});

test("modSkillsProjectName: both null -> null", () => {
  assert.equal(modSkillsProjectName({ proyecto: null, worktree: null }), null);
});

test("modSkillsProjectName: non-record input -> null", () => {
  assert.equal(modSkillsProjectName(null), null);
  assert.equal(modSkillsProjectName(undefined), null);
  assert.equal(modSkillsProjectName("not a record"), null);
});

test("modSkillsProjectName: no proyecto at all -> falls back to basename(worktree)", () => {
  assert.equal(modSkillsProjectName({ worktree: "/tmp/some-folder" }), "some-folder");
});
