// Recognises the git commands that overwrite the working tree and lose
// uncommitted changes: `git checkout` in its path and force forms, and
// `git restore` whenever it writes the working tree. `git reset --hard` and
// `git clean -f` stay with their existing regex in adapters/claude/
// gate-bash.ts; this module covers what that regex never matched.
//
// It exists because `git checkout -- <file>` discarded an agent's
// uncommitted work in a real session (odd/CHECKPOINT.md) while the deny
// rule only knew reset and clean. A regex over the whole line cannot tell
// `git checkout -- x` from `git log -- .` or `git checkout main && ls .`,
// so this reads each command segment's git subcommand and its arguments.
//
// Deliberately NOT recognised:
//   - `git checkout <name>` with no `--`: git resolves a bare name as a
//     branch before a path, and a branch switch carries local changes over
//     (or refuses on a conflict). Catching it would stop the most common
//     harmless command there is; the path reading of it is left to the
//     ordinary Jev path.
//   - `git checkout -b` / `-B`: both create or reset a branch POINTER; the
//     working tree is carried over exactly as with any branch switch.
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

/** Splits on the shell's command separators, the same set gate_measurement.ts uses, plus newlines. */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** A token with the quotes and grouping punctuation of the text around it removed. */
function bare(token: string): string {
  return token.replace(/^[("'{]+/, "").replace(/[)"'}]+$/, "");
}

function isShortCluster(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token);
}

function checkoutDiscards(args: readonly string[]): boolean {
  const separator = args.indexOf("--");
  if (separator !== -1 && separator < args.length - 1) return true;
  return args.some(
    (arg) =>
      arg === "--force" ||
      arg.startsWith("--pathspec-from-file") ||
      (isShortCluster(arg) && arg.includes("f")) ||
      WHOLE_TREE_PATHSPECS.has(arg),
  );
}

function restoreDiscards(args: readonly string[]): boolean {
  const worktree = args.some((arg) => arg === "--worktree" || (isShortCluster(arg) && arg.includes("W")));
  const staged = args.some((arg) => arg === "--staged" || (isShortCluster(arg) && arg.includes("S")));
  // Without --staged, restore targets the working tree by default.
  return worktree || !staged;
}

/** True when `tokens[start]` is `git` and the invocation it begins discards uncommitted work. */
function discardsFrom(tokens: readonly string[], start: number): boolean {
  if (tokens[start] !== "git") return false;
  let index = start + 1;
  while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
    const option = tokens[index] ?? "";
    index += GLOBAL_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = tokens[index];
  const args = tokens.slice(index + 1);
  if (subcommand === "checkout") return checkoutDiscards(args);
  if (subcommand === "restore") return restoreDiscards(args);
  return false;
}

function tokensOf(segment: string): string[] {
  return segment.split(/\s+/).map(bare).filter((token) => token.length > 0);
}

/**
 * True when any git invocation anywhere in `command` -- including one
 * wrapped in `bash -c "..."` or a subshell -- overwrites the working tree.
 * Used by the deny tier, which, like the regexes beside it, looks at the
 * whole line.
 */
export function discardsUncommittedWork(command: string): boolean {
  return segments(command).some((segment) => {
    const tokens = tokensOf(segment);
    return tokens.some((_, index) => discardsFrom(tokens, index));
  });
}

/** True when `segment` itself STARTS with such a git invocation -- the anchored form commandFamily needs. */
export function startsWithGitDiscard(segment: string): boolean {
  return discardsFrom(segment.trim().split(/\s+/), 0);
}
