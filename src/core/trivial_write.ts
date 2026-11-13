// odd/tasks/gate-ignored-files-not-main.md: the write targets of a
// trivially safe shell command, or null for any other command.
//
// The gate may set never_write_to_main aside for a write on main only when
// git verifies that every file the command writes is ignored
// (ignored_files.ts). That is sound only when the text settles every file
// the command can write, so this reads a deliberately small shell: anything
// it does not fully understand is not trivial, and the policy is asked as
// before. A first design that inferred what any command does was bypassed by
// links made in the same command, a cd that fails, assignments that change
// how a name resolves (PATH, HOME, CDPATH) and the like.
//
// Trivially safe means all of this holds:
//   - Every segment (split on `;`, `&&`, `||`, `|` and newlines) runs one of
//     PRINTERS, which write no file (`printf` with no option: `-v` assigns),
//     or one of the named writers below, with only the options listed for
//     it, or is only redirections.
//   - The program is a plain word: no path, no quoting, no `NAME=value`.
//   - No word outside quotes holds `$`, a backtick, `\`, `~`, a glob or
//     brace character, `#`, `!` or parentheses, or starts with `=` (zsh's
//     `=name` is a path from PATH); double quotes hold no `$`,
//     backtick or `\`; no quoted string spans lines. So there is no
//     expansion, substitution, subshell, group, function or comment.
//   - Redirections are `>`, `>>`, `>|` (optionally with an fd), `<`, a
//     heredoc, a here-string, or an fd duplication whose whole word is
//     digits or `-` (`2>&1`, `>&2`, `>&-`; `>&2x.ts` writes 2x.ts).
//     `&>`, `<>`, `>&file` and process substitution are not trivial.
//   - An unquoted heredoc body holds no `$`, backtick or `\` (it would
//     expand); a quoted one is data and is not read at all.
//   - No target has a `..` or `.git` component, and none is empty.
// `/dev/null` is not a target.

/** How a target is written: a file written or created, a file a `mv` removes, a directory created, or a directory created with every missing parent (`mkdir -p`, `install -d`). */
export type TrivialTargetKind = "file" | "removed" | "dir" | "dirs";

export interface TrivialTarget {
  /** The target as the command spells it, quotes removed; relative to the directory the command runs in. */
  readonly word: string;
  readonly kind: TrivialTargetKind;
}

/** Programs that write no file themselves; their redirections still count. */
const PRINTERS: ReadonlySet<string> = new Set(["cat", "echo", "printf", "true"]);

/** Characters a word may hold outside quotes. */
const PLAIN = /^[A-Za-z0-9_.\/@%+,:=-]$/;

interface Word {
  readonly text: string;
  readonly quoted: boolean;
}

type Token = { readonly type: "word"; readonly word: Word } | { readonly type: "sep" } | { readonly type: "write"; readonly target: Word } | { readonly type: "read" };

interface Heredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

