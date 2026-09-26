// Unit tests for skill_inventory.ts's directory-scanning half: `SkillFs`,
// `listSkillInventory` and their symlink handling.
//
// Root cause under test (found live on 2026-09-26): `~/.claude/skills`
// often holds symlinked skills (the community skills CLI, Orca's own
// skills installer). The engine's `$.fs.list` reports a symbolic link as
// `kind: "other"` with `isLink: true` -- `$.fs.stat` says what it actually
// leads to. Filtering only on `entry.kind === "dir"` silently drops every
// symlinked skill, which is exactly what made `orca-plane`, `orchestration`
// and `orca-cli` invisible to mod-skills' own candidate list.
//
// Run with:
//   node --test src/core/skill_inventory.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { listSkillInventory } from "./skill_inventory.ts";
import type { SkillFs, SkillFsEntry, SkillFsStat, SkillInventoryRoots } from "./skill_inventory.ts";

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;
}

interface FakeFsState {
  readonly dirs: Map<string, SkillFsEntry[]>;
  readonly files: Map<string, string>;
  readonly stats: Map<string, SkillFsStat>;
  readonly statErrors: Set<string>;
}

function makeState(): FakeFsState {
  return { dirs: new Map(), files: new Map(), stats: new Map(), statErrors: new Set() };
}

function makeFakeFs(state: FakeFsState): SkillFs {
  return {
    exists: async (path) => state.dirs.has(path) || state.files.has(path),
    list: async (path) => state.dirs.get(path) ?? [],
    read: async (path) => {
      const content = state.files.get(path);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    },
    stat: async (path) => {
      if (state.statErrors.has(path)) throw new Error(`stat rejected: ${path}`);
      const stat = state.stats.get(path);
      if (stat === undefined) throw new Error(`fake fs: no stat configured for ${path}`);
      return stat;
    },
  };
}

test("a symlinked skill directory is listed with its SKILL.md name and description", async () => {
  const state = makeState();
  state.dirs.set("/proj/.claude/skills", [{ name: "orca-plane", kind: "other", isLink: true }]);
  state.stats.set("/proj/.claude/skills/orca-plane", { kind: "dir" });
  state.files.set("/proj/.claude/skills/orca-plane/SKILL.md", skillMd("orca-plane", "Lists Plane work items."));

  const roots: SkillInventoryRoots = { projectSkillsDir: "/proj/.claude/skills", userSkillsDir: null };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(skills, [{ name: "orca-plane", description: "Lists Plane work items.", path: "/proj/.claude/skills/orca-plane/SKILL.md", source: "project" }]);
});

test("a dangling link and a link to a file are skipped without throwing", async () => {
  const state = makeState();
  state.dirs.set("/proj/.claude/skills", [
    { name: "dangling", kind: "other", isLink: true },
    { name: "link-to-file", kind: "other", isLink: true },
    { name: "real-skill", kind: "dir" },
  ]);
  // A dangling link leads nowhere: $.fs.stat reports it as `other`.
  state.stats.set("/proj/.claude/skills/dangling", { kind: "other" });
  state.stats.set("/proj/.claude/skills/link-to-file", { kind: "file" });
  state.files.set("/proj/.claude/skills/real-skill/SKILL.md", skillMd("real-skill", "A real one."));

  const roots: SkillInventoryRoots = { projectSkillsDir: "/proj/.claude/skills", userSkillsDir: null };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => s.name),
    ["real-skill"],
  );
});

test("a stat that rejects skips only that entry, never the whole inventory", async () => {
  const state = makeState();
  state.dirs.set("/proj/.claude/skills", [
    { name: "broken", kind: "other", isLink: true },
    { name: "fine", kind: "dir" },
  ]);
  state.statErrors.add("/proj/.claude/skills/broken");
  state.files.set("/proj/.claude/skills/fine/SKILL.md", skillMd("fine", "Works."));

  const roots: SkillInventoryRoots = { projectSkillsDir: "/proj/.claude/skills", userSkillsDir: null };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => s.name),
    ["fine"],
  );
});

test("project skills still take precedence over same-named user skills, deduped", async () => {
  const state = makeState();
  state.dirs.set("/proj/.claude/skills", [{ name: "shared", kind: "dir" }]);
  state.files.set("/proj/.claude/skills/shared/SKILL.md", skillMd("shared", "Project version."));
  state.dirs.set("/home/.claude/skills", [
    { name: "shared", kind: "dir" },
    { name: "only-user", kind: "dir" },
  ]);
  state.files.set("/home/.claude/skills/shared/SKILL.md", skillMd("shared", "User version -- should be dropped."));
  state.files.set("/home/.claude/skills/only-user/SKILL.md", skillMd("only-user", "User only."));

  const roots: SkillInventoryRoots = { projectSkillsDir: "/proj/.claude/skills", userSkillsDir: "/home/.claude/skills" };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => ({ name: s.name, source: s.source, description: s.description })),
    [
      { name: "shared", source: "project", description: "Project version." },
      { name: "only-user", source: "user", description: "User only." },
    ],
  );
});

test("a symlinked account directory under synced/ is walked the same way as a real one", async () => {
  const state = makeState();
  state.dirs.set("/home/.claude/skills", []);
  state.dirs.set("/home/.claude/skills/synced", [{ name: "acct-1", kind: "other", isLink: true }]);
  state.stats.set("/home/.claude/skills/synced/acct-1", { kind: "dir" });
  state.dirs.set("/home/.claude/skills/synced/acct-1", [{ name: "remote-skill", kind: "dir" }]);
  state.files.set("/home/.claude/skills/synced/acct-1/remote-skill/SKILL.md", skillMd("remote-skill", "Synced."));

  const roots: SkillInventoryRoots = { projectSkillsDir: null, userSkillsDir: "/home/.claude/skills" };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => ({ name: s.name, source: s.source })),
    [{ name: "remote-skill", source: "synced" }],
  );
});

test("a dangling symlinked account directory under synced/ is skipped without throwing", async () => {
  const state = makeState();
  state.dirs.set("/home/.claude/skills", []);
  state.dirs.set("/home/.claude/skills/synced", [
    { name: "dangling-acct", kind: "other", isLink: true },
    { name: "acct-1", kind: "dir" },
  ]);
  state.stats.set("/home/.claude/skills/synced/dangling-acct", { kind: "other" });
  state.dirs.set("/home/.claude/skills/synced/acct-1", [{ name: "remote-skill", kind: "dir" }]);
  state.files.set("/home/.claude/skills/synced/acct-1/remote-skill/SKILL.md", skillMd("remote-skill", "Synced."));

  const roots: SkillInventoryRoots = { projectSkillsDir: null, userSkillsDir: "/home/.claude/skills" };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => s.name),
    ["remote-skill"],
  );
});

test("a plain (non-link) directory is still listed with no stat call needed", async () => {
  const state = makeState();
  state.dirs.set("/proj/.claude/skills", [{ name: "plain", kind: "dir" }]);
  state.files.set("/proj/.claude/skills/plain/SKILL.md", skillMd("plain", "No link involved."));

  const roots: SkillInventoryRoots = { projectSkillsDir: "/proj/.claude/skills", userSkillsDir: null };
  const skills = await listSkillInventory(makeFakeFs(state), roots);

  assert.deepEqual(
    skills.map((s) => s.name),
    ["plain"],
  );
});
