// Recognises the git commands that overwrite the working tree and lose
// uncommitted changes: `git checkout` in its path and force forms, and
// `git restore` whenever it writes the working tree. `git reset --hard` and
// `git clean -f` stay with their existing regex in adapters/claude/
// gate-bash.ts; this module covers what that regex never matched.
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
function splitOutsideQuotes(command: string): string[] {
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
  if (separator !== -1 && separator < args.length - 1) return true;
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
