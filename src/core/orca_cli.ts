// ---------------------------------------------------------------------------
// Invoking the `orca` CLI on the three platforms this plugin runs on.
//
// Three places shell out to `orca` (catalog derivation, board project
// resolution, the doctor's reachability probe) and all three did it the same
// way: `execFile('orca', args)`. That is correct on macOS and Linux, where the
// CLI on PATH is an executable file with a shebang and `execvp` runs it.
//
// It cannot work on Windows. There, a CLI installed on PATH is a `.cmd` (or
// `.ps1`, or `.bat`) shim, and `execFile` hands the name to CreateProcess,
// which runs `.exe` images only and resolves nothing through PATHEXT. The call
// fails with ENOENT -- and since all three call sites catch and fall back to
// an empty result, a Windows install showed an empty catalog, a board with no
// project names and a doctor reporting the CLI unreachable, with the actual
// cause visible only in the plugin log.
//
// Running the command through the platform's shell is what makes PATHEXT
// apply. It is enabled on Windows ONLY: elsewhere a shell adds a process, adds
// quoting rules, and buys nothing, because the shebang already works.
//
// On the safety of `shell: true` here: with a shell, arguments are re-parsed
// by cmd.exe, whose quoting cannot be made reliably injection-proof for
// attacker-controlled input. That is acceptable in this one place, and only
// because every argument this plugin ever passes is a compile-time literal --
// see ORCA_CLI_ARGUMENTS and the test that holds it to that. Nothing derived
// from a repository, a branch name, a panel field or a Jev response is ever
// passed to the CLI. If that ever changes, this helper is the wrong tool and
// the call must move to `spawn` with an explicit interpreter.
// ---------------------------------------------------------------------------

import type { SupportedPlatform } from "./paths.ts";

/**
 * Every argument list this plugin passes to the CLI.
 *
 * Kept here as data so the "all arguments are literals" claim the shell
 * decision rests on is checkable by a test rather than by reading three call
 * sites and trusting them to stay that way.
 */
export const ORCA_CLI_ARGUMENTS = {
  worktreePs: ["worktree", "ps", "--json"],
  worktreeList: ["worktree", "list", "--json"],
  status: ["status", "--json"],
} as const;

/** How long any one CLI call may take before it is abandoned. */
export const ORCA_CLI_TIMEOUT_MS = 5000;

/**
 * `execFile` options for invoking the CLI on `platform`.
 *
 * `maxBuffer` is raised well above Node's 1MB default: the output is one JSON
 * document describing every worktree Orca knows, which on a working machine
 * with 65 of them is already ~130KB. The default leaves far less headroom than
 * it appears to, and exceeding it kills the child and surfaces as the same
 * empty result every other failure here produces.
 */
export function orcaCliOptions(platform: SupportedPlatform): {
  timeout: number;
  maxBuffer: number;
  shell: boolean;
} {
  return {
    timeout: ORCA_CLI_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // See the module note: PATHEXT resolution for `.cmd` shims, Windows only.
    shell: platform === "win32",
  };
}
