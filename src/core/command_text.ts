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

import { commandHandOff, runArgumentPositions, splitOnCommandSeparatorsDetailed, tokenize } from "./git_discard.ts";
import { commandsRunByProgram, languageOfProgram, looksLikeOnePath, programTextAsPlaceholders } from "./program_text.ts";
import type { ProgramLanguage } from "./program_text.ts";

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
  return mapHeredocBodies(command, (heredoc) => {
    if (bodyStaysVisible(heredoc)) return [...heredoc.body, ...heredoc.terminator];
    if (!heredoc.nested && INTERPRETER_READERS.test(heredoc.openerLine)) return commandsRunByProgram(heredoc.body.join("\n"), programLanguage(heredoc.openerLine));
    return [];
  });
}

/**
 * The body of every heredoc fed to an interpreter (python, node, perl,
 * ruby) as its program, not one opened inside a quoted substitution -- the
 * same heredocs withoutHeredocBodies reads as programs (0.6.17 T2).
 */
export function interpreterHeredocBodies(command: string): readonly string[] {
  const bodies: string[] = [];
  mapHeredocBodies(command, (heredoc) => {
    if (!heredoc.nested && !bodyStaysVisible(heredoc) && INTERPRETER_READERS.test(heredoc.openerLine)) bodies.push(heredoc.body.join("\n"));
    return [];
  });
  return bodies;
}

// 0.6.13 T5 (JEVADV-63) and 0.6.14 T3 (N-09): a heredoc body fed to python,
// node, perl or ruby is a program, replaced by the command lines it runs,
// read the way its own language reads it -- see program_text.ts.

