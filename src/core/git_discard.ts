// Recognises the git commands that overwrite the working tree and lose
// uncommitted changes: `git checkout` in its path and force forms, `git
// restore` whenever it writes the working tree, and `git reset --hard` /
// `git clean -f`. The last two used to stay with their own, separate,
// quote-blind regex in adapters/claude/gate-bash.ts; they are folded in
// here (odd/tasks/release-0.5.1.md T8) so every one of these commands gets
// the same tokenizer, the same wrapper/eval/`-c` recursion, and the same
// command-position discipline, instead of two different readings of the
// same command line disagreeing about what a shell would actually run.
//
// It exists because `git checkout -- <file>` discarded an agent's
// uncommitted work in a real session (odd/CHECKPOINT.md) while the deny
// rule only knew reset and clean. A regex over the whole line cannot tell
// `git checkout -- x` from `git log -- .`, `git checkout main && ls .` or a
// commit message that merely names the command, so this reads the line the
// way a shell would: quotes respected, and `git` only counted where a shell
// would actually run it -- the start of a command, after wrappers like
// `sudo`/`env`, inside `bash -c` / `eval` / `ssh`'s remote command / `su -c`
// / `watch` / `script -c`, and inside `$(...)` / backticks. Text inside an
// argument (`git commit -m "use git restore x"`) is never a run. This
// matters because this rule DENIES: a false match refuses an agent's
// commit, not just asks about it.
//
// Deliberately NOT recognised:
//   - `git checkout <name>` with one positional and no `--`: git resolves a
//     bare name as a branch before a path, and a branch switch carries local
//     changes over (or refuses on a conflict). Catching it would stop the
//     most common harmless command there is; the path reading of it (a file,
//     or a directory such as `src/`) is left to the ordinary Jev path.
//   - `git checkout -b` / `-B` / `--orphan`: they create or reset a branch
//     POINTER; the working tree is carried over as with any branch switch.
//   - `git switch`: out of scope for this rule, including its
//     `--discard-changes` / `-f` forms (a known gap, recorded in
//     odd/tasks/gate-destructive-restore-and-seed-refresh.md).
//   - `git restore --staged` / `-S` alone: it rewrites the index only;
//     the working tree -- the uncommitted work -- is untouched.
//
// Pure: no I/O.

/** Options git accepts BEFORE the subcommand that take a separate value. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** A pathspec that means "everything under here". */
const WHOLE_TREE_PATHSPECS = new Set([".", "./", ":/", "*"]);

/** Checkout options that create or reset a branch and take its name as a separate value. */
const BRANCH_CREATING_OPTIONS = new Set(["-b", "-B", "--orphan"]);

/** Words that run the command after them (plus their own options). */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "exec", "nohup", "time", "timeout", "nice", "ionice", "stdbuf", "xargs",
  "then", "do", "else", "if", "while", "until", "!", "{",
]);

/** Shells whose `-c` argument is itself a command line. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Programs that, like a shell, take a WHOLE command line as their `-c`
 *  argument's value -- `su -c '...'` (optionally `su USER -c '...'`) and
 *  `script -c '...'` read exactly like `bash -c`, just under a different
 *  name. */
const DASH_C_COMMAND_PROGRAMS = new Set(["su", "script"]);

/** ssh options that take a separate value, so the token right after one is
 *  never mistaken for the host, or for the start of the remote command. */
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-p", "-l", "-i", "-F", "-o", "-L", "-R", "-D", "-W", "-B", "-c", "-e", "-J", "-Q", "-S", "-O", "-w", "-b",
]);

/** `watch`'s own options that take a separate value. */
const WATCH_OPTIONS_WITH_VALUE = new Set(["-n", "--interval"]);

/** `find` options whose following tokens are a whole command it runs. */
const FIND_EXEC_OPTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Every program name this module ever recurses into as a command line in
 *  its own right -- `git` itself, plus every wrapper that runs one whole
 *  line found further down the same token list. Used to jump PAST a
 *  wrapper's own option that this walk cannot know the value-grammar of
 *  (`sudo -u root`, `nice -n 10`) to the program it actually wraps. */
const RECURSIVE_COMMAND_PROGRAMS = new Set(["git", "eval", "ssh", "watch", ...SHELLS, ...DASH_C_COMMAND_PROGRAMS]);

/**
 * Pulls every `$(...)` and backtick substitution out of `command`: they run
 * wherever they sit, even inside double quotes. Returns the line with each
 * one replaced by a placeholder word, and the substitutions' own text.
 */
function extractSubstitutions(command: string): { readonly outer: string; readonly inner: readonly string[] } {
  const inner: string[] = [];
  let outer = "";
  let single = false;
  let double = false;
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (char === "\\" && !single) {
      outer += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && char === "$" && command[index + 1] === "(") {
      let depth = 1;
      let close = index + 2;
      while (close < command.length && depth > 0) {
        if (command[close] === "(") depth += 1;
        else if (command[close] === ")") depth -= 1;
        close += 1;
      }
      inner.push(command.slice(index + 2, close - 1));
      outer += "_";
      index = close;
      continue;
    } else if (!single && char === "`") {
      const close = command.indexOf("`", index + 1);
      const end = close === -1 ? command.length : close;
      inner.push(command.slice(index + 1, end));
      outer += "_";
      index = end + 1;
      continue;
    }
    outer += char;
    index += 1;
  }
  return { outer, inner };
}

/**
 * Splits on the shell's command separators (`;`, `&&`, `||`, `|`, `&`,
 * newline) and subshell parentheses -- but only outside quotes, so a
 * separator inside a commit message does not start a command.
 */
