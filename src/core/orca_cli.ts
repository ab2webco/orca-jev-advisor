// Resolves which "orca" executable to invoke from inside this plugin's own
// worker, without hardcoding anyone's install location.
//
// Why this exists: Orca forks the plugin worker with an allowlisted
// environment (measured: 19 vars) that DOES include PATH, but that PATH is
// inherited from the Electron *main* process, not a login shell. A macOS
// app launched from the Dock or Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`
// -- verified live: `command -v orca` finds nothing there -- so it never
// sees `/usr/local/bin`, where a Homebrew (or otherwise manually placed)
// `orca` actually lives. `execFile('orca', ...)` under that PATH fails with
// ENOENT before it ever runs anything.
//
// The fix is not a hardcoded path (that would only work on the machine it
// was measured on): the worker runs inside the Orca installation, so its
// own `process.execPath` locates the CLI Orca bundles right alongside
// itself, one platform-specific hop away -- see resolveBundledOrcaCliPath.
// A bare "orca" on PATH is kept as a fallback for the case that actually
// works today (a shell-launched Orca, or a machine where /usr/local/bin is
// on the inherited PATH after all).
//
// Pure and platform-INDEPENDENT-of-the-running-OS, same convention as
// paths.ts: every function here takes the target platform (and execPath) as
// a plain argument, using node:path's own `win32`/`posix` namespaces so it
// is testable for all three platforms from one machine.

import { posix, win32 } from "node:path";
import { isRecord } from "../guards.ts";
import type { SupportedPlatform } from "./paths.ts";

function pathModuleFor(platform: SupportedPlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** The bundled CLI's own filename, per platform's executable-extension convention. */
export function cliBinaryName(platform: SupportedPlatform): string {
  return platform === "win32" ? "orca.exe" : "orca";
}

/**
 * Where the bundled Orca CLI should live relative to the worker's own
 * `process.execPath`.
 *
 * macOS: Electron's own convention places the app's executable at
 * `<App>.app/Contents/MacOS/<Executable>`. The bundled CLI ships as a plain
 * resource file (not inside the app's own asar) at
 * `Contents/Resources/bin/orca` -- one hop up from `MacOS`, then into
 * `Resources`.
 *
 * Windows and Linux: electron-builder puts a `resources/` directory as a
 * sibling of the main executable, not nested under a macOS-style bundle, so
 * the bundled CLI is expected at `resources/bin/<name>` next to it.
 */
export function resolveBundledOrcaCliPath(execPath: string, platform: SupportedPlatform): string {
  const { dirname, join } = pathModuleFor(platform);
  const execDir = dirname(execPath);
  if (platform === "darwin") {
    const contentsDir = dirname(execDir);
    return join(contentsDir, "Resources", "bin", "orca");
  }
  return join(execDir, "resources", "bin", cliBinaryName(platform));
}

/**
 * Every command worth trying to run `orca`, most-specific first: the
 * bundled CLI at its expected location, then bare name(s) relying on the
 * worker's own PATH (a last resort -- see this module's own header for why
 * that PATH is often not what a real shell would have).
 *
 * Windows gets `.exe` then `.cmd` before the extensionless name: `execFile`
 * does not apply PATHEXT resolution to a bare command the way a real shell
 * does, so a bare "orca" would silently never match an `orca.cmd` shim even
 * when it is right there on PATH.
 */
export function resolveOrcaCliCandidates(execPath: string, platform: SupportedPlatform): readonly string[] {
  const bundled = resolveBundledOrcaCliPath(execPath, platform);
  if (platform === "win32") {
    return [bundled, "orca.exe", "orca.cmd", "orca"];
  }
  return [bundled, "orca"];
}

/** True for the one error shape that means "there is nothing at this path/on this PATH to run" -- as opposed to a command that was found and then failed on its own. */
export function isMissingCommandError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
