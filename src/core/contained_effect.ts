// 0.6.28 T2: whether a command's only effect is inside a temp root.
//
// Measured on 835 real advice blocks (odd/tasks/gate-harmless-daily-work.md):
// 349 were `rm -rf` and writes inside Claude's scratchpad, `/tmp` or
// `$TMPDIR`. Jev reads every path pseudonymised (jev_pseudonyms.ts), so it
// cannot see that a scratchpad is temporary, and it keeps advising against
// deleting one. This layer answers that question from the text and the
// filesystem instead, before Jev, and allows the command locally only when
// every segment is either obviously safe (gate_safe_command.ts) or writes or
// deletes nothing but paths strictly inside a temp root.
//
// It reads the command with its own small shell reader, because the rest of
// the gate's tokenizers drop the quoting that decides what a `$VAR` means.
// Everything it does not positively understand answers false, which only
// sends the command on to the ordinary path:
//   - `$(...)`, backticks, `${...}` other than a bare name, `$1`/`$?`, a
//     subshell or group, a background `&`, a here-string, `<(...)`;
//   - a variable that is neither assigned earlier in the same command (a
//     standalone `VAR=value` or `export VAR=value`) nor one of the temp
//     variables of the environment (HOME, TMPDIR, TMP, TEMP,
//     CLAUDE_CODE_TMPDIR); a prefix assignment (`HOME=/tmp/x rm $HOME`)
//     never counts, since the shell expands the arguments before it;
//   - an unquoted variable whose value would split or glob, any glob other
//     than a final `*` of `rm` inside a temp directory, a `..` component;
//   - a path whose real location (realpath of the deepest existing parent)
//     leaves the temp roots, or that equals or holds home, the session's
//     directory or its repository, or sits in a linked worktree;
//   - a path under a symlink, copy or move made earlier in the same
//     command, which the filesystem cannot show yet;
//   - an interpreter fed code, a heredoc to anything but `cat`/`tee`, and an
//     unquoted heredoc whose body would expand `$` or backticks;
//   - a copy or a `cat` whose source is outside the temp roots (reading a
//     secret into /tmp is a copy, judged like `cp`).
// The Bash tool runs the owner's shell, zsh as often as bash, so zsh's own
// expansions fail closed too: `$S:h` and `$S[1]`, `=cmd`, `>!`, and a
// relative `cd` (cdpath).
// 0.6.28 T6: the same reading also answers isOwnTreeWork -- plain file writes
// and local git in the session's own working tree on a working branch (see
// that function), where the temp roots alone answer isContainedToTempRoots.
// Which segments run is followed through `&&`, `||` and `;` the way the
// shell runs them, so `cd /tmp/x; rm -rf src` (a failed cd deletes the
// project's src) is not contained while `cd /tmp/x && rm -rf src` is.
import { posix } from "node:path";

import { isSafeSegment } from "./gate_safe_command.ts";

export interface ContainedEffectInput {
  /** Temp roots as the environment names them (tempRootsFromEnvironment); realpath'd here. */
  readonly tempRoots: readonly string[];
  /** The session's directory, where relative paths start. */
  readonly cwd: string;
  /** The hook's environment: HOME and the temp variables are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The real path of an existing path, null when it does not exist. */
  readonly realpath: (path: string) => string | null;
  /** The session's repository root, or null outside one: never contained. */
  readonly sessionRepoRoot: string | null;
  /** Whether a real path sits in a linked worktree: real work, never contained. */
  readonly isLinkedWorktree: (path: string) => boolean;
}

/**
 * 0.6.28 T6: one repository working tree as the hook reads it: its root, its
 * current branch (null when detached or unknown) and the git directory it
 * shares with its linked worktrees.
 */
export interface OwnTree {
  readonly root: string;
  readonly branch: string | null;
  readonly commonDir: string | null;
}

/** 0.6.28 T6: what isOwnTreeWork needs beyond the temp reading. */
export interface OwnTreeInput {
  /** The working tree a path sits in, or null outside any repository. */
  readonly treeOf: (path: string) => OwnTree | null;
  /** Branch names, lower case, that are never an own tree (client_reach.ts's SHARED_BRANCH_NAMES). */
  readonly protectedBranches: ReadonlySet<string>;
}

/** The variables a command may use without assigning them first. */
const ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set(["HOME", "TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"]);

/**
 * Names whose value steers the shell or the programs it runs (`IFS=/`
 * splits `$S` into relative words, `PATH` picks which `rm` runs, `HOME`
 * moves `~`, `GIT_DIR` moves `git init`): assigning one is never read.
 */
