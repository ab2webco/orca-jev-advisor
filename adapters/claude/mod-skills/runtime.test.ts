// Unit tests for computeHomePaths, the pure half of runtime.ts's home/
// config/cache resolution -- plain env object in, paths out, no `$`, no
// EngineInterface. This is the sandbox mod-skills' hooks run in has no
// node:os or node:path, so it cannot reuse src/core/paths.test.ts's own
// harness; this file exercises the same win32/linux/XDG matrix against
// this module's own (deliberately simpler, forward-slash-only) resolution.
//
// Run with:
//   node --test adapters/claude/mod-skills/runtime.test.ts
//
// Deliberately NOT under hooks/ (which would put it in scope of
// hooks/tsconfig.json's `hooks/*.ts` include and fail to typecheck there --
// that config has no Node types, matching the hook sandbox's own "no DOM,
// no Node"). This is NOT run by `claude plugin test` (no fs/process there
// either) and is NOT part of the `node --test src/core/*.test.ts` suite the
// rest of this project's CI counts on -- it is a plain Node test file, run
// separately, because computeHomePaths itself has no dependency on the
// hooks sandbox.

import assert from "node:assert/strict";
import test from "node:test";

import { computeHomePaths } from "./hooks/runtime.ts";

test("returns null when neither HOME nor USERPROFILE is set", () => {
  assert.equal(computeHomePaths({}), null);
});

test("darwin/linux shape: prefers HOME, uses ~/.config and ~/.cache with no XDG set", () => {
  const result = computeHomePaths({ home: "/home/dev" });
  assert.deepEqual(result, { home: "/home/dev", configDir: "/home/dev/.config/orca-supervisor", cacheDir: "/home/dev/.cache/orca-supervisor" });
});

test("honors XDG_CONFIG_HOME and XDG_CACHE_HOME when both are set", () => {
  const result = computeHomePaths({ home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig", xdgCacheHome: "/home/dev/.xdgcache" });
  assert.deepEqual(result, {
    home: "/home/dev",
    configDir: "/home/dev/.xdgconfig/orca-supervisor",
    cacheDir: "/home/dev/.xdgcache/orca-supervisor",
  });
});

test("falls back to ~/.config and ~/.cache when XDG_* are set but empty", () => {
  const result = computeHomePaths({ home: "/home/dev", xdgConfigHome: "", xdgCacheHome: "" });
  assert.deepEqual(result, { home: "/home/dev", configDir: "/home/dev/.config/orca-supervisor", cacheDir: "/home/dev/.cache/orca-supervisor" });
});

test("honors XDG_CONFIG_HOME independently of XDG_CACHE_HOME", () => {
  const result = computeHomePaths({ home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" });
  assert.deepEqual(result, {
    home: "/home/dev",
    configDir: "/home/dev/.xdgconfig/orca-supervisor",
    cacheDir: "/home/dev/.cache/orca-supervisor",
  });
});

test("win32 shape: falls back to USERPROFILE when HOME is unset, and uses AppData when %APPDATA%/%LOCALAPPDATA% are unset", () => {
  const result = computeHomePaths({ userProfile: "C:/Users/dev" });
  assert.deepEqual(result, {
    home: "C:/Users/dev",
    configDir: "C:/Users/dev/AppData/Roaming/orca-supervisor",
    cacheDir: "C:/Users/dev/AppData/Local/orca-supervisor/Cache",
  });
});

test("win32 shape: uses %APPDATA%/%LOCALAPPDATA% when set, and ignores XDG_* entirely", () => {
  const result = computeHomePaths({
    userProfile: "C:/Users/dev",
    appData: "C:/Users/dev/AppData/Roaming",
    localAppData: "C:/Users/dev/AppData/Local",
    xdgConfigHome: "/should/be/ignored/on/windows",
  });
  assert.deepEqual(result, {
    home: "C:/Users/dev",
    configDir: "C:/Users/dev/AppData/Roaming/orca-supervisor",
    cacheDir: "C:/Users/dev/AppData/Local/orca-supervisor/Cache",
  });
});

test("win32 shape survives a home directory containing a space", () => {
  const result = computeHomePaths({
    userProfile: "C:/Users/Ana Gómez",
    appData: "C:/Users/Ana Gómez/AppData/Roaming",
    localAppData: "C:/Users/Ana Gómez/AppData/Local",
  });
  assert.deepEqual(result, {
    home: "C:/Users/Ana Gómez",
    configDir: "C:/Users/Ana Gómez/AppData/Roaming/orca-supervisor",
    cacheDir: "C:/Users/Ana Gómez/AppData/Local/orca-supervisor/Cache",
  });
});

test("HOME wins over USERPROFILE when both are set (a real POSIX box never sets USERPROFILE)", () => {
  const result = computeHomePaths({ home: "/home/dev", userProfile: "C:/Users/dev" });
  assert.equal(result?.home, "/home/dev");
  assert.equal(result?.configDir, "/home/dev/.config/orca-supervisor");
});

test("an %APPDATA% present alongside HOME still reads as Windows (the isWindows heuristic keys off %APPDATA%, not just HOME's absence)", () => {
  const result = computeHomePaths({ home: "C:/Users/dev", appData: "C:/Users/dev/AppData/Roaming" });
  assert.equal(result?.configDir, "C:/Users/dev/AppData/Roaming/orca-supervisor");
});
