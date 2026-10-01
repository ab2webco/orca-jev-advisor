// Part 4 (0.5.2): policy coverage must know WHERE a command's file targets
// actually sit, not only the session's own cwd. The real miss this closes:
// two `rm` of a temp file were hard-denied by `never_write_to_main` because
// the session's cwd happened to be a main-branch checkout -- the deleted
// file was in a DIFFERENT repository entirely, on a feature branch. Jev saw
// only "on main, deleting something" and judged the policy covered.
//
// Two pure pieces, resolved with real filesystem reads at the edge
// (adapters/claude/gate-bash.ts, via linked_worktree.ts's own
// resolveRepoRootForCwd/resolveBranchForCwd and command_targets.ts's own
// resolveCommandTargetDirs):
//   - buildCrossRepoSentence: the plain-English, model-facing context
//     sentence naming a target's own repository/branch when it differs from
//     the session's -- fed into the SAME state both the policy and risk
//     questions already read (see gate-bash.ts's own repoContext/
//     deployPublishSignal precedent).
//   - pickStricterDestination: which destination's policies and
//     consequence-ceiling override actually govern, when the session's cwd
//     and its target(s) resolve to DIFFERENT cataloged destinations --
//     "stricter" reads as the lower consequence-ceiling override (less
//     autonomy granted), never averaged or voted; no destination match at
//     all is the least strict, chosen only when nothing else matched.
//
// Pure: no I/O, no locale -- both stay English/generic like repoContext().
import type { MatchableDestination } from "./destination_match.ts";
import type { MatchedDestinationForCwd } from "./linked_worktree.ts";
import type { GhMerge, PushTarget } from "./deny_rule_shapes.ts";
import { CLEAR_BRANCH_NAMES, IDENTITY_NAMES } from "./jev_pseudonyms.ts";
import type { JevNames } from "./jev_pseudonyms.ts";

export interface RepoLocation {
  /** Null when the path is outside any git repository this codebase can positively resolve (a scratch directory, `/tmp`, `$TMPDIR`, ...). */
  readonly repoRoot: string | null;
  /** Null for a detached HEAD, or when `repoRoot` itself is null -- never guessed at. */
  readonly branch: string | null;
}

export interface TargetLocation extends RepoLocation {
  /** The resolved absolute path this location was resolved for -- carried only for the caller's own bookkeeping; never itself part of the sentence (see the module note on why "outside any repository" targets are grouped, not named individually). */
  readonly path: string;
}

function sameRepo(a: RepoLocation, b: RepoLocation): boolean {
  return a.repoRoot === b.repoRoot;
}

function branchOf(location: RepoLocation, names: JevNames): string {
  return location.branch === null ? "an unknown branch" : names.name("branch", location.branch);
}

function targetOpening(location: RepoLocation, names: JevNames): string {
  if (location.repoRoot === null) return "The command acts on files outside any repository";
  return `The command acts on files in the repository at ${names.name("path", location.repoRoot)} on branch ${branchOf(location, names)}`;
}

function sessionClause(location: RepoLocation, names: JevNames): string {
  if (location.repoRoot === null) return "outside any repository";
  return `${names.name("path", location.repoRoot)} on ${branchOf(location, names)}`;
}

/** What gate-bash.ts reads from git about the session's own checkout. */
export interface RepoFacts {
  /** The origin remote's repository name, `.git` stripped; empty when there is no origin. */
  readonly remote: string;
  /** The checked-out branch; empty when git could not say. */
  readonly branch: string;
  readonly dirty: boolean;
}

/**
 * What makes a feature branch different from a client's main, as one
 * English sentence. Rendered twice by the gate (0.6.11 T3): in clear with
 * IDENTITY_NAMES for the verdict-cache key -- byte-for-byte the text it has
 * always been -- and with a fresh Jev pseudonym table for the copy Jev reads.
 */
export function renderRepoContext(facts: RepoFacts, names: JevNames): string {
  const { remote, branch, dirty } = facts;
  return [
    remote.length > 0 ? `repository ${names.name("repo", remote)}` : "no remote",
    branch.length > 0 ? `branch ${names.name("branch", branch)}` : "unknown branch",
    branch === "main" || branch === "master" ? "this is the shared main branch" : "this is a working branch",
    dirty ? "with uncommitted changes" : "clean",
  ].join(", ");
}

/**
 * One plain-English sentence per DISTINCT target location that differs from
 * the session's own -- English regardless of locale, same discipline as
 * gate-bash.ts's own repoContext(). Null when every resolved target agrees
 * with the session's own repository (including "no targets were resolved at
 * all", the ordinary case for almost every command -- see
 * command_targets.ts's own resolveCommandTargetDirs). Every target outside
 * any repository is grouped into ONE sentence: there is no shared root to
 * tell two such targets apart by, so naming each one's own path would claim
 * a precision this module does not have.
 */
