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
  if (!command.includes("<<")) return command;

  const lines = command.split("\n");
  const kept: string[] = [];
  let awaiting: string | null = null;
  let awaitingIsShell = false;
  let quote: Quote = null;

  for (const line of lines) {
    if (awaiting !== null) {
      if (awaitingIsShell) kept.push(line);
      if (line.trim() === awaiting) {
        awaiting = null;
        awaitingIsShell = false;
      }
      continue;
    }
    kept.push(line);
    // Only the LAST heredoc opener on a line decides what the next lines are,
    // which is also how the shell queues them.
    const scan = scanHeredocOpeners(line, quote);
    quote = scan.quote;
    const last = scan.delimiters.at(-1);
    if (last !== undefined) {
      awaiting = last;
      awaitingIsShell = SHELL_READERS.test(line);
    }
  }

  return kept.join("\n");
}

/** The quote open at a point in the line; `$'` is ANSI-C quoting, where `\'` does not close it. */
type Quote = "'" | "$'" | '"' | null;

const HEREDOC_DELIMITER = /^-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

/**
 * The delimiters of the heredocs `line` really opens, and the quote still
 * open at its end (a quoted string can span lines).
 *
 * QA 0.6.5 C2 (JEVADV-60): a `<<` inside quotes (`grep -n '<<EOF' docs/`),
 * the last two `<` of a `<<<` here-string, and a `<<` in a `#` comment open
 * nothing in the shell, so the lines after them really run. Matching `<<`
 * anywhere in the text treated them as openers and hid those lines from the
 * rules. An unclosed quote carries over and keeps later lines visible, which
 * errs toward judging more text, never less.
 */
function scanHeredocOpeners(line: string, openQuote: Quote): { delimiters: string[]; quote: Quote } {
  const delimiters: string[] = [];
  let quote = openQuote;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (quote === "$'") {
      if (char === "\\") index += 2;
      else {
        if (char === "'") quote = null;
        index += 1;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      index += 1;
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      index += 1;
      continue;
    }
    if (char === "$" && line[index + 1] === "'") {
      quote = "$'";
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "#" && (index === 0 || /[\s;&|(]/.test(line[index - 1] ?? ""))) break;
    if (line.startsWith("<<<", index)) {
      index += 3;
      continue;
    }
    if (line.startsWith("<<", index)) {
      const match = HEREDOC_DELIMITER.exec(line.slice(index + 2));
      if (match !== null) {
        delimiters.push(match[1] ?? match[2] ?? match[3] ?? "");
        index += 2 + match[0].length;
        continue;
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  return { delimiters, quote };
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
