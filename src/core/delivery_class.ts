// Which delivery classes a Bash line belongs to (0.6.28, remembered gate
// authorizations): pushing a feature branch, opening, updating or merging a
// pull request, and creating a release. These are non-destructive and
// recoverable, and they are what the gate's advice blocked most on real
// transcripts -- an agent re-running them unchanged 73% of the time.
//
// The line rule: every segment is either obviously safe (the gate's own
// tier-1a test), a plain `git fetch`, or one of the classes below; at least
// one class is present; anything else -- `rm`, `ssh`, a heredoc write, a
// force push, a protected branch, `--admin`, another repository -- makes the
// whole line null. Splitting and plumbing follow qualifiesForLocalGitAllow
// (push_own_branch.ts): one optional leading `cd <dir> &&`, segments joined by
// `&&` or `;`, a `|` only into an obviously safe reader, the `2>&1` and
// `/dev/null` redirections, and no command substitution anywhere.
//
// Pure: a push that names no destination of its own is resolved by the
// caller-supplied `implicitPushDestination`, and is null without it.

import { hasCommandSubstitution } from "./command_shape.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";
import { splitOnCommandSeparatorsDetailed } from "./git_discard.ts";
import { isPlainBranchRefspec, parseCdSegment, parsePushSegment, tokensWithoutQualifyingRedirections } from "./push_own_branch.ts";
import { PROTECTED_BRANCH_NAMES, isBareRemoteName } from "./push_remote.ts";
import type { ImplicitPushDestination } from "./push_remote.ts";

export type DeliveryClass = "push-branch" | "pr-create" | "pr-merge" | "pr-update" | "release-create";

/** Every class, in the order deliveryClassesOf reports them. */
export const DELIVERY_CLASSES: readonly DeliveryClass[] = ["push-branch", "pr-create", "pr-merge", "pr-update", "release-create"];

export interface DeliveryClassOptions {
  /**
   * Where a push that names no branch (`git push origin`, `git push origin
   * HEAD`) goes, read in the directory it runs in: the leading `cd` argument
   * as written (null without one; the caller resolves it against its cwd).
   * Absent, such a push never qualifies.
   */
  readonly implicitPushDestination?: (cdDir: string | null, head: boolean) => ImplicitPushDestination;
}

/** The only remote a delivery push may name: the authorization is keyed by origin's URL, so another remote would carry it to another repository. */
const DELIVERY_REMOTE = "origin";

function isProtected(branch: string): boolean {
  return PROTECTED_BRANCH_NAMES.includes(branch);
}

/** A push to a non-protected branch of origin, with no force, delete or `+refspec` of any kind (parsePushSegment admits only -u/-q/-v). */
function isBranchPush(tokens: readonly string[], cdDir: string | null, options: DeliveryClassOptions): boolean {
  const positionals = parsePushSegment(tokens.join(" "));
  if (positionals === null) return false;
  if (positionals[0] !== DELIVERY_REMOTE) return false;
  const refspec = positionals[1];
  if (refspec === undefined || refspec === "HEAD") {
    const destination = options.implicitPushDestination?.(cdDir, refspec === "HEAD") ?? { kind: "unknown" };
    return destination.kind === "branch" && !isProtected(destination.name);
  }
  const colon = refspec.indexOf(":");
  if (colon === -1) return isPlainBranchRefspec(refspec) && !isProtected(refspec);
  const source = refspec.slice(0, colon);
  const target = refspec.slice(colon + 1);
  if (source !== "HEAD" && !isPlainBranchRefspec(source)) return false;
  return isPlainBranchRefspec(target) && !isProtected(target);
}

/** `--repo`/`-R` points gh at another repository than the one the authorization belongs to. */
function namesAnotherRepository(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--repo" || arg === "-R" || arg.startsWith("--repo=") || /^-R./.test(arg));
}

const MERGE_SWITCHES: ReadonlySet<string> = new Set(["--squash", "-s", "--merge", "-m", "--rebase", "-r", "--delete-branch", "-d", "--auto"]);
const MERGE_VALUE_FLAGS: ReadonlySet<string> = new Set(["--author-email", "-A", "--subject", "-t", "--body", "-b", "--match-head-commit"]);

