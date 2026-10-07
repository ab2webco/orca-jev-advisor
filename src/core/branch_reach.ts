// 0.6.28 T1: whether a command can reach a protected branch, for the
// `protected-branch` policy scope (decisions.ts's filterPoliciesForBranchReach).
//
// The owner, 2026-10-07: `git add` on a working branch was refused under
// never_write_to_main, because Jev was asked about that policy for every
// command. Two facts decide instead, both read from the text:
//   - the places the command writes in (acting_location.ts's own reading:
//     `cd`, `git -C`, a write's own target), whose branch the hook resolves;
//   - whether the text names a protected branch as a whole word, a refspec
//     side or a remote branch (`main`, `HEAD:main`, `origin/main`).
// Both fail toward keeping the policy: an unknown place is null, a gh command
// that writes counts as naming one (its base branch is not in the text).
import { actingPlaces } from "./acting_location.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";

/**
 * Every place `command`, run from `cwd`, writes in, once each: a directory
 * or a file path, or null where it cannot be known without running it. An
 * obviously safe segment writes nowhere and adds nothing.
 */
export function branchReachPlaces(command: string, cwd: string, home: string): readonly (string | null)[] {
  const places: (string | null)[] = [];
  for (const { path } of actingPlaces(command, cwd, home)) {
    if (!places.includes(path)) places.push(path);
  }
  return places;
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
 * (a merge, an API call): those reach a branch the text does not name.
 * A file path or a message that merely contains the word does not count
 * (`src/main.ts`, `-m "fix main menu"`); a path whose last part is exactly
 * a protected name does, which only costs one question.
 */
export function namesProtectedBranch(command: string, protectedBranches: ReadonlySet<string>): boolean {
  for (const segment of splitOnCommandSeparators(command)) {
    if (isObviouslySafeCommand(segment)) continue;
    const tokens = tokenize(segment);
    if (runsGh(tokens)) return true;
    if (tokens.some((token) => branchNamesIn(token).some((name) => protectedBranches.has(name)))) return true;
  }
  return false;
}
