// Unit tests for paths.ts -- pure input to pure output, no filesystem, no
// process.platform read. Run with:
//   node --test src/core/paths.test.ts
//
// Every test drives a target platform explicitly (as this project's own
// convention requires -- see paths.ts's own header comment) so win32,
// darwin and linux are all exercised from this one machine.

import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedPlatform, joinPath, normalizePlatform, resolveCacheDir, resolveConfigDir } from "./paths.ts";

test("isSupportedPlatform recognizes exactly the three supported platforms", () => {
  assert.equal(isSupportedPlatform("win32"), true);
  assert.equal(isSupportedPlatform("darwin"), true);
  assert.equal(isSupportedPlatform("linux"), true);
  assert.equal(isSupportedPlatform("freebsd"), false);
  assert.equal(isSupportedPlatform("sunos"), false);
});

test("normalizePlatform falls back to linux for an unmeasured platform", () => {
  assert.equal(normalizePlatform("win32"), "win32");
  assert.equal(normalizePlatform("darwin"), "darwin");
  assert.equal(normalizePlatform("linux"), "linux");
  assert.equal(normalizePlatform("freebsd"), "linux");
});

test("joinPath uses the right separator for each target platform", () => {
  assert.equal(joinPath("win32", "C:\\Users\\dev", "orca-supervisor"), "C:\\Users\\dev\\orca-supervisor");
  assert.equal(joinPath("darwin", "/Users/dev", "orca-supervisor"), "/Users/dev/orca-supervisor");
  assert.equal(joinPath("linux", "/home/dev", "orca-supervisor"), "/home/dev/orca-supervisor");
});

test("resolveConfigDir on darwin always uses ~/.config, XDG or not", () => {
  assert.equal(resolveConfigDir("darwin", { home: "/Users/dev" }), "/Users/dev/.config/orca-supervisor");
  // macOS deliberately never honors XDG_CONFIG_HOME -- Orca itself does not
  // on darwin (it uses ~/Library/Application Support instead), and this
  // plugin must not disagree with Orca about where things live.
  assert.equal(
    resolveConfigDir("darwin", { home: "/Users/dev", xdgConfigHome: "/Users/dev/xdg-config" }),
    "/Users/dev/.config/orca-supervisor",
  );
});

test("resolveConfigDir on linux honors XDG_CONFIG_HOME when set", () => {
  assert.equal(
    resolveConfigDir("linux", { home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" }),
    "/home/dev/.xdgconfig/orca-supervisor",
  );
});

test("resolveConfigDir on linux falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
  assert.equal(resolveConfigDir("linux", { home: "/home/dev" }), "/home/dev/.config/orca-supervisor");
});

test("resolveConfigDir on linux falls back to ~/.config when XDG_CONFIG_HOME is set but empty", () => {
  assert.equal(resolveConfigDir("linux", { home: "/home/dev", xdgConfigHome: "" }), "/home/dev/.config/orca-supervisor");
});

test("resolveConfigDir on win32 uses %APPDATA% when set", () => {
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\dev", appDataDir: "C:\\Users\\dev\\AppData\\Roaming" }),
    "C:\\Users\\dev\\AppData\\Roaming\\orca-supervisor",
  );
});

test("resolveConfigDir on win32 falls back to <home>\\AppData\\Roaming when %APPDATA% is unset", () => {
  assert.equal(resolveConfigDir("win32", { home: "C:\\Users\\dev" }), "C:\\Users\\dev\\AppData\\Roaming\\orca-supervisor");
});

test("resolveConfigDir on win32 survives a home directory containing a space", () => {
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\Ana Gómez" }),
    "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca-supervisor",
  );
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\Ana Gómez", appDataDir: "C:\\Users\\Ana Gómez\\AppData\\Roaming" }),
    "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca-supervisor",
  );
});

test("resolveCacheDir on darwin always uses ~/.cache, XDG or not", () => {
  assert.equal(resolveCacheDir("darwin", { home: "/Users/dev" }), "/Users/dev/.cache/orca-supervisor");
  assert.equal(
    resolveCacheDir("darwin", { home: "/Users/dev", xdgCacheHome: "/Users/dev/xdg-cache" }),
    "/Users/dev/.cache/orca-supervisor",
  );
});

test("resolveCacheDir on linux honors XDG_CACHE_HOME when set", () => {
  assert.equal(
    resolveCacheDir("linux", { home: "/home/dev", xdgCacheHome: "/home/dev/.xdgcache" }),
    "/home/dev/.xdgcache/orca-supervisor",
  );
});

test("resolveCacheDir on linux falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
  assert.equal(resolveCacheDir("linux", { home: "/home/dev" }), "/home/dev/.cache/orca-supervisor");
});

test("resolveCacheDir on linux falls back to ~/.cache when XDG_CACHE_HOME is set but empty", () => {
  assert.equal(resolveCacheDir("linux", { home: "/home/dev", xdgCacheHome: "" }), "/home/dev/.cache/orca-supervisor");
});

test("resolveCacheDir on win32 uses %LOCALAPPDATA% when set, and appends Cache", () => {
  assert.equal(
    resolveCacheDir("win32", { home: "C:\\Users\\dev", localAppDataDir: "C:\\Users\\dev\\AppData\\Local" }),
    "C:\\Users\\dev\\AppData\\Local\\orca-supervisor\\Cache",
  );
});

test("resolveCacheDir on win32 falls back to <home>\\AppData\\Local when %LOCALAPPDATA% is unset", () => {
  assert.equal(resolveCacheDir("win32", { home: "C:\\Users\\dev" }), "C:\\Users\\dev\\AppData\\Local\\orca-supervisor\\Cache");
});

test("resolveCacheDir on win32 survives a home directory containing a space", () => {
  assert.equal(
    resolveCacheDir("win32", { home: "C:\\Users\\Ana Gómez", localAppDataDir: "C:\\Users\\Ana Gómez\\AppData\\Local" }),
    "C:\\Users\\Ana Gómez\\AppData\\Local\\orca-supervisor\\Cache",
  );
});

test("config and cache dirs never collide with each other on any platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const home = platform === "win32" ? "C:\\Users\\dev" : "/home/dev";
    assert.notEqual(resolveConfigDir(platform, { home }), resolveCacheDir(platform, { home }));
  }
});
