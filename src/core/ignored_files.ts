// odd/tasks/gate-ignored-files-not-main.md: whether every target of a
// trivially safe write (trivial_write.ts) is a file git ignores or excludes
// (.gitignore, .git/info/exclude, the global excludes file). Such a file is
// in no commit, so writing it cannot reach main through a commit or a push.
//
// The answer comes from git and the filesystem, never from the command's
// text, and anything that cannot be answered fails closed (null: the policy
// is asked, and Jev is told nothing). A command passes only when:
//   - its directory resolves, through git, to one repository root that is
//     not a submodule;
//   - each target, read from that directory, lies inside the root, with no
//     `..` and no `.git` component, and is all ASCII (APFS treats `ñ`/`Ñ`
//     and NFC/NFD spellings as one file; git's icase folds ASCII only);
//   - no existing component from the root to the target is a symlink, and
//     no directory on the way holds a `.git` (a submodule or a nested
//     repository: another repository's main);
//   - an existing target is a regular file with one link (a hard link to a
//     tracked file writes it), or for a directory target a real directory;
//   - no target is an ignore source: a `.gitignore`, anything in `.git`,
//     the file .git/info/exclude resolves to, the configured
//     core.excludesFile or the default global excludes file (emptying one
//     would make a path git now ignores trackable);
//   - `git check-ignore` reports it ignored and `git ls-files` finds nothing
//     tracked at it or under it (a tracked file can sit in an ignored
//     directory, `git add -f`).
// Every git call runs with gitSubprocessEnv: the hook's GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE and GIT_CONFIG* must not choose the
// repository, the index or the ignore rules git answers from.
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { IDENTITY_NAMES, type JevNames } from "./jev_pseudonyms.ts";
import type { TrivialTarget } from "./trivial_write.ts";

/** What git printed and how it exited. */
export interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

/** Runs git in `cwd` with `input` on stdin; null when it could not run, was killed or ran past its timeout. */
export type GitRunner = (args: readonly string[], cwd: string, input: string) => GitResult | null;

/** The git verdict for a command's targets. `ignored` lists, repository-relative and in order, the targets git verified as ignored with nothing tracked there. */
export interface IgnoredTargets {
  readonly allIgnored: boolean;
  readonly ignored: readonly string[];
}

/** Where the default global excludes file is read from. */
export interface ExcludesHome {
  readonly home: string;
  readonly xdgConfigHome: string | undefined;
}

/** Variables that point git at another repository, index, object store or config. */
const MOVES_GIT = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"]);

/** The environment for every git call here: `env` without MOVES_GIT nor any GIT_CONFIG* variable, and with optional locks off (these calls only read). */
export function gitSubprocessEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || MOVES_GIT.has(name) || name.startsWith("GIT_CONFIG")) continue;
    clean[name] = value;
  }
  clean["GIT_OPTIONAL_LOCKS"] = "0";
  return clean;
}

/** `git` through `run`, never a throw: a runner that throws counts as a failed call. */
function callGit(run: GitRunner, args: readonly string[], cwd: string, input = ""): GitResult | null {
  try {
    return run(args, cwd, input);
  } catch {
    return null;
  }
}

/** lstat, or null when nothing is there; undefined when it cannot be read (fail closed). */
function lstatOrNull(path: string): Stats | null | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

/** `path` with the symlinks of its existing part resolved, lower-cased for a case-insensitive comparison. */
function canonical(path: string): string {
  const tail: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...tail.reverse()).toLowerCase();
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path).toLowerCase();
      tail.push(basename(at));
      at = parent;
    }
  }
}

