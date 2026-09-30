// Where each part of a command runs. The 0.6.11 live QA (odd/qa/qa-0.6.11.md
// F-03, F-05, F-07) found the gate judged every command in the session's own
// directory: `cd other && git commit`, `git -C other push origin main` and
// `bash -c 'cd other && ...'` were weighed against the repository the agent
// happened to start in. This walks the command the way the shell would --
// `cd`/`pushd`/`popd` carry to later segments, a `( ... )` subshell and the
// script of `bash -c`/`sh -c`/`eval` are read as their own command lines --
// and hands back each simple command with the directory it starts in. Pure:
// no I/O; a directory that cannot be known without running anything (a
// variable, `cd -`) is `null`, never a guess.
import { isAbsolute, resolve } from "node:path";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";

export interface LocatedSegment {
  /** One simple command, as written. */
  readonly segment: string;
  /** The directory it starts in, or null when that cannot be known. */
  readonly dir: string | null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "timeout", "nice", "xargs"]);
const REDIRECTION = /^\d*[<>&]/;
const MAX_DEPTH = 6;

function programName(word: string): string {
  return word.split("/").pop() ?? word;
}

/** `~`, `$HOME`, `${HOME}` or the home directory's own path at the start of `target`, and what follows it; null when it starts with none. */
export function afterHome(target: string, home: string): string | null {
  for (const prefix of ["~", "${HOME}", "$HOME", home]) {
    if (prefix.length === 0 || !target.startsWith(prefix)) continue;
    const rest = target.slice(prefix.length);
    if (rest.length === 0 || rest.startsWith("/")) return rest;
  }
  return null;
}

/** `target` as an absolute directory seen from `from`, or null when it cannot be known without running anything. */
export function resolveDirectory(target: string, from: string | null, home: string): string | null {
  const rest = afterHome(target, home);
  if (rest !== null) return resolve(home, `.${rest}`);
  if (/[$*?[`]/.test(target)) return null;
  if (isAbsolute(target)) return resolve(target);
  return from === null ? null : resolve(from, target);
}

/** The words a wrapped command runs: leading `NAME=value` assignments and wrappers (with their own options) skipped. */
export function commandWords(words: readonly string[]): readonly string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1;
    else if (WRAPPERS.has(programName(word))) {
      index += 1;
      while (index < words.length && ((words[index] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? ""))) index += 1;
    } else break;
  }
  return words.slice(index);
}

/**
 * Where a `cd`/`pushd`/`popd` segment moves to: a directory, null when it
 * cannot be known, or undefined when the segment is not a directory change.
 */
export function directoryChange(words: readonly string[], from: string | null, home: string): string | null | undefined {
  const program = words[0];
  if (program === "popd") return null;
  if (program !== "cd" && program !== "pushd") return undefined;
  const args = words.slice(1).filter((word, at, all) => !word.startsWith("-") && !REDIRECTION.test(word) && !/^\d*[<>]+$/.test(all[at - 1] ?? ""));
  const target = args[0];
  if (target === undefined) return program === "cd" ? home : null;
  return resolveDirectory(target, from, home);
}

/** The script a `bash -c`/`sh -c`/`eval` segment runs as its own command line, or null. */
function innerScript(words: readonly string[]): string | null {
  const run = commandWords(words);
  const program = programName(run[0] ?? "");
  if (program === "eval") return run.length > 1 ? run.slice(1).join(" ") : null;
  if (!SHELLS.has(program)) return null;
  const flag = run.findIndex((word, at) => at > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
  return flag === -1 ? null : (run[flag + 1] ?? null);
}

/** The body of a segment that is one whole `( ... )` subshell, or null. */
function subshellBody(segment: string): string | null {
  if (!segment.startsWith("(") || !segment.endsWith(")")) return null;
  let depth = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && index < segment.length - 1) return null;
  }
  return segment.slice(1, -1).trim();
}

function walk(command: string, start: string | null, home: string, depth: number, out: LocatedSegment[]): string | null {
  let dir = start;
  for (const segment of splitOnCommandSeparators(command)) {
    const body = depth < MAX_DEPTH ? subshellBody(segment) : null;
    if (body !== null) {
      walk(body, dir, home, depth + 1, out);
      continue;
    }
    const words = tokenize(segment);
    const moved = directoryChange(words, dir, home);
    if (moved !== undefined) {
      dir = moved;
      continue;
    }
    const script = depth < MAX_DEPTH ? innerScript(words) : null;
    if (script !== null) {
      walk(script, dir, home, depth + 1, out);
      continue;
    }
    out.push({ segment, dir });
  }
  return dir;
}

/** Every simple command in `command`, with the directory it starts in when run from `cwd`. */
export function locateCommandSegments(command: string, cwd: string, home: string): readonly LocatedSegment[] {
  const out: LocatedSegment[] = [];
  walk(command, resolve(cwd), resolve(home), 0, out);
  return out;
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);

export interface GitInvocation {
  /** The git subcommand (`push`, `commit`, ...), or null for a bare `git`. */
  readonly subcommand: string | null;
  /** Its arguments. */
  readonly args: readonly string[];
  /** The working directory git acts in: `-C` applied, `--work-tree`/`--git-dir` honoured; null when unknown. */
  readonly dir: string | null;
}

/** The git invocation `segment` runs from `dir`, read past wrappers and git's own global options; null when it runs no git. */
export function gitInvocation(segment: string, dir: string | null, home: string): GitInvocation | null {
  const run = commandWords(tokenize(segment));
  if (programName(run[0] ?? "") !== "git") return null;
  let at = 1;
  let gitDir = dir;
  while (at < run.length && (run[at] ?? "").startsWith("-")) {
    const option = run[at] ?? "";
    const [name, inline] = option.includes("=") ? [option.slice(0, option.indexOf("=")), option.slice(option.indexOf("=") + 1)] : [option, null];
    const value = inline ?? (GIT_OPTIONS_WITH_VALUE.has(name) ? (run[at + 1] ?? "") : null);
    if (name === "-C" && value !== null) gitDir = value.length === 0 ? gitDir : resolveDirectory(value, gitDir, home);
    else if (name === "--work-tree" && value !== null) gitDir = resolveDirectory(value, gitDir, home);
    else if (name === "--git-dir" && value !== null) {
      const resolved = resolveDirectory(value, gitDir, home);
      gitDir = resolved === null ? null : resolved.endsWith("/.git") ? resolved.slice(0, -"/.git".length) : resolved;
    }
    at += inline === null && GIT_OPTIONS_WITH_VALUE.has(name) ? 2 : 1;
  }
  const subcommand = run[at] ?? null;
  return { subcommand, args: run.slice(at + 1), dir: gitDir };
}
