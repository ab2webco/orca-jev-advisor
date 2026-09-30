// A program handed to an interpreter, read the way its own language reads it.
//
// 0.6.13 T5 (JEVADV-63): a heredoc body fed to python, node, perl or ruby is
// a program. Stripping it whole hid what the program hands a shell -- the
// 0.6.12 QA ran `python3 - <<'PY'` with `os.system('git push --force origin
// x')` and got only advice. Keeping it whole would read Python as shell. So
// the body is replaced by the command lines it runs: the string arguments of
// a call that hands them to a shell or runs them as a program (os.system,
// subprocess.*, child_process exec/spawn, system, exec, popen, Open3), and a
// backtick, `qx` or `%x` string for perl and ruby. Each becomes its own line,
// read by the rules in command position; a print or a string the program
// only holds stays out of view, as before.
//
// 0.6.14 T3 (N-09, qa-0.6.13): the calls above were found by their text, so
// one spelled inside a string literal -- a document the program writes,
// quoting `os.system('git push --force ...')` -- read as a call, and the
// write was refused as a force push. A pattern anchored at the start of a
// statement would not do: `x = os.system(...)` is a call too. So the body is
// first read the way its own language reads it: every string literal's text
// and every comment is blanked out (same length, newlines kept), and a call
// counts only where its name sits in what is left, the code. Its arguments
// are then read from the original text at the same place. Per language:
//   python  # comments; '…' "…" '''…''' """…""" with any r/b/u/f prefix;
//           an f-string's {…} is code again (0.6.15 N-10);
//   node    // and /* */ comments; '…' "…"; `…` whose ${…} IS code again;
//   perl, ruby  # comments; '…' "…"; a backtick string is a command, so it
//           stays code, as does qx/%x.
//
// Moved here from command_text.ts in 0.6.15 (T1) so the `-c`/`-e` source the
// local rules scan (git_discard.ts) is read by the same code as a heredoc's.
//
// Pure: no I/O.

export type ProgramLanguage = "python" | "node" | "perl" | "ruby";

/** The language a program name runs its code in, or null when it is none of the four read here. */
export function languageOfProgram(name: string): ProgramLanguage | null {
  const base = name.split("/").pop() ?? name;
  if (/^python[\d.]*$/.test(base)) return "python";
  return base === "node" || base === "perl" || base === "ruby" ? base : null;
}

