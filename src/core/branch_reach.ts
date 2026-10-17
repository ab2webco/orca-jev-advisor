// 0.6.28 T1: whether a command can reach a protected branch, for the
// `protected-branch` policy scope (decisions.ts's filterPoliciesForBranchReach).
//
// The owner, 2026-10-07: `git add` on a working branch was refused under
// never_write_to_main, because Jev was asked about that policy for every
// command. Two facts decide instead, both read from the text:
//   - the places the command writes in (command_locations.ts and
//     command_targets.ts, as acting_location.ts reads them: `cd`, `git -C`,
//     a write's own target), whose branch the hook resolves;
//   - whether the text names a protected branch as a whole word, a refspec
//     side or a remote branch (`main`, `HEAD:main`, `origin/main`).
// Both fail toward keeping the policy: an unknown place is null, a gh command
// that writes counts as naming one (its base branch is not in the text).
import { resolve } from "node:path";

import { afterHome, gitInvocation, locateCommandSegments, resolveDirectory, substitutionSpans } from "./command_locations.ts";
import { resolveCommandTargetDirs } from "./command_targets.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";
import { outputRedirectionTargets } from "./redirections.ts";

// odd/tasks/branch-reach-places.md B1: on 2026-10-17, in a session on main,
// `pgrep`, `head`, `mkdir -p /tmp/x` and `rm -rf ~/Library/a && ln -s ...`
// were asked about never_write_to_main: every program off a short list
// counted its own directory, and `~` was read as a folder of the checkout.
// Two strict lists decide instead. Any program on neither may write where it
// runs (`node edit.mjs > /tmp/log` edits the checkout), so its directory counts.

/**
 * Programs that write no file except their redirect targets. A program that
 * may write a file it does not name (awk, curl, env, xargs, an interpreter, a
 * build tool) is never here. find, sed, sort, uniq, file and rg are here only
 * in the forms writesNoFile accepts.
 */
const WRITES_NO_FILE: ReadonlySet<string> = new Set([
  "pgrep", "ps", "lsof", "kill", "pkill",
  "head", "tail", "cat", "grep", "rg", "ls", "wc", "stat", "file", "which", "du", "df", "diff", "jq", "uniq", "cut", "tr",
  "readlink", "realpath", "basename", "dirname", "date", "uname", "whoami", "id", "hostname", "sleep", "true", "false", "test",
  "echo", "printf", "find", "sed", "sort",
]);

/** find actions that write or run something: `-delete`, `-exec`, `-fprint out`... */
const FIND_WRITES: ReadonlySet<string> = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** sed's `s` command, with any delimiter, and its flags (`w file` writes, `e` runs). */
const SED_SUBSTITUTE = /s([^\\\s\w])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1([a-zA-Z0-9]*)/g;
/** sed's `y/abc/xyz/`, and `/re/` or `\cREc` addresses: text, not commands. */
const SED_TEXT = /y([^\\\s\w])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1|\/(?:\\.|[^/])*\/|\\(.)(?:\\.|(?!\2).)*\2/g;

/** A sed script that reads and prints only: no `w`/`W` file, no `e` command, in the commands or the `s` flags. */
function sedScriptWritesNothing(script: string): boolean {
  // One script line only: a filename runs to the end of its line, so a span read across lines could hide a `w`.
  if (script.includes("\n")) return false;
  let writes = false;
  const rest = script.replace(SED_SUBSTITUTE, (_match: string, _delimiter: string, flags: string) => {
    if (/[we]/.test(flags)) writes = true;
    return ";";
  });
  return !writes && !/[wWe]/.test(rest.replace(SED_TEXT, ";"));
}

/** sed without `-i`/`--in-place` (also `-i''`, `-i.bak`, `-ni`), without `-f`, and with print-only scripts. */
function sedWritesNoFile(args: readonly string[]): boolean {
  const scripts: string[] = [];
  let explicit = false;
  let firstOperand: string | null = null;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg === "--") {
      firstOperand ??= args[at + 1] ?? null;
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (name.startsWith("--in-place") || name === "--file") return false;
      if (name === "--expression") {
        explicit = true;
        if (arg.includes("=")) scripts.push(arg.slice(arg.indexOf("=") + 1));
        else scripts.push(args[(at += 1)] ?? "");
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let letter = 1; letter < arg.length; letter += 1) {
        const flag = arg[letter] ?? "";
        if (flag === "i" || flag === "f") return false;
        if (flag === "e" || flag === "l") {
          const value = arg.length > letter + 1 ? arg.slice(letter + 1) : (args[(at += 1)] ?? "");
          if (flag === "e") {
            explicit = true;
            scripts.push(value);
          }
          break;
        }
      }
      continue;
    }
    firstOperand ??= arg;
  }
  if (!explicit && firstOperand !== null) scripts.push(firstOperand);
  return scripts.every(sedScriptWritesNothing);
}