export function splitOutsideQuotes(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && !single) {
      current += command.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    if (!single && !double && /[;&|\n()]/.test(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Shell words of one segment, with quotes removed and a quoted argument kept whole. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let single = false;
  let double = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (char === "\\" && !single) {
      current += segment[index + 1] ?? "";
      inToken = true;
      index += 1;
    } else if (char === "'" && !double) {
      single = !single;
      inToken = true;
    } else if (char === '"' && !single) {
      double = !double;
      inToken = true;
    } else if (/\s/.test(char) && !single && !double) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** `/usr/bin/git` is `git`. */
function programName(token: string): string {
  return token.split("/").pop() ?? token;
}

/** A subshell wrapping a real command must not hide it: `(bash -c '...')`
 *  still runs `bash -c`, and `(git commit -m "...")` still runs `git`.
 *  Stripped only for a program-name check, never for the token's own text
 *  in a reconstructed/joined output. Shared by resolveProgram (which
 *  program a wrapped command line runs) and scanSegment (the same check for
 *  `-c`/eval/ssh/watch recognition). */
function stripLeadingGroupers(token: string): string {
  return token.replace(/^[({]+/, "");
}

function isShortCluster(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token);
}

function checkoutDiscards(args: readonly string[], viaXargs: boolean): boolean {
  const separator = args.indexOf("--");
  if (separator !== -1) {
    // A `--` followed by a real pathspec is always the path form:
    // `git checkout -- src/app.ts`, `git checkout main -- src/app.ts`.
    if (separator < args.length - 1) return true;
    // A BARE trailing `--`, with nothing after it, is not itself a
    // meaningful invocation -- UNLESS xargs is about to append the real
    // pathspecs after it at runtime (`find . | xargs git checkout --`,
    // odd/tasks/release-0.5.1.md T10, JEVADV-28, R3-checkout-trailing-dashdash).
    // `git checkout main --` alone is an ordinary, non-destructive branch
    // switch that merely signals "no more flags"; falling through lets the
    // positional-count check below decide it on `args` with `--` excluded
    // (it starts with `-`, so the filter already drops it).
    if (viaXargs) return true;
  }
  if (
    args.some(
      (arg) =>
        arg === "--force" ||
        arg.startsWith("--pathspec-from-file") ||
        (isShortCluster(arg) && arg.includes("f")) ||
        WHOLE_TREE_PATHSPECS.has(arg),
    )
  ) {
    return true;
  }
  // `git checkout <tree-ish> <pathspec>...`: two or more positionals can
  // only be the path form, unless a branch-creating option took the first
  // as its new branch's name.
  if (args.some((arg) => BRANCH_CREATING_OPTIONS.has(arg))) return false;
  return args.filter((arg) => !arg.startsWith("-")).length >= 2;
}

function restoreDiscards(args: readonly string[]): boolean {
  const worktree = args.some((arg) => arg === "--worktree" || (isShortCluster(arg) && arg.includes("W")));
  const staged = args.some((arg) => arg === "--staged" || (isShortCluster(arg) && arg.includes("S")));
  // Without --staged, restore targets the working tree by default.
  return worktree || !staged;
}

/** `--hard` throws away the working tree; `--soft`/`--mixed` (the default)
 *  never touch it. The ARGS decide this, not their position -- unlike the
 *  old regex, `git reset --quiet --hard` still counts. */
function resetDiscards(args: readonly string[]): boolean {
  return args.includes("--hard");
}

/** `-f`/`--force` is required before clean will run at all, so its presence
 *  alone is enough -- including folded into a short cluster (`-df`, `-fx`). */
function cleanDiscards(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--force" || (isShortCluster(arg) && arg.includes("f")));
}

/** True when `tokens[start]` is git and the invocation it begins discards
 *  uncommitted work. `viaXargs` is whether this invocation is fed its
 *  arguments by an `xargs` further back in the same segment -- see
 *  checkoutDiscards' bare trailing `--` case. */
function gitDiscardsFrom(tokens: readonly string[], start: number, viaXargs = false): boolean {
  if (programName(tokens[start] ?? "") !== "git") return false;
  let index = start + 1;
  while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
    index += GLOBAL_OPTIONS_WITH_VALUE.has(tokens[index] ?? "") ? 2 : 1;
  }
  const subcommand = tokens[index];
  const args = tokens.slice(index + 1);
  if (subcommand === "checkout") return checkoutDiscards(args, viaXargs);
  if (subcommand === "restore") return restoreDiscards(args);
  if (subcommand === "reset") return resetDiscards(args);
  if (subcommand === "clean") return cleanDiscards(args);
  return false;
}

/** Index of the first token at or after `start` that is not one of a
 *  program's own flags -- skipping a flag's separate value when
 *  `optionsWithValue` says it takes one. Used to walk past `ssh`'s and
 *  `watch`'s own options to find the host / the command they run. */
function afterOwnOptions(tokens: readonly string[], start: number, optionsWithValue: ReadonlySet<string>): number {
  let index = start;
  while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
    index += optionsWithValue.has(tokens[index] ?? "") ? 2 : 1;
  }
  return index;
}

/**
 * The program name a shell would actually run for `tokens`, and its index --
 * skipping leading `NAME=value` assignments and wrapper words (WRAPPERS)
 * together with their own flags, then -- because a wrapper's own option can
 * take a separate value this walk cannot know the grammar of (`sudo -u
 * root`, `nice -n 10`) -- jumping forward to the first token naming one of
 * `recognized`'s programs. Shared by segmentDiscards (which program
 * discards) and scanSegment's dataPositionIndexes (which argument of that
 * program is data), so both read a wrapped command line the same way.
 * `viaXargs` reports whether `xargs` itself was one of the skipped wrappers.
 */
function resolveProgram(
  tokens: readonly string[],
  recognized: ReadonlySet<string>,
): { readonly name: string; readonly index: number; readonly viaXargs: boolean } {
  let index = 0;
  let wrapped = false;
  let viaXargs = false;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const name = programName(stripLeadingGroupers(token));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
    } else if (WRAPPERS.has(name)) {
      wrapped = true;
      if (name === "xargs") viaXargs = true;
      index += 1;
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index += 1;
    } else {
      break;
    }
  }
  if (wrapped) {
    const runs = tokens.findIndex((token, at) => at >= index && recognized.has(programName(stripLeadingGroupers(token))));
    if (runs !== -1) index = runs;
  }
  return { name: programName(stripLeadingGroupers(tokens[index] ?? "")), index, viaXargs };
}

/** Whether the command a segment runs -- looking through wrappers, `sh -c`,
 *  `eval`, `su -c`/`script -c`, `ssh`'s remote command and `watch` --
 *  discards work. */
