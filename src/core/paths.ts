// Where this plugin's own files live, per platform -- the one place that
// decides it, so nothing else has to hardcode `~/.config` or `~/.cache`
// (which do not exist on Windows) or guess a separator.
//
// Pure and platform-INDEPENDENT-of-the-running-OS on purpose: every
// function here takes the target platform and the already-resolved home
// directory as plain arguments, using `node:path`'s own `win32`/`posix`
// namespaces (both always available, regardless of which OS Node is
// actually running on) to join paths the right way for that target. This
// is what makes it testable by simulating `process.platform` without
// needing three real machines.
//
// Node-based callers (secrets.ts, gate-bash.ts, the .mjs sidecars) already
// get the HOME-vs-USERPROFILE distinction for free from `os.homedir()`,
// which is itself cross-platform-correct; they only need this module for
// the `.config`/`.cache` vs `%APPDATA%`/`%LOCALAPPDATA%` convention.
// adapters/claude/mod-skills cannot call `os.homedir()` at all (no Node in
// its sandbox) and resolves `home` itself from `$.env.get('HOME')` /
// `$.env.get('USERPROFILE')` before calling in here -- see
// mod-skills/hooks/runtime.ts's `resolveHomePaths`.
//
// Test isolation (`resolveConfigDir`/`resolveCacheDir`/their `*Candidates`
// siblings only) -- see odd/tasks/write-guard-test-isolation.md for the
// incident history: a `node --test` run reaching these functions with a
// real, unoverridden home has already corrupted the developer's real
// ~/.config/orca-supervisor and wiped every gate hook out of ~/.claude/
// settings.json, more than once, silently. `src/core/write_guard.ts`
// guards the WRITE side of that (every mutating fs call in the two
// sidecars that do the actual writing); this module guards the RESOLUTION
// side, so a caller can never even be HANDED a real path to write to (or
// read from) while running under node's own test runner:
//
//   - Two environment variables, honoured on win32, darwin AND linux alike
//     (unlike XDG_CONFIG_HOME/XDG_CACHE_HOME below, which are Linux-only by
//     platform convention), always take precedence over the platform
//     default: `ORCA_SUPERVISOR_CONFIG_DIR` for resolveConfigDir/
//     resolveConfigDirCandidates, `ORCA_SUPERVISOR_CACHE_DIR` for
//     resolveCacheDir/resolveCacheDirCandidates. This is NOT a test-only
//     escape hatch -- a developer who genuinely wants this plugin's config
//     or cache to live somewhere unusual can set either one too -- but it
//     is also the ONLY way a test running under node's test runner can get
//     a path out of these functions at all.
//   - Absent that override, running under node's test runner
//     (`isRunningUnderNodeTestRunner`, reused from write_guard.ts rather
//     than reinventing a second notion of "under test") makes these
//     functions throw `RealConfigPathBlockedError` instead of silently
//     computing and returning the real per-platform path. There is no
//     third option (e.g. "the computed path happens to already be safe") --
//     under test, it is the override or nothing, so a test can never rely
//     on an accidentally-safe-looking `home` it was given.
//   - Outside the test runner, with no override set, nothing changes: same
//     paths, same platform rules, same XDG behaviour on Linux, computed
//     exactly as before this guard existed.

import { posix, win32 } from "node:path";

import { isRunningUnderNodeTestRunner } from "./write_guard.ts";

/** Honoured on every platform (see this module's header comment), always ahead of the platform default; set by a test to redirect resolveConfigDir/resolveConfigDirCandidates, or by a developer with an unusual layout. */
export const CONFIG_DIR_OVERRIDE_ENV = "ORCA_SUPERVISOR_CONFIG_DIR";
/** Same as {@link CONFIG_DIR_OVERRIDE_ENV}, for resolveCacheDir/resolveCacheDirCandidates. */
export const CACHE_DIR_OVERRIDE_ENV = "ORCA_SUPERVISOR_CACHE_DIR";

/**
 * Thrown by {@link resolveConfigDir}/{@link resolveCacheDir} (and their
 * `*Candidates` siblings) instead of silently returning a real path while
 * running under node's test runner with no override set. Modeled on
 * write_guard.ts's `RealConfigWriteBlockedError`: a distinct class, not a
 * plain Error, so a test asserting refusal can confirm it was THIS guard
 * that fired.
 */
