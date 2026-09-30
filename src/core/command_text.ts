// What part of a command line is a command, and what part is only data.
//
// The tier-1b rules match text anywhere in the command string. That is fine
// while the verdict is `ask` -- a false match costs a click -- and it is not
// fine once the verdict is `deny`, because then the agent simply cannot do
// the thing. Measured the hard way: writing a file whose CONTENT described a
// rule was refused as if the rule were being run. Documentation, tests,
// migrations and this plugin's own source all describe these commands.
//
// A heredoc body is the clearest case. In `python3 - <<'PY' ... PY` the body
// is Python handed to a program on stdin; no shell ever sees it. Stripping it
// before the rules look is therefore not a loosening, it is the rules finally
// looking at the command instead of at an argument.
//
// The exception that keeps this honest: when the program reading the heredoc
// IS a shell -- `bash -s`, `sh <<EOF`, `zsh` -- the body is exactly a list of
// commands, and stripping it would hide the real thing. Those keep their body
// and stay judged. When in doubt this errs toward keeping the text, because a
// false strip waves a dangerous command through while a false keep costs one
// refusal that the person can override by running it themselves.

import { splitOnCommandSeparatorsDetailed, tokenize } from "./git_discard.ts";

/** Programs whose heredoc body is itself shell, so the body must keep being read. */
const SHELL_READERS = /(^|[\s|;&(])(ba|z|k|da|fi)?sh\b/;

/**
 * The command with every heredoc body removed, leaving the command line
 * itself. A command with no heredoc comes back unchanged.
 *
 * Handles the quoted (`<<'EOF'`), double-quoted (`<<"EOF"`), bare (`<<EOF`)
 * and indented (`<<-EOF`) spellings, and several heredocs in one command.
 * An unterminated heredoc -- the delimiter never reappears -- drops
 * everything after it, which is what the shell would have consumed anyway.
 *
 * SHELL_READERS is checked against each heredoc's own OPENER line, never the
 * body: a body that merely mentions "bash"/"sh" as ordinary text (a JSON
 * description, a comment, a string literal) used to make the WHOLE-command
 * check above true and keep every heredoc's body in the command unstripped
 * -- exactly the false positive that hard-denied a `python3 -` heredoc
 * editing a JSON value containing "curl | bash" as data. Reading only the
 * opener line answers the real question ("is the PROGRAM reading this
 * heredoc a shell") without also asking "does the DATA inside it happen to
 * spell a shell's name" -- and it decides each heredoc independently, so one
 * shell-fed heredoc in a command no longer keeps every OTHER heredoc's body
 * (fed to some non-shell program) visible too.
 */
export function withoutHeredocBodies(command: string): string {
  return mapHeredocBodies(command, (heredoc) => (bodyStaysVisible(heredoc) ? [...heredoc.body, ...heredoc.terminator] : []));
}

/**
 * A heredoc read by a shell keeps its body. One opened inside a quoted
 * substitution (0.6.13 T1) is stripped only when it is the message of a known
 * CLI (`git commit -m "$(cat <<'EOF'`): what the substitution's output feeds
 * (`eval "$(cat <<EOF`, `echo "$(cat <<EOF ...)" | bash`) may run it, and until
 * 0.6.13 such a body was never stripped at all.
 */
function bodyStaysVisible(heredoc: Heredoc): boolean {
  if (heredoc.nested) return !heredocBodyIsData(heredoc.openerLine, heredoc.openerIndex);
  return SHELL_READERS.test(heredoc.openerLine);
}

/** One heredoc as mapHeredocBodies hands it to its caller. */
interface Heredoc {
  /** The whole line that opened it. */
  readonly openerLine: string;
  /** Where its `<<` sits in that line. */
  readonly openerIndex: number;
  /** True when it opens inside a quoted substitution (`"$(cat <<'EOF'`). */
  readonly nested: boolean;
  readonly body: readonly string[];
  /** The delimiter line, or nothing when the heredoc is never closed. */
  readonly terminator: readonly string[];
}

/**
 * The command with each heredoc's body and terminator line replaced by what
 * `replace` returns for it; every other line is kept as it is. Only the LAST
 * heredoc opener on a line decides what the next lines are, which is also how
 * the shell queues them.
 */
function mapHeredocBodies(command: string, replace: (heredoc: Heredoc) => readonly string[]): string {
  if (!command.includes("<<")) return command;

  const lines = command.split("\n");
  const kept: string[] = [];
  let open: { readonly delimiter: string; readonly openerLine: string; readonly openerIndex: number; readonly nested: boolean; readonly body: string[] } | null = null;
  let state: QuoteState = [];

  for (const line of lines) {
    if (open !== null) {
      if (line.trim() === open.delimiter) {
        kept.push(...replace({ openerLine: open.openerLine, openerIndex: open.openerIndex, nested: open.nested, body: open.body, terminator: [line] }));
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    kept.push(line);
    const scan = scanHeredocOpeners(line, state);
    state = scan.state;
    const last = scan.openers.at(-1);
    if (last !== undefined) open = { delimiter: last.delimiter, openerLine: line, openerIndex: last.index, nested: last.nested, body: [] };
  }
  if (open !== null) kept.push(...replace({ openerLine: open.openerLine, openerIndex: open.openerIndex, nested: open.nested, body: open.body, terminator: [] }));

  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// 0.6.13 T1 (F-09/N-03): the copy of a command Jev reads.
//
// The local rules already skip text a known program never runs (git_discard.ts
// dataPositionIndexes, and the heredoc stripping above). Jev did not: it read
// the whole command, so `orca terminal send --text '... git push origin main
// ...'` or a heredoc writing a script that mentions a force push came back as
// advice, as if the text were the command. The copy sent to Jev now carries a
// placeholder in exactly two places: the value of a message/body flag of a
// known CLI, and a heredoc body written to a file (or read as a message).
//
// Anything that may run keeps its text: a heredoc fed to a shell, an
// interpreter or a pipe; a value holding a command substitution; a script's
// own arguments (`node probe.mjs '<json>'`, the script may run them); an
// unknown program's argument. When in doubt the text stays, because Jev
// reading a mention costs an advice while Jev missing a command costs a miss.
// ---------------------------------------------------------------------------

/** What Jev reads in place of text that is data. */
export const DATA_TEXT_PLACEHOLDER = "‹text›";

/**
 * A line that attributes the text to an AI: a co-author trailer, a "Generated
 * with" line, a robot emoji. The shipped `no_ai_attribution` prohibition is
 * judged on exactly these lines of a commit, PR or issue text (0.6.13 T2
 * measured it: with the text hidden it could no longer stop one), so they
 * stay readable inside the placeholder; nothing else of the text does.
 */
const AI_ATTRIBUTION_LINE = /co-authored-by:|generated with|\u{1F916}/iu;

/** The placeholder for `text`, carrying its AI attribution lines when it has any. */
function dataPlaceholder(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => AI_ATTRIBUTION_LINE.test(line));
  if (lines.length === 0) return DATA_TEXT_PLACEHOLDER;
  return `‹text with the line${lines.length > 1 ? "s" : ""}: ${lines.join("; ")}›`;
}

/** Words that run the next word as the program: `sudo git ...`, `env A=1 gh ...`. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["sudo", "env", "command", "nohup", "time", "exec"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** git global options that take the next word as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GH_TEXT_COMMANDS: ReadonlySet<string> = new Set(["pr", "issue", "release"]);
const GH_TEXT_ACTIONS: ReadonlySet<string> = new Set(["create", "edit", "comment"]);

/** The flags of one known CLI call whose value is text it never runs, and the ones that read that text from a file (`-` = stdin). */
interface TextFlags {
  readonly text: ReadonlySet<string>;
  readonly file: ReadonlySet<string>;
}

const GIT_MESSAGE_FLAGS: TextFlags = { text: new Set(["-m", "--message"]), file: new Set(["-F", "--file"]) };
const GH_TEXT_FLAGS: TextFlags = { text: new Set(["--title", "-t", "--body", "-b", "--notes", "-n"]), file: new Set(["--body-file", "-F", "--notes-file"]) };
const ORCA_SEND_FLAGS: TextFlags = { text: new Set(["--text"]), file: new Set() };

/** `words` (shell words, quotes removed) from the program on: prefixes and env assignments dropped, the program by its base name. */
function programWords(words: readonly string[]): readonly string[] {
  let index = 0;
  while (index < words.length && (ENV_ASSIGNMENT.test(words[index] ?? "") || COMMAND_PREFIXES.has(words[index] ?? ""))) index += 1;
  const rest = words.slice(index);
  if (rest.length === 0) return rest;
  return [(rest[0] ?? "").split("/").pop() ?? "", ...rest.slice(1)];
}

/** The text flags of the call `words` makes, or null when it is not `git commit|tag`, `gh pr|issue|release create|edit|comment` or `orca terminal send`. */
function textFlagsOf(words: readonly string[]): TextFlags | null {
  const [program, first, second] = words;
  if (program === "git") {
    let index = 1;
    while (index < words.length && (words[index] ?? "").startsWith("-")) index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(words[index] ?? "") ? 2 : 1;
    const subcommand = words[index];
    return subcommand === "commit" || subcommand === "tag" ? GIT_MESSAGE_FLAGS : null;
  }
  if (program === "gh") return GH_TEXT_COMMANDS.has(first ?? "") && GH_TEXT_ACTIONS.has(second ?? "") ? GH_TEXT_FLAGS : null;
  if (program === "orca") return first === "terminal" && second === "send" ? ORCA_SEND_FLAGS : null;
  return null;
}

/** True when `words` reads one of `flags`' file flags from stdin: `-F -`, `-F-`, `--file=-`. */
function readsTextFromStdin(words: readonly string[], flags: TextFlags): boolean {
  return words.some((word, index) => {
    if (flags.file.has(word)) return words[index + 1] === "-";
    return [...flags.file].some((flag) => word === `${flag}=-` || (!flag.startsWith("--") && word === `${flag}-`));
  });
}

/** A redirection of stdout to a file: `>f`, `> f`, `>>f`, `1>f` -- never a descriptor copy (`>&2`). */
const STDOUT_TO_FILE = /^1?>>?(?!&)/;

/**
 * True when the heredoc opened at `index` of `line` is data: written to a file
 * by `cat`/`tee`, read as a message by `git commit|tag -F -` or `gh ...
 * --body-file -`, or the `cat` inside `-m "$(cat <<'EOF'` of a known CLI.
 * Never when its output is piped on (`cat <<EOF | bash`).
 */
function heredocBodyIsData(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const after = line.slice(index);

  // `-m "$(cat <<'EOF'`: the body is the value of a text flag.
  const substitution = /\$\(\s*cat\s*$/.exec(before);
  if (substitution !== null) {
    if (!/^<<-?\s*(?:'[^']+'|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*$/.test(after)) return false;
    const outer = before.slice(0, substitution.index);
    const flag = /(?:^|\s)(-{1,2}[A-Za-z-]+)(?:=|\s+)"$/.exec(outer);
    if (flag === null) return false;
    const call = splitOnCommandSeparatorsDetailed(outer.slice(0, flag.index)).segments.at(-1) ?? "";
    return textFlagsOf(programWords(tokenize(call)))?.text.has(flag[1] ?? "") === true;
  }

  const head = splitOnCommandSeparatorsDetailed(before);
  if (head.trailing !== null) return false;
  const tail = splitOnCommandSeparatorsDetailed(after);
  const next = tail.joiners[1] ?? tail.trailing;
  if (next !== undefined && next !== null && next.includes("|") && next !== "||") return false;
  const words = programWords(tokenize(`${head.segments.at(-1) ?? ""} ${tail.segments[0] ?? ""}`));
  const program = words[0];
  if (program === "tee") return true;
  if (program === "cat") return words.some((word) => STDOUT_TO_FILE.test(word));
  const flags = textFlagsOf(words);
  return flags !== null && readsTextFromStdin(words, flags);
}

/** One shell word of a command, with where it sits. */
interface SpanWord {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

/**
 * The command's words, grouped by command segment, each with its position so
 * a value can be replaced in place. Quotes, `$'...'`, `$(...)` (also inside
 * double quotes) and backticks keep a word whole; an unquoted `;`, `&`, `|`,
 * newline or parenthesis ends a segment; a `#` comment is skipped.
 */
function spanSegments(command: string): readonly (readonly SpanWord[])[] {
  const segments: SpanWord[][] = [];
  let words: SpanWord[] = [];
  let start = -1;
  let stack: Frame[] = [];
  const endWord = (end: number): void => {
    if (start !== -1) words.push({ start, end, raw: command.slice(start, end) });
    start = -1;
  };
  const endSegment = (end: number): void => {
    endWord(end);
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    const top = stack.at(-1);
    if (top === undefined) {
      if (/\s/.test(char) && char !== "\n") {
        endWord(index);
        index += 1;
        continue;
      }
      if (/[;&|\n()]/.test(char)) {
        endSegment(index);
        index += 1;
        continue;
      }
      if (char === "#" && start === -1) {
        while (index < command.length && command[index] !== "\n") index += 1;
        continue;
      }
      if (start === -1) start = index;
    }
    const step = frameStep(command, index, stack);
    stack = step.stack;
    index = step.index;
  }
  endSegment(command.length);
  return segments;
}

/** True when a word's raw text holds a command substitution (or text this reading masked out), so it may run. */
function mayRun(raw: string): boolean {
  return raw.includes("$(") || raw.includes("`") || raw.includes("\u0000");
}

/** The command with the value of every known CLI text flag replaced by DATA_TEXT_PLACEHOLDER. */
function withTextFlagValuesAsPlaceholders(command: string): string {
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (const segment of spanSegments(command)) {
    const words = segment.map((word) => tokenize(word.raw)[0] ?? word.raw);
    const skipped = words.length - programWords(words).length;
    const flags = textFlagsOf(programWords(words));
    if (flags === null) continue;
    for (let index = skipped + 1; index < segment.length; index += 1) {
      const word = segment[index];
      if (word === undefined) continue;
      if (flags.text.has(word.raw)) {
        const value = segment[index + 1];
        if (value !== undefined && !mayRun(value.raw)) replacements.push({ start: value.start, end: value.end, text: dataPlaceholder(tokenize(value.raw)[0] ?? value.raw) });
        index += 1;
        continue;
      }
      const assigned = [...flags.text].find((flag) => flag.startsWith("--") && word.raw.startsWith(`${flag}=`));
      if (assigned !== undefined && !mayRun(word.raw.slice(assigned.length + 1))) {
        replacements.push({ start: word.start + assigned.length + 1, end: word.end, text: dataPlaceholder(tokenize(word.raw.slice(assigned.length + 1))[0] ?? "") });
      }
    }
  }
  let result = command;
  for (const { start, end, text } of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}

/**
 * The command as Jev reads it (0.6.13 T1): the value of a message/body flag of
 * `git commit|tag`, `gh pr|issue|release create|edit|comment` and `orca
 * terminal send`, and a heredoc body written to a file or read as a message,
 * each become DATA_TEXT_PLACEHOLDER. Every other heredoc body is set aside
 * while the flags are read (its text is not shell syntax) and put back as it
 * was. The local rules and the cache key never read this copy.
 */
export function withDataTextAsPlaceholders(command: string): string {
  const bodies: (readonly string[])[] = [];
  const masked = mapHeredocBodies(command, (heredoc) => {
    if (heredoc.body.length === 0) return heredoc.terminator;
    bodies.push(heredocBodyIsData(heredoc.openerLine, heredoc.openerIndex) ? [dataPlaceholder(heredoc.body.join("\n"))] : heredoc.body);
    return [`\u0000${bodies.length - 1}\u0000`, ...heredoc.terminator];
  });
  const flagged = withTextFlagValuesAsPlaceholders(masked);
  return flagged.replace(/\u0000(\d+)\u0000/g, (_match, at: string) => (bodies[Number(at)] ?? []).join("\n"));
}

/**
 * What is open at a point in the text: a quote (`$'` is ANSI-C quoting, where
 * `\'` does not close it), or a command substitution / parenthesis inside
 * double quotes, whose text is code again (`"$(cat <<'EOF'`).
 */
type Frame = "'" | "$'" | '"' | "$(" | "(" | "`";
type QuoteState = readonly Frame[];

/**
 * One step of the quote reading shared by scanHeredocOpeners and
 * spanSegments: consumes the character at `index` (two for an escape, `$'`
 * or `$(`) and returns the frames open after it. Outside every frame, and in
 * a `$(`/`(` frame, text is code: quotes open, and in a code frame `(` and
 * `)` nest. A `$(` or backtick inside double quotes opens code too.
 */
function frameStep(text: string, index: number, stack: QuoteState): { readonly stack: QuoteState; readonly index: number } {
  const char = text[index] ?? "";
  const top = stack.at(-1);
  const push = (frame: Frame, width: number) => ({ stack: [...stack, frame], index: index + width });
  const pop = () => ({ stack: stack.slice(0, -1), index: index + 1 });
  if (top === "$'") {
    if (char === "\\") return { stack, index: index + 2 };
    return char === "'" ? pop() : { stack, index: index + 1 };
  }
  if (top === "'") return char === "'" ? pop() : { stack, index: index + 1 };
  if (char === "\\") return { stack, index: index + 2 };
  if (top === '"') {
    if (char === '"') return pop();
    if (char === "$" && text[index + 1] === "(") return push("$(", 2);
    if (char === "`") return push("`", 1);
    return { stack, index: index + 1 };
  }
  if (top === "`") return char === "`" ? pop() : { stack, index: index + 1 };
  if (char === "$" && text[index + 1] === "'") return push("$'", 2);
  if (char === "'" || char === '"') return push(char, 1);
  if (top === "$(" || top === "(") {
    if (char === "(") return push("(", 1);
    if (char === ")") return pop();
  } else if (char === "$" && text[index + 1] === "(") {
    return push("$(", 2);
  } else if (char === "`") {
    return push("`", 1);
  }
  return { stack, index: index + 1 };
}

const HEREDOC_DELIMITER = /^-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

/**
 * The heredocs `line` really opens (delimiter and where its `<<` sits), and
 * the frames still open at its end (a quoted string can span lines).
 *
 * QA 0.6.5 C2 (JEVADV-60): a `<<` inside quotes (`grep -n '<<EOF' docs/`),
 * the last two `<` of a `<<<` here-string, and a `<<` in a `#` comment open
 * nothing in the shell, so the lines after them really run. Matching `<<`
 * anywhere in the text treated them as openers and hid those lines from the
 * rules. An unclosed quote carries over and keeps later lines visible, which
 * errs toward judging more text, never less.
 *
 * 0.6.13 T1: a `$(` inside double quotes is code again, so the heredoc in
 * `git commit -m "$(cat <<'EOF'` -- the way Claude Code writes every commit
 * message -- is a real heredoc. Missing it left the message body in view of
 * the rules, which refused a message that named a force push.
 */
function scanHeredocOpeners(line: string, open: QuoteState): { openers: { readonly delimiter: string; readonly index: number; readonly nested: boolean }[]; state: QuoteState } {
  const openers: { readonly delimiter: string; readonly index: number; readonly nested: boolean }[] = [];
  let stack = open;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    const top = stack.at(-1);
    const isCode = top === undefined || top === "$(" || top === "(";
    if (isCode) {
      if (char === "#" && (index === 0 || /[\s;&|(]/.test(line[index - 1] ?? ""))) break;
      if (line.startsWith("<<<", index)) {
        index += 3;
        continue;
      }
      if (line.startsWith("<<", index)) {
        const match = HEREDOC_DELIMITER.exec(line.slice(index + 2));
        if (match !== null) {
          openers.push({ delimiter: match[1] ?? match[2] ?? match[3] ?? "", index, nested: top !== undefined });
          index += 2 + match[0].length;
          continue;
        }
        index += 2;
        continue;
      }
      // Outside every frame a substitution or backtick opens nothing this
      // reading needs: the shell's own `$(`/backticks there were never quoted,
      // so their `<<` is already seen as code.
      if (top === undefined && ((char === "$" && line[index + 1] === "(") || char === "`")) {
        index += char === "`" ? 1 : 2;
        continue;
      }
    }
    const step = frameStep(line, index, stack);
    stack = step.stack;
    index = step.index;
  }
  return { openers, state: stack };
}


/**
 * The command with every backslash-newline line continuation removed, the
 * way the shell joins the two lines before running them (JEVADV-65:
 * `git push \` + newline + `origin main` hid the branch from the rules).
 * Inside single quotes a backslash is literal, so it stays.
 */
export function withoutLineContinuations(command: string): string {
  if (!command.includes("\\\n")) return command;
  let out = "";
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    if (char === "\\" && !single) {
      const next = command[index + 1] ?? "";
      if (next !== "\n") out += char + next;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}
