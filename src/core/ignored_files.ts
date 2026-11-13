// odd/tasks/gate-ignored-files-not-main.md T2: which files a command writes
// that git ignores or excludes (.gitignore, .git/info/exclude, the global
// excludes file). Such a file is in no commit, so it cannot reach main
// through a commit or a push, and writing it is not writing on the branch.
//
// The answer comes from git and the filesystem, never from the command's
// text. A file counts only when all of these hold:
//   - the path the write lands on, every symlink resolved, is known (a
//     dangling link writes its target, so it does not count);
//   - it is neither the repository root nor inside a `.git` directory (a
//     ref or the ignore rules themselves);
//   - `git check-ignore` reports it ignored;
//   - `git ls-files` finds no tracked file at it or under it (a tracked file
//     can sit in an ignored directory, `git add -f`).
// A write that lands outside any repository counts too: it has no branch.
// Anything git cannot answer does not count, so the policy stays.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

/** Runs git in `cwd` with `input` on stdin; its stdout, or null when it fails or exits non-zero. */
export type GitWithInput = (args: readonly string[], cwd: string, input: string) => string | null;

/** The path a write to `path` (absolute) lands on, every symlink resolved; null when a link on the way cannot be resolved. */
export function landingPath(path: string): string | null {
  const tail: string[] = [];
  let at = path;
  for (;;) {
    let exists: boolean;
    try {
      lstatSync(at);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        return join(realpathSync.native(at), ...tail.reverse());
      } catch {
        return null;
      }
    }
    const parent = dirname(at);
    if (parent === at) return null;
    tail.push(basename(at));
    at = parent;
  }
}

/** Whether `inner` is `outer` itself or inside it. */
function within(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * The subset of `paths` (absolute) whose writes land on a file git ignores
 * with nothing tracked at or under it, or outside any repository.
 * `repoRootOf` resolves a path's checkout root (null outside any).
 */
export function verifiedIgnoredFiles(paths: readonly string[], repoRootOf: (path: string) => string | null, git: GitWithInput): ReadonlySet<string> {
  const verified = new Set<string>();
  const byRoot = new Map<string, { path: string; landing: string }[]>();
  for (const path of paths) {
    const landing = landingPath(path);
    if (landing === null || /[\n\0]/.test(landing)) continue;
    const root = repoRootOf(landing);
    if (root === null) {
      verified.add(path);
      continue;
    }
    const rel = relative(root, landing);
    if (rel.length === 0 || rel.startsWith("..") || rel.split(sep).includes(".git")) continue;
    byRoot.set(root, [...(byRoot.get(root) ?? []), { path, landing }]);
  }
  for (const [root, entries] of byRoot) {
    const out = git(["check-ignore", "-z", "--stdin"], root, entries.map((entry) => entry.landing).join("\0") + "\0");
    if (out === null) continue;
    const ignored = new Set(out.split("\0").filter((line) => line.length > 0));
    const candidates = entries.filter((entry) => ignored.has(entry.landing));
    if (candidates.length === 0) continue;
    const rels = candidates.map((entry) => relative(root, entry.landing).split(sep).join("/"));
    // Case-insensitive: on a case-insensitive filesystem `ODD/x` writes `odd/x`.
    const tracked = git(["ls-files", "-z", "--", ...rels.map((rel) => `:(literal,icase)${rel}`)], root, "");
    if (tracked === null) continue;
    const trackedFiles = tracked.split("\0").filter((line) => line.length > 0).map((line) => line.toLowerCase());
    candidates.forEach((entry, at) => {
      const rel = (rels[at] ?? "").toLowerCase();
      if (!trackedFiles.some((file) => file === rel || file.startsWith(`${rel}/`))) verified.add(entry.path);
    });
  }
  return verified;
}