/** A call that runs its string arguments; `(` or, for perl and ruby, a string right after the name. */
const RUNS_COMMAND_CALL = /(?<![\w$])(?:os\.(?:system|popen|exec\w*|spawn\w*)|subprocess\.\w+|execSync|execFileSync|execFile|spawnSync|spawn|exec|system|popen|Open3\.\w+)\s*(?:(\()|(?=["']))/g;
/** perl's and ruby's own command strings: `qx{...}`/`qx(...)` and `%x(...)`/`%x{...}`. */
const QUOTED_COMMAND = /(?:\bqx|%x)([({[])/g;
const CLOSING: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

/** Every string literal in `text` ('...', "...", `...`), escapes kept as written. */
function stringLiterals(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const quote = text[at] ?? "";
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let end = at + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === "\\" ? 2 : 1;
    out.push(text.slice(at + 1, end));
    at = end;
  }
  return out;
}

/** The text from `from` up to the bracket that closes the one before it, strings skipped. */
function bracketBody(text: string, from: number, open: string): string {
  const close = CLOSING[open] ?? ")";
  let depth = 1;
  let at = from;
  while (at < text.length && depth > 0) {
    const char = text[at] ?? "";
    if (char === "'" || char === '"' || char === "`") {
      at += 1;
      while (at < text.length && text[at] !== char) at += text[at] === "\\" ? 2 : 1;
    } else if (char === open) depth += 1;
    else if (char === close) depth -= 1;
    at += 1;
  }
  return text.slice(from, Math.max(from, at - 1));
}

/** One stretch of a program that is not code: a string literal's text (quotes excluded) or a whole comment. */
interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: "string" | "comment";
}

/** A python string's prefix letters right before its quote at `at` (`f`, `rb`, ...), or "" when the letters belong to a name. */
function pythonPrefix(text: string, at: number): string {
  let from = at;
  while (from > 0 && /[rRbBuUfF]/.test(text[from - 1] ?? "")) from -= 1;
  if (at - from > 2 || /[\w]/.test(text[from - 1] ?? "")) return "";
  return text.slice(from, at);
}

/** The string literals' text and the comments of `text` in `language`, in order (see the notes above). */
function textSpans(text: string, language: ProgramLanguage): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  const add = (start: number, end: number, kind: TextSpan["kind"]): void => {
    if (end > start) spans.push({ start, end: Math.min(end, text.length), kind });
  };
  /** Scans code from `start`; stops at an unmatched `}` when `inBraces` (a JS `${…}`, a python f-string's `{…}`), returning where. */
  const scanCode = (start: number, inBraces: boolean): number => {
    let at = start;
    let depth = 0;
    while (at < text.length) {
      const char = text[at] ?? "";
      const nextChar = text[at + 1] ?? "";
      if (inBraces && char === "{") depth += 1;
      if (inBraces && char === "}") {
        if (depth === 0) return at;
        depth -= 1;
      }
      if (language === "node" && char === "/" && nextChar === "/") {
        const end = text.indexOf("\n", at);
        add(at, end === -1 ? text.length : end, "comment");
        at = end === -1 ? text.length : end;
        continue;
      }
      if (language === "node" && char === "/" && nextChar === "*") {
        const end = text.indexOf("*/", at + 2);
        add(at, end === -1 ? text.length : end + 2, "comment");
        at = end === -1 ? text.length : end + 2;
        continue;
      }
      // perl's `$#array` is its last index, not a comment.
      if (language !== "node" && char === "#" && !(language === "perl" && text[at - 1] === "$")) {
        const end = text.indexOf("\n", at);
        add(at, end === -1 ? text.length : end, "comment");
        at = end === -1 ? text.length : end;
        continue;
      }
      if (language === "node" && char === "`") {
        at = scanTemplate(at + 1);
        continue;
      }
      if (char === "'" || char === '"') {
        at = scanString(at);
        continue;
      }
      at += 1;
    }
    return at;
  };
  /** A quoted string from its opening quote at `start`; a python f-string's `{…}` is scanned as code. Returns past its closing quote. */
  const scanString = (start: number): number => {
    const char = text[start] ?? "";
    const triple = language === "python" && text.startsWith(char.repeat(3), start);
    const quote = triple ? char.repeat(3) : char;
    const formatted = language === "python" && /[fF]/.test(pythonPrefix(text, start));
    let end = start + quote.length;
    let from = end;
    while (end < text.length && !text.startsWith(quote, end)) {
      // A lone quote string ends at its line in python and node; a triple one never does.
      if (!triple && text[end] === "\n" && (language === "python" || language === "node")) break;
      if (formatted && text[end] === "{") {
        if (text[end + 1] === "{") {
          end += 2;
          continue;
        }
        add(from, end, "string");
        end = scanCode(end + 1, true) + 1;
        from = end;
        continue;
      }
      end += text[end] === "\\" ? 2 : 1;
    }
    add(from, end, "string");
    return end + quote.length;
  };
  /** A JS template from just after its opening backtick: text is a string, each `${…}` scanned as code. Returns past the closing backtick. */
  const scanTemplate = (start: number): number => {
    let at = start;
    let from = start;
    while (at < text.length && text[at] !== "`") {
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (text[at] === "$" && text[at + 1] === "{") {
        add(from, at, "string");
        at = scanCode(at + 2, true) + 1;
        from = at;
        continue;
      }
      at += 1;
    }
    add(from, at, "string");
    return at + 1;
  };
  scanCode(0, false);
  return spans;
}

/** `text` with every string literal's contents and every comment blanked in `language`, so only code is left to match. */
export function codeOnly(text: string, language: ProgramLanguage): string {
  const out = text.split("");
  for (const span of textSpans(text, language)) {
    for (let i = span.start; i < span.end; i += 1) if (out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

/** perl and ruby run a backtick string as a shell command; python has none and node's is a template. */
function runsBackticks(language: ProgramLanguage): boolean {
  return language === "perl" || language === "ruby";
}

/** Where each call that runs a command sits, and the stretch of the original text holding its arguments. */
function runCalls(body: string, code: string): readonly { readonly argsStart: number; readonly argsEnd: number; readonly bracketed: boolean }[] {
  const out: { readonly argsStart: number; readonly argsEnd: number; readonly bracketed: boolean }[] = [];
  for (const match of code.matchAll(RUNS_COMMAND_CALL)) {
    const after = (match.index ?? 0) + match[0].length;
    const bracketed = match[1] === "(";
    out.push({ argsStart: after, argsEnd: bracketed ? after + bracketBody(body, after, "(").length : body.length, bracketed });
  }
  return out;
}

/** The command lines a program body runs through a shell or as a program (see the notes above). */
export function commandsRunByProgram(body: string, language: ProgramLanguage): string[] {
  const out: string[] = [];
  const add = (line: string): void => {
    if (line.length > 0) out.push(line);
  };
  const code = codeOnly(body, language);
  for (const call of runCalls(body, code)) {
    // `system("git", "push")`, `run(["git", "push"])`: every string argument, in order.
    // `system "git push"` (perl, ruby): the one string right after the name.
    const strings = call.bracketed ? stringLiterals(body.slice(call.argsStart, call.argsEnd)) : stringLiterals(body.slice(call.argsStart)).slice(0, 1);
    add(strings.filter((part) => part.length > 0).join(" "));
  }
  if (runsBackticks(language)) {
    for (const match of code.matchAll(QUOTED_COMMAND)) add(bracketBody(body, (match.index ?? 0) + match[0].length, match[1] ?? "(").trim());
    for (const match of code.matchAll(/`([^`]*)`/g)) {
      const at = (match.index ?? 0) + 1;
      add(body.slice(at, at + (match[1] ?? "").length).trim());
    }
  }
  return out;
}

/**
 * True when `text`, though it holds a space, reads as one path: it starts
 * like one (`/`, `~`, `./`, `../`, `$VAR/`, a drive letter), holds no shell
 * punctuation and at most three spaces (`~/Library/Application Support/x`).
 * The paths a command acts on are what Jev needs to judge it (0.6.15 T1).
 */
export function looksLikeOnePath(text: string): boolean {
  if (!/^(?:~|\/|\.{1,2}\/|\$\{?[A-Za-z_]\w*\}?\/|[A-Za-z]:[\\/])/.test(text)) return false;
  if (/[\n|;&<>`]/.test(text)) return false;
  return (text.match(/\s/g)?.length ?? 0) <= 3;
}

/**
 * 0.6.15 T1 (JEVADV-83, N-10, N-11): the program as Jev reads it. The code
 * stays as written -- `const fs = require("fs")`, `open(p, 'w')` -- so Jev
 * sees what the program does; a comment is dropped; a string literal that
 * holds a space becomes `placeholder`, unless it is an argument of a call
 * that runs a command (that text runs) or reads as one path. A string with
 * no space (a file name, a mode, a module) stays: it is what the program
 * acts on, not prose.
 */
export function programTextAsPlaceholders(body: string, language: ProgramLanguage, placeholder: string): string {
  const spans = textSpans(body, language);
  const calls = runCalls(body, codeOnly(body, language));
  const runsIt = (span: TextSpan): boolean =>
    calls.some((call) => {
      if (call.bracketed) return span.start >= call.argsStart && span.end <= call.argsEnd;
      // `system "git push"`: the first string after the name.
      const first = spans.find((candidate) => candidate.kind === "string" && candidate.start >= call.argsStart);
      return first === span;
    });
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += body.slice(at, span.start);
    const text = body.slice(span.start, span.end);
    if (span.kind === "string") out += runsIt(span) || !/\s/.test(text) || looksLikeOnePath(text) ? text : placeholder;
    at = span.end;
  }
  return out + body.slice(at);
}
