// 0.6.24 T2 (JEVADV-103): what a command writes, for the commands whose
// target branch Jev keeps misreading. `gh pr update-branch 821` was refused
// as a write to main by a "never write on main" policy, five runs out of
// five (odd/tasks/release-0.6.24.md): it names a pull request and a base,
// and nothing told Jev which side gets written. It brings the base into the
// pull request's own head branch; the base is only read.
//
// 0.6.25 (JEVADV-104): the same for syncing the CURRENT branch with its OWN
// remote branch (`git pull`, `git merge origin/main`, `git rebase @{u}`).
// On a checkout that sits on main a "never write on main" policy refused
// them every time, though they only bring in commits that already exist
// remotely. Pulling or merging ANOTHER branch is real new work and is not
// described here: Jev keeps judging it. The current branch and the remote
// names are read by the caller (a bounded git call); with them unknown, only
// the forms that cannot name another branch (`git pull`, `@{u}`) count.
//
// A plain English fact for the same Jev state the policy and risk questions
// read, the way deploy_publish.ts feeds `deployPublishSignal`. Detected in
// COMMAND POSITION with the same mention-vs-command reading
// (git_discard.ts's someSegmentMatches): a grep pattern or a commit message
// that names the command is data. No network: the pull request itself is
// never looked up. Pure: no I/O.
import { withoutHeredocBodies, withoutLineContinuations } from "./command_text.ts";
import { gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { someSegmentMatches } from "./git_discard.ts";

const BRANCH_EFFECTS: readonly { readonly pattern: { test(segment: string): boolean }; readonly effect: string }[] = [
  {
    pattern: /\bgh\s+pr\s+update-branch\b/,
    effect:
      "brings the pull request's base branch into the pull request's own branch (a merge, or a rebase with --rebase); it writes only to the pull request's own branch and never writes to the base branch, such as main",
  },
];

const SYNC_EFFECT =
  "brings into the current branch only the commits that already exist on its own remote branch (a fast-forward, or a merge or rebase of the two when they diverged); it adds no change of its own and sends nothing to the remote";

type SyncSubcommand = "pull" | "merge" | "rebase";

interface SyncSegment {
  readonly subcommand: SyncSubcommand;
  readonly args: readonly string[];
  readonly dir: string | null;
  /** Run by this shell itself: not inside `$(...)`, a script argument or xargs. */
  readonly direct: boolean;
}

const SYNC_COMMAND = /\bgit\b.*\b(?:pull|merge|rebase)\b/;
const SYNC_FLAGS: Readonly<Record<SyncSubcommand, ReadonlySet<string>>> = {
  pull: new Set(["--ff-only", "--ff", "--no-ff", "--rebase", "--no-rebase", "-r", "--rebase=true", "--rebase=false", "--rebase=merges", "--no-edit", "--autostash", "--no-autostash", "--quiet", "-q", "--verbose", "-v"]),
  merge: new Set(["--ff-only", "--ff", "--no-ff", "--no-edit", "--autostash", "--no-autostash", "--quiet", "-q", "--verbose", "-v"]),
  rebase: new Set(["--autostash", "--no-autostash", "--quiet", "-q", "--verbose", "-v"]),
};
/** Git subcommands that write nothing the fact would be wrong about when they share the command. */
const HARMLESS_GIT = new Set(["fetch", "status", "log", "diff", "show", "rev-parse", "rev-list", "remote", "branch", "ls-files", "describe", "merge-base"]);
const UPSTREAM_REFS = new Set(["@{u}", "@{upstream}"]);
const DEFAULT_REMOTES: readonly string[] = ["origin"];

function isSyncSubcommand(subcommand: string | null): subcommand is SyncSubcommand {
  return subcommand === "pull" || subcommand === "merge" || subcommand === "rebase";
}

/** Every git segment of `command`, as a sync candidate or null when one is not a harmless read; null when the command runs no git pull, merge or rebase. */
function syncSegments(command: string, cwd: string, home: string): { readonly sync: readonly SyncSegment[]; readonly others: boolean } | null {
  const inspected = withoutLineContinuations(withoutHeredocBodies(command));
  if (someSegmentMatches(inspected, SYNC_COMMAND) !== "deny") return null;
  const sync: SyncSegment[] = [];
  let others = false;
  for (const located of locateCommandSegments(inspected, cwd, home)) {
    const direct = !located.substituted && !located.viaScript && !located.outer.split(/\s+/).some((word) => (word.split("/").pop() ?? word) === "xargs");
    const invocation = gitInvocation(located.outer, located.dir, home);
    if (invocation === null) continue;
    if (isSyncSubcommand(invocation.subcommand)) sync.push({ subcommand: invocation.subcommand, args: invocation.args, dir: invocation.dir, direct });
    else if (!direct || invocation.subcommand === null || !HARMLESS_GIT.has(invocation.subcommand)) others = true;
  }
  return sync.length === 0 ? null : { sync, others };
}

/** The directories a pull, merge or rebase in `command` acts in (null when unknown); empty when it runs none. */
export function syncActingDirectories(command: string, cwd: string, home: string): readonly (string | null)[] {
  return syncSegments(command, cwd, home)?.sync.map((segment) => segment.dir) ?? [];
}

function syncsOwnBranch(segment: SyncSegment, currentBranch: string | null, remotes: readonly string[]): boolean {
  if (!segment.direct) return false;
  const positionals: string[] = [];
  for (const arg of segment.args) {
    if (arg.startsWith("-")) {
      if (!SYNC_FLAGS[segment.subcommand].has(arg)) return false;
    } else positionals.push(arg);
  }
  const first = positionals[0] ?? "";
  if (segment.subcommand === "pull") {
    if (positionals.length === 0) return true;
    if (!remotes.includes(first)) return false;
    return positionals.length === 1 || (positionals.length === 2 && currentBranch !== null && positionals[1] === currentBranch);
  }
  if (positionals.length !== 1) return false;
  if (UPSTREAM_REFS.has(first)) return true;
  const slash = first.indexOf("/");
  return slash > 0 && currentBranch !== null && remotes.includes(first.slice(0, slash)) && first.slice(slash + 1) === currentBranch;
}

/**
 * The effect fact for `command`, or null when none of the known commands runs in it.
 * `currentBranch` is the branch checked out where a pull, merge or rebase acts,
 * and `remotes` that repository's remote names (origin alone when unknown).
 */
export function detectBranchEffect(command: string, currentBranch: string | null, remotes: readonly string[] | null = null): string | null {
  const inspected = withoutLineContinuations(withoutHeredocBodies(command));
  for (const { pattern, effect } of BRANCH_EFFECTS) {
    if (someSegmentMatches(inspected, pattern) === "deny") return effect;
  }
  const found = syncSegments(command, "/", "/");
  if (found === null || found.others) return null;
  const names = remotes ?? DEFAULT_REMOTES;
  return found.sync.every((segment) => syncsOwnBranch(segment, currentBranch, names)) ? SYNC_EFFECT : null;
}
