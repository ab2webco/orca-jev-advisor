// Matches a cwd against a catalog of destinations, in the cwd -> destination
// direction (the reverse of src/projection.ts's destination -> live worktree
// matching, which this module does not touch and has no dependency on).
//
// Plain string equality on worktreePath is wrong here: real worktrees for a
// single destination are siblings on disk, not the destination's own path,
// e.g. `orca-oss` has real worktrees like `orca-oss-385` and
// `orca-oss-parked-input`. Equality alone matches roughly 1 out of every 62
// real sessions for that destination. This module instead does longest
// path-segment prefix matching, enforcing a `/` segment boundary so that
// `/Projects/orca-oss-385` never matches a destination whose worktreePath is
// `/Projects/orca-oss` (it does not start with `/Projects/orca-oss/`).
//
// Pure and dependency-free by design: no filesystem, no node builtins, so it
// can be unit-tested without touching the real catalog loader in catalog.ts.

export interface MatchableDestination {
  readonly id: string;
  readonly worktreePath: string;
}

/**
 * Converts backslashes to forward slashes and strips a trailing slash, so
 * POSIX and Windows-style paths (and mixes of the two) compare identically.
 */
function normalizePath(path: string): string {
  const withForwardSlashes = path.replace(/\\/g, "/");
  if (withForwardSlashes.length > 1 && withForwardSlashes.endsWith("/")) {
    return withForwardSlashes.slice(0, -1);
  }
  return withForwardSlashes;
}

/**
 * Finds the destination whose worktreePath is the longest normalized
 * path-segment prefix of cwd (or equals it exactly). Returns null when no
 * destination's worktreePath is a prefix of, or equal to, cwd.
 *
 * Generic over the destination element type, so a caller passing a richer
 * type than the bare MatchableDestination shape (e.g. gate_catalog_mirror.ts's
 * MirroredDestination, which adds an optional `autonomy` override) gets that
 * SAME type back, not the narrower MatchableDestination erased -- see
 * matchDestinationForCwd below, whose own MatchedDestinationForCwd is
 * generic for exactly this reason (odd/tasks/release-0.5.1.md JEVADV-35,
 * review-3ca73b9da09b0927 R2).
 */
export function matchDestination<D extends MatchableDestination>(
  cwd: string,
  destinations: readonly D[],
): D | null {
  const normalizedCwd = normalizePath(cwd);

  let best: D | null = null;
  let bestWorktreePathLength = -1;

  for (const destination of destinations) {
    const normalizedWorktreePath = normalizePath(destination.worktreePath);
    const isExactMatch = normalizedCwd === normalizedWorktreePath;
    const isNestedMatch = normalizedCwd.startsWith(`${normalizedWorktreePath}/`);

    if (!isExactMatch && !isNestedMatch) {
      continue;
    }

    if (normalizedWorktreePath.length > bestWorktreePathLength) {
      best = destination;
      bestWorktreePathLength = normalizedWorktreePath.length;
    }
  }

  return best;
}
