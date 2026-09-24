// Unit tests for paths.ts -- pure input to pure output, no filesystem, no
// process.platform read. Run with:
//   node --test src/core/paths.test.ts
//
// Every test drives a target platform explicitly (as this project's own
// convention requires -- see paths.ts's own header comment) so win32,
// darwin and linux are all exercised from this one machine.
//
// The platform-behavior tests below pass NOT_TEST_ENV explicitly as the
// third (env) argument. That is not incidental: this file itself runs
// under node's own test runner, so the AMBIENT process.env already carries
// NODE_TEST_CONTEXT (see write_guard.ts's module doc) -- and since
// resolveConfigDir/resolveCacheDir now refuse to compute a real path under
// the test runner unless an explicit override is set (see the guard tests
// at the bottom of this file), every one of these calls would otherwise
// throw instead of exercising the platform logic they're actually testing.
// Passing NOT_TEST_ENV isolates "what does this function compute" from
// "does the guard fire", which get their own dedicated tests below.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_DIR_OVERRIDE_ENV,
  CONFIG_DIR_OVERRIDE_ENV,
  isSupportedPlatform,
  joinPath,
  normalizePlatform,
  RealConfigPathBlockedError,
  resolveCacheDir,
  resolveCacheDirCandidates,
  resolveConfigDir,
  resolveConfigDirCandidates,
} from "./paths.ts";

const NODE_TEST_ENV = { NODE_TEST_CONTEXT: "child-v8" };
const NOT_TEST_ENV = {};

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
  assert.equal(resolveConfigDir("darwin", { home: "/Users/dev" }, NOT_TEST_ENV), "/Users/dev/.config/orca-supervisor");
  // macOS deliberately never honors XDG_CONFIG_HOME -- Orca itself does not
  // on darwin (it uses ~/Library/Application Support instead), and this
  // plugin must not disagree with Orca about where things live.
  assert.equal(
    resolveConfigDir("darwin", { home: "/Users/dev", xdgConfigHome: "/Users/dev/xdg-config" }, NOT_TEST_ENV),
    "/Users/dev/.config/orca-supervisor",
  );
});

test("resolveConfigDir on linux honors XDG_CONFIG_HOME when set", () => {
  assert.equal(
    resolveConfigDir("linux", { home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" }, NOT_TEST_ENV),
    "/home/dev/.xdgconfig/orca-supervisor",
  );
});

test("resolveConfigDir on linux falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
  assert.equal(resolveConfigDir("linux", { home: "/home/dev" }, NOT_TEST_ENV), "/home/dev/.config/orca-supervisor");
});

test("resolveConfigDir on linux falls back to ~/.config when XDG_CONFIG_HOME is set but empty", () => {
  assert.equal(resolveConfigDir("linux", { home: "/home/dev", xdgConfigHome: "" }, NOT_TEST_ENV), "/home/dev/.config/orca-supervisor");
});

test("resolveConfigDir on win32 uses %APPDATA% when set", () => {
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\dev", appDataDir: "C:\\Users\\dev\\AppData\\Roaming" }, NOT_TEST_ENV),
    "C:\\Users\\dev\\AppData\\Roaming\\orca-supervisor",
  );
});

test("resolveConfigDir on win32 falls back to <home>\\AppData\\Roaming when %APPDATA% is unset", () => {
  assert.equal(resolveConfigDir("win32", { home: "C:\\Users\\dev" }, NOT_TEST_ENV), "C:\\Users\\dev\\AppData\\Roaming\\orca-supervisor");
});

test("resolveConfigDir on win32 survives a home directory containing a space", () => {
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\Ana Gómez" }, NOT_TEST_ENV),
    "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca-supervisor",
  );
  assert.equal(
    resolveConfigDir("win32", { home: "C:\\Users\\Ana Gómez", appDataDir: "C:\\Users\\Ana Gómez\\AppData\\Roaming" }, NOT_TEST_ENV),
    "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca-supervisor",
  );
});

test("resolveCacheDir on darwin always uses ~/.cache, XDG or not", () => {
  assert.equal(resolveCacheDir("darwin", { home: "/Users/dev" }, NOT_TEST_ENV), "/Users/dev/.cache/orca-supervisor");
  assert.equal(
    resolveCacheDir("darwin", { home: "/Users/dev", xdgCacheHome: "/Users/dev/xdg-cache" }, NOT_TEST_ENV),
    "/Users/dev/.cache/orca-supervisor",
  );
});

test("resolveCacheDir on linux honors XDG_CACHE_HOME when set", () => {
  assert.equal(
    resolveCacheDir("linux", { home: "/home/dev", xdgCacheHome: "/home/dev/.xdgcache" }, NOT_TEST_ENV),
    "/home/dev/.xdgcache/orca-supervisor",
  );
});

test("resolveCacheDir on linux falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
  assert.equal(resolveCacheDir("linux", { home: "/home/dev" }, NOT_TEST_ENV), "/home/dev/.cache/orca-supervisor");
});

