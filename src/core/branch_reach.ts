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
import { isAbsolute, resolve } from "node:path";

import { gitInvocation, locateCommandSegments, substitutionSpans } from "./command_locations.ts";
import { resolveCommandTargetDirs } from "./command_targets.ts";
import { isObviouslySafeCommand, rgRunsNothing, sortWritesNothing, uniqWritesNothing } from "./gate_safe_command.ts";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";
import { outputRedirectionTargets } from "./redirections.ts";
import { hasExpansion, hasUnquotedRedirect, isLongOptionPrefix, isUnreadableWord, rawWords, wordText } from "./shell_words.ts";

// odd/tasks/branch-reach-places.md B1: on 2026-10-17, in a session on main,
// `pgrep`, `head`, `mkdir -p /tmp/x` and `rm -rf ~/Library/a && ln -s ...`
// were asked about never_write_to_main: every program off a short list
// counted its own directory, and `~` was read as a folder of the checkout.
// Two strict lists decide instead. Any program on neither may write where it
// runs (`node edit.mjs > /tmp/log` edits the checkout), so its directory counts.
// Every word is read as the shell writes it: a word the text cannot settle
// (a `$`, a backtick, a brace, an option spelled with quotes, a GNU prefix
// that could be two options) sends the segment back to that rule, or counts
// the directory, never fewer places than before.

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

/** Tools that are obviously safe only for some arguments (`find -delete`, `sort -o`, `sed -i`, `rg --pre`, `awk system()`). */
const ARGUMENT_DEPENDENT: ReadonlySet<string> = new Set(["find", "sed", "sort", "uniq", "rg", "awk", "file", "env"]);

/** find actions that write or run something: `-delete`, `-exec`, `-fprint out`... */
const FIND_WRITES: ReadonlySet<string> = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/**
 * sed is not parsed: GNU and BSD sed differ (`-I` edits in place on macOS,
 * `-l` takes a value only in GNU sed, GNU accepts `--exp=` for
 * `--expression`), and a script can write (`w`, `W`, `s///w`) or run (`e`)
 * in more shapes than a reader can follow. It writes nothing only in one
 * shape: options among `-n`, `-E`, `-r` (`-nE`, `-En`), one script of line
 * addresses or ranges printing or deleting (`1,40p`, `$p`, `10,$p`, `1d`,
 * joined by `;`), and plain file operands.
 */
const SED_OPTIONS = /^-(?:n|E|r|nE|En)$/;
const SED_LINE_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?[pd](?:;(?:\d+|\$)(?:,(?:\d+|\$))?[pd])*$/;
const PLAIN_OPERAND = /^[^-$`{}*?[\]][^$`{}*?[\]]*$/;

function sedReadsOnly(args: readonly string[]): boolean {
  let at = 0;
  for (; at < args.length; at += 1) {
    const raw = args[at] ?? "";
    if (raw === "--") {
      at += 1;
      break;
    }
    const text = wordText(raw);
    if (!text.startsWith("-")) break;
    if (raw !== text || !SED_OPTIONS.test(text)) return false;
  }
  const script = args[at];
  if (script === undefined) return false;
  const text = wordText(script);
  if (!SED_LINE_SCRIPT.test(text)) return false;
  // `$p` unquoted, or in double quotes, is the shell's variable `p`.
  if (text.includes("$") && script !== `'${text}'`) return false;
  return args.slice(at + 1).every((raw) => !hasExpansion(raw) && PLAIN_OPERAND.test(wordText(raw)));
}

/** Whether `program` with the raw words `args` writes no file but its redirect targets. */
function writesNoFile(program: string, args: readonly string[]): boolean {
  if (!WRITES_NO_FILE.has(program)) return false;
  if (program === "sed") return sedReadsOnly(args);
  if (args.some(isUnreadableWord)) return false;
  const texts = args.map(wordText);
  switch (program) {
    case "find":
      return !texts.some((arg) => FIND_WRITES.has(arg));
    case "sort":
      return sortWritesNothing(texts);
    case "uniq":
      return uniqWritesNothing(texts);
    case "file":
      return !texts.some((arg) => /^-[^-]*C/.test(arg) || arg === "--compile");
    case "rg":
      return rgRunsNothing(texts);
    default:
      return true;
  }
}

/** Options that take a value, per program whose only writes are the files it names. */
interface OptionShape {
  /** Short letters that take a value, glued (`-m755`) or as the next word. */
  readonly short: string;
  /** Long options that take a value, `=`-joined or as the next word; GNU getopt also accepts an unambiguous prefix of each. */
  readonly long: readonly string[];
}

const NAMED_FILE_WRITERS: ReadonlyMap<string, OptionShape> = new Map([
  ["rm", { short: "", long: [] }],
  ["cp", { short: "tS", long: ["--target-directory", "--suffix"] }],
  ["mv", { short: "tS", long: ["--target-directory", "--suffix"] }],
  ["ln", { short: "tS", long: ["--target-directory", "--suffix"] }],
  ["mkdir", { short: "m", long: ["--mode"] }],
  ["touch", { short: "tdrA", long: ["--date", "--reference", "--time"] }],
  ["chmod", { short: "", long: ["--reference"] }],
  ["chown", { short: "", long: ["--reference", "--from"] }],
  ["tee", { short: "", long: [] }],
]);

