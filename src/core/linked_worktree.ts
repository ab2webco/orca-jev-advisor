// Resolves a linked git worktree's own root AND its MAIN checkout root from
// the filesystem, and composes that with destination_match.ts's pure
// matcher -- JEVADV-3 (odd/tasks/release-0.5.1.md T3).
//
// Why this exists: Orca creates a worktree NEXT TO its main checkout, not
// inside it (`~/Projects/cineco-frontend-cin-985` beside
// `~/Projects/cineco-frontend`). destination_match.ts's longest-prefix match
// is a plain path comparison, so a linked worktree's own cwd never matches
// its repository's own destination -- the client-site policies and
// consequence-ceiling override that destination carries never apply to the
// client work actually happening there, which is exactly backwards: the
// gate is loosest where it should be tightest.
//
// A linked worktree's `.git` is a FILE (never a directory), containing
// `gitdir: <main>/.git/worktrees/<name>`. That `worktrees/<name>` directory
// itself carries a `commondir` file -- the relative path back to the shared
// `.git` directory git uses for the common object store and refs. The main
// checkout root is that shared `.git` directory's parent. `commondir` is
// preferred over pattern-matching the `worktrees/<name>` suffix off gitdir,
// because it is the exact mechanism git itself uses (see a real worktree's
// `.git/worktrees/<name>/commondir`, normally `../..`) rather than a
// convention this module would otherwise have to assume holds.
//
// Filesystem reads only -- no `git` subprocess -- because this sits on
// gate-bash.ts's hot path, once per command. Every step degrades to `null`
// on anything unexpected (missing file, unreadable, wrong shape, an
// ordinary non-worktree repo): a worktree this module cannot positively
// resolve must fall back to "no match", never throw and never guess.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { matchDestination } from "./destination_match.ts";
import type { MatchableDestination } from "./destination_match.ts";

/**
 * Walks up from `cwd` looking for the nearest `.git` entry, stopping at the
 * home directory or the filesystem root -- whichever the walk reaches first
 * -- so a cwd outside any repository (or a permissions-restricted ancestor)
 * cannot turn into an unbounded walk. Returns the entry's path and whether
 * it is a directory (an ordinary checkout) or a file (a linked worktree);
 * null when nothing is found within that bound.
 */
function findGitEntry(cwd: string): { readonly path: string; readonly isDirectory: boolean } | null {
  const home = resolve(homedir());
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      const stat = statSync(candidate);
      return { path: candidate, isDirectory: stat.isDirectory() };
    } catch {
      // No `.git` here -- keep walking up, unless this was already the bound.
    }
    if (dir === home) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Parses a linked worktree's `.git` FILE for its `gitdir:` line, resolved
 * against the directory that contains the `.git` file when the path is
 * relative (git itself always writes an absolute one, but nothing here
 * requires that to stay true). Null on anything that doesn't parse as
 * exactly this shape -- never a throw.
 */
function parseGitdirFile(gitFilePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(gitFilePath, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (match === null) return null;
  const gitdir = match[1];
  if (gitdir.length === 0) return null;
  return isAbsolute(gitdir) ? gitdir : resolve(dirname(gitFilePath), gitdir);
}

/**
 * Verifies git's OWN back-pointer: `gitdir` (the per-worktree admin
 * directory a linked worktree's `.git` FILE names, `<main>/.git/worktrees/
 * <name>`) itself contains a `gitdir` file -- confusingly, the same name one
 * level up -- naming the exact `.git` FILE this walk started from. Without
 * this, ANY `.git` file whose `gitdir:` line and that gitdir's `commondir`
 * both resolve on disk is trusted, and both of those are real, valid
 * git-internal state that a byte-for-byte COPY of a real linked worktree's
 * `.git` file reproduces perfectly when placed in an unrelated directory --
 * git itself never wrote that directory into its worktree registry, but
 * nothing upstream of this check would have noticed
 * (odd/tasks/release-0.5.1.md JEVADV-35, review-3ca73b9da09b0927 R1).
 *
 * `realpathSync` on both sides of the comparison, same reasoning as this
 * module's own tests already document for the temp roots they create: a
 * symlinked path segment (macOS's `/var` -> `/private/var`, or any other)
 * must not defeat a comparison that is otherwise correct. Any failure to
 * read or resolve either side -- a missing back-pointer file, a dangling
 * target -- fails closed to "no match", same discipline as every other step
 * in this module.
 */
function verifyBackPointer(gitFilePath: string, gitdir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(gitdir, "gitdir"), "utf8").trim();
  } catch {
    return false;
  }
  if (raw.length === 0) return false;
  const pointedPath = isAbsolute(raw) ? raw : resolve(gitdir, raw);
  try {
    return realpathSync(pointedPath) === realpathSync(gitFilePath);
  } catch {
    return false;
  }
}

/**
 * Resolves the shared `.git` directory a linked worktree's own gitdir points
 * back to, preferring the `commondir` file git writes there (the exact
 * mechanism git itself uses) and falling back to stripping a trailing
 * `worktrees/<name>` segment off `gitdir` when `commondir` is missing or
 * unreadable. Either way, the candidate is only trusted once it is checked
 * against the filesystem: a `.git` file can point at a `gitdir` that itself
 * never existed (hand-edited, or a worktree whose main checkout moved), and
 * the pattern fallback has no other way to notice that -- it only reshapes a
 * string.
 */