/** Reads one word starting at `at`; null when it holds anything outside the small shell above. */
function readWord(command: string, at: number): { readonly word: Word; readonly end: number } | null {
  let text = "";
  let quoted = false;
  let i = at;
  while (i < command.length) {
    const c = command[i] ?? "";
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      const body = command.slice(i + 1, close);
      if (body.includes("\n")) return null;
      text += body;
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      const close = command.indexOf('"', i + 1);
      if (close === -1) return null;
      const body = command.slice(i + 1, close);
      if (/[\n$`\\]/.test(body)) return null;
      text += body;
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">") break;
    // zsh expands an unquoted word that starts with `=` to a path from PATH.
    if (!PLAIN.test(c) || (c === "=" && i === at)) return null;
    text += c;
    i++;
  }
  if (i === at) return null;
  return { word: { text, quoted }, end: i };
}

/** Skips spaces and tabs. */
function skipBlanks(command: string, at: number): number {
  let i = at;
  while (command[i] === " " || command[i] === "\t") i++;
  return i;
}

/** The tokens of `command`, heredoc bodies consumed; null when it is not in the small shell. */
function tokenize(command: string): readonly Token[] | null {
  const tokens: Token[] = [];
  const pending: Heredoc[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i] ?? "";
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\n") {
      tokens.push({ type: "sep" });
      i++;
      // Heredoc bodies start on the line after their operator.
      for (const heredoc of pending.splice(0)) {
        const read = readHeredocBody(command, i, heredoc);
        if (read === null) return null;
        i = read;
      }
      continue;
    }
    if (c === ";") {
      if (command[i + 1] === ";") return null;
      tokens.push({ type: "sep" });
      i++;
      continue;
    }
    if (c === "&") {
      if (command[i + 1] !== "&") return null;
      tokens.push({ type: "sep" });
      i += 2;
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "&") return null;
      tokens.push({ type: "sep" });
      i += command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (c === "<" || c === ">") {
      const read = readRedirection(command, i, tokens, pending);
      if (read === null) return null;
      i = read;
      continue;
    }
    const read = readWord(command, i);
    if (read === null) return null;
    // An fd number glued to a redirection (`2>`) is part of it.
    const next = command[read.end];
    if ((next === "<" || next === ">") && !read.word.quoted && /^[0-9]+$/.test(read.word.text)) {
      i = read.end;
      continue;
    }
    tokens.push({ type: "word", word: read.word });
    i = read.end;
  }
  if (pending.length > 0) return null;
  return tokens;
}

/** Reads a redirection at `at` into `tokens` (a heredoc goes to `pending`); the index after it, or null. */
function readRedirection(command: string, at: number, tokens: Token[], pending: Heredoc[]): number | null {
  const c = command[at];
  let i = at + 1;
  if (c === ">") {
    if (command[i] === "(") return null;
    // `>&2`, `>&-`: an fd duplication, no file. Any other word (`>&2x.ts`, `>&-foo`, `>& file`) is a file bash and zsh write.
    if (command[i] === "&") return fdDuplication(command, i + 1);
    if (command[i] === ">" || command[i] === "|") i++;
    const start = skipBlanks(command, i);
    const read = readWord(command, start);
    if (read === null) return null;
    tokens.push({ type: "write", target: read.word });
    return read.end;
  }
  if (command[i] === "(" || command[i] === ">") return null;
  if (command[i] === "&") return fdDuplication(command, i + 1);
  if (command[i] === "<") {
    i++;
    if (command[i] === "<") {
      // A here-string: its word is data, read like any other word.
      const read = readWord(command, skipBlanks(command, i + 1));
      if (read === null) return null;
      tokens.push({ type: "read" });
      return read.end;
    }
    const stripTabs = command[i] === "-";
    if (stripTabs) i++;
    const read = readWord(command, skipBlanks(command, i));
    if (read === null || read.word.text.length === 0) return null;
    pending.push({ delimiter: read.word.text, quoted: read.word.quoted, stripTabs });
    tokens.push({ type: "read" });
    return read.end;
  }
  const read = readWord(command, skipBlanks(command, i));
  if (read === null) return null;
  tokens.push({ type: "read" });
  return read.end;
}

/** The index after the word of an fd duplication at `at`; null unless the whole word is digits or exactly `-`. */
function fdDuplication(command: string, at: number): number | null {
  const read = readWord(command, at);
  if (read === null || read.word.quoted || !/^([0-9]+|-)$/.test(read.word.text)) return null;
  return read.end;
}

/** Consumes a heredoc body starting at `at` (the start of a line); the index after its closing line, or null when it never closes or would expand anything. */
function readHeredocBody(command: string, at: number, heredoc: Heredoc): number | null {
  let i = at;
  while (i <= command.length) {
    const lineEnd = command.indexOf("\n", i);
    const end = lineEnd === -1 ? command.length : lineEnd;
    const line = command.slice(i, end);
    const compared = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
    if (compared === heredoc.delimiter) return lineEnd === -1 ? command.length : lineEnd + 1;
    if (!heredoc.quoted && /[$`\\]/.test(line)) return null;
    if (lineEnd === -1) return null;
    i = lineEnd + 1;
  }
  return null;
}

/** The options a named writer may carry: each allowed letter, and the letters that take the next word (or the rest of the cluster) as a value. */
interface WriterOptions {
  readonly flags: string;
  readonly valued: string;
}

const WRITERS: ReadonlyMap<string, WriterOptions> = new Map([
  ["tee", { flags: "a", valued: "" }],
  ["cp", { flags: "fp", valued: "" }],
  ["mv", { flags: "f", valued: "" }],
  ["install", { flags: "d", valued: "m" }],
  ["mkdir", { flags: "p", valued: "m" }],
  ["touch", { flags: "", valued: "" }],
]);

const MODE = /^[0-7]{3,4}$/;

