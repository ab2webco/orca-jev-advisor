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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { IDENTITY_NAMES, type JevNames } from "./jev_pseudonyms.ts";

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

// T3: when never_write_to_main is still asked (the command runs a program
// that may write anything, or also writes a tracked file), Jev reads which of
// the paths the command names git verified as ignored. The paths come from
// the text; that they are ignored comes from git. Jev's violation question
// counts a file as ignored only when this sentence lists it.

/** A path-like word: optional `~/`, `./`, `../` or `/`, then name parts joined by `/`. It never starts inside another word. */
const PATH_LIKE = /(?<![\w.\/~$@:+-])(?:~\/|\.\.?\/|\/)?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)*\/?/g;
/** A file extension that starts with a letter (`.md`, `.ts`), not a version (`1.2.3`). */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const MAX_MENTIONS = 32;

/** The path-like words in `command`, heredoc bodies included, in order, once each, at most 32: a word with a `/`, or a name with an extension. Options, URLs, `$VAR` paths and package specs are left out. */
export function pathMentions(command: string): readonly string[] {
  const mentions: string[] = [];
  for (const match of command.matchAll(PATH_LIKE)) {
    const word = match[0];
    const next = command[match.index + word.length] ?? "";
    // `name@1.2` and `https://...` are not paths; a word glued to `$`, `:` or `=` is part of something else.
    if (word.includes("@") || next === ":" || (!word.includes("/") && !EXTENSION.test(word))) continue;
    if (!mentions.includes(word)) mentions.push(word);
    if (mentions.length === MAX_MENTIONS) break;
  }
  return mentions;
}

/** The context sentence naming the paths git verified as ignored, as written in the command; null for none. `names` swaps any absolute path for Jev's copy. */
export function buildIgnoredPathsSentence(paths: readonly string[], names: JevNames = IDENTITY_NAMES): string | null {
  if (paths.length === 0) return null;
  return names.redactText(`Checked with git, not read from the command: git ignores these paths the command names (${paths.join(", ")}), so they are in no commit and on no branch. No other path is known to be ignored.`);
}

/** A pathMentions word as an absolute path, read from `dir` (`~/` from `home`). */
export function mentionPath(word: string, dir: string, home: string): string {
  if (word.startsWith("~/")) return join(home, word.slice(2));
  return isAbsolute(word) ? resolve(word) : resolve(dir, word);
}