/** Whether `program` with `args` writes no file but its redirect targets. */
function writesNoFile(program: string, args: readonly string[]): boolean {
  if (!WRITES_NO_FILE.has(program)) return false;
  switch (program) {
    case "find":
      return !args.some((arg) => FIND_WRITES.has(arg));
    case "sed":
      return sedWritesNoFile(args);
    case "sort":
      // `-o out` (also in a cluster, `-uo out`) writes, `-T dir` keeps temp files there, `--compress-program` runs one.
      return !args.some((arg) => /^-[^-]*[oT]/.test(arg) || arg.startsWith("--output") || arg.startsWith("--temporary-directory") || arg.startsWith("--compress-program"));
    case "uniq":
      // A second operand is the file uniq writes.
      return args.filter((arg) => !arg.startsWith("-")).length <= 1;
    case "file":
      return !args.some((arg) => /^-[^-]*C/.test(arg) || arg === "--compile");
    case "rg":
      // `--pre cmd` runs a program on every file.
      return !args.some((arg) => arg.startsWith("--pre"));
    default:
      return true;
  }
}

/** Options that take a value, per program whose only writes are the files it names. */
interface OptionShape {
  /** Short letters that take a value, glued (`-m755`) or as the next word. */
  readonly short: string;
  /** Long options that take the next word as their value when written without `=`. */
  readonly long: ReadonlySet<string>;
}

const NAMED_FILE_WRITERS: ReadonlyMap<string, OptionShape> = new Map([
  ["rm", { short: "", long: new Set<string>() }],
  ["cp", { short: "tS", long: new Set(["--target-directory", "--suffix"]) }],
  ["mv", { short: "tS", long: new Set(["--target-directory", "--suffix"]) }],
  ["ln", { short: "tS", long: new Set(["--target-directory", "--suffix"]) }],
  ["mkdir", { short: "m", long: new Set(["--mode"]) }],
  ["touch", { short: "tdrA", long: new Set(["--date", "--reference", "--time"]) }],
  ["chmod", { short: "", long: new Set(["--reference"]) }],
  ["chown", { short: "", long: new Set(["--reference", "--from"]) }],
  ["tee", { short: "", long: new Set<string>() }],
]);

interface ParsedArgs {
  /** Every option by name (`-t`, `--target-directory`), with its value when it takes one. */
  readonly options: ReadonlyMap<string, string>;
  readonly operands: readonly string[];
}

function parseArgs(args: readonly string[], shape: OptionShape, modeFlag: (arg: string) => boolean): ParsedArgs {
  const options = new Map<string, string>();
  const operands: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      options.set(name, eq !== -1 ? arg.slice(eq + 1) : shape.long.has(name) ? (args[(at += 1)] ?? "") : "");
    } else if (modeFlag(arg)) {
      continue;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let letter = 1; letter < arg.length; letter += 1) {
        const flag = arg[letter] ?? "";
        if (shape.short.includes(flag)) {
          options.set(`-${flag}`, arg.length > letter + 1 ? arg.slice(letter + 1) : (args[(at += 1)] ?? ""));
          break;
        }
        options.set(`-${flag}`, "");
      }
    } else operands.push(arg);
  }
  return { options, operands };
}

/** A chmod mode: octal, or symbolic (`u+x`, `go-w,a+r`, `+x`). */
const CHMOD_MODE = /^(?:[0-7]{1,4}|[ugoa]*(?:[-+=][rwxXstugo]*)+(?:,[ugoa]*(?:[-+=][rwxXstugo]*)+)*)$/;
/** A symbolic mode written like a flag, `chmod -x f`. */
const CHMOD_MODE_FLAG = /^-[rwxXst]+$/;

interface NamedWrites {
  /** The words naming the files written. */
  readonly files: readonly string[];
  /** It also writes the directory it runs in (`ln -s /a`, one operand). */
  readonly writesDir: boolean;
  /** A named file that holds the checkout (a delete or a move of a parent) writes the checkout. */
  readonly parentsCount: boolean;
}

