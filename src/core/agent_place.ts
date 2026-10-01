// 0.6.23 T1 (JEVADV-102): where each running agent works, for the agents
// band. The engine never reports a subagent's shell directory (a shell `cd`
// does not move `$.session.root()`), so it is read off the agent's own tool
// calls: a file it writes (Edit, Write, NotebookEdit) and a directory its
// shell moves to (`cd`, `git -C`). A read never counts: a writer told to
// read a plan in a sibling worktree must not move there. The directory is
// then named by git: its worktree's top level and the branch checked out.
//
// Pure apart from the ProcessRun it is handed. The hooks module runs with no
// Node (no `node:path`), so command_locations.ts (which resolves through
// node:path) cannot be imported there; the command is split by the same
// node-free splitter and tokenizer it uses (git_discard.ts), and paths are
// resolved here as plain POSIX strings.
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";
import type { ProcessRun } from "./orca_context.ts";
import type { AgentPlace } from "./subagent_status.ts";

/** POSIX `path` with `.`, `..` and repeated slashes folded; `path` is absolute. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The directory holding `path` (absolute and normalized); `/` for the root itself. */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/**
 * `target` as an absolute path: `~`, `$HOME` and `${HOME}` expanded (the way
 * gate_own_files.ts does), a relative path against `base`. null when it
 * cannot be known without running anything: a substitution, any other
 * variable, a glob, no home or no base to resolve against.
 */
export function absolutePath(target: string, base: string | null, home: string | null): string | null {
  const homeForm = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(target);
  if (homeForm !== null) return home === null ? null : normalize(`${home}/${target.slice(homeForm[0].length)}`);
  if (target.length === 0 || /[$`*?[]/.test(target)) return null;
  if (target.startsWith("/")) return normalize(target);
  return base === null ? null : normalize(`${base}/${target}`);
}

const FILE_TOOLS: Readonly<Record<string, string>> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);

/** The words a simple command runs, its leading `NAME=value` assignments skipped. */
function runWords(segment: string): readonly string[] {
  const words = tokenize(segment);
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) at += 1;
  return words.slice(at);
}

/** Where a `cd`/`pushd` moves to from `dir`: a directory, null when unknown, undefined when `words` is no directory change. */
function cdTarget(words: readonly string[], dir: string | null, home: string | null): string | null | undefined {
  if (words[0] !== "cd" && words[0] !== "pushd") return undefined;
  const target = words.slice(1).find((word) => !word.startsWith("-"));
  return target === undefined ? null : absolutePath(target, dir, home);
}

/** The directory a `git -C <dir> ...` acts in, seen from `dir`: null when unknown, undefined when `words` runs no git or names no `-C`. */
function gitDirectory(words: readonly string[], dir: string | null, home: string | null): string | null | undefined {
  if ((words[0] ?? "").split("/").pop() !== "git") return undefined;
  let acting: string | null | undefined;
  let at = 1;
  while (at < words.length && (words[at] ?? "").startsWith("-")) {
    const option = words[at] ?? "";
    if (option === "-C") {
      acting = absolutePath(words[at + 1] ?? "", acting === undefined ? dir : acting, home);
      at += 2;
    } else at += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  return acting;
}

/** The directory a Bash command ends up working in: the last `cd` or `git -C` it runs at its top level; null when none, or when that one cannot be known. */
function bashDirectory(command: string, base: string | null, home: string | null): string | null {
  let dir = base;
  let last: string | null = null;
  for (const segment of splitOnCommandSeparators(command)) {
    const words = runWords(segment);
    const moved = cdTarget(words, dir, home);
    if (moved !== undefined) {
      dir = moved;
      last = moved;
      continue;
    }
    const git = gitDirectory(words, dir, home);
    if (git !== undefined) last = git;
  }
  return last;
}

/**
 * The absolute directory one tool call works in, from the tool's name and
 * its arguments (as `tool.call` carries them, beside the tool), seen from
 * `base` (the agent's own directory; null when unknown). null when the call
 * is not one that says where the agent works, or when that cannot be known.
 */
export function callDirectory(tool: string, args: Readonly<Record<string, unknown>>, base: string | null, home: string | null): string | null {
  const fileKey = FILE_TOOLS[tool];
  if (fileKey !== undefined) {
    const file = args[fileKey];
    if (typeof file !== "string") return null;
    const path = absolutePath(file, base, home);
    return path === null ? null : parentOf(path);
  }
  if (tool === "Bash" && typeof args.command === "string") return bashDirectory(args.command, base, home);
  return null;
}

/** What git says of a directory: its worktree's top level, and the branch checked out (null for a detached HEAD or when git cannot tell). */
export interface GitPlace {
  readonly toplevel: string;
  readonly branch: string | null;
}

/** git's answer for `dir`, through `run`; null when it is in no repository or git fails. Never throws. */
export async function resolveGitPlace(run: ProcessRun, dir: string): Promise<GitPlace | null> {
  const answer = async (argv: readonly string[]): Promise<string | null> => {
    try {
      const result = await run(argv);
      const out = result.stdout.trim();
      return result.exitCode === 0 && out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
  const [toplevel, branch] = await Promise.all([answer(["git", "-C", dir, "rev-parse", "--show-toplevel"]), answer(["git", "-C", dir, "branch", "--show-current"])]);
  return toplevel === null ? null : { toplevel, branch };
}

/** The most directories kept at once: a session's agents work in a handful. */
export const PLACE_CACHE_MAX = 64;

/** git's answers by directory, oldest first; a lookup in flight is kept as its promise, so two calls never run git twice. */
export interface PlaceCache {
  readonly entries: Map<string, Promise<GitPlace | null>>;
  readonly max: number;
}

export function newPlaceCache(max: number = PLACE_CACHE_MAX): PlaceCache {
  return { entries: new Map<string, Promise<GitPlace | null>>(), max };
}

/** resolveGitPlace, once per directory (a failure included) while it stays among the cache's `max` most recent. */
export function cachedGitPlace(cache: PlaceCache, run: ProcessRun, dir: string): Promise<GitPlace | null> {
  const kept = cache.entries.get(dir);
  if (kept !== undefined) {
    cache.entries.delete(dir);
    cache.entries.set(dir, kept);
    return kept;
  }
  const looked = resolveGitPlace(run, dir);
  cache.entries.set(dir, looked);
  for (const oldest of cache.entries.keys()) {
    if (cache.entries.size <= cache.max) break;
    cache.entries.delete(oldest);
  }
  return looked;
}

/** The band's place for a worktree git named, against the lead's top level (null when the lead is in no repository: then every worktree is apart). */
export function agentPlace(place: GitPlace, leadToplevel: string | null): AgentPlace {
  return { worktree: place.toplevel.split("/").filter((part) => part.length > 0).at(-1) ?? place.toplevel, branch: place.branch, apart: place.toplevel !== leadToplevel };
}

/** An agent whose Agent call asked for `isolation: 'worktree'`, before any call of its own shows the path. */
export const PENDING_ISOLATION_PLACE: AgentPlace = { worktree: null, branch: null, apart: true, pendingIsolation: true };

export function samePlace(a: AgentPlace | undefined, b: AgentPlace | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.worktree === b.worktree && a.branch === b.branch && a.apart === b.apart && a.pendingIsolation === b.pendingIsolation;
}
