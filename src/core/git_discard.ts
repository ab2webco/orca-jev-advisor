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
// `sudo`/`env`, inside `bash -c` / `eval`, and inside `$(...)` / backticks.
// Text inside an argument (`git commit -m "use git restore x"`) is never a
// run. This matters because this rule DENIES: a false match refuses an
// agent's commit, not just asks about it.
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

function isShortCluster(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token);
}

function checkoutDiscards(args: readonly string[]): boolean {
  const separator = args.indexOf("--");
  // A bare `--` with nothing after it is not a meaningful invocation on its
  // own; the one place it appears in real use is `xargs ... git checkout
  // --`, where xargs appends the actual pathspecs after this static text
  // ends. Denying it costs nothing -- no legitimate, non-destructive command
  // is spelled this way.
  if (separator !== -1) return true;
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

/** True when `tokens[start]` is git and the invocation it begins discards uncommitted work. */
function gitDiscardsFrom(tokens: readonly string[], start: number): boolean {
  if (programName(tokens[start] ?? "") !== "git") return false;
  let index = start + 1;
  while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
    index += GLOBAL_OPTIONS_WITH_VALUE.has(tokens[index] ?? "") ? 2 : 1;
  }
  const subcommand = tokens[index];
  const args = tokens.slice(index + 1);
  if (subcommand === "checkout") return checkoutDiscards(args);
  if (subcommand === "restore") return restoreDiscards(args);
  if (subcommand === "reset") return resetDiscards(args);
  if (subcommand === "clean") return cleanDiscards(args);
  return false;
}

