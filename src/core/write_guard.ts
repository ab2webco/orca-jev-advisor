// A structural backstop against a test reaching the developer's real
// ~/.claude, ~/.config/orca-supervisor, or Orca's own claude-accounts/*/auth
// -- the exact files a `node --test` run has already reached four times
// (twice corrupting policies.json/catalog.json, once wiping every gate hook
// entry out of settings.json in all five real Claude config roots on the
// machine, silently, with zero error output).
//
// Every one of those incidents shares the same shape: a sidecar script
// (install-claude-integration.mjs, write-secret-mirror.mjs) resolves its
// write target from `os.homedir()`/`process.env` at its own module scope,
// and the ONLY thing standing between that resolution and a real write was
// whichever test happened to spawn it remembering to override HOME first.
// That is programmer discipline, not a guarantee, and discipline has
// already failed four times.
//
// This module is that guarantee instead: every atomic write in those two
// sidecars calls `assertSafeWriteTarget` with its resolved destination as
// the very first thing it does, before `mkdir` or `writeFile` ever runs.
// Outside node's test runner this is a pure no-op (production installs are
// meant to write to the real machine -- that is the whole point of the
// installer). Inside it, a destination that resolves outside the OS temp
// directory throws immediately, naming the exact path, instead of quietly
// succeeding against a real file.
//
// Detection needs no cooperation from any test file: node's own test
// runner sets `NODE_TEST_CONTEXT` on every isolated test-file process it
// spawns (confirmed against the installed Node: `--test-isolation=process`
// is the default, and each spawned test file carries
// `NODE_TEST_CONTEXT=child-v8`). `child_process.spawn`'s inherited/copied
// `env` then carries that variable into every sidecar such a test-file
// process spawns in turn -- including through main.mjs's `sidecarEnv`,
// which forwards `process.env` verbatim. So the guard fires for a sidecar
// spawned directly by a test AND for one spawned two levels down through
// main.mjs, which is exactly how the settings.json wipe happened: a test
// exercising main.mjs's Claude-integration path, with no HOME override of
// its own, reached the real installer through a real `process.env`.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The env var node:test sets on every isolated test-file process it spawns. Not documented as public API, but stable across the supported Node range this project targets, and the only signal available that needs no cooperation from callers. */
const NODE_TEST_CONTEXT_ENV = "NODE_TEST_CONTEXT";

/**
 * True exactly when this process is one node:test spawned, directly or as a
 * grandchild through an inherited environment -- see the module doc above.
 */
export function isRunningUnderNodeTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NODE_TEST_CONTEXT_ENV] !== undefined;
}

/**
 * The OS temp directory, both as node:os reports it and (when it differs)
 * with its own symlinks resolved -- e.g. macOS's `os.tmpdir()` normally
 * already returns a `/var/folders/...` path with no symlink in it, but
 * historically-real `/tmp` is itself a symlink to `/private/tmp` on macOS,
 * and this project runs on whatever a developer's machine actually has.
 * Both forms are accepted as "safe": a target is fine if it lands under
 * either one.
 */
function resolvedTempRoots(): readonly string[] {
  const lexical = resolve(tmpdir());
  const roots = [lexical];
  try {
    const real = realpathSync(lexical);
    if (real !== lexical) roots.push(real);
  } catch {
    // tmpdir() not present/stat-able is not this guard's problem to solve.
  }
  return roots;
}

/**
 * Resolves the target path for comparison the same way the filesystem
 * ultimately will: if its parent directory already exists (the normal case
 * -- `mkdtempSync` already created it), symlinks in THAT are resolved too,
 * so a target under a real temp dir compares correctly against
 * {@link resolvedTempRoots}'s resolved form even when `os.tmpdir()` and its
 * realpath differ. A target whose parent does not exist yet (a write about
 * to create it) is compared lexically instead -- there is nothing to
 * resolve, and a purely hypothetical temp-shaped path still matches the
 * lexical root.
 */
function resolveForComparison(targetPath: string): string {
  const resolved = resolve(targetPath);
  const dir = dirname(resolved);
  try {
    return join(realpathSync(dir), basename(resolved));
  } catch {
    return resolved;
  }
}

function isWithinAnyRoot(roots: readonly string[], target: string): boolean {
  return roots.some((root) => {
    if (target === root) return true;
    const rel = relative(root, target);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** Thrown by {@link assertSafeWriteTarget}. A distinct class (rather than a plain Error) so a test asserting refusal can confirm it was THIS guard that refused, not an unrelated ENOENT/EACCES. */
export class RealConfigWriteBlockedError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, safeRoot: string) {
    super(
      `orca-supervisor write guard: refusing to write "${targetPath}" while running under node's test runner -- it resolves outside the OS temp directory (${safeRoot}). ` +
        "A test must isolate its HOME/config root (e.g. mkdtempSync(join(tmpdir(), ...))) before reaching this code path; production installs are unaffected."
    );
    this.name = "RealConfigWriteBlockedError";
    this.targetPath = targetPath;
  }
}

/**
 * Call this with the exact destination a write/rename/rm is about to touch,
 * before any filesystem call happens. A no-op outside the test runner, and
 * a no-op for any target already inside the OS temp directory. Everywhere
 * else, under the test runner, it throws {@link RealConfigWriteBlockedError}
 * instead of letting the caller proceed.
 *
 * `env` is a parameter (not baked in) purely so this function's own tests
 * can exercise both branches deterministically; every real caller in this
 * repository uses the default, i.e. the process's actual environment.
 */
export function assertSafeWriteTarget(targetPath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isRunningUnderNodeTestRunner(env)) return;
  const roots = resolvedTempRoots();
  const resolvedTarget = resolveForComparison(targetPath);
  if (isWithinAnyRoot(roots, resolvedTarget)) return;
  throw new RealConfigWriteBlockedError(resolvedTarget, roots[0]);
}