interface ParsedArgs {
  /** Every option by name (`-t`, `--target-directory`), with its raw value when it takes one. */
  readonly options: ReadonlyMap<string, string>;
  /** The operands, as written. */
  readonly operands: readonly string[];
}

/** The value-taking long option `name` spells (itself or an unambiguous prefix); undefined for none, null when it could be two. */
function longOption(name: string, longs: readonly string[]): string | null | undefined {
  if (longs.includes(name)) return name;
  const matches = longs.filter((long) => isLongOptionPrefix(name, long, 3));
  if (matches.length > 1) return null;
  return matches[0];
}

/** `args` read as getopt reads them; null when an option is spelled in a way the text cannot settle. */
function parseArgs(args: readonly string[], shape: OptionShape, modeFlag: (text: string) => boolean): ParsedArgs | null {
  const options = new Map<string, string>();
  const operands: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const raw = args[at] ?? "";
    const text = wordText(raw);
    if (raw === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (!text.startsWith("-") || text === "-") {
      operands.push(raw);
      continue;
    }
    // An option spelled with quotes (`'-t'`, `-t''src`) is still the option.
    if (raw !== text) return null;
    if (modeFlag(text)) continue;
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const name = eq === -1 ? text : text.slice(0, eq);
      const long = longOption(name, shape.long);
      if (long === null) return null;
      if (long === undefined) options.set(name, eq === -1 ? "" : text.slice(eq + 1));
      else options.set(long, eq !== -1 ? text.slice(eq + 1) : (args[(at += 1)] ?? ""));
      continue;
    }
    for (let letter = 1; letter < text.length; letter += 1) {
      const flag = text[letter] ?? "";
      if (shape.short.includes(flag)) {
        options.set(`-${flag}`, text.length > letter + 1 ? text.slice(letter + 1) : (args[(at += 1)] ?? ""));
        break;
      }
      options.set(`-${flag}`, "");
    }
  }
  return { options, operands };
}

/** A chmod mode: octal, or symbolic (`u+x`, `go-w,a+r`, `+x`). */
const CHMOD_MODE = /^(?:[0-7]{1,4}|[ugoa]*(?:[-+=][rwxXstugo]*)+(?:,[ugoa]*(?:[-+=][rwxXstugo]*)+)*)$/;
/** A symbolic mode written like a flag, `chmod -x f`. */
const CHMOD_MODE_FLAG = /^-[rwxXst]+$/;

interface NamedWrites {
  /** The raw words naming the files written. */
  readonly files: readonly string[];
  /** It also writes the directory it runs in (`ln -s /a`, one operand). */
  readonly writesDir: boolean;
  /** A named file that holds the checkout (a delete or a move of a parent) writes the checkout. */
  readonly parentsCount: boolean;
}

