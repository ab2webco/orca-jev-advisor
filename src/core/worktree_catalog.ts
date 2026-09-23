// Builds the destination catalog from the worktrees Orca already knows
// about, so a fresh install has one without anybody having to type it — and
// without the plugin shipping somebody else's repositories.
//
// The previous seed was generated from the author's own machine: it named
// real clients and pointed at `/Users/<author>/Projects/...`, which matches
// nothing on anyone else's disk. A catalog is inherently local, so it has to
// be derived per install, never shipped.
//
// Pure on purpose: it takes the parsed `orca worktree ps --json` payload and
// returns destinations. Running the CLI belongs to the caller.

import { isArrayOf, isRecord, isString } from "../guards.ts";
import type { AutonomyConfig, CatalogDestination } from "./store.ts";

/** The fields this module reads from `orca worktree ps --json`. The payload carries far more; the rest is ignored on purpose. */
export interface OrcaWorktree {
  readonly repo: string;
  readonly path: string;
  readonly isArchived?: boolean;
}

function isOrcaWorktree(value: unknown): value is OrcaWorktree {
  return isRecord(value) && isString(value.repo) && isString(value.path);
}

/**
 * Reads the worktree list out of the CLI's envelope: the real shape is
 * `{ id, ok, result: { worktrees: [...] } }`. Anything else yields an empty
 * list rather than throwing — a catalog that cannot be derived is a plugin
 * with no destinations, which still works, not a plugin that fails to start.
 */
export function parseWorktreeList(payload: unknown): readonly OrcaWorktree[] {
  if (!isRecord(payload)) return [];
  const result = payload.result;
  if (!isRecord(result)) return [];
  const worktrees = result.worktrees;
  return isArrayOf(worktrees, isOrcaWorktree) ? worktrees : [];
}

/** True when `candidate` sits inside `ancestor`, comparing whole path segments so `/a/repo-2` is NOT inside `/a/repo`. */
function isInside(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return false;
  const separator = ancestor.includes("\\") || candidate.includes("\\") ? "\\" : "/";
  const prefix = ancestor.endsWith(separator) ? ancestor : `${ancestor}${separator}`;
  return candidate.startsWith(prefix);
}

function trimTrailingSeparator(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, "") : path;
}

/**
 * The smallest set of paths that still covers every worktree.
 *
 * Matching a command's cwd to a destination is done by longest path prefix
 * (see destination_match.ts), so a worktree living inside another one is
 * already covered and would only add a duplicate row to the panel. A
 * SIBLING is not covered: measured on a real machine, `team-helpdesk` and
 * `team-helpdesk-hotfix` are different directories that share a name
 * prefix but not a path, and collapsing them would silently judge one under
 * the other's thresholds.
 */
export function coveringPaths(paths: readonly string[]): readonly string[] {
  const unique = [...new Set(paths.map(trimTrailingSeparator))].filter((p) => p.length > 0);
  return unique.filter((candidate) => !unique.some((other) => isInside(candidate, other)));
}

function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Lowercase, punctuation-free, stable across runs -- it keys the settings the developer edits, so it must not drift. */
function toId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 48) : "worktree";
}

export interface DeriveOptions {
  /**
   * Applied to every derived destination.
   *
   * Deliberately one value for all of them: nothing in the worktree list
   * says whether a repository belongs to a client, carries real users, or is
   * a scratch experiment, and guessing would put a confident number on an
   * invention. A single cautious default that the developer then loosens
   * where they know better is honest; an inferred one is not.
   */
  readonly autonomy: AutonomyConfig;
}

export const DEFAULT_DERIVED_AUTONOMY: AutonomyConfig = {
  actThreshold: 0.85,
  confirmThreshold: 0.65,
  maxAutoDelicateness: 1,
};

/**
 * Turns Orca's worktree list into destinations.
 *
 * Archived worktrees are skipped, duplicate and nested paths collapse, and
 * a repository that owns several separate roots gets one destination per
 * root, disambiguated by directory name so two rows are never called the
 * same thing.
 */
export function deriveDestinations(
  worktrees: readonly OrcaWorktree[],
  options: DeriveOptions = { autonomy: DEFAULT_DERIVED_AUTONOMY },
): readonly CatalogDestination[] {
  const live = worktrees.filter((w) => w.isArchived !== true && w.path.trim().length > 0);

  const pathsByRepo = new Map<string, string[]>();
  for (const w of live) {
    const list = pathsByRepo.get(w.repo) ?? [];
    list.push(w.path);
    pathsByRepo.set(w.repo, list);
  }

  const destinations: CatalogDestination[] = [];
  const usedIds = new Set<string>();

  for (const [repo, paths] of pathsByRepo) {
    const roots = coveringPaths(paths);
    for (const path of roots) {
      // A directory is usually named after its repository, so joining the
      // two blindly produces `team-helpdesk-team-helpdesk-hero197`. When
      // the directory already carries the repository's name, it is the more
      // specific of the two and stands alone.
      const repoId = toId(repo);
      const dirId = toId(lastSegment(path));
      const base = roots.length === 1 ? repoId : dirId.startsWith(repoId) ? dirId : `${repoId}-${dirId}`;
      let id = base;
      let n = 2;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id);
      destinations.push({
        id,
        label: roots.length === 1 || lastSegment(path) === repo ? repo : `${repo} (${lastSegment(path)})`,
        kind: "project",
        worktreePath: path,
        autonomy: options.autonomy,
      });
    }
  }

  return destinations.sort((a, b) => a.id.localeCompare(b.id));
}
