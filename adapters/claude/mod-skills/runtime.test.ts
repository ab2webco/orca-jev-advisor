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
// separately.
//
// JEVADV-43: resolveModSkillsSwitches, resolveModSkillsSamplingConfig,
// measurementDecisionsToday, toolMeasurementDecisionsToday and
// resolveModSkillsReadiness all take `$` and moved to hooks/index.ts (the
// engine only follows `$` into a function declared at the top of the same
// file that receives it, never across an import) -- they are imported from
// there now, by name, exactly as index.ts's own module doc promises. Only
// computeHomePaths stayed in runtime.ts (it never touches `$`), so this
// file now depends on the hooks sandbox's full module graph for its other
// half; it is still a plain Node test file run the same way.

import assert from "node:assert/strict";
import test from "node:test";

import { computeHomePaths, resolveUserSkillsDir } from "./hooks/runtime.ts";
import { measurementDecisionsToday, resolveModSkillsReadiness, resolveModSkillsSamplingConfig, resolveModSkillsSwitches, toolMeasurementDecisionsToday } from "./hooks/index.ts";

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

// The gate and this mod read the same API key from the same file. If their
// two resolvers ever disagree, one of them finds nothing and says nothing --
// which is what a live macOS machine with XDG_CONFIG_HOME set did before
// this was fixed. These tests exist to keep the two in step, so they assert
// agreement with src/core/paths.ts rather than a hardcoded string.
test('agrees with src/core/paths.ts on every platform shape', async () => {
  const { resolveConfigDir, resolveCacheDir } = await import('../../../src/core/paths.ts');
  const cases = [
    { name: 'macOS, no XDG', platform: 'darwin' as const, home: '/Users/dev', env: {} },
    { name: 'macOS WITH XDG set', platform: 'darwin' as const, home: '/Users/dev', env: { xdgConfigHome: '/custom/cfg', xdgCacheHome: '/custom/cache' } },
    { name: 'Linux, no XDG', platform: 'linux' as const, home: '/home/dev', env: {} },
    { name: 'Linux WITH XDG set', platform: 'linux' as const, home: '/home/dev', env: { xdgConfigHome: '/custom/cfg', xdgCacheHome: '/custom/cache' } },
  ];
  // Pass an explicit empty `env` (the third, test-isolation-guard
  // argument): this test file itself runs under node's test runner, and
  // src/core/paths.ts's resolveConfigDir/resolveCacheDir now refuse to
  // compute a real path at all in that case unless an explicit override is
  // set (see that module's doc). This test compares pure platform logic,
  // not real filesystem safety, so it opts out of the guard the same way
  // src/core/paths.test.ts's own platform-behavior tests do.
  const NOT_TEST_ENV = {};
  for (const c of cases) {
    const mine = computeHomePaths({ home: c.home, ...c.env });
    const theirs = {
      configDir: resolveConfigDir(c.platform, { home: c.home, xdgConfigHome: c.env.xdgConfigHome }, NOT_TEST_ENV),
      cacheDir: resolveCacheDir(c.platform, { home: c.home, xdgCacheHome: c.env.xdgCacheHome }, NOT_TEST_ENV),
    };
    assert.equal(mine?.configDir, theirs.configDir, `${c.name}: config dir diverged`);
    assert.equal(mine?.cacheDir, theirs.cacheDir, `${c.name}: cache dir diverged`);
  }
});

// ---------------------------------------------------------------------------
// resolveUserSkillsDir -- Claude Code's own user skills folder for a
// session is `$CLAUDE_CONFIG_DIR/skills` when that variable is set (how
// every Orca-managed account runs), not unconditionally `<home>/.claude/
// skills`. Pure: env values in, path out, no `$`.
// ---------------------------------------------------------------------------

test("resolveUserSkillsDir prefers CLAUDE_CONFIG_DIR when it is a non-empty string", () => {
  const result = resolveUserSkillsDir({ claudeConfigDir: "/data/claude-accounts/acct-1", home: "/Users/dev" });
  assert.equal(result, "/data/claude-accounts/acct-1/skills");
});

test("resolveUserSkillsDir falls back to <home>/.claude/skills when CLAUDE_CONFIG_DIR is unset", () => {
  const result = resolveUserSkillsDir({ home: "/Users/dev" });
  assert.equal(result, "/Users/dev/.claude/skills");
});

test("resolveUserSkillsDir falls back to <home>/.claude/skills when CLAUDE_CONFIG_DIR is an empty string", () => {
  const result = resolveUserSkillsDir({ claudeConfigDir: "", home: "/Users/dev" });
  assert.equal(result, "/Users/dev/.claude/skills");
});