/** The options and operands of a writer's arguments; null for an option outside its list. */
function parseOptions(args: readonly string[], options: WriterOptions): { readonly letters: string; readonly operands: readonly string[] } | null {
  let letters = "";
  const operands: string[] = [];
  let ended = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (ended || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      ended = true;
      continue;
    }
    // `-` alone, or any long option.
    if (arg.length < 2 || arg.startsWith("--")) return null;
    for (let i = 1; i < arg.length; i++) {
      const letter = arg[i] ?? "";
      if (options.valued.includes(letter)) {
        const value = i + 1 < arg.length ? arg.slice(i + 1) : args[++at];
        if (value === undefined || !MODE.test(value)) return null;
        letters += letter;
        break;
      }
      if (!options.flags.includes(letter)) return null;
      letters += letter;
    }
  }
  return { letters, operands };
}

/** The targets one segment writes; null when it is not trivially safe. */
function segmentTargets(words: readonly Word[], writes: readonly Word[]): readonly TrivialTarget[] | null {
  const targets: TrivialTarget[] = writes.filter((word) => word.text !== "/dev/null").map((word) => ({ word: word.text, kind: "file" as const }));
  const [program, ...rest] = words;
  if (program === undefined) return targets;
  if (program.quoted) return null;
  // `printf -v NAME` assigns a variable (PATH, HOME, ...), like `NAME=value`.
  if (program.text === "printf" && (rest[0]?.text ?? "").startsWith("-")) return null;
  if (PRINTERS.has(program.text)) return targets;
  const options = WRITERS.get(program.text);
  if (options === undefined) return null;
  const parsed = parseOptions(rest.map((word) => word.text), options);
  if (parsed === null) return null;
  const { letters, operands } = parsed;
  switch (program.text) {
    case "tee":
      if (operands.includes("-")) return null;
      return [...targets, ...operands.map((word) => ({ word, kind: "file" as const }))];
    case "touch":
      if (operands.length === 0) return null;
      return [...targets, ...operands.map((word) => ({ word, kind: "file" as const }))];
    case "mkdir":
      if (operands.length === 0) return null;
      return [...targets, ...operands.map((word) => ({ word, kind: letters.includes("p") ? ("dirs" as const) : ("dir" as const) }))];
    case "install":
      if (letters.includes("d")) {
        if (operands.length === 0) return null;
        return [...targets, ...operands.map((word) => ({ word, kind: "dirs" as const }))];
      }
      return copyTargets(targets, operands, "file");
    case "cp":
      return copyTargets(targets, operands, "file");
    case "mv":
      return copyTargets(targets, operands, "removed");
    default:
      return null;
  }
}

/** `cp`/`mv`/`install` with exactly one source: the destination is written, and a `mv` source is removed. */
function copyTargets(targets: readonly TrivialTarget[], operands: readonly string[], sourceKind: "file" | "removed"): readonly TrivialTarget[] | null {
  // Several sources need a directory destination, which the verifier refuses anyway.
  if (operands.length !== 2) return null;
  const [source, destination] = operands as [string, string];
  return [...targets, ...(sourceKind === "removed" ? [{ word: source, kind: "removed" as const }] : []), { word: destination, kind: "file" as const }];
}

/** A target spelling the verifier can place without reading the filesystem through it. */
function plainTarget(word: string): boolean {
  if (word.length === 0) return false;
  return !word.split("/").some((part) => part === ".." || part.toLowerCase() === ".git");
}

/**
 * The files and directories `command` writes, in order, once each, when it
 * is trivially safe (see the module comment); null for any other command.
 * An empty list is a trivially safe command that writes no file.
 */
export function trivialWriteTargets(command: string): readonly TrivialTarget[] | null {
  const tokens = tokenize(command);
  if (tokens === null) return null;
  const targets: TrivialTarget[] = [];
  let words: Word[] = [];
  let writes: Word[] = [];
  const close = (): boolean => {
    const found = segmentTargets(words, writes);
    words = [];
    writes = [];
    if (found === null) return false;
    for (const target of found) if (!targets.some((seen) => seen.word === target.word && seen.kind === target.kind)) targets.push(target);
    return true;
  };
  for (const token of tokens) {
    if (token.type === "word") words.push(token.word);
    else if (token.type === "write") writes.push(token.target);
    else if (token.type === "sep" && !close()) return null;
  }
  if (!close()) return null;
  return targets.every((target) => plainTarget(target.word)) ? targets : null;
}
