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

import { posix, win32 } from "node:path";

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
 * orca-supervisor` on macOS/Linux, `%APPDATA%/orca-supervisor` on Windows
 * (falling back to `<home>/AppData/Roaming` when `%APPDATA%` itself is
 * unset, which real Windows always sets but a stripped-down environment
 * might not).
 */
export function resolveConfigDir(platform: SupportedPlatform, paths: HomePaths): string {
  const join = joinerFor(platform);
  if (platform === "win32") {
    const base = paths.appDataDir && paths.appDataDir.length > 0 ? paths.appDataDir : join(paths.home, "AppData", "Roaming");
    return join(base, "orca-supervisor");
  }
  return join(paths.home, ".config", "orca-supervisor");
}

/**
 * Where this plugin's own cache/log files live: `~/.cache/orca-supervisor`
 * on macOS/Linux, `%LOCALAPPDATA%/orca-supervisor/Cache` on Windows
 * (Windows convention keeps cache-like data under LOCALAPPDATA, not the
 * roaming profile).
 */
export function resolveCacheDir(platform: SupportedPlatform, paths: HomePaths): string {
  const join = joinerFor(platform);
  if (platform === "win32") {
    const base = paths.localAppDataDir && paths.localAppDataDir.length > 0 ? paths.localAppDataDir : join(paths.home, "AppData", "Local");
    return join(base, "orca-supervisor", "Cache");
  }
  return join(paths.home, ".cache", "orca-supervisor");
}