test("resolveUserSkillsDir is null when neither CLAUDE_CONFIG_DIR nor home is known", () => {
  assert.equal(resolveUserSkillsDir({}), null);
});

// ---------------------------------------------------------------------------
// resolveModSkillsSwitches -- T10 (odd/tasks/panel-worker-wakeup.md). Reads
// <configDir>/mod-skills-config.json the same best-effort way resolveLocale
// reads the locale mirror: missing file, unreachable home, or a read that
// throws all fall back to both switches off, never a thrown error.
//
// EngineInterface is a large host-provided type; this fake only implements
// the two namespaces resolveModSkillsSwitches (via resolveHomePaths) actually
// touches (`env.get`, `fs.exists`, `fs.read`) and is cast through `unknown`,
// same shape as main.test.mjs's fakeOrca/fakeStorageHost fakes elsewhere in
// this project -- not `any`, an explicit narrow substitute for the one real
// interface.
// ---------------------------------------------------------------------------

interface FakeEngine {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> };
}

function fakeEngine(env: Readonly<Record<string, string>>, files: Readonly<Record<string, string>>): FakeEngine {
  return {
    env: { get: async (name: string) => env[name] },
    fs: {
      exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
      read: async (path: string) => {
        if (!Object.prototype.hasOwnProperty.call(files, path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return files[path] as string;
      },
    },
  };
}

test("resolveModSkillsSwitches: no home resolvable falls back to both off", async () => {
  const engine = fakeEngine({}, {});
  const result = await resolveModSkillsSwitches(engine as Parameters<typeof resolveModSkillsSwitches>[0]);
  assert.deepEqual(result, { active: false, activeTools: false });
});

test("resolveModSkillsSwitches: the file has never been written -- falls back to both off", async () => {
  const engine = fakeEngine({ HOME: "/home/dev" }, {});
  const result = await resolveModSkillsSwitches(engine as Parameters<typeof resolveModSkillsSwitches>[0]);
  assert.deepEqual(result, { active: false, activeTools: false });
});

test("resolveModSkillsSwitches: reads both switches from a real file", async () => {
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { "/home/dev/.config/orca-supervisor/mod-skills-config.json": '{"active":true,"activeTools":true}' },
  );
  const result = await resolveModSkillsSwitches(engine as Parameters<typeof resolveModSkillsSwitches>[0]);
  assert.deepEqual(result, { active: true, activeTools: true });
});

test("resolveModSkillsSwitches: malformed JSON on disk falls back to both off, never throws", async () => {
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { "/home/dev/.config/orca-supervisor/mod-skills-config.json": "{not json" },
  );
  const result = await resolveModSkillsSwitches(engine as Parameters<typeof resolveModSkillsSwitches>[0]);
  assert.deepEqual(result, { active: false, activeTools: false });
});

test("resolveModSkillsSwitches: a read that throws falls back to both off, never propagates", async () => {
  const engine: FakeEngine = {
    env: { get: async (name: string) => (name === "HOME" ? "/home/dev" : undefined) },
    fs: {
      exists: async () => true,
      read: async () => {
        throw new Error("disk on fire");
      },
    },
  };
  const result = await resolveModSkillsSwitches(engine as Parameters<typeof resolveModSkillsSwitches>[0]);
  assert.deepEqual(result, { active: false, activeTools: false });
});

// ---------------------------------------------------------------------------
// resolveModSkillsSamplingConfig -- the sampling half of mod-skills'
// measurement-mode cost fix (src/core/mod_skills_sampling.ts). Reads
// <configDir>/mod-skills-sampling-config.json the same best-effort way
// resolveModSkillsSwitches reads mod-skills-config.json: missing file,
// unreachable home, or a read that throws all fall back to the safe
// default (sampling ON at a reduced rate, never OFF and never the old
// unsampled behaviour), never a thrown error.
// ---------------------------------------------------------------------------

test("resolveModSkillsSamplingConfig: no home resolvable falls back to the default", async () => {
  const engine = fakeEngine({}, {});
  const result = await resolveModSkillsSamplingConfig(engine as Parameters<typeof resolveModSkillsSamplingConfig>[0]);
  assert.deepEqual(result, { enabled: true, sampleRate: 0.25, dailyPromptCap: 40 });
});

test("resolveModSkillsSamplingConfig: the file has never been written -- falls back to the default", async () => {
  const engine = fakeEngine({ HOME: "/home/dev" }, {});
  const result = await resolveModSkillsSamplingConfig(engine as Parameters<typeof resolveModSkillsSamplingConfig>[0]);
  assert.deepEqual(result, { enabled: true, sampleRate: 0.25, dailyPromptCap: 40 });
});