test("resolveCacheDir on linux falls back to ~/.cache when XDG_CACHE_HOME is set but empty", () => {
  assert.equal(resolveCacheDir("linux", { home: "/home/dev", xdgCacheHome: "" }, NOT_TEST_ENV), "/home/dev/.cache/orca-supervisor");
});

test("resolveCacheDir on win32 uses %LOCALAPPDATA% when set, and appends Cache", () => {
  assert.equal(
    resolveCacheDir("win32", { home: "C:\\Users\\dev", localAppDataDir: "C:\\Users\\dev\\AppData\\Local" }, NOT_TEST_ENV),
    "C:\\Users\\dev\\AppData\\Local\\orca-supervisor\\Cache",
  );
});

test("resolveCacheDir on win32 falls back to <home>\\AppData\\Local when %LOCALAPPDATA% is unset", () => {
  assert.equal(resolveCacheDir("win32", { home: "C:\\Users\\dev" }, NOT_TEST_ENV), "C:\\Users\\dev\\AppData\\Local\\orca-supervisor\\Cache");
});

test("resolveCacheDir on win32 survives a home directory containing a space", () => {
  assert.equal(
    resolveCacheDir("win32", { home: "C:\\Users\\Ana Gómez", localAppDataDir: "C:\\Users\\Ana Gómez\\AppData\\Local" }, NOT_TEST_ENV),
    "C:\\Users\\Ana Gómez\\AppData\\Local\\orca-supervisor\\Cache",
  );
});

test("config and cache dirs never collide with each other on any platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const home = platform === "win32" ? "C:\\Users\\dev" : "/home/dev";
    assert.notEqual(resolveConfigDir(platform, { home }, NOT_TEST_ENV), resolveCacheDir(platform, { home }, NOT_TEST_ENV));
  }
});

// ---------------------------------------------------------------------------
// The test-isolation guard itself -- see this module's own header comment
// and src/core/write_guard.ts's module doc for the incident history this
// exists to close off. Reuses write_guard.ts's own NODE_TEST_CONTEXT
// detection rather than inventing a second notion of "under test".
// ---------------------------------------------------------------------------

test("resolveConfigDir refuses to compute a real path under the node test runner when no override is set", () => {
  assert.throws(
    () => resolveConfigDir("darwin", { home: "/Users/dev" }, NODE_TEST_ENV),
    (error: unknown) => {
      assert.ok(error instanceof RealConfigPathBlockedError);
      assert.equal(error.resolver, "resolveConfigDir");
      assert.equal(error.wouldHaveReturned, "/Users/dev/.config/orca-supervisor");
      assert.equal(error.overrideEnvVar, CONFIG_DIR_OVERRIDE_ENV);
      assert.match(error.message, /resolveConfigDir/);
      assert.match(error.message, /\/Users\/dev\/\.config\/orca-supervisor/);
      assert.ok(error.message.includes(CONFIG_DIR_OVERRIDE_ENV), "message must name the override variable");
      return true;
    },
  );
});

test("resolveCacheDir refuses to compute a real path under the node test runner when no override is set", () => {
  assert.throws(
    () => resolveCacheDir("linux", { home: "/home/dev" }, NODE_TEST_ENV),
    (error: unknown) => {
      assert.ok(error instanceof RealConfigPathBlockedError);
      assert.equal(error.resolver, "resolveCacheDir");
      assert.equal(error.wouldHaveReturned, "/home/dev/.cache/orca-supervisor");
      assert.equal(error.overrideEnvVar, CACHE_DIR_OVERRIDE_ENV);
      assert.ok(error.message.includes(CACHE_DIR_OVERRIDE_ENV), "message must name the override variable");
      return true;
    },
  );
});

test("resolveConfigDir returns the override path under the test runner, regardless of platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const home = platform === "win32" ? "C:\\Users\\dev" : "/home/dev";
    const env = { ...NODE_TEST_ENV, [CONFIG_DIR_OVERRIDE_ENV]: "/tmp/fake-orca-config" };
    assert.equal(resolveConfigDir(platform, { home }, env), "/tmp/fake-orca-config");
  }
});

test("resolveCacheDir returns the override path under the test runner, regardless of platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const home = platform === "win32" ? "C:\\Users\\dev" : "/home/dev";
    const env = { ...NODE_TEST_ENV, [CACHE_DIR_OVERRIDE_ENV]: "/tmp/fake-orca-cache" };
    assert.equal(resolveCacheDir(platform, { home }, env), "/tmp/fake-orca-cache");
  }
});

test("the override env var takes precedence even outside the test runner -- it is not a test-only hatch", () => {
  const configEnv = { [CONFIG_DIR_OVERRIDE_ENV]: "/opt/custom/orca-config" };
  const cacheEnv = { [CACHE_DIR_OVERRIDE_ENV]: "/opt/custom/orca-cache" };
  assert.equal(resolveConfigDir("darwin", { home: "/Users/dev" }, configEnv), "/opt/custom/orca-config");
  assert.equal(resolveCacheDir("darwin", { home: "/Users/dev" }, cacheEnv), "/opt/custom/orca-cache");
});