/** Whether the command a segment runs -- looking through wrappers, `sh -c` and `eval` -- discards work. */
function segmentDiscards(segment: string): boolean {
  const tokens = tokenize(segment);
  let index = 0;
  let wrapped = false;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
    } else if (WRAPPERS.has(programName(token))) {
      wrapped = true;
      index += 1;
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index += 1;
    } else {
      break;
    }
  }
  // A wrapper's options can take a separate value (`sudo -u root`,
  // `nice -n 10`, `timeout 60`), and that value is not the program. Rather
  // than learn every wrapper's option grammar, jump to the first word after
  // the wrapper that IS one of the programs this rule reads. The walk stays
  // limited to wrapped segments, so an argument of an ordinary program (a
  // commit message, a search pattern) is still never read as a run.
  if (wrapped) {
    const runs = tokens.findIndex((token, at) => {
      if (at < index) return false;
      const name = programName(token);
      return name === "git" || name === "eval" || SHELLS.has(name);
    });
    if (runs !== -1) index = runs;
  }
  const program = programName(tokens[index] ?? "");
  if (SHELLS.has(program)) {
    const flag = tokens.findIndex((token, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    const script = flag === -1 ? undefined : tokens[flag + 1];
    return script !== undefined && discardsUncommittedWork(script);
  }
  if (program === "eval") return discardsUncommittedWork(tokens.slice(index + 1).join(" "));
  return gitDiscardsFrom(tokens, index);
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
// EXECUTE: a quoted, multi-word argument goes opaque, while `$(...)`,
// backticks (even inside double quotes) and the script argument of
// `bash -c`/`sh -c`/`zsh -c`/`dash -c`/`ksh -c`/`eval` stay exactly as
// visible as before, because a shell really does run those. A single quoted
// WORD (`"main"`, `"-f"`) also stays visible on purpose: it is ordinary
// shell usage for a bare value, not descriptive prose, and no `\s`-spanning
// pattern can ever be spelled with one word alone -- so keeping it visible
// only ever adds a true match, never reopens the false positive this exists
// to close.
// ---------------------------------------------------------------------------

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

/** A subshell wrapping a real command must not hide it: `(bash -c '...')`
 *  still runs `bash -c`. Stripped only for the SHELLS/eval name check below,
 *  never for the token's own text in the reconstructed output. */
function stripLeadingGroupers(token: string): string {
  return token.replace(/^[({]+/, "");
}

const SCAN_MAX_DEPTH = 8;
/** Stands in for one quoted, multi-word argument in scanSegment's output. */
const SCAN_DATA_PLACEHOLDER = "‹data›";

function scanToken(token: ScanToken): string {
  return token.quoted && /\s/.test(token.text) ? SCAN_DATA_PLACEHOLDER : token.text;
}

/**
 * scanToken for a token that may carry substitution markers. The bodies are
 * spliced in AFTER tokenizing, never before: a `$(...)` inside double quotes
 * still runs, and splicing it into the quoted text first let the data
 * placeholder swallow it (review finding R3). Only the literal text around
 * the markers is judged as data; every body is always emitted.
 */
function scanTokenWithBodies(token: ScanToken, nextBody: () => string): string {
  if (!token.text.includes(SCAN_SUBSTITUTION_MARKER)) return scanToken(token);
  const parts = token.text.split(SCAN_SUBSTITUTION_MARKER);
  const bodies = parts.slice(1).map(() => nextBody());
  const literal = parts.join("");
  if (token.quoted && /\s/.test(literal)) return [SCAN_DATA_PLACEHOLDER, ...bodies].join(" ");
  return parts.reduce((out, part, at) => (at === 0 ? part : `${out} ${bodies[at - 1] ?? ""} ${part}`), "");
}

/**
 * `segment` reduced to the text someSegmentMatches' patterns are allowed to
 * read -- see the module note above for the rule and why it exists. Returns
 * null when `segment` cannot be read with confidence: an unbalanced quote,
 * an unterminated substitution, or nesting deep enough to suggest either.
 * Failing closed here means the caller falls back to the RAW segment text,
 * which is what matched before this fix existed -- matching MORE freely on
 * a parse this function could not finish, never less.
 */
function scanSegment(segment: string, depth: number): string | null {
  if (depth > SCAN_MAX_DEPTH) return null;
  const extracted = extractSubstitutionsForScan(segment);
  if (extracted === null) return null;
  const scannedBodies: string[] = [];
  for (const body of extracted.bodies) {
    const scanned = scanSegment(body, depth + 1);
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

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as ScanToken;
    const name = programName(stripLeadingGroupers(token.text));
    const isEval = name === "eval";
    const flagIndex = SHELLS.has(name)
      ? tokens.findIndex((candidate, at) => at > index && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(candidate.text))
      : -1;
    const scriptStart = isEval ? index + 1 : flagIndex + 1;
    if ((isEval || flagIndex !== -1) && tokens[scriptStart] !== undefined) {
      const before = tokens.slice(0, scriptStart).map((candidate) => scanTokenWithBodies(candidate, nextScannedBody));
      // The script is scanned again as a whole, so its substitutions go back
      // in as their ORIGINAL `$(...)` text, in the same order, for that
      // recursive scan to extract and read on its own.
      const script = tokens
        .slice(scriptStart)
        .map((candidate) => candidate.text.split(SCAN_SUBSTITUTION_MARKER).reduce((out, part, at) => (at === 0 ? part : `${out}$(${extracted.bodies[bodyIndex++] ?? ""})${part}`), ""))
        .join(" ");
      const scanned = scanSegment(script, depth + 1);
      if (scanned === null) return null;
      return [...before, scanned].join(" ");
    }
  }

  return tokens.map((token) => scanTokenWithBodies(token, nextScannedBody)).join(" ");
}

/**
 * True when `command` cannot be read the way a shell would -- an unclosed
 * single or double quote, or a `$(...)`/backtick that never closes. Used by
 * gate-bash.ts's resetClean rule: discardsUncommittedWork's own tokenizer
 * silently absorbs the rest of an unterminated quote into one token instead
 * of failing, which would hide a `git reset --hard` sitting after it --
 * exactly the case the resetClean rule's old, quote-blind regex never
 * missed. That regex is kept as this rule's own fail-CLOSED fallback for
 * exactly this one case; see NEVER_SILENTLY in gate-bash.ts.
 */
export function hasUnbalancedQuoting(command: string): boolean {
  return scanSegment(command, 0) === null;
}

/**
 * True when `pattern` matches at least one of `command`'s segments
 * (`splitOnCommandSeparators`), rather than the whole joined string. Used by
 * gate-bash.ts's NEVER_SILENTLY loop for rules whose `scope` is `'segment'`:
 * a `.*` inside `pattern` can then never span a separator (`&&`, `;`, `|`,
 * newline) and falsely implicate a command its own match never touched,
 * while a flag produced by a substitution still counts for its command. As
 * of T8 (JEVADV-24), each segment is also read through scanSegment first, so
 * quoted DATA can no longer satisfy a pattern meant for a command a shell
 * actually runs -- see the module note above.
 */
export function someSegmentMatches(command: string, pattern: { test(segment: string): boolean }): boolean {
  return splitOnCommandSeparators(command).some((segment) => pattern.test(scanSegment(segment, 0) ?? segment));
}