export class RealConfigPathBlockedError extends Error {
  /** Which exported function refused -- `"resolveConfigDir"` or `"resolveCacheDir"`. */
  readonly resolver: string;
  /** The real path this resolver would have returned had the guard not fired. */
  readonly wouldHaveReturned: string;
  /** The env var (see {@link CONFIG_DIR_OVERRIDE_ENV}/{@link CACHE_DIR_OVERRIDE_ENV}) that would have avoided this. */
  readonly overrideEnvVar: string;

  constructor(resolver: string, wouldHaveReturned: string, overrideEnvVar: string) {
    super(
      `orca-supervisor paths guard: ${resolver} refused to hand back the real path it would have used ("${wouldHaveReturned}") while running under node's test runner. ` +
        `Set ${overrideEnvVar} to an explicit test directory before this module loads (e.g. a mkdtempSync(join(tmpdir(), ...)) path) -- production callers outside the test runner are unaffected.`,
    );
    this.name = "RealConfigPathBlockedError";
    this.resolver = resolver;
    this.wouldHaveReturned = wouldHaveReturned;
    this.overrideEnvVar = overrideEnvVar;
  }
}

export type SupportedPlatform = "win32" | "darwin" | "linux";

export function isSupportedPlatform(value: string): value is SupportedPlatform {
  return value === "win32" || value === "darwin" || value === "linux";
}

/** Node platforms this project has not been measured against fall back to the POSIX convention (darwin/linux already share it) rather than guessing at a fourth shape. */
export function normalizePlatform(value: string): SupportedPlatform {
  return isSupportedPlatform(value) ? value : "linux";
}

export interface HomePaths {
  readonly home: string;
  /** Windows `%APPDATA%` (roaming), when known. Ignored on non-Windows platforms. */
  readonly appDataDir?: string;
  /** Windows `%LOCALAPPDATA%`, when known. Ignored on non-Windows platforms. */
  readonly localAppDataDir?: string;
  /**
   * `$XDG_CONFIG_HOME`, when set. Linux only; ignored on win32 and darwin --
   * same scoping src/core/orca_accounts.ts already uses for Orca's own
   * userData resolution. macOS is deliberately excluded even though nothing
   * stops a directory named `.config` from existing there: Orca itself never
   * reads XDG_CONFIG_HOME on darwin (it uses `~/Library/Application Support`
   * instead), so honoring it here too would just as deliberately make this
   * plugin disagree with Orca about where things live on that platform.
   */
  readonly xdgConfigHome?: string;
  /** `$XDG_CACHE_HOME`, when set. Linux only; ignored on win32 and darwin, for the same reason as {@link xdgConfigHome}. */
  readonly xdgCacheHome?: string;
}

function joinerFor(platform: SupportedPlatform): (...parts: string[]) => string {
  return platform === "win32" ? win32.join : posix.join;
}

export function joinPath(platform: SupportedPlatform, ...parts: string[]): string {
  return joinerFor(platform)(...parts);
}

/**
 * Where this plugin's own small, non-secret settings files live (the
 * locale choice, the settings.json install-state and backup): `~/.config/
 * orca-supervisor` on macOS, `$XDG_CONFIG_HOME/orca-supervisor` (falling
 * back to `~/.config/orca-supervisor`) on Linux, `%APPDATA%/orca-supervisor`
 * on Windows (falling back to `<home>/AppData/Roaming` when `%APPDATA%`
 * itself is unset, which real Windows always sets but a stripped-down
 * environment might not).
 *
 * The Linux branch matches Orca's own `linux-package-update-recovery.ts`
 * (`process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')`) and
 * `src/core/orca_accounts.ts`'s userData resolution, so a developer's Orca
 * and this plugin agree on where things live when XDG_CONFIG_HOME is set --
 * previously this ignored it outright and always wrote to `~/.config`.
 *
 * `env` (default: the process's real environment) governs the test-isolation
 * guard described in this module's header comment: an explicit
 * `ORCA_SUPERVISOR_CONFIG_DIR` always wins outright, on every platform; with
 * none set, running under node's test runner throws
 * {@link RealConfigPathBlockedError} instead of computing the real path
 * below. `env` is a parameter (not baked in) purely so this function's own
 * tests can exercise both branches deterministically.
 */
export function resolveConfigDir(platform: SupportedPlatform, paths: HomePaths, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_DIR_OVERRIDE_ENV];
  if (override !== undefined && override.length > 0) return override;
  const computed = computeConfigDir(platform, paths);
  if (isRunningUnderNodeTestRunner(env)) {
    throw new RealConfigPathBlockedError("resolveConfigDir", computed, CONFIG_DIR_OVERRIDE_ENV);
  }
  return computed;
}