/** Programs whose heredoc body is a program in their own language. */
const INTERPRETER_READERS = /(^|[\s|;&(])(?:\S*\/)?(?:python[\d.]*|node|perl|ruby)\b/;

/** The language of the interpreter an opener line feeds, python when it cannot tell. */
function programLanguage(openerLine: string): ProgramLanguage {
  const match = /(^|[\s|;&(])((?:\S*\/)?(?:python[\d.]*|node|perl|ruby))\b/.exec(openerLine);
  return languageOfProgram(match?.[2] ?? "python") ?? "python";
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
  // 0.6.15 T3 (N-07): a SQL client runs its heredoc as it runs `psql -c`.
  return SHELL_READERS.test(heredoc.openerLine) || SQL_READERS.test(heredoc.openerLine);
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
// 0.6.15 T1 (JEVADV-83): that list of data positions was the root cause of
// the false positives left (qa-0.6.13): every shape nobody had listed -- a
// `for` list's strings, `python3 -c` source, a script's JSON argument -- came
// to Jev as if it were the command. It is inverted: the words in command
// position reach Jev, and so do the paths and refs they act on; every other
// quoted text is a placeholder unless the program is known to run it:
// `eval`, `sh|bash|zsh -c`, `su -c`, `ssh host cmd`, `watch`, `xargs` and a
// `--` hand-off, `find -exec`, `$( )` and backticks (all read again as a
// command line, git_discard.ts commandHandOff); a SQL client's statement and
// an awk or sed program that can run a command (kept as written); and an
// interpreter's source, read as its language reads it (program_text.ts). A
// heredoc follows its reader the same way: a shell or ssh reads it as
// commands, a SQL client runs it, an interpreter reads it as its program,
// and anything else only reads it as text.
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
  if (heredocFeedsAPipe(line, index)) return false;
  const tail = splitOnCommandSeparatorsDetailed(after);
  const words = programWords(tokenize(`${head.segments.at(-1) ?? ""} ${tail.segments[0] ?? ""}`));
  const program = words[0];
  if (program === "tee") return true;
  if (program === "cat") return words.some((word) => STDOUT_TO_FILE.test(word));
  const flags = textFlagsOf(words);
  return flags !== null && readsTextFromStdin(words, flags);
}

/** True when the command whose heredoc opens at `index` of `line` pipes its output on (`cat <<EOF | bash`). */
function heredocFeedsAPipe(line: string, index: number): boolean {
  const tail = splitOnCommandSeparatorsDetailed(line.slice(index));
  const next = tail.joiners[1] ?? tail.trailing;
  return next !== undefined && next !== null && next.includes("|") && next !== "||";
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
  let stack: QuoteState = [];
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
      // `2>&1`, `&>f`, `>&2` are redirections, not a background `&`.
      const redirection = char === "&" && (/[<>]/.test(command[index - 1] ?? "") || command[index + 1] === ">");
      if (/[;&|\n()]/.test(char) && !redirection) {
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

/** How deep a command line read inside another (`bash -c "ssh h '…'"`) is still read; deeper keeps its text. */
const VIEW_MAX_DEPTH = 8;
/** A heredoc read by a SQL client: its body is statements the client runs. */
const SQL_READERS = /(^|[\s|;&(])(?:\S*\/)?(?:psql|mysql|mariadb|sqlite3)\b/;
/** ssh runs the heredoc on its stdin as the remote shell's commands. */
const REMOTE_SHELL_READERS = /(^|[\s|;&(])(?:\S*\/)?ssh\b/;

/** Programs that run what they read on stdin: a shell, an interpreter, a SQL client, ssh's remote shell, xargs's command line. */
const STDIN_RUNNERS = /^(?:(?:ba|z|k|da|fi)?sh|python[\d.]*|node|perl|ruby|php|osascript|psql|mysql|mariadb|sqlite3|ssh|xargs)$/;

/** True when `texts` (one simple command's words) is a program that runs what it reads on stdin. */
function runsItsInput(texts: readonly string[]): boolean {
  return STDIN_RUNNERS.test(programWords(texts)[0] ?? "");
}

/** One piece of the command replaced in the copy Jev reads. */
interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `viewed` in the quotes `raw` was written in, so a script read again stays one word. */
function inQuotesOf(raw: string, viewed: string): string {
  if (raw.length >= 2 && raw.endsWith("'") && (raw.startsWith("'") || raw.startsWith("$'"))) return `'${viewed}'`;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return `"${viewed}"`;
  return viewed;
}

/** What Jev reads for one heredoc body, by the program that reads it (see the notes above). */
function heredocBodyForJev(heredoc: Heredoc, depth: number): string {
  const body = heredoc.body.join("\n");
  if (heredocBodyIsData(heredoc.openerLine, heredoc.openerIndex)) return dataPlaceholder(body);
  if (heredoc.nested || SQL_READERS.test(heredoc.openerLine)) return body;
  if (SHELL_READERS.test(heredoc.openerLine) || REMOTE_SHELL_READERS.test(heredoc.openerLine)) return commandLineForJev(body, depth + 1);
  if (INTERPRETER_READERS.test(heredoc.openerLine)) return programTextAsPlaceholders(body, programLanguage(heredoc.openerLine), DATA_TEXT_PLACEHOLDER);
  if (heredocFeedsAPipe(heredoc.openerLine, heredoc.openerIndex)) return body;
  return dataPlaceholder(body);
}

/** The replacements for one simple command's words (see withDataTextAsPlaceholders). */
function segmentReplacements(command: string, segment: readonly SpanWord[], depth: number, feedsARunner: boolean): readonly Replacement[] {
  const texts = segment.map((word) => tokenize(word.raw)[0] ?? word.raw);
  // What it prints is read by a later stage that runs it (`echo "DROP …" | psql`).
  if (feedsARunner) return [];
  const out: Replacement[] = [];
  const handled = new Set<number>();
  const handedOff = new Set<number>();
  // A here-string is the stdin of the command it sits in (`psql <<< "DROP …"`).
  if (runsItsInput(texts)) {
    texts.forEach((text, index) => {
      if (text.startsWith("<<<")) handled.add(text === "<<<" ? index + 1 : index);
    });
  }

  // A known CLI's message/body flags are text even as one bare word (0.6.13 T1).
  const skipped = texts.length - programWords(texts).length;
  const flags = textFlagsOf(programWords(texts));
  for (let index = skipped + 1; flags !== null && index < segment.length; index += 1) {
    const word = segment[index];
    if (word === undefined) continue;
    if (flags.text.has(word.raw)) {
      const value = segment[index + 1];
      if (value !== undefined && !mayRun(value.raw)) out.push({ start: value.start, end: value.end, text: dataPlaceholder(texts[index + 1] ?? value.raw) });
      handled.add(index + 1);
      index += 1;
      continue;
    }
    const assigned = [...flags.text].find((flag) => flag.startsWith("--") && word.raw.startsWith(`${flag}=`));
    if (assigned !== undefined) {
      if (!mayRun(word.raw.slice(assigned.length + 1))) out.push({ start: word.start + assigned.length + 1, end: word.end, text: dataPlaceholder(tokenize(word.raw.slice(assigned.length + 1))[0] ?? "") });
      handled.add(index);
    }
  }

  // A command line handed to another program is read again as one.
  let end = segment.length;
  const handOff = depth < VIEW_MAX_DEPTH ? commandHandOff(texts) : null;
  const first = handOff === null ? undefined : segment[handOff.index];
  const last = segment.at(-1);
  if (handOff !== null && first !== undefined && last !== undefined) {
    if (handOff.kind === "command-line") {
      const rest = command.slice(first.start, last.end);
      const viewed = shellWordsForJev(rest, depth + 1);
      if (viewed !== rest) out.push({ start: first.start, end: last.end, text: viewed });
      end = handOff.index;
    } else {
      const upTo = handOff.kind === "dash-c" ? handOff.index + 1 : segment.length;
      const script = texts.slice(handOff.index, upTo).join(" ");
      const viewed = commandLineForJev(script, depth + 1);
      const lastWord = segment[upTo - 1] ?? first;
      if (viewed !== script) out.push({ start: first.start, end: lastWord.end, text: upTo - handOff.index === 1 ? inQuotesOf(first.raw, viewed) : viewed });
      for (let index = handOff.index; index < upTo; index += 1) handedOff.add(index);
    }
  }

  const runs = runArgumentPositions(texts);
  for (let index = 0; index < end; index += 1) {
    const word = segment[index];
    const text = texts[index] ?? "";
    if (word === undefined || handedOff.has(index)) continue;
    if (mayRun(word.raw)) {
      // A `$( )` or backtick runs wherever it sits: its command line is read again as one.
      if (!word.raw.includes("\u0000")) {
        for (const body of substitutionBodies(word.raw)) {
          const inner = word.raw.slice(body.start, body.end);
          const viewed = commandLineForJev(inner, depth + 1);
          if (viewed !== inner) out.push({ start: word.start + body.start, end: word.start + body.end, text: viewed });
        }
      }
      continue;
    }
    if (handled.has(index)) continue;
    const run = runs.get(index);
    if (run !== undefined) {
      // A SQL statement or a command-running awk/sed program stays as written; an interpreter's source is read as its language reads it.
      const language = run.kind === "interpreter" ? languageOfProgram(run.program) : null;
      const viewed = language === null ? text : programTextAsPlaceholders(text, language, DATA_TEXT_PLACEHOLDER);
      if (viewed !== text) out.push({ start: word.start, end: word.end, text: inQuotesOf(word.raw, viewed) });
      continue;
    }
    // `--flag=value` and `NAME=value`: the value is what is judged, and what becomes the placeholder.
    const prefix = /^(?:-{1,2}[A-Za-z][\w-]*=|[A-Za-z_]\w*=)/.exec(word.raw)?.[0] ?? "";
    const value = text.slice(prefix.length);
    if (!/\s/.test(value) || looksLikeOnePath(value)) continue;
    out.push({ start: word.start + prefix.length, end: word.end, text: dataPlaceholder(value) });
  }
  return out;
}

/** Where each outermost `$( )` or backtick substitution's command line sits in one shell word. */
function substitutionBodies(raw: string): readonly { readonly start: number; readonly end: number }[] {
  const out: { readonly start: number; readonly end: number }[] = [];
  const runs = (stack: QuoteState): boolean => stack.some((frame) => frame === "$(" || frame === "`");
  let stack: QuoteState = [];
  let index = 0;
  let openedAt = -1;
  while (index < raw.length) {
    const step = frameStep(raw, index, stack);
    if (!runs(stack) && runs(step.stack)) openedAt = step.index;
    if (runs(stack) && !runs(step.stack) && openedAt !== -1) {
      out.push({ start: openedAt, end: index });
      openedAt = -1;
    }
    stack = step.stack;
    index = step.index;
  }
  return out;
}

/** `command`'s shell words as Jev reads them, heredoc bodies already set aside. */
function shellWordsForJev(command: string, depth: number): string {
  const segments = spanSegments(command);
  // Each segment's pipe to the next one: a bare `|` (never `||`) right after its last word.
  const pipes = segments.map((segment) => /^\s*\|(?!\|)/.test(command.slice(segment.at(-1)?.end ?? 0)));
  const runners = segments.map((segment) => runsItsInput(segment.map((word) => tokenize(word.raw)[0] ?? word.raw)));
  const feedsARunner = (at: number): boolean => {
    for (let next = at; pipes[next] === true && next + 1 < segments.length; next += 1) if (runners[next + 1] === true) return true;
    return false;
  };
  const replacements = segments.flatMap((segment, at) => segmentReplacements(command, segment, depth, feedsARunner(at)));
  let result = command;
  for (const { start, end, text } of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}

/** One command line as Jev reads it, heredocs included (see withDataTextAsPlaceholders). */
function commandLineForJev(command: string, depth: number): string {
  if (depth > VIEW_MAX_DEPTH) return command;
  const bodies: string[] = [];
  const masked = mapHeredocBodies(command, (heredoc) => {
    if (heredoc.body.length === 0) return heredoc.terminator;
    bodies.push(heredocBodyForJev(heredoc, depth));
    return [`\u0000${bodies.length - 1}\u0000`, ...heredoc.terminator];
  });
  const viewed = shellWordsForJev(masked, depth);
  return viewed.replace(/\u0000(\d+)\u0000/g, (_match, at: string) => bodies[Number(at)] ?? "");
}

/**
 * The command as Jev reads it: the words in command position, the paths and
 * refs they act on, and the text a program runs (0.6.15 T1, see the notes
 * above); every other quoted text, a known CLI's message/body flag and a
 * heredoc body only read as text become DATA_TEXT_PLACEHOLDER (an AI
 * attribution line stays readable inside it). The local rules and the cache
 * key never read this copy.
 */
export function withDataTextAsPlaceholders(command: string): string {
  return commandLineForJev(command, 0);
}

/** A word longer than this (JEVADV-96) is a blob, not an action: it is replaced when the state is too large. */
export const LONG_WORD_CHARS = 200;

/**
 * The command with every word longer than `limit` characters replaced by a
 * marker carrying its length (`‹400 chars›`), for a state that is over the
 * size cap (src/core/jev_state_cap.ts). Run it on withDataTextAsPlaceholders'
 * output: that already sets aside the text of a message, a heredoc fed to a
 * non-shell program and every quoted text with spaces in it; what is left
 * that is long is a blob (base64, hex, minified code) glued to the words that
 * are the action, and those words stay. Left as written: a word that runs
 * something (`$( )`, a backtick, `<( )`), a path, and a heredoc body read by a
 * shell, which is code.
 */
export function withLongWordsElided(command: string, limit: number = LONG_WORD_CHARS): string {
  const bodies: string[] = [];
  const masked = mapHeredocBodies(command, (heredoc) => {
    if (heredoc.body.length === 0) return heredoc.terminator;
    bodies.push(heredoc.body.join("\n"));
    return [`\u0000${bodies.length - 1}\u0000`, ...heredoc.terminator];
  });
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (const segment of spanSegments(masked)) {
    for (const word of segment) {
      if (word.end - word.start <= limit || mayRun(word.raw) || word.raw.includes("\u0000")) continue;
      if (looksLikeOnePath(tokenize(word.raw)[0] ?? word.raw)) continue;
      replacements.push({ start: word.start, end: word.end, text: `‹${word.end - word.start} chars›` });
    }
  }
  let result = masked;
  for (const { start, end, text } of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result.replace(/\u0000(\d+)\u0000/g, (_match, at: string) => bodies[Number(at)] ?? "");
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
