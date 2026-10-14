// Memory module in Active, files store (odd/tasks/memory-active-files.md, A2).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { backupDir, checkUpdate, effectiveMemoryMode, lockHeld, memorySpoolRoot } from "./memory_active.ts";
import { detectMemoryBackend } from "./memory_detect.ts";
import type { MemorySignals } from "./memory_detect.ts";

const NONE: MemorySignals = { liveServer: null, health: null, userConfigured: false, pluginEnabled: false, binaryVersion: null };
const LIVE = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "ok" });
const REFUSED = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "permission" });
const TOOLS_ONLY = detectMemoryBackend({ ...NONE, liveServer: "plugin_engram_engram", health: null });
const DOWN = detectMemoryBackend({ ...NONE, userConfigured: true });
const ABSENT = detectMemoryBackend(NONE);
const DIR = "/acct/projects/-repo/memory";

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_active.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

test("effective mode: Active writes to the files store, and to Engram when it is usable; a refused check keeps measuring", () => {
  assert.equal(effectiveMemoryMode("active", ABSENT), "active");
  assert.equal(effectiveMemoryMode("active", DOWN), "active");
  assert.equal(effectiveMemoryMode("active", LIVE), "active", "0.10.0: Engram live takes the saves");
  assert.equal(effectiveMemoryMode("active", TOOLS_ONLY), "active", "an Engram with no health tool (1.12.0) is live by its tools");
  assert.equal(effectiveMemoryMode("active", REFUSED), "shadow", "a refused check means Engram cannot be written: keep measuring");
  for (const backend of [ABSENT, DOWN, LIVE, TOOLS_ONLY, REFUSED]) assert.equal(effectiveMemoryMode("shadow", backend), "shadow");
});

test("spool root: one per memory folder, so a replay only writes the items of its own folder", () => {
  const root = memorySpoolRoot("/home/dev/.cache/orca-supervisor", DIR);
  assert.match(root, /^\/home\/dev\/\.cache\/orca-supervisor\/memory-spool\/[0-9a-f]{8}$/);
  assert.equal(memorySpoolRoot("/home/dev/.cache/orca-supervisor", DIR), root, "stable");
  assert.notEqual(memorySpoolRoot("/home/dev/.cache/orca-supervisor", "/acct/projects/-other/memory"), root);
  assert.equal(memorySpoolRoot("/home/dev/.cache/orca-supervisor", `${DIR}/`), root, "a trailing slash is the same folder");
});

test("update: only an existing file, and only with frontmatter that names it", () => {
  const good = "---\nname: merge-email\ndescription: use noreply\nmetadata:\n  type: feedback\n---\n\nUse the noreply address.\n";
  assert.deepEqual(checkUpdate({ name: "merge-email.md", content: good }, "old text"), { ok: true });
  assert.deepEqual(checkUpdate({ name: "merge-email.md", content: good }, null), { ok: false, reason: "missing" });
  assert.deepEqual(checkUpdate({ name: "merge-email.md", content: "Use the noreply address.\n" }, "old text"), { ok: false, reason: "no-frontmatter" });
  assert.deepEqual(checkUpdate({ name: "merge-email.md", content: "---\ndescription: x\n---\nbody\n" }, "old text"), { ok: false, reason: "no-frontmatter" });
});

test("backup folder: hidden inside the memory folder, one per pass, named by the time", () => {
  assert.equal(backupDir(`${DIR}/`, "2026-10-13T12:00:00.000Z"), `${DIR}/.memory-backup/2026-10-13T12-00-00-000Z`);
});

test("lock: held while Claude Code's own consolidation runs; a stale, empty or dead one is not", () => {
  const nowMs = Date.parse("2026-10-13T12:00:00.000Z");
  const fresh = nowMs - 60_000;
  assert.equal(lockHeld({ content: "4242", mtimeMs: fresh, nowMs, alive: true }), true);
  assert.equal(lockHeld({ content: "4242", mtimeMs: fresh, nowMs, alive: false }), false, "its process is gone");
  assert.equal(lockHeld({ content: "4242", mtimeMs: nowMs - 2 * 3_600_000, nowMs, alive: true }), false, "over an hour old");
  assert.equal(lockHeld({ content: null, mtimeMs: null, nowMs, alive: true }), false, "no lock");
  assert.equal(lockHeld({ content: "not a pid", mtimeMs: fresh, nowMs, alive: true }), false);
  assert.equal(lockHeld({ content: "4242", mtimeMs: fresh, nowMs, alive: null }), true, "a pid that cannot be checked is respected");
});
