// 0.6.28 T1: whether a command can reach a protected branch, for the
// `protected-branch` policy scope (decisions.ts's filterPoliciesForBranchReach).
//
// The owner, 2026-10-07: `git add` on a working branch was refused under
// never_write_to_main, because Jev was asked about that policy for every
// command. Two facts decide instead, both read from the text:
//   - the places the command writes in (command_locations.ts and
//     command_targets.ts, as acting_location.ts reads them: `cd`, `git -C`,
//     a write's own target), whose branch the hook resolves;
//   - whether the text names a protected branch as a whole word, a refspec
//     side or a remote branch (`main`, `HEAD:main`, `origin/main`).
// Both fail toward keeping the policy: an unknown place is null, a gh command
// that writes counts as naming one (its base branch is not in the text).
import { gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { resolveCommandTargetDirs } from "./command_targets.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";

/**
 * Programs whose only write is the files command_targets.ts names (`rm`'s
 * operands, the `cp` destination, a redirect target). Any other program may
 * also write where it runs (`node edit.mjs > /tmp/log` edits the checkout,
 * `mv src/a.ts /tmp/x` removes a file from it), so its directory counts.
 */
const FILE_ONLY_WRITERS: ReadonlySet<string> = new Set(["rm", "cp", "echo", "printf"]);

/**
 * Every place `command`, run from `cwd`, writes in, once each: a directory
 * or a file path, or null where it cannot be known without running it. An
 * obviously safe segment writes nowhere and adds nothing. A git segment
 * always counts its own directory (after `cd`, `-C`), even when it also
 * writes a file (`git commit > /tmp/log`): that file says nothing about the
 * branch the commit lands on.
 */
export function branchReachPlaces(command: string, cwd: string, home: string): readonly (string | null)[] {
  const places: (string | null)[] = [];
  const add = (place: string | null): void => {
    if (!places.includes(place)) places.push(place);
  };
  for (const { outer, dir } of locateCommandSegments(command, cwd, home)) {
    if (isObviouslySafeCommand(outer)) continue;
    const git = gitInvocation(outer, dir, home);
    const base = git?.dir ?? dir;
    if (base === null) {
      add(null);
      continue;
    }
    const files = resolveCommandTargetDirs(outer, base);
    const words = tokenize(outer);
    const fileOnly = git === null && files.length > 0 && FILE_ONLY_WRITERS.has(words[0] ?? "");
    if (!fileOnly) add(base);
    for (const file of files) add(file);
    // An operand command_targets.ts cannot resolve (`rm /a $X`) is a place nobody knows.
    if (fileOnly && words.slice(1).some((word) => !word.startsWith("-") && /[$`*?[]/.test(word))) add(null);
  }
  return places;
}

/** git subcommands that pick or write a branch named by an argument. */
const BRANCH_SELECTING: ReadonlySet<string> = new Set(["checkout", "switch", "push", "merge", "rebase", "reset", "pull", "cherry-pick", "branch", "worktree"]);

/** An argument naming a branch the text does not spell: `-` and `@{-1}` (the previous one), a variable, a substitution. */
function namesUnknownBranch(arg: string): boolean {
  return arg === "-" || arg.startsWith("@{") || /[$`]/.test(arg);
}

/** The branch names one shell word can stand for: `+main`, `HEAD:main`, `refs/heads/main`, `origin/main`, `--base=main`, `main~1`. */
function branchNamesIn(token: string): readonly string[] {
  const value = token.startsWith("-") ? (token.includes("=") ? token.slice(token.indexOf("=") + 1) : "") : token;
  const names: string[] = [];
  for (const side of value.replace(/^\+/, "").split(":")) {
    for (const range of side.split(/\.\.\.?/)) {
      const ref = range.replace(/[~^@].*$/, "").replace(/^refs\/(?:heads|tags)\//, "").replace(/^refs\/remotes\//, "");
      if (ref.length === 0) continue;
      names.push(ref.toLowerCase());
      const slash = ref.lastIndexOf("/");
      if (slash >= 0) names.push(ref.slice(slash + 1).toLowerCase());
    }
  }
  return names;
}

/** A gh command's program word, past leading `NAME=value` assignments. */
function runsGh(tokens: readonly string[]): boolean {
  const program = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return program === "gh";
}

/**
 * Whether `command` names one of `protectedBranches` (lower case) in a
 * segment that is not obviously safe, or runs a gh command that may write
 * (a merge, an API call), or a git command that picks or writes a branch
 * the text does not spell (`checkout -`, `@{-1}`, `"$BASE"`): those may
 * reach a protected branch without naming it.
 * A file path or a message that merely contains the word does not count
 * (`src/main.ts`, `-m "fix main menu"`); a path whose last part is exactly
 * a protected name does, which only costs one question.
 */
export function namesProtectedBranch(command: string, protectedBranches: ReadonlySet<string>): boolean {
  for (const segment of splitOnCommandSeparators(command)) {
    if (isObviouslySafeCommand(segment)) continue;
    const tokens = tokenize(segment);
    if (runsGh(tokens)) return true;
    const git = gitInvocation(segment, null, "/");
    if (git !== null && git.subcommand !== null && BRANCH_SELECTING.has(git.subcommand) && git.args.some(namesUnknownBranch)) return true;
    if (tokens.some((token) => branchNamesIn(token).some((name) => protectedBranches.has(name)))) return true;
  }
  return false;
}