function resolveCommonGitDir(gitdir: string): string | null {
  let candidate: string | null = null;
  try {
    const raw = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (raw.length > 0) candidate = isAbsolute(raw) ? raw : resolve(gitdir, raw);
  } catch {
    // Fall through to the pattern-based fallback below.
  }
  if (candidate === null) {
    const worktreesMatch = gitdir.match(/^(.*)[/\\]worktrees[/\\][^/\\]+[/\\]?$/);
    candidate = worktreesMatch !== null ? worktreesMatch[1] : null;
  }
  if (candidate === null) return null;
  try {
    return statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/** Both roots a linked worktree resolves to: its OWN root (where `cwd` physically lives) and the main checkout it was created from. */
interface LinkedWorktreeInfo {
  readonly worktreeRoot: string;
  readonly mainCheckoutRoot: string;
}

/**
 * Resolves both roots for the linked worktree `cwd` sits inside. Null when
 * `cwd` is not inside a linked worktree at all -- its nearest `.git` is an
 * ordinary directory, or nothing along the way could be resolved -- which is
 * also the correct answer for a plain sibling directory that merely sits
 * next to a catalogued repo without being a worktree of it.
 */
function resolveLinkedWorktreeInfo(cwd: string): LinkedWorktreeInfo | null {
  const entry = findGitEntry(cwd);
  if (entry === null || entry.isDirectory) return null;
  const gitdir = parseGitdirFile(entry.path);
  if (gitdir === null) return null;
  // Cheap and fails fast: reject a forged `.git` file before ever touching
  // `commondir` or the main checkout's path (see verifyBackPointer's own
  // comment above for exactly what this closes).
  if (!verifyBackPointer(entry.path, gitdir)) return null;
  const commonGitDir = resolveCommonGitDir(gitdir);
  if (commonGitDir === null) return null;
  return { worktreeRoot: dirname(entry.path), mainCheckoutRoot: dirname(commonGitDir) };
}

/**
 * Resolves the main checkout root for the linked worktree `cwd` sits inside.
 * Null when `cwd` is not inside a linked worktree at all -- see
 * resolveLinkedWorktreeInfo above for exactly when.
 */
export function resolveLinkedWorktreeMainCheckout(cwd: string): string | null {
  return resolveLinkedWorktreeInfo(cwd)?.mainCheckoutRoot ?? null;
}

/**
 * What matchDestinationForCwd resolved: which destination's rules apply, and
 * which physical root the command actually runs against.
 *
 * Generic over `D` so a caller passing a richer destination type (e.g.
 * gate_catalog_mirror.ts's MirroredDestination) gets `.destination` typed as
 * THAT type, not the narrower MatchableDestination -- see matchDestination's
 * own comment in destination_match.ts (JEVADV-35, review-3ca73b9da09b0927
 * R2). Before this, a call site had to widen the result with an explicit
 * type annotation (`const matched: MirroredDestination | null = ...`) that
 * only compiled because every field MirroredDestination adds over
 * MatchableDestination is optional -- true today, silently unsafe the
 * moment that stops being true.
 */
export interface MatchedDestinationForCwd<D extends MatchableDestination = MatchableDestination> {
  /** Which destination's policies and consequence-ceiling override apply. */
  readonly destination: D;
  /**
   * The physical worktree root a caller building command_shape.ts's cache
   * key should use as `treeRoot` for THIS cwd -- deliberately NOT always the
   * same as `destination.worktreePath`. For a direct/nested match those two
   * already agree (the destination's own worktreePath is an ancestor of
   * cwd). For a match resolved through the linked-worktree fallback below,
   * they must NOT be conflated: `destination` is the MAIN checkout (that is
   * the whole point -- its policies and ceiling are what should apply), but
   * the main checkout is a SIBLING of cwd's own worktree, never an ancestor
   * of it. Using the main's path as `treeRoot` there would classify an
   * ordinary in-tree target (`rm -rf dist` run inside the worktree) as
   * out-of-tree, because it does not sit under the main checkout's path --
   * exactly the misclassification the Windows path audit already fixed once
   * for a different cause (see README's cross-platform section). `treeRoot`
   * always answers "what counts as in-tree for this command", which is the
   * worktree `cwd` is actually in, regardless of whose rules govern it.
   */
  readonly treeRoot: string;
}

/**
 * `matchDestination`, with one extra attempt: when `cwd` itself matches no
 * destination, try again against its linked worktree's main checkout (see
 * resolveLinkedWorktreeInfo above). A direct/nested match on `cwd` always
 * wins and skips the filesystem walk entirely -- this only ever WIDENS what
 * matches, never narrows or overrides destination_match.ts's own
 * longest-prefix rule.
 */
export function matchDestinationForCwd<D extends MatchableDestination>(
  cwd: string,
  destinations: readonly D[],
): MatchedDestinationForCwd<D> | null {
  const direct = matchDestination(cwd, destinations);
  if (direct !== null) return { destination: direct, treeRoot: direct.worktreePath };
  const info = resolveLinkedWorktreeInfo(cwd);
  if (info === null) return null;
  const matched = matchDestination(info.mainCheckoutRoot, destinations);
  return matched === null ? null : { destination: matched, treeRoot: info.worktreeRoot };
}