function segmentDiscards(segment: string): boolean {
  const tokens = tokenize(segment);
  const { name: program, index, viaXargs } = resolveProgram(tokens, RECURSIVE_COMMAND_PROGRAMS);
  if (SHELLS.has(program) || DASH_C_COMMAND_PROGRAMS.has(program)) {
    const flag = tokens.findIndex((token, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    const script = flag === -1 ? undefined : tokens[flag + 1];
    return script !== undefined && discardsUncommittedWork(script);
  }
  if (program === "eval") return discardsUncommittedWork(tokens.slice(index + 1).join(" "));
  // ssh joins every argument after the host into ONE line and hands it to
  // the remote shell -- the same thing `bash -c`'s argument already is,
  // just assembled from several local shell words instead of one.
  if (program === "ssh") {
    const afterHost = afterOwnOptions(tokens, index + 1, SSH_OPTIONS_WITH_VALUE) + 1;
    return afterHost < tokens.length && discardsUncommittedWork(tokens.slice(afterHost).join(" "));
  }
  // `watch CMD` reruns CMD on an interval; everything after watch's own
  // options is that command line, with no `-c` flag to mark it.
  if (program === "watch") {
    const commandStart = afterOwnOptions(tokens, index + 1, WATCH_OPTIONS_WITH_VALUE);
    return commandStart < tokens.length && discardsUncommittedWork(tokens.slice(commandStart).join(" "));
  }
  return gitDiscardsFrom(tokens, index, viaXargs);
}

/**
 * True when any command `command` would run -- including one wrapped in
 * `sudo`, `bash -c "..."`, `eval`, a subshell or a substitution --
 * overwrites the working tree. Used by the deny tier.
 */
export function discardsUncommittedWork(command: string): boolean {
  const { outer, inner } = extractSubstitutions(command);
  if (inner.some(discardsUncommittedWork)) return true;
  return splitOutsideQuotes(outer).some(segmentDiscards);
}

/**
 * True when `segment` itself STARTS with such a git invocation -- the
 * anchored form commandFamily needs, read with the same tokenizer.
 */
export function startsWithGitDiscard(segment: string): boolean {
  return gitDiscardsFrom(tokenize(segment.trim()), 0);
}

/**
 * Splits on the shell's command separators (`;`, `&&`, `||`, `|`, `&`,
 * newline) outside quotes, backticks and parentheses. Unlike
 * `splitOutsideQuotes` it never splits on a parenthesis: a `$(...)`
 * substitution is part of the arguments of the command it feeds, so
 * `git push $(echo --force) origin` stays one segment. A plain `( ... )`
 * subshell also stays whole, which errs toward matching (a deny rule may
 * see two of its commands together), never toward missing one. A
 * redirection (`2>&1`, `&>`, `>|`) is part of its command, not a separator.
 */
export function splitOnCommandSeparators(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let backtick = false;
  let depth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\" && !single) {
      current += command.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (char === "`" && !single) backtick = !backtick;
    else if (char === "(" && !single && !double) depth += 1;
    else if (char === ")" && !single && !double && depth > 0) depth -= 1;
    if (!single && !double && !backtick && depth === 0 && /[;&|\n]/.test(char) && !isRedirection(command, index)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * True when the `&` or `|` at `index` belongs to a redirection (`2>&1`,
 * `0<&3`, `&>file`, `>|file`) rather than separating two commands.
 */
function isRedirection(command: string, index: number): boolean {
  const char = command[index];
  const previous = command[index - 1];
  if (char === "&") return previous === ">" || previous === "<" || command[index + 1] === ">";
  if (char === "|") return previous === ">";
  return false;
}

// ---------------------------------------------------------------------------
// Quote-opacity for someSegmentMatches (odd/tasks/release-0.5.1.md T8,
// JEVADV-24). forcePush and pushProtected are its only `scope: 'segment'`
// callers, and both used to test a segment's RAW text: a quoted argument
// with whitespace in it -- a commit message, a PR body -- reads exactly
// like a real command to a `.*`-spanning pattern, because nothing told the
// pattern the text sat inside quotes. Observed live: `printf` whose
// double-quoted argument merely SPELLED OUT a destructive git command was
// refused as if that command had run.
//
// scanSegment below reduces a segment to the text a shell would actually
// EXECUTE: `$(...)`, backticks (even inside double quotes) and the script
// argument of `bash -c`/`sh -c`/`zsh -c`/`dash -c`/`ksh -c`/`eval` stay
// exactly as visible as before, because a shell really does run those. A
// single quoted WORD (`"main"`, `"-f"`) also stays visible on purpose: it is
// ordinary shell usage for a bare value, not descriptive prose, and no
// `\s`-spanning pattern can ever be spelled with one word alone -- so
// keeping it visible only ever adds a true match, never reopens the false
// positive this exists to close.
//
// T8 made every OTHER quoted, multi-word argument opaque, everywhere. T10
// (JEVADV-28) narrows that to the KNOWN DATA POSITIONS block further down
// this file: opaque only where the program reading it is known to treat
// that argument as data, never as something to run -- see that block's own
// note for why (a command run by ANOTHER program, e.g. `ssh host "git push
// --force origin main"`, looked identical to a shell running something
// quoted, and T8's blanket rule hid it).
//
// JEVADV-36 (odd/tasks/release-0.5.1.md T10 review-3 follow-ups) refines
// T10's binary opaque/visible split into three outcomes a caller can act on
// differently: a match in COMMAND POSITION still denies; a match that
// exists ONLY because a quoted argument of some OTHER, non-executing
// program stayed visible (not a known data position, not code) is a MENTION
// -- not a run, but not known-safe either; and a known data position stays
// fully opaque (no match at all). This function's own contract stops there:
// what a caller DOES with a mention is the caller's decision, not this
// module's. JEVADV-37 (same file) changed that decision at the gate layer
// (adapters/claude/gate-bash.ts): a mention no longer stops locally to ask a
// person -- an unattended agent has nobody to answer it -- it now falls
// through to the ordinary Jev path instead, a real risk/policy judgment
// rather than a silent allow. `scanSegment` is scanned TWICE per
// segment, once per `ScanMode`:
//   - "command": the strict view -- every quoted multi-word argument is
//     opaque (T8's original blanket rule), EXCEPT an interpreter CODE
//     string (see INTERPRETER_CODE_FLAGS below), which commonly shells out
//     and so stays visible even here.
//   - "visible": today's T10 allowlist -- opaque only at a known DATA
//     position (dataPositionIndexes), visible everywhere else.
// A match surviving the strict "command" view is real command-position
// text (recursion into `bash -c`/`eval`/`ssh`/`su -c`/`script -c`/`watch`
// behaves identically in both modes, since that text really does run); a
// match that only shows up under "visible" is a mention. Recursion depth,
// substitution/quote-balance failures and everything else about WHETHER a
// segment can be scanned at all does not depend on the mode -- only which
// already-successfully-parsed tokens the mode hides.
// ---------------------------------------------------------------------------

/** Which of the two allowlists scanSegment applies to a quoted, multi-word
 *  argument -- see the module note above. */
type ScanMode = "command" | "visible";

/**
 * Programs whose "run this string" flag makes its value CODE, not data --
 * `python3 -c '...'`, `node -e '...'`, `osascript -e '...'`, etc. These
 * commonly shell out (`os.system`, `execSync`, `do shell script`, ...), so
 * unlike a plain argument to some other, non-executing program, this stays
 * visible even under the strictest ("command") scan mode -- it is not
 * recursively re-parsed as shell syntax (it is not shell syntax), it is
 * simply never hidden.
 */
const INTERPRETER_CODE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["node", new Set(["-e", "-p", "--eval"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e", "-E"])],
  ["php", new Set(["-r"])],
  ["osascript", new Set(["-e"])],
]);
const INTERPRETER_CODE_PROGRAMS: ReadonlySet<string> = new Set(INTERPRETER_CODE_FLAGS.keys());

/** One shell word of a scanned segment: its dequoted text, and whether ANY
 *  of its characters were drawn from inside a quote. */
interface ScanToken {
  readonly text: string;
  readonly quoted: boolean;
}

/**
 * Like `tokenize`, but flags whether each token drew a character from
 * inside a quote, and reports failure (null) on an unbalanced quote instead
 * of silently absorbing the rest of the line into one token -- exactly what
 * `tokenize` itself does, and exactly what the deny tier's fail-CLOSED
 * contract cannot use (see scanSegment's own doc comment).
 */
function tokenizeForScan(segment: string): readonly ScanToken[] | null {
  const tokens: ScanToken[] = [];
  let current = "";
  let inToken = false;
  let quoted = false;
  let single = false;
  let double = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (char === "\\" && !single) {
      current += segment[index + 1] ?? "";
      inToken = true;
      index += 1;
    } else if (char === "'" && !double) {
      single = !single;
      inToken = true;
      quoted = true;
    } else if (char === '"' && !single) {
      double = !double;
      inToken = true;
      quoted = true;
    } else if (/\s/.test(char) && !single && !double) {
      if (inToken) tokens.push({ text: current, quoted });
      current = "";
      inToken = false;
      quoted = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (single || double) return null;
  if (inToken) tokens.push({ text: current, quoted });
  return tokens;
}

/** Stands in for one `$(...)`/backtick span while the rest of a scanned
 *  segment is tokenized; a control character no real command line can
 *  contain, so splicing the recursively-scanned body back in by searching
 *  for it can never collide with the segment's own text. Kept separate from
 *  extractSubstitutions' own "_" marker above: that one is never spliced
 *  back in, so it has no need to be collision-proof. */
const SCAN_SUBSTITUTION_MARKER = "\u0001";

/**
 * The same walk as `extractSubstitutions`, but reports failure (null) on an
 * unterminated quote or substitution instead of quietly keeping going --
 * needed here because scanSegment must fail CLOSED (see its own doc
 * comment) rather than guess at malformed input.
 */
function extractSubstitutionsForScan(text: string): { readonly outer: string; readonly bodies: readonly string[] } | null {
  const bodies: string[] = [];
  let outer = "";
  let single = false;
  let double = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\" && !single) {
      outer += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      outer += char;
      index += 1;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      outer += char;
      index += 1;
      continue;
    }
    if (!single && char === "$" && text[index + 1] === "(") {
      let depth = 1;
      let close = index + 2;
      while (close < text.length && depth > 0) {
        if (text[close] === "(") depth += 1;
        else if (text[close] === ")") depth -= 1;
        close += 1;
      }
      if (depth !== 0) return null;
      bodies.push(text.slice(index + 2, close - 1));
      outer += SCAN_SUBSTITUTION_MARKER;
      index = close;
      continue;
    }
    if (!single && char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close === -1) return null;
      bodies.push(text.slice(index + 1, close));
      outer += SCAN_SUBSTITUTION_MARKER;
      index = close + 1;
      continue;
    }
    outer += char;
    index += 1;
  }
  if (single || double) return null;
  return { outer, bodies };
}


const SCAN_MAX_DEPTH = 8;
/** Stands in for one quoted, multi-word argument in a known DATA position in scanSegment's output. */
const SCAN_DATA_PLACEHOLDER = "‹data›";

// ---------------------------------------------------------------------------
// KNOWN DATA POSITIONS (odd/tasks/release-0.5.1.md T10, JEVADV-28).
//
// T8 made EVERY quoted multi-word argument opaque, everywhere -- which also
// hid a real command run by another program (`ssh host "git push --force
// origin main"`, `su -c "git push -f origin main"`), because a shell running
// something quoted looks identical, character for character, to a program
// merely printing or matching text. T10 inverts this into an ALLOWLIST: a
// quoted multi-word argument goes opaque ONLY when the program reading it is
// known to treat that argument as DATA rather than as something to run.
// Everywhere else -- an unrecognised program included -- it stays VISIBLE,
// which is exactly 0.5.0's behaviour: fail closed for the unknown case,
// rather than assume the best.
//
// dataPositionIndexes below names the token indexes, within one already-
// resolved command's tokens, that this allowlist covers. Only a QUOTED
// MULTI-WORD token is ever a candidate in the first place (see scanToken):
// this only decides which of THOSE tokens is data, not whether a plain,
// unquoted word is ever hidden -- it never is.
// ---------------------------------------------------------------------------

/** Programs whose data-position rules this file knows, used as
 *  resolveProgram's `recognized` set so a wrapper (`sudo`, `env`, ...) does
 *  not hide which program's argument is actually being judged. */
const DATA_MARKING_PROGRAMS = new Set(["printf", "echo", "git", "gh", "grep", "egrep", "fgrep", "rg", "ag", "jq"]);

/** git commit's own message flags; `-F`/`--message`/`-m` all name a file or
 *  literal text to use VERBATIM as the commit message -- never a command. */
const GIT_COMMIT_MESSAGE_FLAGS = new Set(["-m", "--message", "-F"]);
/** `git tag -m` / `git notes add -m` only ever take the short form. */
const GIT_SINGLE_M_FLAG = new Set(["-m"]);

/** gh's text flags: a PR/issue body, title, subject or comment message,
 *  across every gh subcommand -- gh never runs this text, it posts it. */
const GH_TEXT_FLAGS = new Set(["--body", "-b", "--title", "-t", "--subject", "--message", "-m"]);

const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
/** grep-family flags whose OWN value is the pattern, wherever it appears. */
const GREP_PATTERN_FLAGS = new Set(["-e", "--regexp"]);
/** grep-family flags that consume a separate value that is NOT the pattern,
 *  so the search for "the first non-flag argument" does not stop on one of
 *  these values by mistake -- including ripgrep's own
 *  `-t/-T/-g/-r/-M/-j/-E`, so `rg -t ts "pattern"` still finds "pattern",
 *  not "ts". */
const GREP_OTHER_VALUE_FLAGS = new Set([
  "-f", "--file", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-t", "--type", "-T", "--type-not", "-g", "--glob", "-r", "--replace", "-M", "--max-columns", "-j", "--threads", "-E", "--encoding",
]);

/** jq flags that consume one, or two, separate values that are not the filter. */
const JQ_ONE_VALUE_FLAGS = new Set(["-f", "--from-file", "--slurpfile", "--rawfile"]);
const JQ_TWO_VALUE_FLAGS = new Set(["--arg", "--argjson"]);

/** `git log`'s own history-search flags: `-S<string>`/`-G<regex>` (the
 *  pickaxe) and `--grep`, each read here in their SPACE-separated form
 *  (`git log -S "text"`) -- the same shape GIT_COMMIT_MESSAGE_FLAGS already
 *  reads, and the one the live false positive this closes was spelled with
 *  (odd/tasks/release-0.5.1.md JEVADV-36). None of these ever run the text;
 *  they search commit history/diffs for it. */
const GIT_LOG_SEARCH_FLAGS = new Set(["-S", "-G", "--grep"]);

/** The index, within `plain` starting at `from`, of the first token that is
 *  not one of `program`'s own flags and not a value one of `valueFlags`
 *  consumes -- i.e. `program`'s first true positional argument. Shared by
 *  the grep-family and jq cases below, whose "the filter/pattern is the
 *  first positional" shape is otherwise identical. */
function firstPositionalIndex(plain: readonly string[], from: number, valueFlags: ReadonlyMap<string, number>): number {
  let index = from;
  while (index < plain.length) {
    const token = plain[index] ?? "";
    if (!token.startsWith("-")) return index;
    index += valueFlags.get(token) ?? 1;
  }
  return -1;
}

/**
 * The grep-family's own "the pattern is `-e`/`--regexp`'s value, or else the
 * first positional" rule, starting the search at `from` -- shared by a
 * bare, top-level `grep`/`rg`/... invocation and by `git grep`, whose
 * pattern-position rule is otherwise identical (odd/tasks/release-0.5.1.md
 * JEVADV-36): both read the SAME flag grammar, just starting after a
 * different program token.
 */
function grepPatternIndexes(plain: readonly string[], tokenCount: number, from: number): ReadonlySet<number> {
  const data = new Set<number>();
  for (let j = from; j < plain.length; j += 1) {
    if (GREP_PATTERN_FLAGS.has(plain[j] ?? "") && j + 1 < tokenCount) {
      data.add(j + 1);
      return data;
    }
  }
  const valueFlags = new Map<string, number>([...GREP_OTHER_VALUE_FLAGS].map((flag): [string, number] => [flag, 2]));
  const pattern = firstPositionalIndex(plain, from, valueFlags);
  if (pattern !== -1) data.add(pattern);
  return data;
}

/** gh's text flags, and now a generic set for ANY program (odd/tasks/
 *  release-0.5.1.md JEVADV-36): a PR/issue body, title, description,
 *  comment, subject, summary or note -- none of these are ever RUN by the
 *  program reading them, whichever program that is. `-m` deliberately stays
 *  OUT of this generic set: it is too overloaded a flag letter across
 *  unrelated tools (merge, mode, message, ...) to safely generalise, so it
 *  stays scoped to where it was already allowlisted above (git commit/tag/
 *  notes, gh). */
const GENERIC_TEXT_FLAGS: ReadonlySet<string> = new Set([
  "--body", "--title", "--message", "--description", "--comment", "--text", "--subject", "--summary", "--note",
]);
/** The same set's `=value` form (`--body=...`), glued into ONE shell token --
 *  the whole token becomes the data position (see addGenericTextFlagPositions). */
const GENERIC_TEXT_FLAG_ASSIGNMENT = /^--(?:body|title|message|description|comment|text|subject|summary|note)=/;

/** Marks every generic-text-flag position in `plain`, for ANY program,
 *  regardless of which (if any) program-specific branch below also runs --
 *  mutates `data` rather than returning a fresh set, so it composes with
 *  whatever the program-specific rules already added instead of requiring
 *  every branch below to remember to include it. */
function addGenericTextFlagPositions(plain: readonly string[], tokenCount: number, data: Set<number>): void {
  for (let j = 0; j < plain.length; j += 1) {
    const token = plain[j] ?? "";
    if (GENERIC_TEXT_FLAGS.has(token) && j + 1 < tokenCount) data.add(j + 1);
    else if (GENERIC_TEXT_FLAG_ASSIGNMENT.test(token)) data.add(j);
  }
}

/**
 * The token indexes in `tokens` that are a known DATA position -- see the
 * module note above. `tokens` is always ONE already-resolved command's
 * tokens (scanSegment's recursion into `-c`/eval/ssh/su/watch has already
 * peeled away any wrapper's own command-line argument by the time this
 * runs), so only ONE program's rules ever apply here (plus the
 * program-independent generic text flags, which apply regardless).
 */
function dataPositionIndexes(tokens: readonly ScanToken[]): ReadonlySet<number> {
  const plain = tokens.map((token) => token.text);
  const data = new Set<number>();
  addGenericTextFlagPositions(plain, tokens.length, data);
  const { name: program, index: programIndex } = resolveProgram(plain, DATA_MARKING_PROGRAMS);

  if (program === "printf" || program === "echo") {
    for (let i = programIndex + 1; i < tokens.length; i += 1) data.add(i);
    return data;
  }

  if (program === "git") {
    let i = programIndex + 1;
    while (i < plain.length && (plain[i] ?? "").startsWith("-")) {
      i += GLOBAL_OPTIONS_WITH_VALUE.has(plain[i] ?? "") ? 2 : 1;
    }
    const subcommand = plain[i];
    if (subcommand === "grep") {
      for (const index of grepPatternIndexes(plain, tokens.length, i + 1)) data.add(index);
      return data;
    }
    if (subcommand === "log") {
      for (let j = i + 1; j < plain.length; j += 1) {
        if (GIT_LOG_SEARCH_FLAGS.has(plain[j] ?? "") && j + 1 < tokens.length) data.add(j + 1);
      }
      return data;
    }
    const messageFlags =
      subcommand === "commit" ? GIT_COMMIT_MESSAGE_FLAGS :
      subcommand === "tag" ? GIT_SINGLE_M_FLAG :
      subcommand === "notes" && plain[i + 1] === "add" ? GIT_SINGLE_M_FLAG :
      null;
    if (messageFlags !== null) {
      for (let j = i + 1; j < plain.length; j += 1) {
        if (messageFlags.has(plain[j] ?? "") && j + 1 < tokens.length) data.add(j + 1);
      }
    }
    return data;
  }

  if (program === "gh") {
    for (let j = programIndex + 1; j < plain.length; j += 1) {
      if (GH_TEXT_FLAGS.has(plain[j] ?? "") && j + 1 < tokens.length) data.add(j + 1);
    }
    return data;
  }

  if (GREP_FAMILY.has(program)) {
    for (const index of grepPatternIndexes(plain, tokens.length, programIndex + 1)) data.add(index);
    return data;
  }

  if (program === "jq") {
    const valueFlags = new Map<string, number>([
      ...[...JQ_ONE_VALUE_FLAGS].map((flag): [string, number] => [flag, 2]),
      ...[...JQ_TWO_VALUE_FLAGS].map((flag): [string, number] => [flag, 3]),
    ]);
    const filter = firstPositionalIndex(plain, programIndex + 1, valueFlags);
    if (filter !== -1) data.add(filter);
    return data;
  }

  return data;
}

/**
 * The token indexes in `tokens` that are an interpreter CODE string -- see
 * INTERPRETER_CODE_FLAGS' own doc comment. Unlike dataPositionIndexes, this
 * is never opaque: it exists so scanTokens' "command" mode can EXCLUDE these
 * positions from its blanket hide-everything-quoted rule, because this text
 * really does run (just not as shell syntax).
 */
function interpreterCodePositions(tokens: readonly ScanToken[]): ReadonlySet<number> {
  const plain = tokens.map((token) => token.text);
  const { name: program, index: programIndex } = resolveProgram(plain, INTERPRETER_CODE_PROGRAMS);
  const positions = new Set<number>();
  const flags = INTERPRETER_CODE_FLAGS.get(program);
  if (flags === undefined) return positions;
  for (let j = programIndex + 1; j < plain.length; j += 1) {
    if (flags.has(plain[j] ?? "") && j + 1 < tokens.length) positions.add(j + 1);
  }
  return positions;
}

/** Whether index `i` is hidden under `mode` -- see the module note on
 *  ScanMode above. An interpreter CODE position is never hidden, in either
 *  mode. Otherwise "command" mode hides every candidate (T8's original
 *  blanket rule); "visible" mode hides only a known DATA position. */
function isHiddenInMode(i: number, mode: ScanMode, dataPositions: ReadonlySet<number>, codePositions: ReadonlySet<number>): boolean {
  if (codePositions.has(i)) return false;
  return mode === "command" || dataPositions.has(i);
}

function scanToken(token: ScanToken, isHidden: boolean): string {
  return isHidden && token.quoted && /\s/.test(token.text) ? SCAN_DATA_PLACEHOLDER : token.text;
}

/**
 * scanToken for a token that may carry substitution markers. The bodies are
 * spliced in AFTER tokenizing, never before: a `$(...)` inside double quotes
 * still runs, and splicing it into the quoted text first let the data
 * placeholder swallow it (review finding R3). Only the literal text around
 * the markers is judged as hidden; every body is always emitted, regardless
 * of mode -- a substitution really does run.
 */
function scanTokenWithBodies(token: ScanToken, nextBody: () => string, isHidden: boolean): string {
  if (!token.text.includes(SCAN_SUBSTITUTION_MARKER)) return scanToken(token, isHidden);
  const parts = token.text.split(SCAN_SUBSTITUTION_MARKER);
  const bodies = parts.slice(1).map(() => nextBody());
  const literal = parts.join("");
  if (isHidden && token.quoted && /\s/.test(literal)) return [SCAN_DATA_PLACEHOLDER, ...bodies].join(" ");
  return parts.reduce((out, part, at) => (at === 0 ? part : `${out} ${bodies[at - 1] ?? ""} ${part}`), "");
}

/** Maps every token in `tokens` through scanTokenWithBodies, resolving DATA
 *  and interpreter-code positions once for the whole list rather than per
 *  token -- a position is always decided by where a token sits relative to
 *  the OTHERS in the same command, never in isolation. */
function scanTokens(tokens: readonly ScanToken[], nextBody: () => string, mode: ScanMode): string {
  const dataPositions = dataPositionIndexes(tokens);
  const codePositions = interpreterCodePositions(tokens);
  return tokens.map((token, i) => scanTokenWithBodies(token, nextBody, isHiddenInMode(i, mode, dataPositions, codePositions))).join(" ");
}

/**
 * `segment` reduced to the text someSegmentMatches' patterns are allowed to
 * read under `mode` -- see the module note above for the rule and why it
 * exists. Returns null when `segment` cannot be read with confidence: an
 * unbalanced quote, an unterminated substitution, or nesting deep enough to
 * suggest either. Failing closed here means the caller falls back to the RAW
 * segment text, which is what matched before this fix existed -- matching
 * MORE freely on a parse this function could not finish, never less. Whether
 * a segment parses at all never depends on `mode`: only which
 * already-successfully-parsed tokens end up hidden does.
 */
function scanSegment(segment: string, depth: number, mode: ScanMode): string | null {
  if (depth > SCAN_MAX_DEPTH) return null;
  const extracted = extractSubstitutionsForScan(segment);
  if (extracted === null) return null;
  const scannedBodies: string[] = [];
  for (const body of extracted.bodies) {
    const scanned = scanSegment(body, depth + 1, mode);
    if (scanned === null) return null;
    scannedBodies.push(scanned);
  }
  // Substitution bodies are flattened back in, not hidden: a flag or branch
  // produced by `$(...)`/backticks is still part of the enclosing command's
  // own arguments at runtime (see someSegmentMatches' substitution tests).
  // They go back in per token, after tokenizing the outer text, so the
  // quotes a substitution sat in can never hide it (scanTokenWithBodies).
  const tokens = tokenizeForScan(extracted.outer);
  if (tokens === null) return null;
  let bodyIndex = 0;
  const nextScannedBody = (): string => scannedBodies[bodyIndex++] ?? "";

  // The COMMAND-position program this segment resolves to (odd/tasks/
  // release-0.5.1.md JEVADV-36, item 2): resolveProgram already knows how to
  // walk PAST a wrapper's own flags (sudo/env/nice/...) to the program it
  // actually runs, and how to skip a leading `NAME=value` assignment -- the
  // exact discipline resolveProgram gives gitDiscardsFrom elsewhere in this
  // file. Checking only the ONE resolved program (rather than looping over
  // every token looking for a name that happens to equal a wrapper's own)
  // is what stops a wrapper's NAME appearing as a plain, unrelated argument
  // of some other program (`grep -n watch "..." f`) from being misread as
  // that wrapper's own command.
  const plainTexts = tokens.map((token) => token.text);
  const { name, index } = resolveProgram(plainTexts, RECURSIVE_COMMAND_PROGRAMS);

  // A program that runs ANOTHER program named in its own arguments hands off
  // a whole command line, exactly like a wrapper: `find ... -exec sh -c '...'`
  // and a `--` hand-off (`docker exec c -- sh -c '...'`, `kubectl exec p --
  // git ...`). The rest of the segment from that point is scanned as its own
  // command line, so a shell reached this way is recursed into instead of
  // being read as one opaque quoted argument (review finding
  // R3-wrapper-only-at-resolved-program). `xargs` needs nothing here: it is
  // already one of WRAPPERS.
  const handOff = RECURSIVE_COMMAND_PROGRAMS.has(name) ? -1 : execHandOffIndex(plainTexts, index, name);
  if (handOff !== -1) {
    const before = scanTokens(tokens.slice(0, handOff), nextScannedBody, mode);
    const rest = tokens
      .slice(handOff)
      .map((candidate) => candidate.text.split(SCAN_SUBSTITUTION_MARKER).reduce((out, part, at) => (at === 0 ? part : `${out}$(${extracted.bodies[bodyIndex++] ?? ""})${part}`), ""))
      .map((text, at) => (tokens[handOff + at]?.quoted && /\s/.test(text) ? `'${text.replace(/'/g, "'\\''")}'` : text))
      .join(" ");
    const scanned = scanSegment(rest, depth + 1, mode);
    if (scanned === null) return null;
    return [before, scanned].join(" ");
  }
  const isEval = name === "eval";
  const takesDashC = SHELLS.has(name) || DASH_C_COMMAND_PROGRAMS.has(name);
  const flagIndex = takesDashC
    ? tokens.findIndex((candidate, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(candidate.text))
    : -1;
  const isSsh = name === "ssh";
  const isWatch = name === "watch";
  const resolvedScriptStart = isEval
    ? index + 1
    : flagIndex !== -1
      ? flagIndex + 1
      : isSsh
        ? afterOwnOptions(plainTexts, index + 1, SSH_OPTIONS_WITH_VALUE) + 1
        : isWatch
          ? afterOwnOptions(plainTexts, index + 1, WATCH_OPTIONS_WITH_VALUE)
          : -1;
  // JEVADV-37 item 3: nothing above recognised a runner for this segment at
  // all -- the resolved program is some OTHER, unmodelled command (`parallel`,
  // `flock`, `chroot`, ...). Fall back to a real shell `-c` pair found
  // ANYWHERE in the segment -- see shellDashCAnywhereIndex's own doc comment.
  const scriptStart = resolvedScriptStart !== -1 ? resolvedScriptStart : shellDashCAnywhereIndex(plainTexts);
  if (scriptStart !== -1 && tokens[scriptStart] !== undefined) {
    const before = scanTokens(tokens.slice(0, scriptStart), nextScannedBody, mode);
    // The script is scanned again as a whole, so its substitutions go back
    // in as their ORIGINAL `$(...)` text, in the same order, for that
    // recursive scan to extract and read on its own.
    const script = tokens
      .slice(scriptStart)
      .map((candidate) => candidate.text.split(SCAN_SUBSTITUTION_MARKER).reduce((out, part, at) => (at === 0 ? part : `${out}$(${extracted.bodies[bodyIndex++] ?? ""})${part}`), ""))
      .join(" ");
    const scanned = scanSegment(script, depth + 1, mode);
    if (scanned === null) return null;
    return [before, scanned].join(" ");
  }

  return scanTokens(tokens, nextScannedBody, mode);
}

/**
 * Where the command a program hands off to begins, or -1. `find`'s -exec
 * family starts one right after the option; a bare `--` starts one only when
 * the token after it names a program this module recurses into, so `npm test
 * -- --grep x` (arguments, not a program) is left alone.
 */
function execHandOffIndex(texts: readonly string[], index: number, name: string): number {
  if (name === "find") {
    const at = texts.findIndex((text, position) => position > index && FIND_EXEC_OPTIONS.has(text));
    return at === -1 || at + 1 >= texts.length ? -1 : at + 1;
  }
  const dashDash = texts.findIndex((text, position) => position > index && text === "--");
  if (dashDash === -1) return -1;
  const next = texts[dashDash + 1];
  return next !== undefined && RECURSIVE_COMMAND_PROGRAMS.has(programName(stripLeadingGroupers(next))) ? dashDash + 1 : -1;
}

/**
 * The index right after a real shell's `-c`-style flag, found ANYWHERE in
 * `texts` -- not only at the segment's own resolved command position -- or
 * -1. JEVADV-37 item 3 (odd/tasks/release-0.5.1.md): a real `sh -c`/
 * `bash -c`/`zsh -c`/`dash -c`/`ksh -c` pair still runs its script whichever
 * program precedes it (`parallel sh -c "…"`, `flock f sh -c "…"`, `chroot /
 * sh -c "…"`), because none of those wrapping programs is modelled here the
 * way WRAPPERS/RECURSIVE_COMMAND_PROGRAMS already model sudo/env/nice/etc. --
 * this is the fallback for exactly that unmodelled case, only ever reached
 * from scanSegment once resolveProgram's own forward search and
 * execHandOffIndex have both already found no runner for this segment at
 * all (a nice/ionice pair, or a `find -exec`/`--` hand-off, already resolves
 * the shell without this).
 *
 * Deliberately narrower than resolveProgram's own forward search:
 *   - it requires the `-c`-style flag IMMEDIATELY after the shell token, not
 *     merely somewhere later in the segment;
 *   - it only ever recognises a REAL shell name (SHELLS) -- never
 *     ssh/watch/su/script, which stay limited to the segment's own command
 *     position or a known exec hand-off (see RECURSIVE_COMMAND_PROGRAMS/
 *     execHandOffIndex above). A bare later mention of one of those names as
 *     some OTHER program's own argument (`grep -n watch "…git reset
 *     --hard…" f`) must keep resolving to a mention, not a run (review-3 R3).
 */
function shellDashCAnywhereIndex(texts: readonly string[]): number {
  for (let i = 0; i < texts.length - 1; i += 1) {
    if (SHELLS.has(programName(stripLeadingGroupers(texts[i] ?? ""))) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(texts[i + 1] ?? "")) {
      return i + 2;
    }
  }
  return -1;
}

/**
 * True when `command` cannot be scanned with confidence: scanSegment
 * returned null. Three distinct causes, all folded into one boolean because
 * every one of them means the same thing to a caller -- "don't trust what
 * you can read here, fall back to the raw text":
 *   - an unclosed single or double quote;
 *   - a `$(...)`/backtick substitution that never closes;
 *   - nesting deep enough (SCAN_MAX_DEPTH) to suggest either of the above
 *     rather than a real, deeply-nested command.
 * Whether a segment can be scanned at all never depends on ScanMode (see
 * scanSegment's own doc comment), so this reads it under either one --
 * "visible" here is an arbitrary, inconsequential choice.
 */
export function cannotScanWithConfidence(command: string): boolean {
  return scanSegment(command, 0, "visible") === null;
}

/** The result of scanning a command for one destructive pattern -- see
 *  someSegmentMatches below. `"deny"` is a match in COMMAND position (a real
 *  shell/interpreter would run it); `"ask"` is a match that exists ONLY
 *  because a quoted argument of some other, non-executing program stayed
 *  visible -- a mention, not a run, but not a KNOWN-safe data position
 *  either. `null` is no match at all (including every match sitting at a
 *  known data position, which is opaque in both scan modes and so never
 *  reaches either outcome).
 *
 *  What a caller does with `"ask"` is the caller's own decision, not this
 *  module's: gate-bash.ts (JEVADV-37, odd/tasks/release-0.5.1.md) does NOT
 *  stop locally on it -- an unattended agent has nobody to answer a local
 *  ask -- it routes the command to the ordinary Jev path instead. The name
 *  stays `"ask"` here because at THIS module's level the fact being reported
 *  is still "a mention, not a run"; only the gate's response to that fact
 *  changed. */
export type SegmentMatchSeverity = "deny" | "ask" | null;

/**
 * Whether `pattern` matches `command`, and at what severity -- used by
 * gate-bash.ts's NEVER_SILENTLY loop for its two-level rules (forcePush,
 * pushProtected, resetClean; odd/tasks/release-0.5.1.md JEVADV-36). Each of
 * `command`'s segments (`splitOnCommandSeparators`) is read TWICE, once per
 * ScanMode: the strict "command" view (every quoted multi-word argument
 * hidden, except an interpreter code string) decides `"deny"`, and only when
 * that view found nothing is the looser "visible" view (today's T10
 * allowlist) checked for `"ask"`. `"visible"` never finds LESS than
 * `"command"` did (a known data position is a subset of "everything", and an
 * interpreter code position is excluded from both identically), so checking
 * "command" first and returning immediately on a hit is exact, not just an
 * optimisation.
 *
 * A segment scanSegment cannot parse with confidence (an unbalanced quote,
 * see cannotScanWithConfidence) falls back to matching the RAW segment text
 * and resolves that match to `"deny"`, never `"ask"`: there is no position
 * to reason about at all when the parse itself failed, so this fails CLOSED
 * onto the more cautious of the two outcomes -- the same discipline
 * gate-bash.ts's own RESET_CLEAN_FALLBACK_PATTERN used to provide as a
 * separate, second disjunct; this makes that disjunct redundant (see its
 * removal in gate-bash.ts).
 *
 * `pattern` is checked against every segment even after an `"ask"` is found
 * in an earlier one, because a LATER segment's `"deny"` still outranks it --
 * `severity` only ever moves from `null` to `"ask"` to `"deny"`, never back.
 */
export function someSegmentMatches(command: string, pattern: { test(segment: string): boolean }): SegmentMatchSeverity {
  let severity: SegmentMatchSeverity = null;
  for (const segment of splitOnCommandSeparators(command)) {
    const commandView = scanSegment(segment, 0, "command");
    if (commandView === null) {
      if (pattern.test(segment)) return "deny";
      continue;
    }
    if (pattern.test(commandView)) return "deny";
    const visibleView = scanSegment(segment, 0, "visible") ?? segment;
    if (pattern.test(visibleView)) severity = "ask";
  }
  return severity;
}