function computeConfigDir(platform: SupportedPlatform, paths: HomePaths): string {
  const join = joinerFor(platform);
  if (platform === "win32") {
    const base = paths.appDataDir && paths.appDataDir.length > 0 ? paths.appDataDir : join(paths.home, "AppData", "Roaming");
    return join(base, "orca-supervisor");
  }
  if (platform === "linux") {
    const base = paths.xdgConfigHome && paths.xdgConfigHome.length > 0 ? paths.xdgConfigHome : join(paths.home, ".config");
    return join(base, "orca-supervisor");
  }
  return join(paths.home, ".config", "orca-supervisor");
}

/**
 * Every directory a reader should look in, best first.
 *
 * Honouring `XDG_CONFIG_HOME` on Linux was the right fix and it silently
 * orphaned anyone who already had this plugin set up: their API key, locale
 * and install state sat in `~/.config/orca-supervisor`, the code started
 * looking in `$XDG_CONFIG_HOME/orca-supervisor`, and nothing said so -- the
 * gate would simply behave as though no key had ever been entered.
 *
 * Rather than migrate files behind the user's back, readers try each
 * candidate in order and writers use the first. A legacy directory is left
 * exactly where it is, so downgrading or unsetting the variable finds it
 * again. On every other platform, and on Linux without the variable, there
 * is one candidate and this changes nothing.
 *
 * The legacy entry is a second raw join, not itself routed through
 * {@link resolveConfigDir} -- so under node's test runner (see this
 * module's header comment) it is dropped entirely rather than leaking a
 * second, unguarded real-looking path once an override has made the
 * primary safe. `resolveConfigDir` itself still throws first when no
 * override is set at all, exactly as it would if called directly.
 */
export function resolveConfigDirCandidates(platform: SupportedPlatform, paths: HomePaths, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const primary = resolveConfigDir(platform, paths, env);
  if (platform !== "linux" || isRunningUnderNodeTestRunner(env)) return [primary];
  const legacy = joinPath(platform, paths.home, ".config", "orca-supervisor");
  return primary === legacy ? [primary] : [primary, legacy];
}

/** Cache-dir counterpart of {@link resolveConfigDirCandidates}; see its doc comment for the test-isolation behaviour. */
export function resolveCacheDirCandidates(platform: SupportedPlatform, paths: HomePaths, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const primary = resolveCacheDir(platform, paths, env);
  if (platform !== "linux" || isRunningUnderNodeTestRunner(env)) return [primary];
  const legacy = joinPath(platform, paths.home, ".cache", "orca-supervisor");
  return primary === legacy ? [primary] : [primary, legacy];
}

/**
 * Where this plugin's own cache/log files live: `~/.cache/orca-supervisor`
 * on macOS, `$XDG_CACHE_HOME/orca-supervisor` (falling back to
 * `~/.cache/orca-supervisor`) on Linux, `%LOCALAPPDATA%/orca-supervisor/Cache`
 * on Windows (Windows convention keeps cache-like data under LOCALAPPDATA,
 * not the roaming profile). See {@link resolveConfigDir} for why Linux
 * alone honors the XDG variable, and for what `env` (default: the
 * process's real environment) governs -- the same test-isolation guard,
 * keyed on {@link CACHE_DIR_OVERRIDE_ENV} instead of
 * {@link CONFIG_DIR_OVERRIDE_ENV}.
 */
export function resolveCacheDir(platform: SupportedPlatform, paths: HomePaths, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CACHE_DIR_OVERRIDE_ENV];
  if (override !== undefined && override.length > 0) return override;
  const computed = computeCacheDir(platform, paths);
  if (isRunningUnderNodeTestRunner(env)) {
    throw new RealConfigPathBlockedError("resolveCacheDir", computed, CACHE_DIR_OVERRIDE_ENV);
  }
  return computed;
}

function computeCacheDir(platform: SupportedPlatform, paths: HomePaths): string {
  const join = joinerFor(platform);
  if (platform === "win32") {
    const base = paths.localAppDataDir && paths.localAppDataDir.length > 0 ? paths.localAppDataDir : join(paths.home, "AppData", "Local");
    return join(base, "orca-supervisor", "Cache");
  }
  if (platform === "linux") {
    const base = paths.xdgCacheHome && paths.xdgCacheHome.length > 0 ? paths.xdgCacheHome : join(paths.home, ".cache");
    return join(base, "orca-supervisor");
  }
  return join(paths.home, ".cache", "orca-supervisor");
}