const STEERING_NAMES: ReadonlySet<string> = new Set(["IFS", "PATH", "CDPATH", "HOME", "ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "GLOBIGNORE", "PWD", "OLDPWD", "PS4", "PROMPT_COMMAND", "POSIXLY_CORRECT"]);
const STEERING_PREFIXES: readonly string[] = ["LD_", "DYLD_", "GIT_", "NODE_", "NPM_", "npm_"];

/** More states than this (each `cd`/`||` branch doubles them) is not worth reading. */
const MAX_STATES = 16;

/**
 * The temp roots the environment names: `os.tmpdir()`, `$TMPDIR`, `/tmp`,
 * `/private/tmp`, `/var/folders`, and Claude's per-user root
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>` (where its scratchpads live). Nothing is
 * hardcoded per machine; a relative or empty value is ignored.
 */
export function tempRootsFromEnvironment(env: Readonly<Record<string, string | undefined>>, tmpdir: string, uid: number | null): readonly string[] {
  const claude = env["CLAUDE_CODE_TMPDIR"];
  const candidates = [tmpdir, env["TMPDIR"], "/tmp", "/private/tmp", "/var/folders", claude !== undefined && uid !== null ? `${claude}/claude-${uid}` : undefined];
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || !posix.isAbsolute(candidate)) continue;
    const root = withoutTrailingSlash(posix.normalize(candidate));
    if (root !== "/" && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// ---------------------------------------------------------------------------
// Reading the command
// ---------------------------------------------------------------------------

type Quote = "none" | "single" | "double";

type WordPart =
  | { readonly kind: "text"; readonly text: string; readonly quote: Quote }
  | { readonly kind: "var"; readonly name: string; readonly quote: Quote }
  | { readonly kind: "tilde" };

type Word = readonly WordPart[];

type Joiner = "&&" | "||" | ";" | "|";

type Redirect =
  | { readonly kind: "out"; readonly target: Word }
  | { readonly kind: "in"; readonly target: Word }
  | { readonly kind: "dup" };

interface Heredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
  body: string | null;
}

interface Segment {
  /** What joins it to the previous segment; null for the first. */
  readonly joiner: Joiner | null;
  /** Its own text, without any heredoc body. */
  readonly raw: string;
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly heredoc: Heredoc | null;
}

/** Thrown inside the reader for anything it does not understand; caught once. */
class Unreadable extends Error {}

function unreadable(): never {
  throw new Unreadable();
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const WORD_END = /[\s;&|()<>]/;

class Reader {
  private index = 0;
  private readonly segments: Segment[] = [];
  private pendingHeredocs: Heredoc[] = [];
  private joiner: Joiner | null = null;
  private words: Word[] = [];
  private redirects: Redirect[] = [];
  private heredoc: Heredoc | null = null;
  private start = -1;
  private end = -1;

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  read(): readonly Segment[] {
    const { text } = this;
    while (this.index < text.length) {
      const char = text[this.index] ?? "";
      const next = text[this.index + 1] ?? "";
      if (char === " " || char === "\t") this.index += 1;
      else if (char === "\\" && next === "\n") this.index += 2;
      else if (char === "#") this.skipComment();
      else if (char === "\n") {
        this.endSegment(";", true);
        this.index += 1;
        this.readHeredocBodies();
      } else if (char === ";") {
        if (next === ";") unreadable();
        this.endSegment(";", false);
        this.index += 1;
      } else if (char === "&") {
        if (next === "&") {
          this.endSegment("&&", false);
          this.index += 2;
        } else if (next === ">") this.readRedirect();
        else unreadable();
      } else if (char === "|") {
        if (next === "|") {
          this.endSegment("||", false);
          this.index += 2;
        } else if (next === "&") unreadable();
        else {
          this.endSegment("|", false);
          this.index += 1;
        }
      } else if (char === "(" || char === ")") unreadable();
      else if (char === "<" || char === ">") this.readRedirect();
      else {
        const begin = this.index;
        const word = this.readWord();
        const after = text[this.index] ?? "";
        const digitsOnly = word.length === 1 && word[0]?.kind === "text" && word[0].quote === "none" && /^\d+$/.test(word[0].text);
        if ((after === "<" || after === ">") && digitsOnly) {
          this.mark(begin);
          this.readRedirect();
        } else {
          this.mark(begin);
          this.words.push(word);
          this.mark(this.index);
        }
      }
    }
    this.endSegment(null, false);
    if (this.pendingHeredocs.length > 0) unreadable();
    return this.segments;
  }

  private mark(position: number): void {
    if (this.start === -1) this.start = position;
    this.end = position;
  }

  private skipComment(): void {
    while (this.index < this.text.length && this.text[this.index] !== "\n") this.index += 1;
  }

  /** Closes the segment being read; `joinerAfter` joins it to the next one. */
  private endSegment(joinerAfter: Joiner | null, fromNewline: boolean): void {
    const empty = this.words.length === 0 && this.redirects.length === 0;
    if (empty) {
      // A newline after `&&`, `||` or `|` continues the list; any other
      // empty segment between two joiners is not a command.
      if (fromNewline) return;
      const dangling = this.segments.length > 0 && (this.joiner === "&&" || this.joiner === "||" || this.joiner === "|");
      if ((joinerAfter === ";" || joinerAfter === null) && !dangling) return;
      unreadable();
    }
    this.segments.push({
      joiner: this.segments.length === 0 ? null : this.joiner ?? ";",
      raw: this.text.slice(this.start, this.end).trim(),
      words: this.words,
      redirects: this.redirects,
      heredoc: this.heredoc,
    });
    this.words = [];
    this.redirects = [];
    this.heredoc = null;
    this.start = -1;
    this.end = -1;
    if (joinerAfter === null) {
      if (this.joiner === "&&" || this.joiner === "||" || this.joiner === "|") this.joiner = null;
      return;
    }
    this.joiner = joinerAfter;
  }

  private readHeredocBodies(): void {
    for (const heredoc of this.pendingHeredocs) {
      const lines: string[] = [];
      for (;;) {
        if (this.index >= this.text.length) unreadable();
        const lineEnd = this.text.indexOf("\n", this.index);
        const line = this.text.slice(this.index, lineEnd === -1 ? this.text.length : lineEnd);
        this.index = lineEnd === -1 ? this.text.length : lineEnd + 1;
        if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
        lines.push(line);
      }
      heredoc.body = lines.join("\n");
    }
    this.pendingHeredocs = [];
  }

  private readRedirect(): void {
    const { text } = this;
    this.mark(this.index);
    const char = text[this.index] ?? "";
    const next = text[this.index + 1] ?? "";
    if (char === "&") {
      // `&>` and `&>>`: stdout and stderr to a file.
      this.index += next === ">" && text[this.index + 2] === ">" ? 3 : 2;
      this.redirects.push({ kind: "out", target: this.readTarget() });
      return;
    }
    if (char === ">") {
      if (next === "(") unreadable();
      if (next === "&") {
        this.index += 2;
        this.readDuplicatedDescriptor();
        return;
      }
      this.index += next === ">" || next === "|" ? 2 : 1;
      this.redirects.push({ kind: "out", target: this.readTarget() });
      return;
    }
    // `<`
    if (next === "(" || next === ">") unreadable();
    if (next === "&") {
      this.index += 2;
      this.readDuplicatedDescriptor();
      return;
    }
    if (next === "<") {
      if (text[this.index + 2] === "<") unreadable();
      const stripTabs = text[this.index + 2] === "-";
      this.index += stripTabs ? 3 : 2;
      this.readHeredocOpener(stripTabs);
      return;
    }
    this.index += 1;
    this.redirects.push({ kind: "in", target: this.readTarget() });
  }

  private readDuplicatedDescriptor(): void {
    const match = /^(?:\d+|-)/.exec(this.text.slice(this.index));
    if (match === null) unreadable();
    this.index += match[0].length;
    if (this.index < this.text.length && !WORD_END.test(this.text[this.index] ?? "")) unreadable();
    this.redirects.push({ kind: "dup" });
    this.mark(this.index);
  }

  private readTarget(): Word {
    // zsh's `>!` clobbers the NEXT word, not a file named `!`.
    if (this.text[this.index] === "!") unreadable();
    while (this.text[this.index] === " " || this.text[this.index] === "\t") this.index += 1;
    const word = this.readWord();
    if (word.length === 0) unreadable();
    this.mark(this.index);
    return word;
  }

  private readHeredocOpener(stripTabs: boolean): void {
    if (this.heredoc !== null) unreadable();
    while (this.text[this.index] === " " || this.text[this.index] === "\t") this.index += 1;
    let raw = "";
    while (this.index < this.text.length && !/[\s;&|()<>]/.test(this.text[this.index] ?? "")) {
      raw += this.text[this.index];
      this.index += 1;
    }
    const delimiter = raw.replace(/['"\\]/g, "");
    if (delimiter.length === 0) unreadable();
    const heredoc: Heredoc = { delimiter, quoted: /['"\\]/.test(raw), stripTabs, body: null };
    this.heredoc = heredoc;
    this.pendingHeredocs.push(heredoc);
    this.mark(this.index);
  }

  /** One shell word from the current position, its quoting kept per part. */
  private readWord(): Word {
    const { text } = this;
    const parts: WordPart[] = [];
    const pushText = (piece: string, quote: Quote): void => {
      const last = parts[parts.length - 1];
      if (last !== undefined && last.kind === "text" && last.quote === quote) parts[parts.length - 1] = { kind: "text", text: last.text + piece, quote };
      else parts.push({ kind: "text", text: piece, quote });
    };
    while (this.index < text.length) {
      const char = text[this.index] ?? "";
      if (WORD_END.test(char)) break;
      if (char === "\\") {
        const escaped = text[this.index + 1];
        if (escaped === undefined) unreadable();
        if (escaped !== "\n") pushText(escaped, "single");
        this.index += 2;
      } else if (char === "'") {
        const close = text.indexOf("'", this.index + 1);
        if (close === -1) unreadable();
        pushText(text.slice(this.index + 1, close), "single");
        this.index = close + 1;
      } else if (char === '"') {
        this.index += 1;
        this.readDoubleQuoted(parts, pushText);
      } else if (char === "$") {
        parts.push(this.readVariable("none"));
      } else if (char === "`" || char === "{" || char === "}") {
        unreadable();
      } else if (char === "=" && this.tildeMayStartHere(parts)) {
        // zsh expands `=cmd` to the program's path.
        unreadable();
      } else if (char === "~" && this.tildeMayStartHere(parts)) {
        const after = text[this.index + 1] ?? "";
        if (after !== "" && after !== "/" && !WORD_END.test(after)) unreadable();
        parts.push({ kind: "tilde" });
        this.index += 1;
      } else {
        pushText(char, "none");
        this.index += 1;
      }
    }
    return parts;
  }

  /** At the start of a word, or right after the `=` of an assignment. */
  private tildeMayStartHere(parts: readonly WordPart[]): boolean {
    if (parts.length === 0) return true;
    const only = parts[0];
    return parts.length === 1 && only?.kind === "text" && only.quote === "none" && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(only.text);
  }

  private readDoubleQuoted(parts: WordPart[], pushText: (piece: string, quote: Quote) => void): void {
    const { text } = this;
    for (;;) {
      if (this.index >= text.length) unreadable();
      const char = text[this.index] ?? "";
      if (char === '"') {
        this.index += 1;
        // An empty "" still makes a (possibly empty) word.
        if (parts.length === 0) pushText("", "double");
        return;
      }
      if (char === "\\") {
        const escaped = text[this.index + 1] ?? "";
        if ("$`\"\\".includes(escaped) && escaped !== "") pushText(escaped, "double");
        else if (escaped !== "\n") pushText(`\\${escaped}`, "double");
        this.index += 2;
      } else if (char === "$") {
        parts.push(this.readVariable("double"));
      } else if (char === "`") {
        unreadable();
      } else {
        pushText(char, "double");
        this.index += 1;
      }
    }
  }

  /** `$NAME` or `${NAME}`; anything else after `$` is not read. */
  private readVariable(quote: Quote): WordPart {
    const { text } = this;
    const next = text[this.index + 1] ?? "";
    if (next === "{") {
      const close = text.indexOf("}", this.index + 2);
      if (close === -1) unreadable();
      const name = text.slice(this.index + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) unreadable();
      this.index = close + 1;
      return { kind: "var", name, quote };
    }
    if (!NAME_START.test(next)) unreadable();
    let end = this.index + 1;
    while (end < text.length && NAME_CHAR.test(text[end] ?? "")) end += 1;
    const name = text.slice(this.index + 1, end);
    // zsh applies `:h`/`:t` modifiers and `[n]` subscripts to an unbraced
    // parameter, inside double quotes too: `$S:h:h` reaches `/`.
    if (text[end] === ":" || text[end] === "[") unreadable();
    this.index = end;
    return { kind: "var", name, quote };
  }
}

function readSegments(command: string): readonly Segment[] | null {
  try {
    return new Reader(command).read();
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Expanding words
// ---------------------------------------------------------------------------

type Glob = "none" | "star" | "other";

interface Expanded {
  readonly text: string;
  readonly glob: Glob;
}

interface State {
  readonly cwd: string;
  readonly status: "ok" | "fail" | "any";
  readonly vars: ReadonlyMap<string, string>;
}

function variableValue(name: string, vars: ReadonlyMap<string, string>, env: Readonly<Record<string, string | undefined>>): string | null {
  const assigned = vars.get(name);
  if (assigned !== undefined) return assigned;
  return ENVIRONMENT_VARIABLES.has(name) ? env[name] ?? null : null;
}

/** A word as the shell would hand it to the program, or null when that cannot be known from the text. */
function expandWord(word: Word, vars: ReadonlyMap<string, string>, env: Readonly<Record<string, string | undefined>>, splits: boolean): Expanded | null {
  let text = "";
  let glob: Glob = "none";
  for (const part of word) {
    if (part.kind === "tilde") {
      const home = env["HOME"];
      if (home === undefined || !posix.isAbsolute(home)) return null;
      text += home;
    } else if (part.kind === "var") {
      const value = variableValue(part.name, vars, env);
      if (value === null) return null;
      if (splits && part.quote === "none" && (value.length === 0 || /[\s*?[\]]/.test(value))) return null;
      text += value;
    } else {
      if (splits && part.quote === "none") {
        if (/[?[\]]/.test(part.text)) glob = "other";
        else if (part.text.includes("*")) glob = glob === "none" ? "star" : "other";
      }
      text += part.text;
    }
  }
  return { text, glob };
}

function isAssignment(word: Word): boolean {
  const first = word[0];
  return first !== undefined && first.kind === "text" && first.quote === "none" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text);
}

/** `NAME=value` as the shell assigns it: no splitting, no globbing. */
function assign(word: Word, vars: Map<string, string>, env: Readonly<Record<string, string | undefined>>): boolean {
  const first = word[0];
  if (first === undefined || first.kind !== "text") return false;
  const equals = first.text.indexOf("=");
  const name = first.text.slice(0, equals);
  if (STEERING_NAMES.has(name) || STEERING_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  const rest: WordPart[] = [{ kind: "text", text: first.text.slice(equals + 1), quote: "none" }, ...word.slice(1)];
  const value = expandWord(rest, vars, env, false);
  if (value === null) return false;
  vars.set(name, value.text);
  return true;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

interface Places {
  readonly input: ContainedEffectInput;
  /** Realpath'd temp roots, none of them `/` or holding home. */
  readonly roots: readonly string[];
  /** Realpath'd home, session directory and repository: never equal to or under a target. */
  readonly guards: readonly string[];
  readonly sessionRepo: string | null;
  /** Symlinks made earlier in this command: nothing at or under them is known. */
  readonly links: string[];
  /** Copy and move destinations made earlier: nothing under them is known. */
  readonly copies: string[];
  /** 0.6.28 T6: set only by isOwnTreeWork; null reads temp roots alone. */
  readonly ownTrees: OwnTreeInput | null;
  /** The session's own tree, its root and common directory realpath'd, when its branch is an own one. */
  readonly sessionTree: OwnTree | null;
}

/** The real location of `path`: realpath of its deepest existing part, the rest appended. */
function realLocation(path: string, realpath: (path: string) => string | null): string | null {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    const real = realpath(current);
    if (real !== null) return rest.length === 0 ? real : posix.join(real, ...rest.reverse());
    if (current === "/") return null;
    rest.push(posix.basename(current));
    current = posix.dirname(current);
  }
}

function isUnder(path: string, parent: string): boolean {
  return path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** `text` resolved against `cwd`, or null with a `..` component or nothing at all. */
function absolutePath(text: string, cwd: string): string | null {
  if (text.length === 0 || text.split("/").includes("..")) return null;
  return withoutTrailingSlash(posix.normalize(posix.isAbsolute(text) ? text : posix.join(cwd, text)));
}

/** Whether `path` (or its real location) sits at or under a symlink, or under a copy, made earlier in this command. */
function madeEarlier(path: string, real: string, places: Places): boolean {
  for (const link of places.links) if (link === path || link === real || isUnder(path, link) || isUnder(real, link)) return true;
  for (const copy of places.copies) if (isUnder(path, copy) || isUnder(real, copy)) return true;
  return false;
}

/** Whether `text`, from `cwd`, is a path strictly inside a temp root and nothing this layer protects. */
function isContainedPath(text: string, cwd: string, places: Places): boolean {
  const path = absolutePath(text, cwd);
  if (path === null) return false;
  const real = realLocation(path, places.input.realpath);
  if (real === null) return false;
  if (madeEarlier(path, real, places)) return false;
  if (!places.roots.some((root) => isUnder(real, root))) return false;
  // A root nested in another (TMPDIR in /var/folders) is never a target either.
  if (places.roots.some((root) => root === real || isUnder(root, real))) return false;
  if (places.guards.some((guard) => guard === real || isUnder(guard, real))) return false;
  if (places.sessionRepo !== null && isUnder(real, places.sessionRepo)) return false;
  return !places.input.isLinkedWorktree(real);
}

/** A tree whose branch is known and not shared, with its root and common directory realpath'd; null otherwise. */
function ownBranchTree(tree: OwnTree | null, places: Places): OwnTree | null {
  const own = places.ownTrees;
  if (tree === null || own === null || tree.branch === null || own.protectedBranches.has(tree.branch.toLowerCase())) return null;
  const root = realLocation(tree.root, places.input.realpath);
  if (root === null) return null;
  const commonDir = tree.commonDir === null ? null : realLocation(tree.commonDir, places.input.realpath);
  return { root, branch: tree.branch, commonDir };
}

/**
 * 0.6.28 T6: the own tree a real path sits in, when the command may write
 * there: the session's tree, a linked worktree of the same repository, or
 * the tree the command itself runs in (`cd`, `git -C`), each on a known,
 * non-shared branch. Null for any other repository.
 */
function writableTreeAt(real: string, cwd: string, places: Places): OwnTree | null {
  const own = places.ownTrees;
  if (own === null) return null;
  const tree = ownBranchTree(own.treeOf(real), places);
  if (tree === null) return null;
  const session = places.sessionTree;
  if (session !== null && (tree.root === session.root || (tree.commonDir !== null && tree.commonDir === session.commonDir))) return tree;
  const acting = realLocation(cwd, places.input.realpath);
  const actingTree = acting === null ? null : ownBranchTree(own.treeOf(acting), places);
  return actingTree !== null && actingTree.root === tree.root ? tree : null;
}

/**
 * 0.6.28 T6: whether `text`, from `cwd`, is a file or directory strictly
 * inside an own working tree -- never the tree's root, never its `.git`,
 * never through a symlink or a `..` that leaves it (the written path and its
 * real location must be in the same tree), never home or the session's
 * directory itself.
 */
function isOwnTreePath(text: string, cwd: string, places: Places): boolean {
  const own = places.ownTrees;
  if (own === null) return false;
  const path = absolutePath(text, cwd);
  if (path === null) return false;
  const real = realLocation(path, places.input.realpath);
  if (real === null || madeEarlier(path, real, places)) return false;
  const tree = writableTreeAt(real, cwd, places);
  if (tree === null || !isUnder(real, tree.root)) return false;
  const written = own.treeOf(path);
  if (written === null || realLocation(written.root, places.input.realpath) !== tree.root) return false;
  const gitDir = `${tree.root}/.git`;
  if (real === gitDir || isUnder(real, gitDir)) return false;
  return !places.guards.some((guard) => guard !== tree.root && (guard === real || isUnder(guard, real)));
}

/** A path this command may write: inside a temp root, or (isOwnTreeWork only) inside an own working tree. */
function isWritablePath(text: string, cwd: string, places: Places): boolean {
  return isContainedPath(text, cwd, places) || isOwnTreePath(text, cwd, places);
}

/** `rm`'s one accepted glob: a final `*` in a directory strictly inside a temp root. */
function isContainedGlob(text: string, cwd: string, places: Places): boolean {
  if (!text.endsWith("/*")) return false;
  const parent = text.slice(0, -2);
  return !parent.includes("*") && isContainedPath(parent, cwd, places);
}

function rememberPath(text: string, cwd: string, places: Places, into: string[]): void {
  const path = absolutePath(text, cwd);
  if (path === null) return;
  into.push(path);
  const real = realLocation(path, places.input.realpath);
  if (real !== null && real !== path) into.push(real);
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** The arguments after a program's options: every `-x` before `--` (or the first operand) is an option. */
function splitOptions(args: readonly Expanded[]): { readonly options: readonly string[]; readonly operands: readonly Expanded[] } {
  const options: string[] = [];
  let index = 0;
  while (index < args.length) {
    const text = args[index]?.text ?? "";
    if (text === "--") {
      index += 1;
      break;
    }
    if (!text.startsWith("-") || text === "-") break;
    options.push(text);
    index += 1;
  }
  return { options, operands: args.slice(index) };
}

function allOptions(options: readonly string[], allowed: RegExp): boolean {
  return options.every((option) => allowed.test(option));
}

function operandsContained(operands: readonly Expanded[], cwd: string, places: Places): boolean {
  return operands.every((operand) => operand.glob === "none" && isWritablePath(operand.text, cwd, places));
}

/** Programs whose output is only the text they were given or a temp file's content. */
const DATA_PRODUCERS: ReadonlySet<string> = new Set(["echo", "printf", "cat", "tee"]);

/** Programs that read stdin into what they write: their pipe input must be data too. */
const STDIN_WRITERS: ReadonlySet<string> = new Set(["cat", "tee"]);

const WRITERS: ReadonlySet<string> = new Set(["rm", "mkdir", "touch", "cp", "mv", "ln", "cat", "echo", "printf", "tee", "git", "sed"]);

/** Whether `program` with `args`, run from `cwd`, writes only inside the temp roots. */
function writerContained(program: string, args: readonly Expanded[], cwd: string, places: Places): boolean {
  if (program === "echo" || program === "printf") return true;
  if (program === "git") return args[0]?.text === "init" ? gitInitContained(args, cwd, places) : localGitContained(args, cwd, places);
  if (program === "sed") return sedInPlaceContained(args, cwd, places);
  const { options, operands } = splitOptions(args);
  switch (program) {
    case "rm": {
      // In an own tree only files: no -r, no glob (T6).
      const filesOnly = allOptions(options, /^-[fv]+$/);
      return (
        operands.length > 0 &&
        operands.every((operand) =>
          operand.glob === "star"
            ? isContainedGlob(operand.text, cwd, places)
            : operand.glob === "none" && (isContainedPath(operand.text, cwd, places) || (filesOnly && isOwnTreePath(operand.text, cwd, places))),
        )
      );
    }
    case "mkdir":
      return mkdirContained(args, cwd, places);
    case "touch":
      return allOptions(options, /^-[acm]+$/) && operands.length > 0 && operandsContained(operands, cwd, places);
    case "cat":
      return allOptions(options, /^-[nbsvetuAE]+$/) && operandsContained(operands, cwd, places);
    case "tee":
      return allOptions(options, /^(?:-a|--append)$/) && operandsContained(operands, cwd, places);
    case "cp":
    case "mv": {
      if (!allOptions(options, program === "cp" ? /^-[rRpafvn]+$/ : /^-[fnv]+$/)) return false;
      if (operands.length < 2 || !operandsContained(operands, cwd, places)) return false;
      rememberPath(operands[operands.length - 1]?.text ?? "", cwd, places, places.copies);
      return true;
    }
    case "ln": {
      // Only a symlink: a hard link to a file outside would be written through.
      if (!allOptions(options, /^-[sfnv]+$/) || !options.some((option) => option.includes("s"))) return false;
      const link = operands[1];
      if (operands.length !== 2 || link === undefined || link.glob !== "none" || operands[0]?.glob !== "none") return false;
      if (!isWritablePath(link.text, cwd, places)) return false;
      rememberPath(link.text, cwd, places, places.links);
      return true;
    }
    default:
      return false;
  }
}

function mkdirContained(args: readonly Expanded[], cwd: string, places: Places): boolean {
  const operands: Expanded[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "-m") index += 1;
    else if (/^-[pv]+$/.test(text) || text === "--parents" || text === "--verbose" || /^-m./.test(text) || text.startsWith("--mode=")) continue;
    else if (text.startsWith("-")) return false;
    else operands.push(args[index] ?? { text: "", glob: "none" });
  }
  return operands.length > 0 && operandsContained(operands, cwd, places);
}

/** `git init [-q] [-b <name>] [<dir>]`, its directory inside a temp root; no other git command writes here. */
function gitInitContained(args: readonly Expanded[], cwd: string, places: Places): boolean {
  if (args[0]?.text !== "init") return false;
  const operands: Expanded[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (text === "-b" || text === "--initial-branch") index += 1;
    else if (text === "-q" || text === "--quiet" || text.startsWith("--initial-branch=")) continue;
    else if (text.startsWith("-")) return false;
    else operands.push(args[index] ?? { text: "", glob: "none" });
  }
  if (operands.length > 1) return false;
  const dir = operands[0];
  return dir === undefined ? isContainedPath(cwd, cwd, places) : dir.glob === "none" && isContainedPath(dir.text, cwd, places);
}

/**
 * 0.6.28 T6: a sed script made only of `s` commands, each with an optional
 * address (`N`, `$`, `/re/`, a range), whose flags only choose which match
 * and how (`g`, `p`, `i`/`I`, `m`/`M`, a number). GNU sed's `e` flag and
 * command run a shell, `w` writes another file and `r`/`R` read one into
 * this one, so a script with any of them, or anything else, is not read.
 * The existing sed reading (git_discard.ts's scriptProgramCodePosition) finds
 * where the script is, not what it may do, so this is its own small reader.
 */
function isSubstitutionOnlySedScript(script: string): boolean {
  let index = 0;
  const skipAddress = (): boolean => {
    for (let part = 0; part < 2; part += 1) {
      if (/\d/.test(script[index] ?? "")) while (/\d/.test(script[index] ?? "")) index += 1;
      else if (script[index] === "$") index += 1;
      else if (script[index] === "/") {
        index += 1;
        while (index < script.length && script[index] !== "/") index += script[index] === "\\" ? 2 : 1;
        if (script[index] !== "/") return false;
        index += 1;
        if (script[index] === "I") index += 1;
      } else if (part === 1) return false;
      if (part === 0 && script[index] === ",") index += 1;
      else break;
    }
    return true;
  };
  let commands = 0;
  while (index < script.length) {
    while (/[\s;]/.test(script[index] ?? "")) index += 1;
    if (index >= script.length) break;
    if (!skipAddress()) return false;
    while (script[index] === " ") index += 1;
    if (script[index] !== "s") return false;
    const delimiter = script[index + 1] ?? "";
    if (delimiter === "" || delimiter === "\\" || delimiter === "\n" || /\s/.test(delimiter)) return false;
    index += 2;
    for (let part = 0; part < 2; part += 1) {
      while (index < script.length && script[index] !== delimiter) index += script[index] === "\\" ? 2 : 1;
      if (script[index] !== delimiter) return false;
      index += 1;
    }
    while (/[gpiImM0-9]/.test(script[index] ?? "")) index += 1;
    commands += 1;
    if (index < script.length && !/[\s;]/.test(script[index] ?? "")) return false;
  }
  return commands > 0;
}

/** `sed -i[suffix] [-i ''] [-E|-r] [-e script]... [script] file...`, every file writable and every script substitution-only. */
function sedInPlaceContained(args: readonly Expanded[], cwd: string, places: Places): boolean {
  const scripts: string[] = [];
  const files: Expanded[] = [];
  let inPlace = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? { text: "", glob: "none" };
    const text = arg.text;
    if (text === "-i" || text === "--in-place") {
      inPlace = true;
      // BSD sed's suffix is its own word, empty for none: `-i ''`.
      if (args[index + 1]?.text === "") index += 1;
    } else if (/^-i[\w.~-]+$/.test(text) || text.startsWith("--in-place=")) inPlace = true;
    else if (text === "-E" || text === "-r" || text === "--regexp-extended") continue;
    else if (text === "-e" || text === "--expression") {
      scripts.push(args[index + 1]?.text ?? "");
      index += 1;
    } else if (text.startsWith("-")) return false;
    else if (scripts.length === 0 && files.length === 0 && !args.slice(0, index).some((a) => a.text === "-e" || a.text === "--expression")) scripts.push(text);
    else files.push(arg);
  }
  return inPlace && scripts.length > 0 && scripts.every(isSubstitutionOnlySedScript) && files.length > 0 && operandsContained(files, cwd, places);
}

/** A branch name a local git command may create or switch to: plain, and not a shared one. */
function isOwnBranchName(name: string, places: Places): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..")) return false;
  const shared = places.ownTrees?.protectedBranches ?? new Set<string>();
  const last = name.slice(name.lastIndexOf("/") + 1);
  return !shared.has(name.toLowerCase()) && !shared.has(last.toLowerCase());
}

/**
 * 0.6.28 T6: git that only changes the own tree's index, its branch list or
 * its own history on a working branch: `add`, `commit` (never
 * `--no-verify`/`-n`), `checkout -b`, `switch -c`/`switch <name>`, `stash`
 * (`push`/`save`), `restore --staged`. Only `-C <dir>` may come before the
 * subcommand. Never anything that discards work, rewrites history from
 * elsewhere, pushes, or names a shared branch.
 */
function localGitContained(args: readonly Expanded[], cwd: string, places: Places): boolean {
  if (places.ownTrees === null || args.some((arg) => arg.glob === "other")) return false;
  let at = 0;
  let dir = cwd;
  if (args[0]?.text === "-C") {
    const named = absolutePath(args[1]?.text ?? "", cwd);
    if (named === null) return false;
    dir = named;
    at = 2;
  }
  const realDir = realLocation(dir, places.input.realpath);
  if (realDir === null) return false;
  const tree = writableTreeAt(realDir, dir, places);
  if (tree === null || realDir === `${tree.root}/.git` || isUnder(realDir, `${tree.root}/.git`)) return false;
  const subcommand = args[at]?.text ?? "";
  const rest = args.slice(at + 1).map((arg) => arg.text);
  const quiet = (word: string): boolean => word === "-q" || word === "--quiet";
  switch (subcommand) {
    case "add":
      return true;
    case "commit":
      return !rest.some((word) => word === "--no-verify" || /^-[A-Za-z]*n[A-Za-z]*$/.test(word));
    case "checkout": {
      const words = rest.filter((word) => !quiet(word));
      return words[0] === "-b" && (words.length === 2 || words.length === 3) && words.slice(1).every((name) => isOwnBranchName(name, places));
    }
    case "switch": {
      const words = rest.filter((word) => !quiet(word));
      if (words[0] === "-c") return (words.length === 2 || words.length === 3) && words.slice(1).every((name) => isOwnBranchName(name, places));
      return words.length === 1 && isOwnBranchName(words[0] ?? "", places);
    }
    case "stash":
      return rest.length === 0 || rest[0] === "push" || rest[0] === "save";
    case "restore":
      return rest.some((word) => word === "--staged" || word === "-S") && !rest.some((word) => word === "--worktree" || /^-[A-Za-z]*W/.test(word));
    default:
      return false;
  }
}

function redirectsContained(segment: Segment, state: State, places: Places): boolean {
  for (const redirect of segment.redirects) {
    if (redirect.kind === "dup") continue;
    const target = expandWord(redirect.target, state.vars, places.input.env, true);
    if (target === null || target.glob !== "none") return false;
    if (redirect.kind === "out" && target.text === "/dev/null") continue;
    if (!isWritablePath(target.text, state.cwd, places)) return false;
  }
  return true;
}

function heredocIsData(heredoc: Heredoc): boolean {
  if (heredoc.body === null) return false;
  return heredoc.quoted || !/[$`]/.test(heredoc.body);
}

// ---------------------------------------------------------------------------
// Running the segments
// ---------------------------------------------------------------------------

/** How one segment leaves a state: the states after it, or null when it is not contained. */
function runSegment(segment: Segment, state: State, places: Places, piped: boolean, upstreamIsData: boolean): readonly State[] | null {
  const env = places.input.env;
  const words = segment.words;
  const first = words[0];

  if (first !== undefined && (isAssignment(first) || isLiteral(first, "export"))) {
    if (piped || segment.redirects.length > 0 || segment.heredoc !== null) return null;
    const vars = new Map(state.vars);
    const assignments = isLiteral(first, "export") ? words.slice(1) : words;
    for (const word of assignments) {
      if (!isAssignment(word)) {
        // `export NAME` exports what is already set; a bare command after
        // an assignment (`HOME=/tmp/x rm $HOME`) is not read.
        if (isLiteral(first, "export") && word.length === 1 && word[0]?.kind === "text" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word[0].text)) continue;
        return null;
      }
      if (!assign(word, vars, env)) return null;
    }
    return [{ cwd: state.cwd, status: "ok", vars }];
  }

  const any: State = { cwd: state.cwd, status: "any", vars: state.vars };
  if (first === undefined) {
    // A redirection alone (`> file`) creates or truncates its target.
    return segment.heredoc === null && redirectsContained(segment, state, places) ? [any] : null;
  }
  if (!first.every((part) => part.kind === "text")) return null;
  const argv: Expanded[] = [];
  for (const word of words) {
    const expanded = expandWord(word, state.vars, env, true);
    if (expanded === null) return null;
    argv.push(expanded);
  }
  const program = argv[0]?.text ?? "";
  const args = argv.slice(1);

  if (program === "cd") {
    if (piped || segment.redirects.length > 0 || segment.heredoc !== null || args.length > 1) return null;
    // Only an absolute target: CDPATH, or zsh's cdpath from the profile, can
    // send `cd sub` anywhere, and the hook's environment does not show it.
    const target = args.length === 0 ? env["HOME"] ?? null : args[0]?.glob === "none" && posix.isAbsolute(args[0]?.text ?? "") ? absolutePath(args[0]?.text ?? "", state.cwd) : null;
    if (target === null || !posix.isAbsolute(target)) return null;
    return [
      { cwd: target, status: "ok", vars: state.vars },
      { cwd: state.cwd, status: "fail", vars: state.vars },
    ];
  }

  const readOnlyGit = program === "git" && args[0]?.text !== "init" && places.ownTrees === null;
  const readOnlySed = program === "sed" && !args.some((arg) => arg.text === "-i" || arg.text.startsWith("-i") || arg.text.startsWith("--in-place"));
  if (!WRITERS.has(program) || readOnlyGit || readOnlySed) {
    return segment.heredoc === null && isSafeSegment(segment.raw) ? [any] : null;
  }
  if (segment.heredoc !== null && (!STDIN_WRITERS.has(program) || !heredocIsData(segment.heredoc))) return null;
  // `cat`/`tee` with no file to read write their stdin: from a pipe, that
  // must itself be data, or `cat ~/.ssh/id_rsa | tee /tmp/k` is a copy.
  const readsPipe = piped && segment.heredoc === null && (program === "tee" || (program === "cat" && splitOptions(args).operands.length === 0));
  if (readsPipe && !upstreamIsData) return null;
  if (!redirectsContained(segment, state, places)) return null;
  if (writerContained(program, args, state.cwd, places)) return [any];
  // A read-only git command beside own-tree work (`git status`) is still safe.
  return program === "git" && segment.heredoc === null && isSafeSegment(segment.raw) ? [any] : null;
}

function isLiteral(word: Word, text: string): boolean {
  return word.length === 1 && word[0]?.kind === "text" && word[0].quote === "none" && word[0].text === text;
}

function stateKey(state: State): string {
  return JSON.stringify([state.cwd, state.status, [...state.vars].sort()]);
}

function dedupe(states: readonly State[]): State[] {
  const seen = new Map<string, State>();
  for (const state of states) seen.set(stateKey(state), state);
  return [...seen.values()];
}

/** The segments grouped into pipelines; each pipeline carries the joiner before its first stage. */
function pipelines(segments: readonly Segment[]): readonly (readonly Segment[])[] {
  const out: Segment[][] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.joiner === "|" && last !== undefined) last.push(segment);
    else out.push([segment]);
  }
  return out;
}

/** Runs one pipeline from `state`: the states after it, or null when a stage is not contained. */
function runPipeline(stages: readonly Segment[], state: State, places: Places): readonly State[] | null {
  if (stages.length === 1) {
    const only = stages[0];
    return only === undefined ? null : runSegment(only, state, places, false, false);
  }
  let upstreamIsData = true;
  for (const stage of stages) {
    if (runSegment(stage, state, places, true, upstreamIsData) === null) return null;
    const program = stage.words[0]?.[0];
    upstreamIsData = upstreamIsData && program !== undefined && program.kind === "text" && DATA_PRODUCERS.has(program.text);
  }
  return [{ cwd: state.cwd, status: "any", vars: state.vars }];
}

/**
 * True only when every segment of `command` is obviously safe or writes and
 * deletes nothing but paths strictly inside a temp root, in every way the
 * shell could run it -- see the module note for what fails closed.
 */
export function isContainedToTempRoots(command: string, input: ContainedEffectInput): boolean {
  return effectStaysInside(command, input, null);
}

/**
 * 0.6.28 T6: true only when every segment of `command` is obviously safe,
 * contained to a temp root, or plain local work in an own working tree: a
 * file write (the temp writers plus a substitution-only `sed -i`; `rm` of
 * files only), or local git (localGitContained). An own tree is the
 * session's repository, a linked worktree of it, or the tree a `cd`/`git -C`
 * runs in, on a known branch that is not shared -- the same effect as
 * Claude Code's own Edit and Write tools, which the gate never sees.
 */
export function isOwnTreeWork(command: string, input: ContainedEffectInput, ownTrees: OwnTreeInput): boolean {
  return effectStaysInside(command, input, ownTrees);
}

function effectStaysInside(command: string, input: ContainedEffectInput, ownTrees: OwnTreeInput | null): boolean {
  const segments = readSegments(command);
  if (segments === null || segments.length === 0) return false;

  const homeText = input.env["HOME"];
  if (homeText === undefined || !posix.isAbsolute(homeText)) return false;
  const home = realLocation(withoutTrailingSlash(posix.normalize(homeText)), input.realpath);
  const cwd = realLocation(input.cwd, input.realpath);
  if (home === null || cwd === null) return false;
  const roots = input.tempRoots
    .map((root) => input.realpath(root))
    .filter((root): root is string => root !== null && root !== "/" && root !== home && !isUnder(home, root));
  if (roots.length === 0 && ownTrees === null) return false;
  const sessionRepo = input.sessionRepoRoot === null ? null : realLocation(input.sessionRepoRoot, input.realpath);
  const places: Places = { input, roots, guards: [home, cwd, ...(sessionRepo === null ? [] : [sessionRepo])], sessionRepo, links: [], copies: [], ownTrees, sessionTree: null };
  const sessionTree = ownTrees === null ? null : ownBranchTree(ownTrees.treeOf(cwd), places);
  const evaluated: Places = { ...places, sessionTree };

  let states: State[] = [{ cwd: input.cwd, status: "any", vars: new Map() }];
  for (const stages of pipelines(segments)) {
    const joiner = stages[0]?.joiner ?? null;
    const next: State[] = [];
    for (const state of states) {
      const runs = joiner === "&&" ? state.status !== "fail" : joiner === "||" ? state.status !== "ok" : true;
      if (joiner === "&&" && state.status !== "ok") next.push({ ...state, status: "fail" });
      if (joiner === "||" && state.status !== "fail") next.push({ ...state, status: "ok" });
      if (!runs) continue;
      const after = runPipeline(stages, state, evaluated);
      if (after === null) return false;
      next.push(...after);
    }
    states = dedupe(next);
    if (states.length > MAX_STATES) return false;
  }
  return true;
}