/** `gh pr merge [<number>|<url>|<branch>]` with only the allowlisted flags; `--admin` (bypasses the branch's own protection) and anything unknown never qualify. */
function isPrMerge(args: readonly string[]): boolean {
  let positionals = 0;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg.startsWith("-")) {
      const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (MERGE_SWITCHES.has(arg)) continue;
      if (!MERGE_VALUE_FLAGS.has(name)) return false;
      if (name === arg) at += 1;
      continue;
    }
    positionals += 1;
  }
  return positionals <= 1;
}

const PR_UPDATE_VERBS: ReadonlySet<string> = new Set(["edit", "comment", "review", "ready"]);

/** The class of one `gh` segment's words, or null. */
function ghClass(tokens: readonly string[]): DeliveryClass | null {
  if (tokens[0] !== "gh") return null;
  const args = tokens.slice(3);
  if (namesAnotherRepository(args)) return null;
  if (tokens[1] === "release") return tokens[2] === "create" ? "release-create" : null;
  if (tokens[1] !== "pr") return null;
  const verb = tokens[2] ?? "";
  if (verb === "create") return "pr-create";
  if (verb === "merge") return isPrMerge(args) ? "pr-merge" : null;
  return PR_UPDATE_VERBS.has(verb) ? "pr-update" : null;
}

const FETCH_SWITCHES: ReadonlySet<string> = new Set(["-q", "--quiet", "-p", "--prune", "--tags", "--no-tags", "--all"]);

/** `git fetch` with plain names only: it updates remote-tracking refs, never a branch of yours. */
function isPlainFetch(tokens: readonly string[]): boolean {
  if (tokens[0] !== "git" || tokens[1] !== "fetch") return false;
  return tokens.slice(2).every((token) => FETCH_SWITCHES.has(token) || (!token.startsWith("-") && (isBareRemoteName(token) || isPlainBranchRefspec(token))));
}

/**
 * The distinct delivery classes of `command`, or null when the line is not a
 * delivery line: some segment is neither obviously safe, a plain fetch nor a
 * delivery class, or no segment is a delivery class at all.
 */
export function deliveryClassesOf(command: string, options: DeliveryClassOptions = {}): readonly DeliveryClass[] | null {
  if (hasCommandSubstitution(command)) return null;
  const { segments, joiners, trailing } = splitOnCommandSeparatorsDetailed(command);
  if (segments.length === 0 || trailing !== null) return null;

  let first = 0;
  let cdDir: string | null = null;
  if (tokensWithoutQualifyingRedirections(segments[0] ?? "")?.[0] === "cd") {
    cdDir = parseCdSegment(segments[0] ?? "");
    if (cdDir === null || segments.length < 2 || joiners[1] !== "&&") return null;
    first = 1;
  }

  const found = new Set<DeliveryClass>();
  for (let i = first; i < segments.length; i += 1) {
    const joiner = i === first ? null : joiners[i];
    if (joiner !== null && joiner !== "&&" && joiner !== ";" && joiner !== "|") return null;
    const segment = segments[i] ?? "";
    const tokens = tokensWithoutQualifyingRedirections(segment);
    if (tokens === null || tokens.length === 0 || tokens[0] === "cd") return null;
    if (joiner === "|") {
      if (!isObviouslySafeCommand(segment)) return null;
      continue;
    }
    if (tokens[0] === "git" && tokens[1] === "push") {
      if (!isBranchPush(tokens, cdDir, options)) return null;
      found.add("push-branch");
      continue;
    }
    const gh = ghClass(tokens);
    if (gh !== null) {
      found.add(gh);
      continue;
    }
    if (isPlainFetch(tokens) || isObviouslySafeCommand(segment)) continue;
    return null;
  }
  if (found.size === 0) return null;
  return DELIVERY_CLASSES.filter((cls) => found.has(cls));
}