test("an empty override env var is treated as unset", () => {
  const env = { ...NODE_TEST_ENV, [CONFIG_DIR_OVERRIDE_ENV]: "" };
  assert.throws(() => resolveConfigDir("darwin", { home: "/Users/dev" }, env), RealConfigPathBlockedError);
});

test("outside the test runner, resolveConfigDir/resolveCacheDir compute the normal per-platform path, unchanged", () => {
  assert.equal(resolveConfigDir("darwin", { home: "/Users/dev" }, NOT_TEST_ENV), "/Users/dev/.config/orca-supervisor");
  assert.equal(resolveCacheDir("darwin", { home: "/Users/dev" }, NOT_TEST_ENV), "/Users/dev/.cache/orca-supervisor");
});

test("fires against the process's own ambient environment, with no env argument", () => {
  // This test file itself runs under `node --test`, so process.env already
  // carries NODE_TEST_CONTEXT -- proving the default parameter behaves
  // identically to the explicit NODE_TEST_ENV used above.
  assert.throws(() => resolveConfigDir("darwin", { home: "/Users/dev" }), RealConfigPathBlockedError);
  assert.throws(() => resolveCacheDir("darwin", { home: "/Users/dev" }), RealConfigPathBlockedError);
});

// ---------------------------------------------------------------------------
// resolveConfigDirCandidates / resolveCacheDirCandidates -- the guard above
// applies to the primary candidate; under the test runner the legacy linux
// fallback (a second raw join, not routed through resolveConfigDir/
// resolveCacheDir) is dropped entirely rather than leaking an unguarded
// second real-looking path.
// ---------------------------------------------------------------------------

test("resolveConfigDirCandidates adds the legacy linux candidate outside the test runner, exactly as before", () => {
  const candidates = resolveConfigDirCandidates("linux", { home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" }, NOT_TEST_ENV);
  assert.deepEqual(candidates, ["/home/dev/.xdgconfig/orca-supervisor", "/home/dev/.config/orca-supervisor"]);
});

test("resolveConfigDirCandidates collapses to one entry when XDG and legacy agree, outside the test runner", () => {
  const candidates = resolveConfigDirCandidates("linux", { home: "/home/dev" }, NOT_TEST_ENV);
  assert.deepEqual(candidates, ["/home/dev/.config/orca-supervisor"]);
});

test("resolveConfigDirCandidates on darwin/win32 never adds a legacy candidate, outside the test runner", () => {
  assert.deepEqual(resolveConfigDirCandidates("darwin", { home: "/Users/dev" }, NOT_TEST_ENV), ["/Users/dev/.config/orca-supervisor"]);
  assert.deepEqual(resolveConfigDirCandidates("win32", { home: "C:\\Users\\dev" }, NOT_TEST_ENV), [
    "C:\\Users\\dev\\AppData\\Roaming\\orca-supervisor",
  ]);
});

test("resolveConfigDirCandidates refuses under the test runner when no override is set, same as resolveConfigDir", () => {
  assert.throws(() => resolveConfigDirCandidates("linux", { home: "/home/dev" }, NODE_TEST_ENV), RealConfigPathBlockedError);
});

test("resolveConfigDirCandidates returns only the override, dropping the legacy linux candidate, under the test runner", () => {
  const env = { ...NODE_TEST_ENV, [CONFIG_DIR_OVERRIDE_ENV]: "/tmp/fake-orca-config" };
  assert.deepEqual(resolveConfigDirCandidates("linux", { home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" }, env), [
    "/tmp/fake-orca-config",
  ]);
});

test("resolveCacheDirCandidates adds the legacy linux candidate outside the test runner, exactly as before", () => {
  const candidates = resolveCacheDirCandidates("linux", { home: "/home/dev", xdgCacheHome: "/home/dev/.xdgcache" }, NOT_TEST_ENV);
  assert.deepEqual(candidates, ["/home/dev/.xdgcache/orca-supervisor", "/home/dev/.cache/orca-supervisor"]);
});

test("resolveCacheDirCandidates refuses under the test runner when no override is set, same as resolveCacheDir", () => {
  assert.throws(() => resolveCacheDirCandidates("linux", { home: "/home/dev" }, NODE_TEST_ENV), RealConfigPathBlockedError);
});

test("resolveCacheDirCandidates returns only the override, dropping the legacy linux candidate, under the test runner", () => {
  const env = { ...NODE_TEST_ENV, [CACHE_DIR_OVERRIDE_ENV]: "/tmp/fake-orca-cache" };
  assert.deepEqual(resolveCacheDirCandidates("linux", { home: "/home/dev", xdgCacheHome: "/home/dev/.xdgcache" }, env), [
    "/tmp/fake-orca-cache",
  ]);
});