/** The files `program` writes, read from `args`, or null when it is not one whose only writes are files it names. */
function namedWrites(program: string, args: readonly string[]): NamedWrites | null {
  const shape = NAMED_FILE_WRITERS.get(program);
  if (shape === undefined) return null;
  const modeFlag = (arg: string): boolean => program === "chmod" && CHMOD_MODE_FLAG.test(arg);
  const { options, operands } = parseArgs(args, shape, modeFlag);
  const targetDir = options.get("-t") ?? options.get("--target-directory");
  switch (program) {
    case "rm":
    case "tee":
    case "mkdir":
    case "touch":
      return { files: operands, writesDir: false, parentsCount: program === "rm" };
    case "mv":
      return { files: targetDir !== undefined ? [targetDir, ...operands] : operands, writesDir: operands.length === 0, parentsCount: true };
    case "cp":
    case "ln": {
      if (targetDir !== undefined) return { files: [targetDir], writesDir: false, parentsCount: false };
      if (operands.length >= 2) return { files: operands.slice(-1), writesDir: false, parentsCount: false };
      // `ln -s /a` links into the directory it runs in; a lone `cp` operand is not a copy anyone can read.
      return { files: [], writesDir: true, parentsCount: false };
    }
    case "chmod": {
      const modeFirst = !options.has("--reference") && !args.some(modeFlag) && CHMOD_MODE.test(operands[0] ?? "");
      return { files: modeFirst ? operands.slice(1) : operands, writesDir: false, parentsCount: true };
    }
    default: {
      // chown: the first operand is the owner, unless --reference names a file to copy it from.
      const ownerFirst = !options.has("--reference");
      if (ownerFirst && operands.length < 2) return { files: [], writesDir: true, parentsCount: true };
      return { files: ownerFirst ? operands.slice(1) : operands, writesDir: false, parentsCount: true };
    }
  }
}

/** A redirection at the start of a shell word: `>`, `2>>`, `&>`, `<<`, `<<<`, `>|`, `2>&1`, alone or glued to its target. */
const REDIRECT_WORD = /^(?:\d+|&)?(?:>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/;

/** The shell words of `text` as written, quotes kept, split on unquoted blanks. */
function rawWords(text: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\" && !single) {
      current += text.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    if (/\s/.test(char) && !single && !double) {
      if (current.length > 0) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** Whether a word as written holds a `<` or `>` outside quotes, where the shell would split it. */
function hasUnquotedRedirect(raw: string): boolean {
  let single = false;
  let double = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char === "\\" && !single) index += 1;
    else if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && !double && (char === "<" || char === ">")) return true;
  }
  return false;
}

/**
 * The words of a command, quotes removed, with leading `NAME=value`
 * assignments and redirections left out (redirect targets are read by
 * outputRedirectionTargets). A word the shell would split at a `<` or `>`
 * (`hi>x`) is an unknown word, `$?`, that never resolves to a path.
 */
function programWords(text: string): readonly string[] {
  const raws = rawWords(text);
  let at = 0;
  while (at < raws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raws[at] ?? "")) at += 1;
  const words: string[] = [];
  for (; at < raws.length; at += 1) {
    const raw = raws[at] ?? "";
    const redirect = REDIRECT_WORD.exec(raw);
    if (redirect !== null) {
      if (redirect[0].length === raw.length) at += 1;
      continue;
    }
    words.push(hasUnquotedRedirect(raw) ? "$?" : tokenize(raw).join(""));
  }
  return words;
}

/** `segment` with each `$(...)`, backtick and `<(...)` written as a variable, so no path built from one resolves. */
function substitutionsAsVariables(segment: string): string {
  let out = "";
  let from = 0;
  for (const span of substitutionSpans(segment)) {
    out += `${segment.slice(from, span.start)}$SUBST`;
    from = span.end + 1;
  }
  return out + segment.slice(from);
}

/** `raw` as an absolute path seen from `dir`, `~` and `$HOME` read as home; null when it cannot be known without running anything. */
function resolveNamedPath(raw: string, dir: string, home: string): string | null {
  // A brace expansion (`src/{a,b}`) names paths the text does not spell; `${HOME}` is home.
  if (raw.length === 0 || /[{}]/.test(afterHome(raw, home) ?? raw)) return null;
  return resolveDirectory(raw, dir, home);
}