test("resolveModSkillsSamplingConfig: reads a real file", async () => {
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { "/home/dev/.config/orca-supervisor/mod-skills-sampling-config.json": '{"enabled":false,"sampleRate":0.5,"dailyPromptCap":10}' },
  );
  const result = await resolveModSkillsSamplingConfig(engine as Parameters<typeof resolveModSkillsSamplingConfig>[0]);
  assert.deepEqual(result, { enabled: false, sampleRate: 0.5, dailyPromptCap: 10 });
});

test("resolveModSkillsSamplingConfig: malformed JSON on disk falls back to the default, never throws", async () => {
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { "/home/dev/.config/orca-supervisor/mod-skills-sampling-config.json": "{not json" },
  );
  const result = await resolveModSkillsSamplingConfig(engine as Parameters<typeof resolveModSkillsSamplingConfig>[0]);
  assert.deepEqual(result, { enabled: true, sampleRate: 0.25, dailyPromptCap: 40 });
});

test("resolveModSkillsSamplingConfig: a read that throws falls back to the default, never propagates", async () => {
  const engine: FakeEngine = {
    env: { get: async (name: string) => (name === "HOME" ? "/home/dev" : undefined) },
    fs: {
      exists: async () => true,
      read: async () => {
        throw new Error("disk on fire");
      },
    },
  };
  const result = await resolveModSkillsSamplingConfig(engine as Parameters<typeof resolveModSkillsSamplingConfig>[0]);
  assert.deepEqual(result, { enabled: true, sampleRate: 0.25, dailyPromptCap: 40 });
});

// ---------------------------------------------------------------------------
// measurementDecisionsToday -- the sampling cap's own "today", read the same
// tolerant way gate-bash.ts's samplesQueuedToday reads the AB-benchmark
// queue: filter the mod's own existing measurement log
// (mod-skills-measurements.jsonl) by `at`'s UTC date prefix, so the daily
// cap means "today", not "ever". Reused rather than inventing a second
// counter file, and only measurement-mode decisions count -- active mode
// never goes through the sampling gate this counts for.
// ---------------------------------------------------------------------------

function measurementLogPath(home: string): string {
  return `${home}/.cache/orca-supervisor/mod-skills-measurements.jsonl`;
}

test("measurementDecisionsToday: no home resolvable reads as 0", async () => {
  const engine = fakeEngine({}, {});
  const result = await measurementDecisionsToday(engine as Parameters<typeof measurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 0);
});

test("measurementDecisionsToday: the log has never been written -- reads as 0", async () => {
  const engine = fakeEngine({ HOME: "/home/dev" }, {});
  const result = await measurementDecisionsToday(engine as Parameters<typeof measurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 0);
});

test("measurementDecisionsToday: counts only measurement-mode decisions whose `at` starts with today, ignoring active-mode decisions, observations, and other days", async () => {
  const lines = [
    { type: "decision", id: "a", at: "2026-09-24T08:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "b", at: "2026-09-24T09:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "c", at: "2026-09-23T09:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "d", at: "2026-09-24T10:00:00.000Z", mode: "active" },
    { type: "observation", id: "a", at: "2026-09-24T08:05:00.000Z", skill: "graft" },
  ];
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { [measurementLogPath("/home/dev")]: lines.map((line) => `${JSON.stringify(line)}\n`).join("") },
  );
  const result = await measurementDecisionsToday(engine as Parameters<typeof measurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 2);
});

test("measurementDecisionsToday: a hand-edited/malformed line is skipped, never thrown on", async () => {
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { [measurementLogPath("/home/dev")]: '{not json\n{"type":"decision","id":"a","at":"2026-09-24T08:00:00.000Z","mode":"measurement"}\n' },
  );
  const result = await measurementDecisionsToday(engine as Parameters<typeof measurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 1);
});

test("measurementDecisionsToday: a read that throws reads as 0, never propagates", async () => {
  const engine: FakeEngine = {
    env: { get: async (name: string) => (name === "HOME" ? "/home/dev" : undefined) },
    fs: {
      exists: async () => true,
      read: async () => {
        throw new Error("disk on fire");
      },
    },
  };
  const result = await measurementDecisionsToday(engine as Parameters<typeof measurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 0);
});