/** The repository root `dir` sits in and its info/exclude file, through git; null outside one, inside a submodule, or when git cannot say. */
function repositoryRoot(dir: string, git: GitRunner): { readonly root: string; readonly infoExclude: string } | null {
  const out = callGit(git, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-path", "info/exclude", "--show-superproject-working-tree"], dir);
  if (out === null || out.status !== 0) return null;
  const lines = out.stdout.split("\n").filter((line) => line.length > 0);
  // A third line is the superproject: `dir` is in a submodule.
  if (lines.length !== 2) return null;
  const [root, infoExclude] = lines as [string, string];
  if (!isAbsolute(root) || !isAbsolute(infoExclude) || /\0/.test(root) || /\0/.test(infoExclude)) return null;
  return { root, infoExclude };
}

/** The ignore files git reads beyond the repository: core.excludesFile when set, and the default global excludes file either way. Null when git cannot say. */
function excludesFiles(root: string, home: ExcludesHome, git: GitRunner): readonly string[] | null {
  const out = callGit(git, ["config", "--path", "--default", "", "--get", "core.excludesFile"], root);
  if (out === null || out.status !== 0) return null;
  const configured = out.stdout.replace(/\n$/, "");
  if (configured.length > 0 && (!isAbsolute(configured) || /[\0\n]/.test(configured))) return null;
  const xdg = home.xdgConfigHome !== undefined && home.xdgConfigHome.length > 0 ? [join(home.xdgConfigHome, "git", "ignore")] : [];
  return [...(configured.length > 0 ? [configured] : []), ...xdg, join(home.home, ".config", "git", "ignore")];
}

/**
 * The repository-relative paths `target` writes, after the filesystem
 * checks above; null when one fails. A `dirs` target adds each missing
 * directory it creates.
 */
function checkedPaths(target: TrivialTarget, cwd: string, root: string): readonly string[] | null {
  if (target.word.split("/").includes("..")) return null;
  const path = isAbsolute(target.word) ? resolve(target.word) : resolve(cwd, target.word);
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  // APFS folds case and Unicode normalization; git's icase and core.ignorecase fold ASCII only, so `odd/ñ.md` may be a tracked `odd/Ñ.md`.
  if (/[^\x00-\x7f]/.test(rel)) return null;
  const parts = rel.split(sep);
  if (parts.some((part) => part.toLowerCase() === ".git") || (parts.at(-1) ?? "").toLowerCase() === ".gitignore") return null;
  const created: string[] = [];
  let at = root;
  for (let index = 0; index < parts.length; index++) {
    at = join(at, parts[index] ?? "");
    const last = index === parts.length - 1;
    const stat = lstatOrNull(at);
    if (stat === undefined) return null;
    if (stat === null) {
      // Missing from here on; `mkdir -p` creates each of these.
      if (target.kind === "dirs") created.push(...parts.slice(index, -1).map((_, offset) => parts.slice(0, index + offset + 1).join("/")));
      break;
    }
    if (stat.isSymbolicLink()) return null;
    if (!last) {
      if (!stat.isDirectory()) return null;
    } else if (target.kind === "file" || target.kind === "removed") {
      if (!stat.isFile() || stat.nlink !== 1) return null;
    } else if (!stat.isDirectory()) {
      return null;
    }
    if (stat.isDirectory() && lstatOrNull(join(at, ".git")) !== null) return null;
  }
  return [...created, parts.join("/")];
}

/**
 * Whether git verifies every target as ignored with nothing tracked there
 * (see the module comment); null when anything fails, so the policy is
 * asked and no facts are given. `cwd` is the directory the command runs in.
 */
export function verifyIgnoredTargets(targets: readonly TrivialTarget[], cwd: string, home: ExcludesHome, git: GitRunner): IgnoredTargets | null {
  if (targets.length === 0) return null;
  let dir: string;
  try {
    dir = realpathSync.native(cwd);
  } catch {
    return null;
  }
  const repository = repositoryRoot(dir, git);
  if (repository === null) return null;
  const { root, infoExclude } = repository;
  if (relative(root, dir).startsWith("..")) return null;
  const perTarget: { readonly rel: string; readonly paths: readonly string[] }[] = [];
  for (const target of targets) {
    const paths = checkedPaths(target, dir, root);
    if (paths === null) return null;
    perTarget.push({ rel: paths.at(-1) ?? "", paths });
  }
  const excludes = excludesFiles(root, home, git);
  if (excludes === null) return null;
  // info/exclude is in .git, but a symlink there can make a worktree file one.
  const sources = [...excludes, infoExclude].map(canonical);
  for (const { paths } of perTarget) {
    for (const rel of paths) {
      const written = canonical(join(root, rel));
      if (sources.some((source) => source === written || source.startsWith(`${written}${sep}`))) return null;
    }
  }
  const all = [...new Set(perTarget.flatMap((entry) => entry.paths))];
  // check-ignore exits 1 when it ignores none of them: an answer, not a failure.
  const ignoredOut = callGit(git, ["check-ignore", "-z", "--stdin"], root, all.join("\0") + "\0");
  if (ignoredOut === null || (ignoredOut.status !== 0 && ignoredOut.status !== 1)) return null;
  const ignored = new Set(ignoredOut.stdout.split("\0").filter((line) => line.length > 0));
  // Case-insensitive: on a case-insensitive filesystem `ODD/x` writes `odd/x`.
  const trackedOut = callGit(git, ["ls-files", "-z", "--", ...all.map((rel) => `:(literal,icase)${rel}`)], root);
  if (trackedOut === null || trackedOut.status !== 0) return null;
  const tracked = trackedOut.stdout.split("\0").filter((line) => line.length > 0).map((line) => line.toLowerCase());
  const verified = (rel: string): boolean => ignored.has(rel) && !tracked.some((file) => file === rel.toLowerCase() || file.startsWith(`${rel.toLowerCase()}/`));
  const passing = perTarget.filter((entry) => entry.paths.every(verified)).map((entry) => entry.rel);
  return { allIgnored: passing.length === perTarget.length, ignored: [...new Set(passing)] };
}

/** The context sentence naming the repository paths git verified as ignored; null for none. `names` swaps any absolute path for Jev's copy. */
export function buildIgnoredPathsSentence(paths: readonly string[], names: JevNames = IDENTITY_NAMES): string | null {
  if (paths.length === 0) return null;
  return names.redactText(`Checked with git, not read from the command: git ignores these repository paths the command writes (${paths.join(", ")}), so they are in no commit and on no branch. No other path is known to be ignored.`);
}
