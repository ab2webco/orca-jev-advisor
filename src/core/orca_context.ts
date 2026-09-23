// Resolves the Orca worktree/project/branch a session is running in --
// the whole reason this mod is written instead of installing
// jev-skill-suggestion as is (see the feature document's "Why our own, not
// a third party's"): a third-party mod sees one session; this one can see which
// worktree, project and branch it is in, because Orca already tracks that.
//
// `orca worktree current --json` is the source, run as a child process.
// Its real shape was read from this machine, both paths:
//
//   success  { id, ok: true, result: { worktree: {
//                path, projectId, branch, displayName, ... } } }
//   failure  { id, ok: false, error: { code, message } }
//
// (a plain `git`-tracked directory that Orca does not manage answers
// `ok: false` with `error.code: "selector_not_found"`, not a thrown error
// or a non-zero-shaped body -- both branches are read here, and neither is
// guessed at: this is what the real binary printed.)
//
// No I/O in this file except through the injected `run`: the parsing is
// pure and unit-testable on canned output, and the resolver's only
// dependency is a function shaped like `$.process.run`.

import { isRecord, isString } from "../guards.ts";

export interface OrcaContext {
  readonly source: "orca" | "cwd";
  readonly worktree: string | null;
  readonly proyecto: string | null;
  readonly rama: string | null;
}

interface OrcaWorktree {
  readonly path: string;
  readonly projectId: string | null;
  readonly branch: string | null;
  readonly displayName: string | null;
}

function isOrcaWorktree(value: unknown): value is OrcaWorktree {
  if (!isRecord(value)) return false;
  if (!isString(value.path)) return false;
  const projectId = value.projectId;
  const branch = value.branch;
  const displayName = value.displayName;
  return (projectId === null || projectId === undefined || isString(projectId)) && (branch === null || branch === undefined || isString(branch)) && (displayName === null || displayName === undefined || isString(displayName));
}

/** Reads `orca worktree current --json`'s stdout. Null on anything that is not the success shape. */
export function parseOrcaWorktreeCurrent(stdout: string): OrcaWorktree | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) return null;
  const worktree = parsed.result.worktree;
  return isOrcaWorktree(worktree) ? worktree : null;
}

/** `refs/heads/main` -> `main`; anything else (already short, or empty) passes through. */
function shortBranch(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

/** The last non-empty path segment, for a filesystem-path fallback project name. */
function lastPathSegment(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Shaped like `$.process.run`, narrowed to what this needs. */
export type ProcessRun = (argv: readonly string[]) => Promise<RunResult>;

/**
 * Resolves the Orca context: `orca worktree current --json` when it can be
 * run and answers its success shape, otherwise the session's own working
 * directory as the worktree with no project or branch known. Never throws:
 * a missing binary, a non-Orca-managed directory, a timeout or malformed
 * output all fall through to the `cwd` source, which is always available.
 */
export async function resolveOrcaContext(run: ProcessRun, cwd: string): Promise<OrcaContext> {
  try {
    const result = await run(["orca", "worktree", "current", "--json"]);
    const worktree = parseOrcaWorktreeCurrent(result.stdout);
    if (worktree !== null) {
      return {
        source: "orca",
        worktree: worktree.path,
        proyecto: worktree.projectId ?? null,
        rama: worktree.branch !== null && worktree.branch.length > 0 ? shortBranch(worktree.branch) : (worktree.displayName ?? null),
      };
    }
  } catch {
    // Fails open to the cwd-only fallback below -- no binary, no timeout
    // budget of its own here (the caller's is the mod's, spent on Jev).
  }
  return { source: "cwd", worktree: cwd, proyecto: lastPathSegment(cwd), rama: null };
}