/** Whether `path` is `inner` itself or a directory holding it. */
function holds(path: string, inner: string): boolean {
  return inner === path || inner.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/**
 * The places a segment of a program on the two lists writes: its redirect
 * targets and the files it names. Null when the program is on neither, so
 * its directory counts.
 */
function listedProgramPlaces(segment: string, dir: string, cwd: string, home: string): readonly (string | null)[] | null {
  const marked = substitutionsAsVariables(segment);
  const [program, ...args] = programWords(marked);
  if (program === undefined) return null;
  const named = writesNoFile(program, args) ? { files: [], writesDir: false, parentsCount: false } : namedWrites(program, args);
  if (named === null) return null;
  const places: (string | null)[] = named.writesDir ? [dir] : [];
  for (const raw of named.files) {
    const path = resolveNamedPath(raw, dir, home);
    places.push(path);
    if (path !== null && named.parentsCount) for (const inner of [dir, cwd]) if (holds(path, inner)) places.push(inner);
  }
  for (const raw of outputRedirectionTargets(marked)) places.push(resolveNamedPath(raw, dir, home));
  return places;
}

/**
 * Every place `command`, run from `cwd`, writes in, once each: a directory
 * or a file path, or null where it cannot be known without running it. An
 * obviously safe segment writes nowhere and adds nothing. A git segment
 * always counts its own directory (after `cd`, `-C`), even when it also
 * writes a file (`git commit > /tmp/log`): that file says nothing about the
 * branch the commit lands on.
 */
export function branchReachPlaces(command: string, cwd: string, home: string): readonly (string | null)[] {
  const places: (string | null)[] = [];
  const add = (place: string | null): void => {
    if (!places.includes(place)) places.push(place);
  };
  for (const { segment, outer, dir } of locateCommandSegments(command, cwd, home)) {
    if (isObviouslySafeCommand(outer)) continue;
    const git = gitInvocation(outer, dir, home);
    const base = git?.dir ?? dir;
    if (base === null) {
      add(null);
      continue;
    }
    const listed = git === null ? listedProgramPlaces(segment, base, resolve(cwd), home) : null;
    if (listed !== null) {
      for (const place of listed) add(place);
      continue;
    }
    add(base);
    for (const file of resolveCommandTargetDirs(outer, base)) add(file);
  }
  return places;
}

/** git subcommands that pick or write a branch named by an argument. */
const BRANCH_SELECTING: ReadonlySet<string> = new Set(["checkout", "switch", "push", "merge", "rebase", "reset", "pull", "cherry-pick", "branch", "worktree"]);

/** An argument naming a branch the text does not spell: `-` and `@{-1}` (the previous one), a variable, a substitution. */
function namesUnknownBranch(arg: string): boolean {
  return arg === "-" || arg.startsWith("@{") || /[$`]/.test(arg);
}

/** The branch names one shell word can stand for: `+main`, `HEAD:main`, `refs/heads/main`, `origin/main`, `--base=main`, `main~1`. */
function branchNamesIn(token: string): readonly string[] {
  const value = token.startsWith("-") ? (token.includes("=") ? token.slice(token.indexOf("=") + 1) : "") : token;
  const names: string[] = [];
  for (const side of value.replace(/^\+/, "").split(":")) {
    for (const range of side.split(/\.\.\.?/)) {
      const ref = range.replace(/[~^@].*$/, "").replace(/^refs\/(?:heads|tags)\//, "").replace(/^refs\/remotes\//, "");
      if (ref.length === 0) continue;
      names.push(ref.toLowerCase());
      const slash = ref.lastIndexOf("/");
      if (slash >= 0) names.push(ref.slice(slash + 1).toLowerCase());
    }
  }
  return names;
}

/** A gh command's program word, past leading `NAME=value` assignments. */
function runsGh(tokens: readonly string[]): boolean {
  const program = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return program === "gh";
}

/**
 * Whether `command` names one of `protectedBranches` (lower case) in a
 * segment that is not obviously safe, or runs a gh command that may write
 * (a merge, an API call), or a git command that picks or writes a branch
 * the text does not spell (`checkout -`, `@{-1}`, `"$BASE"`): those may
 * reach a protected branch without naming it.
 * A file path or a message that merely contains the word does not count
 * (`src/main.ts`, `-m "fix main menu"`); a path whose last part is exactly
 * a protected name does, which only costs one question.
 */
export function namesProtectedBranch(command: string, protectedBranches: ReadonlySet<string>): boolean {
  for (const segment of splitOnCommandSeparators(command)) {
    if (isObviouslySafeCommand(segment)) continue;
    const tokens = tokenize(segment);
    if (runsGh(tokens)) return true;
    const git = gitInvocation(segment, null, "/");
    if (git !== null && git.subcommand !== null && BRANCH_SELECTING.has(git.subcommand) && git.args.some(namesUnknownBranch)) return true;
    if (tokens.some((token) => branchNamesIn(token).some((name) => protectedBranches.has(name)))) return true;
  }
  return false;
}
