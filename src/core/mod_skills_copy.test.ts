// JEVADV-43 -- unit tests for mod_skills_copy.ts's pure logic: the import
// closure walker, the digest (a changed source byte must make a previously
// current copy stale; an unchanged source must stay current), stale-file
// removal, and the two generated-file builders. Every reader here is an
// in-memory fake -- no real filesystem, no temp directory, no dependency on
// this repo's own actual mod-skills tree, so these tests stay meaningful
// even if that tree's own imports change shape later.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModSkillsHooksManifest,
  buildModSkillsPluginManifest,
  computeModSkillsDigest,
  expectedModSkillsPaths,
  resolveModSkillsSpecifier,
  staleModSkillsPaths,
  walkModSkillsClosure,
  type ModSkillsCopyReader,
} from "./mod_skills_copy.ts";

function fakeReader(files: Readonly<Record<string, string>>): ModSkillsCopyReader {
  return {
    read: async (path: string): Promise<string> => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error(`no such fake file: ${path}`), { code: "ENOENT" });
      return content;
    },
  };
}

// ---------------------------------------------------------------------------
// resolveModSkillsSpecifier
// ---------------------------------------------------------------------------

test("resolveModSkillsSpecifier: climbs one directory per leading ../", () => {
  const resolved = resolveModSkillsSpecifier("adapters/claude/mod-skills/hooks/index.ts", "../../../../src/core/jev.ts");
  assert.equal(resolved, "src/core/jev.ts");
});

test("resolveModSkillsSpecifier: a same-directory ./ specifier stays a sibling", () => {
  const resolved = resolveModSkillsSpecifier("adapters/claude/mod-skills/hooks/index.ts", "./runtime.ts");
  assert.equal(resolved, "adapters/claude/mod-skills/hooks/runtime.ts");
});

test("resolveModSkillsSpecifier: one level up from a nested file", () => {
  const resolved = resolveModSkillsSpecifier("src/core/skill_decisions.ts", "./skill_inventory.ts");
  assert.equal(resolved, "src/core/skill_inventory.ts");
  const resolvedUp = resolveModSkillsSpecifier("src/core/jev.ts", "../guards.ts");
  assert.equal(resolvedUp, "src/guards.ts");
});

// ---------------------------------------------------------------------------
// walkModSkillsClosure
// ---------------------------------------------------------------------------

test("walkModSkillsClosure: follows a chain of relative imports, value and type-only alike", () => {
  const reader = fakeReader({
    "adapters/claude/mod-skills/hooks/index.ts": [
      "import type { EngineInterface, Register } from 'claude-code'",
      "import { callJev } from '../../../../src/core/jev.ts'",
      "import { computeHomePaths } from './runtime.ts'",
    ].join("\n"),
    "adapters/claude/mod-skills/hooks/runtime.ts": "export function computeHomePaths() { return null }",
    "src/core/jev.ts": ["import { isRecord } from '../guards.ts'", "export function callJev() {}"].join("\n"),
    "src/guards.ts": "export function isRecord(v) { return typeof v === 'object' }",
  });

  const closure = walkModSkillsClosure("adapters/claude/mod-skills/hooks/index.ts", reader);
  return closure.then((paths) => {
    assert.deepEqual(
      [...paths].sort(),
      ["adapters/claude/mod-skills/hooks/index.ts", "adapters/claude/mod-skills/hooks/runtime.ts", "src/core/jev.ts", "src/guards.ts"].sort(),
    );
  });
});

test("walkModSkillsClosure: a bare specifier (claude-code) is never followed -- there is no file for it", async () => {
  const reader = fakeReader({
    "adapters/claude/mod-skills/hooks/index.ts": "import type { Register } from 'claude-code'\nexport function register() {}",
  });
  const closure = await walkModSkillsClosure("adapters/claude/mod-skills/hooks/index.ts", reader);
  assert.deepEqual(closure, ["adapters/claude/mod-skills/hooks/index.ts"]);
});

test("walkModSkillsClosure: a *.test.ts target is excluded even if something named it", async () => {
  const reader = fakeReader({
    "adapters/claude/mod-skills/hooks/index.ts": ["import { helper } from './runtime.ts'", "import './runtime.test.ts'"].join("\n"),
    "adapters/claude/mod-skills/hooks/runtime.ts": "export function helper() {}",
    "adapters/claude/mod-skills/hooks/runtime.test.ts": "// never installed",
  });
  const closure = await walkModSkillsClosure("adapters/claude/mod-skills/hooks/index.ts", reader);
  assert.deepEqual([...closure].sort(), ["adapters/claude/mod-skills/hooks/index.ts", "adapters/claude/mod-skills/hooks/runtime.ts"]);
});