// ---------------------------------------------------------------------------
// toolMeasurementDecisionsToday -- JEVADV-4's own sampling for the
// tool-relevance path. Same tolerant read as measurementDecisionsToday,
// pointed at the tool-selection log instead (mod-tools-measurements.jsonl),
// so the two logs never get counted against the wrong file.
// ---------------------------------------------------------------------------

function toolMeasurementLogPath(home: string): string {
  return `${home}/.cache/orca-supervisor/mod-tools-measurements.jsonl`;
}

test("toolMeasurementDecisionsToday: no home resolvable reads as 0", async () => {
  const engine = fakeEngine({}, {});
  const result = await toolMeasurementDecisionsToday(engine as Parameters<typeof toolMeasurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 0);
});

test("toolMeasurementDecisionsToday: counts only measurement-mode decisions from today, in the tool log, not the skill log", async () => {
  const toolLines = [
    { type: "decision", id: "a", at: "2026-09-24T08:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "b", at: "2026-09-24T09:00:00.000Z", mode: "active" },
  ];
  const skillLines = [
    { type: "decision", id: "c", at: "2026-09-24T08:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "d", at: "2026-09-24T08:00:00.000Z", mode: "measurement" },
  ];
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    {
      [toolMeasurementLogPath("/home/dev")]: toolLines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      [measurementLogPath("/home/dev")]: skillLines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    },
  );
  const result = await toolMeasurementDecisionsToday(engine as Parameters<typeof toolMeasurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 1, "must read the tool log's own count (1), not the skill log's (2)");
});

test("toolMeasurementDecisionsToday: a read that throws reads as 0, never propagates", async () => {
  const engine: FakeEngine = {
    env: { get: async (name: string) => (name === "HOME" ? "/home/dev" : undefined) },
    fs: {
      exists: async () => true,
      read: async () => {
        throw new Error("disk on fire");
      },
    },
  };
  const result = await toolMeasurementDecisionsToday(engine as Parameters<typeof toolMeasurementDecisionsToday>[0], "2026-09-24");
  assert.equal(result, 0);
});

// ---------------------------------------------------------------------------
// resolveModSkillsReadiness -- JEVADV-4: active mode's own activation
// metric (src/core/mod_skills_readiness.ts), folded from the skill
// measurement log with computeComparableStats
// (src/core/skill_measurement.ts). Best-effort: an unreachable home or a
// throwing read reads as null; a genuinely empty or missing log is a real
// "not-enough-samples" verdict, not a failure.
// ---------------------------------------------------------------------------

test("resolveModSkillsReadiness: no home resolvable reads as null", async () => {
  const engine = fakeEngine({}, {});
  const result = await resolveModSkillsReadiness(engine as Parameters<typeof resolveModSkillsReadiness>[0]);
  assert.equal(result, null);
});

test("resolveModSkillsReadiness: the log has never been written -- a real not-enough-samples verdict, not null", async () => {
  const engine = fakeEngine({ HOME: "/home/dev" }, {});
  const result = await resolveModSkillsReadiness(engine as Parameters<typeof resolveModSkillsReadiness>[0]);
  assert.deepEqual(result, { ready: false, comparableShortfall: 1000, matchRateMet: null, reason: "not-enough-samples" });
});

test("resolveModSkillsReadiness: folds the real log through computeComparableStats and evaluateModSkillsReadiness", async () => {
  const lines = [
    { type: "decision", id: "a", mode: "measurement", decision: { name: "graft" } },
    { type: "observation", id: "a", skill: "graft" },
  ];
  const engine = fakeEngine(
    { HOME: "/home/dev" },
    { [measurementLogPath("/home/dev")]: lines.map((line) => `${JSON.stringify(line)}\n`).join("") },
  );
  const result = await resolveModSkillsReadiness(engine as Parameters<typeof resolveModSkillsReadiness>[0]);
  // 1 comparable sample is nowhere near the 1000 threshold, but the fold
  // itself (comparable=1, matched=1) must have actually run: matchRateMet
  // stays null (count threshold not met), never a fabricated false.
  assert.deepEqual(result, { ready: false, comparableShortfall: 999, matchRateMet: null, reason: "not-enough-samples" });
});

test("resolveModSkillsReadiness: a read that throws reads as null, never propagates", async () => {
  const engine: FakeEngine = {
    env: { get: async (name: string) => (name === "HOME" ? "/home/dev" : undefined) },
    fs: {
      exists: async () => true,
      read: async () => {
        throw new Error("disk on fire");
      },
    },
  };
  const result = await resolveModSkillsReadiness(engine as Parameters<typeof resolveModSkillsReadiness>[0]);
  assert.equal(result, null);
});
