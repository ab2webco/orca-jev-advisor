// The directory a command acts in, when that is not the session's own. The
// 0.6.11 live QA (odd/qa/qa-0.6.11.md F-05, F-07): `never_write_to_main` and
// the rest of the gate read the session's repository and branch, so
// `cd demo-app && git commit` from a feature-branch session landed commits on
// demo-app's main, and the same commit into a feature branch from a main
// session was refused. Each writing part of the command is located
// (command_locations.ts: cd/pushd, subshells, bash -c, eval, substitutions,
// git -C/--git-dir/--work-tree) and, when a part names files (rm, mv/cp,
// a redirect), by where those files are. Pure: the repository lookup is the
// caller's.
import { dirname } from "node:path";
import { gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { resolveCommandTargetDirs } from "./command_targets.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";

interface ActingPlace {
  readonly path: string | null;
  /** A file the command writes, rather than the directory a part runs in. */
  readonly isFile: boolean;
}

function actingPlaces(command: string, cwd: string, home: string): readonly ActingPlace[] {
  const places: ActingPlace[] = [];
  for (const { outer, dir } of locateCommandSegments(command, cwd, home)) {
    if (isObviouslySafeCommand(outer)) continue;
    const base = gitInvocation(outer, dir, home)?.dir ?? dir;
    if (base === null) {
      places.push({ path: null, isFile: false });
      continue;
    }
    const files = resolveCommandTargetDirs(outer, base);
    if (files.length === 0) places.push({ path: base, isFile: false });
    else for (const file of files) places.push({ path: file, isFile: true });
  }
  return places;
}

/**
 * Where `command`, run from `cwd`, acts: the repository root (or, outside
 * any repository, the directory) every writing part of it lands in, when
 * that is one place and not the session's own; `cwd` itself otherwise --
 * when it acts in the session, in several places, only reads, or somewhere
 * that cannot be known without running it.
 */
export function resolveActingDirectory(command: string, cwd: string, home: string, repoRootOf: (dir: string) => string | null): string {
  const places = actingPlaces(command, cwd, home);
  if (places.length === 0) return cwd;
  const keys = new Set<string>();
  for (const { path, isFile } of places) {
    if (path === null) return cwd;
    keys.add(repoRootOf(path) ?? (isFile ? dirname(path) : path));
  }
  if (keys.size !== 1) return cwd;
  const [only] = keys;
  if (only === undefined || only === (repoRootOf(cwd) ?? cwd)) return cwd;
  return only;
}