test("walkModSkillsClosure: a diamond dependency (two files importing the same third file) is visited once", async () => {
  const reader = fakeReader({
    "a.ts": ["import { x } from './b.ts'", "import { y } from './c.ts'"].join("\n"),
    "b.ts": "import { z } from './d.ts'",
    "c.ts": "import { z } from './d.ts'",
    "d.ts": "export const z = 1",
  });
  const closure = await walkModSkillsClosure("a.ts", reader);
  assert.deepEqual([...closure].sort(), ["a.ts", "b.ts", "c.ts", "d.ts"]);
});

test("walkModSkillsClosure: a missing file in the closure rejects rather than silently truncating the result", async () => {
  const reader = fakeReader({
    "a.ts": "import { x } from './missing.ts'",
  });
  await assert.rejects(walkModSkillsClosure("a.ts", reader));
});

// ---------------------------------------------------------------------------
// computeModSkillsDigest -- determinism and sensitivity to a single byte
// ---------------------------------------------------------------------------

test("computeModSkillsDigest: an unchanged source and unchanged generated files reproduce the exact same digest", async () => {
  const reader = fakeReader({ "a.ts": "export const a = 1\n", "b.ts": "export const b = 2\n" });
  const generated = [{ path: "hooks/hooks.json", content: '{"modules":["../a.ts"]}\n' }];
  const first = await computeModSkillsDigest(["a.ts", "b.ts"], reader, generated);
  const second = await computeModSkillsDigest(["b.ts", "a.ts"], reader, generated); // order must not matter
  assert.equal(first, second);
});

test("computeModSkillsDigest: a single changed source byte changes the digest", async () => {
  const before = fakeReader({ "a.ts": "export const a = 1\n" });
  const after = fakeReader({ "a.ts": "export const a = 2\n" });
  const generated = [{ path: "hooks/hooks.json", content: '{"modules":["../a.ts"]}\n' }];
  const digestBefore = await computeModSkillsDigest(["a.ts"], before, generated);
  const digestAfter = await computeModSkillsDigest(["a.ts"], after, generated);
  assert.notEqual(digestBefore, digestAfter, "today's bug: only the source PATH was ever recorded, never its content, so a changed byte at the same path went unnoticed forever");
});

test("computeModSkillsDigest: a changed generated file (e.g. a version bump) changes the digest even though every closure file is unchanged", async () => {
  const reader = fakeReader({ "a.ts": "export const a = 1\n" });
  const digestV1 = await computeModSkillsDigest(["a.ts"], reader, [{ path: ".claude-plugin/plugin.json", content: '{"version":"0.5.0"}\n' }]);
  const digestV2 = await computeModSkillsDigest(["a.ts"], reader, [{ path: ".claude-plugin/plugin.json", content: '{"version":"0.5.1"}\n' }]);
  assert.notEqual(digestV1, digestV2);
});

// ---------------------------------------------------------------------------
// expectedModSkillsPaths / staleModSkillsPaths
// ---------------------------------------------------------------------------

test("expectedModSkillsPaths: closure paths plus every generated file's own path, deduplicated and sorted", () => {
  const expected = expectedModSkillsPaths(["b.ts", "a.ts"], [{ path: ".claude-plugin/plugin.json", content: "x" }, { path: "hooks/hooks.json", content: "y" }]);
  assert.deepEqual(expected, [".claude-plugin/plugin.json", "a.ts", "b.ts", "hooks/hooks.json"]);
});

test("staleModSkillsPaths: a file present on disk but no longer in the expected set is reported stale", () => {
  const stale = staleModSkillsPaths(["a.ts", "b.ts", "leftover-from-an-old-source-tree.ts"], ["a.ts", "b.ts"]);
  assert.deepEqual(stale, ["leftover-from-an-old-source-tree.ts"]);
});

test("staleModSkillsPaths: nothing is reported stale once actual matches expected exactly", () => {
  assert.deepEqual(staleModSkillsPaths(["a.ts", "b.ts"], ["a.ts", "b.ts"]), []);
});

// ---------------------------------------------------------------------------
// buildModSkillsPluginManifest / buildModSkillsHooksManifest
// ---------------------------------------------------------------------------

test("buildModSkillsPluginManifest: author is always an object, never a bare string -- the engine rejects a string author", () => {
  const json = JSON.parse(buildModSkillsPluginManifest({ name: "orca-jev-mod-skills", version: "0.5.1", description: "x", authorName: "Ab2Web" }));
  assert.deepEqual(json.author, { name: "Ab2Web" });
  assert.equal(json.name, "orca-jev-mod-skills");
  assert.equal(json.version, "0.5.1");
});

test("buildModSkillsHooksManifest: modules names exactly the one entry, at the given relative path", () => {
  const json = JSON.parse(buildModSkillsHooksManifest({ description: "x", modulePath: "../adapters/claude/mod-skills/hooks/index.ts" }));
  assert.deepEqual(json.modules, ["../adapters/claude/mod-skills/hooks/index.ts"]);
  assert.equal(json.description, "x");
});