/** The files `program` writes, read from its raw words, or null when it is not one whose only writes are files it names, or its options cannot be read. */
function namedWrites(program: string, args: readonly string[]): NamedWrites | null {
  const shape = NAMED_FILE_WRITERS.get(program);
  if (shape === undefined) return null;
  const modeFlag = (text: string): boolean => program === "chmod" && CHMOD_MODE_FLAG.test(text);
  const parsed = parseArgs(args, shape, modeFlag);
  if (parsed === null) return null;
  const { options, operands } = parsed;
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
      const modeFirst = !options.has("--reference") && !args.some((raw) => modeFlag(wordText(raw))) && CHMOD_MODE.test(wordText(operands[0] ?? ""));
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

/** Stands for a `<(...)` or `>(...)` process substitution: not a file, and its command is walked as its own segment. */
const PROCESS_SUBSTITUTION = "\u0000";

/** `segment` with each `$(...)` and backtick written as a variable (no path built from one resolves), and each process substitution as one inert word. */
function markSubstitutions(segment: string): string {
  let out = "";
  let from = 0;
  for (const span of substitutionSpans(segment)) {
    const opener = segment[span.start];
    out += `${segment.slice(from, span.start)}${opener === "<" || opener === ">" ? PROCESS_SUBSTITUTION : "$SUBST"}`;
    from = span.end + 1;
  }
  return out + segment.slice(from);
}

/** The raw rest of a word after a home prefix the shell expands (`~`, `$HOME`, `${HOME}`, also in double quotes), or null. A quoted or escaped `~` is literal. */
function homeRest(raw: string): string | null {
  if (raw === "~" || raw.startsWith("~/")) return raw.slice(1);
  for (const prefix of ['"${HOME}"', '"$HOME"', "${HOME}", "$HOME"]) {
    const rest = raw.slice(prefix.length);
    if (raw.startsWith(prefix) && (rest.length === 0 || rest.startsWith("/"))) return rest;
  }
  for (const prefix of ['"${HOME}', '"$HOME']) {
    const rest = raw.slice(prefix.length);
    if (raw.startsWith(prefix) && rest.startsWith("/")) return `"${rest}`;
  }
  return null;
}

/** A raw word as the absolute path the shell hands the program, seen from `dir`; null when the text does not settle it (an expansion, a glob, a brace). */
function resolveWord(raw: string, dir: string, home: string): string | null {
  const rest = homeRest(raw);
  const body = rest ?? raw;
  if (hasExpansion(body)) return null;
  const text = wordText(body);
  if ((rest === null && text.length === 0) || /[*?[\]{}$`]/.test(text)) return null;
  if (rest !== null) return resolve(home, `.${text}`);
  return isAbsolute(text) ? resolve(text) : resolve(dir, text);
}

/** Whether `path` is `inner` itself or a directory holding it. */
function holds(path: string, inner: string): boolean {
  return inner === path || inner.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/** A segment's program words and output redirect targets, as written; null when a redirection cannot be read with confidence. */
function splitRedirections(marked: string): { readonly words: readonly string[]; readonly targets: readonly string[] } | null {
  const raws = rawWords(marked);
  let at = 0;
  while (at < raws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raws[at] ?? "")) at += 1;
  const words: string[] = [];
  const targets: string[] = [];
  for (; at < raws.length; at += 1) {
    const raw = raws[at] ?? "";
    if (raw === PROCESS_SUBSTITUTION) continue;
    const operator = REDIRECT_WORD.exec(raw)?.[0];
    if (operator === undefined) {
      // `hi>x`: the shell splits the word at the `>`.
      if (hasUnquotedRedirect(raw)) return null;
      words.push(raw);
      continue;
    }
    // `<>` opens a file to write; `>& word` writes word unless it is a descriptor.
    if (operator.endsWith("<>")) return null;
    const target = operator.length === raw.length ? raws[(at += 1)] : raw.slice(operator.length);
    if (target === undefined) return null;
    if (operator.endsWith("&")) {
      if (!/^(?:\d+|-)$/.test(target)) return null;
      continue;
    }
    if (operator.includes(">") && target !== PROCESS_SUBSTITUTION) targets.push(target);
  }
  // redirections.ts reads the same text quote by quote; both must find the same files.
  if (targets.length !== outputRedirectionTargets(marked).filter((target) => target !== PROCESS_SUBSTITUTION).length) return null;
  return { words, targets };
}

/**
 * The places a segment of a program on the two lists writes: its redirect
 * targets and the files it names. A file the text does not settle counts
 * the directory, as every write did before (rm and cp keep an unknown place
 * beside the files they name, as before). Null when the program is on
 * neither list, or a word cannot be read, so its directory counts.
 */
function listedProgramPlaces(segment: string, dir: string, cwd: string, home: string): readonly (string | null)[] | null {
  const marked = markSubstitutions(segment);
  const split = splitRedirections(marked);
  if (split === null) return null;
  const [program, ...args] = split.words;
  if (program === undefined || program !== wordText(program)) return null;
  const named = WRITES_NO_FILE.has(program) ? (writesNoFile(program, args) ? { files: [], writesDir: false, parentsCount: false } : null) : namedWrites(program, args);
  if (named === null) return null;
  const places: (string | null)[] = named.writesDir ? [dir] : [];
  // A variable may hold an option (`cp $OPTS a b` may be `cp -t src a b`).
  let unknown = !WRITES_NO_FILE.has(program) && args.some((raw) => hasExpansion(homeRest(raw) ?? raw));
  for (const raw of [...named.files, ...split.targets]) {
    const path = resolveWord(raw, dir, home);
    if (path === null) {
      unknown = true;
      continue;
    }
    places.push(path);
    if (named.parentsCount && named.files.includes(raw)) for (const inner of [dir, cwd]) if (holds(path, inner)) places.push(inner);
  }
  if (unknown) places.push((program === "rm" || program === "cp") && places.length > 0 ? null : dir);
  return places;
}

/**
 * Every place `command`, run from `cwd`, writes in, once each: a directory
 * or a file path, or null where it cannot be known without running it. An
 * obviously safe segment writes nowhere and adds nothing. A git segment
 * always counts its own directory (after `cd`, `-C`), even when it also
 * writes a file (`git commit > /tmp/log`): that file says nothing about the
 * branch the commit lands on. `cd -` goes to a directory the text does not name.
 */
export function branchReachPlaces(command: string, cwd: string, home: string): readonly (string | null)[] {
  const places: (string | null)[] = [];
  const add = (place: string | null): void => {
    if (!places.includes(place)) places.push(place);
  };
  for (const { segment, outer, dir } of locateCommandSegments(command, cwd, home, { dashUnknown: true })) {
    // `outer` reads each substitution as one inert word; for a tool whose safety hangs on its arguments that word may be `-delete`.
    if (isObviouslySafeCommand(outer) && (segment === outer || !ARGUMENT_DEPENDENT.has(tokenize(outer)[0] ?? ""))) continue;
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