export function buildCrossRepoSentence(session: RepoLocation, targets: readonly TargetLocation[], names: JevNames = IDENTITY_NAMES): string | null {
  const differing = targets.filter((target) => !sameRepo(target, session));
  if (differing.length === 0) return null;

  const seenRepoRoots = new Set<string>();
  const sentences: string[] = [];
  let sawOutside = false;
  for (const target of differing) {
    if (target.repoRoot === null) {
      if (sawOutside) continue;
      sawOutside = true;
    } else {
      if (seenRepoRoots.has(target.repoRoot)) continue;
      seenRepoRoots.add(target.repoRoot);
    }
    sentences.push(`${targetOpening(target, names)}, not in the session's current repository (${sessionClause(session, names)}).`);
  }
  return sentences.join(" ");
}

/**
 * Which destination's policies and consequence-ceiling override govern, when
 * the session's cwd and its command's own target(s) can resolve to DIFFERENT
 * cataloged destinations: the one with the lower `consequenceCeiling`
 * override wins (less autonomy granted is the stricter reading), a
 * destination with no override at all loses to one that has any, and a
 * `null` (no destination matched there) is the least strict of all --
 * chosen only when every candidate is null. Ties keep the first candidate
 * encountered. Never throws; an empty `candidates` array resolves to null.
 */
export function pickStricterDestination<D extends MatchableDestination & { readonly autonomy?: { readonly consequenceCeiling?: number } }>(
  candidates: ReadonlyArray<MatchedDestinationForCwd<D> | null>,
): MatchedDestinationForCwd<D> | null {
  let best: MatchedDestinationForCwd<D> | null = null;
  let bestCeiling = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const ceiling = candidate.destination.autonomy?.consequenceCeiling ?? Number.POSITIVE_INFINITY;
    if (best === null || ceiling < bestCeiling) {
      best = candidate;
      bestCeiling = ceiling;
    }
  }
  return best;
}

/** Remote names every repository uses; any other can name a client, so it goes through `names`. */
const CLEAR_REMOTE_NAMES: readonly string[] = ["origin", "upstream"];

/**
 * 0.6.15 T3 (N-06): the branch and remote each push updates, as
 * deny_rule_shapes.ts pushTargets read them, in the context both the policy
 * and the risk questions read. Without it Jev judged `git push origin main`
 * from a feature checkout by the checkout's branch and the command text, and
 * a local bare remote's push to main scored at its gate. Null when the
 * command pushes nothing.
 */
export function buildPushDestinationSentence(targets: readonly PushTarget[], names: JevNames = IDENTITY_NAMES): string | null {
  const sentences = targets.map((target) => {
    const remote = target.remote === null ? "its default remote" : `remote ${CLEAR_REMOTE_NAMES.includes(target.remote) ? target.remote : names.name("repo", target.remote)}`;
    const where = target.remoteIsLocal ? "a repository on this machine" : "a repository on another machine";
    const shared = CLEAR_BRANCH_NAMES.includes(target.branch) ? `; ${target.branch} is a shared branch there, whatever branch the checkout is on` : "";
    return `The command pushes commits to branch ${names.name("branch", target.branch)} of ${remote}, ${where}${shared}.`;
  });
  return sentences.length === 0 ? null : [...new Set(sentences)].join(" ");
}

/**
 * 0.6.17 T1 (JEVADV-93): what each `gh` merge goes through, as
 * deny_rule_shapes.ts ghMerges read it, in the context both questions read.
 * A pull request merge from a checkout on main was refused under
 * never_write_to_main as if it wrote on the checkout's branch; the same
 * merge from a feature checkout was not. An API branch merge and an
 * `--admin` merge skip the review, so they say so instead. Null when the
 * command merges nothing on the server.
 */
export function buildGhMergeSentence(merges: readonly GhMerge[], names: JevNames = IDENTITY_NAMES): string | null {
  const local = "It changes nothing in the local checkout, so the branch the checkout is on plays no part.";
  const sentences = merges.map((merge) => {
    if (merge.kind === "pull-request") {
      return merge.admin
        ? `The command asks the hosting service to merge a pull request with --admin, which merges it even when the base branch's required reviews or checks have not passed: it bypasses the review that makes a pull request merge the reviewed path, so it writes the pull request's commits on its base branch as directly as a push to it would. ${local}`
        : "The command asks the hosting service to merge a pull request: the service lands the pull request's commits on its base branch only through that branch's own protection (its required reviews and checks). " +
            `That is the reviewed path into a shared branch, not a direct write on it, and it changes nothing in the local checkout, so the branch the checkout is on plays no part.`;
    }
    if (merge.base === null) return "The command asks the hosting service's API to merge one branch directly into another on the remote, with no pull request and no review.";
    const head = merge.head === null ? "a branch" : `branch ${names.name("branch", merge.head)}`;
    const base = names.name("branch", merge.base);
    return `The command asks the hosting service's API to merge ${head} directly into branch ${base} on the remote, with no pull request and no review; that writes commits on ${base}, whatever branch the checkout is on.`;
  });
  return sentences.length === 0 ? null : [...new Set(sentences)].join(" ");
}
