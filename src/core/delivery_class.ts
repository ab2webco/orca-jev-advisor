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
import { discardsUncommittedWork, splitOnCommandSeparatorsDetailed } from "./git_discard.ts";
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
  /**
   * Whether a pull request named by URL (`gh pr merge https://.../pull/7`)
   * belongs to the repository the authorization is keyed by. A URL can name
   * any repository, so absent, such a line never qualifies.
   */
  readonly prUrlInRepository?: (url: string) => boolean;
  /**
   * Whether `name` is a local branch where the line runs (the leading `cd`
   * argument as written, or null). `git checkout <name>` restores a PATH of
   * that name when no such branch exists, discarding its changes, so absent,
   * a checkout of an existing name never qualifies.
   */
  readonly isLocalBranch?: (name: string, cdDir: string | null) => boolean;
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
    // The PR is never named by heredoc text (`-m` is a switch here, not a message).
    if (arg.includes(LITERAL_TEXT)) return false;
    positionals += 1;
  }
  return positionals <= 1;
}

const PR_UPDATE_VERBS: ReadonlySet<string> = new Set(["edit", "comment", "review", "ready"]);

/** A pull request named by URL, which may live in any repository. */
function isUrl(arg: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg);
}

/**
 * T1b: read-only `gh` that may sit next to a delivery. Never `--repo`/`-R`
 * (checked by the caller), never `--web` (opens a browser), and never `gh
 * api`, `gh run rerun|cancel` or anything else not listed.
 */
const GH_READ_ONLY: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(["view", "checks", "list", "status", "diff"]),
  run: new Set(["view", "list", "watch"]),
  release: new Set(["view", "list"]),
  repo: new Set(["view"]),
};

function isReadOnlyGh(tokens: readonly string[]): boolean {
  if (tokens.some((token) => token === "--web" || token === "-w")) return false;
  return GH_READ_ONLY[tokens[1] ?? ""]?.has(tokens[2] ?? "") === true;
}

/** The class of one `gh` segment's words, or null. */
function ghClass(tokens: readonly string[], options: DeliveryClassOptions): DeliveryClass | null {
  if (tokens[0] !== "gh") return null;
  const args = tokens.slice(3);
  if (namesAnotherRepository(args)) return null;
  if (tokens[1] === "pr" && args.some((arg) => isUrl(arg) && options.prUrlInRepository?.(arg) !== true)) return null;
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

// ---------------------------------------------------------------------------
// T1b: local git that destroys nothing. Each reads its own words against an
// allowlist; any other flag, a force of any kind, or a path where a branch
// belongs makes the segment -- and the line -- not qualify.
// ---------------------------------------------------------------------------

/** `git add <paths>` (or `-A`/`-u`), never `-f`: it stages, and staging loses nothing. */
function isGitAdd(args: readonly string[]): boolean {
  const switches = new Set(["-A", "--all", "-u", "--update", "-v", "--verbose"]);
  let pathsOnly = false;
  for (const arg of args) {
    if (pathsOnly) continue;
    if (arg === "--") pathsOnly = true;
    else if (arg.startsWith("-") && !switches.has(arg)) return false;
  }
  return true;
}

/** `git commit` with a message, `-a`, `-q` or `--amend`: local, and publishing an amend would need a force push, which never qualifies. Never `--no-verify`. */
function isGitCommit(args: readonly string[]): boolean {
  const switches = new Set(["-q", "--quiet", "-a", "--all", "--amend", "--no-edit", "-s", "--signoff", "-v", "--verbose"]);
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (switches.has(arg) || arg.startsWith("--message=")) continue;
    if (arg === "--message" || /^-[aqsv]*m$/.test(arg)) {
      at += 1;
      continue;
    }
    if (/^-[aqsv]+$/.test(arg)) continue;
    return false;
  }
  return true;
}

/** `git checkout [-q] -b <new> [<start>]`, or `git checkout [-q] <branch>` when the caller confirms a local branch of that name. Never `-f`, `-B`, `--`, `.` or a path. */
function isGitCheckout(args: readonly string[], cdDir: string | null, options: DeliveryClassOptions): boolean {
  const rest = args.filter((arg) => arg !== "-q" && arg !== "--quiet");
  if (rest[0] === "-b") {
    if (rest.length < 2 || rest.length > 3) return false;
    return rest.slice(1).every((ref) => isPlainBranchRefspec(ref));
  }
  if (rest.length !== 1) return false;
  const name = rest[0] ?? "";
  return isPlainBranchRefspec(name) && options.isLocalBranch?.(name, cdDir) === true;
}

/** `git switch [-q] [-c <new> [<start>]] <branch>`: switch never touches a path, and without `-f`/`-C`/`--discard-changes` it refuses to lose work. */
function isGitSwitch(args: readonly string[]): boolean {
  const rest = args.filter((arg) => arg !== "-q" && arg !== "--quiet");
  const names = rest[0] === "-c" || rest[0] === "--create" ? rest.slice(1) : rest;
  if (names.length < 1 || names.length > (names === rest ? 1 : 2)) return false;
  return names.every((ref) => isPlainBranchRefspec(ref));
}

/** `git pull --ff-only`: a fast-forward never rewrites or loses a commit. */
function isGitPullFastForward(args: readonly string[]): boolean {
  if (!args.includes("--ff-only")) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  return args.every((arg) => !arg.startsWith("-") || arg === "--ff-only" || arg === "-q" || arg === "--quiet") && positionals.length <= 2 && positionals.every((ref) => isBareRemoteName(ref) || isPlainBranchRefspec(ref));
}

/** `git stash`, `git stash push|save`: it sets work aside, recoverably. Never `drop`, `clear` or `pop`. */
function isGitStashPush(args: readonly string[]): boolean {
  const verb = args[0];
  if (verb !== undefined && verb !== "push" && verb !== "save" && !verb.startsWith("-")) return false;
  const rest = verb === "push" || verb === "save" ? args.slice(1) : args;
  const switches = new Set(["-q", "--quiet", "-u", "--include-untracked", "-k", "--keep-index"]);
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at] ?? "";
    if (arg === "--") return true;
    if (switches.has(arg) || arg.startsWith("--message=")) continue;
    if (arg === "-m" || arg === "--message") {
      at += 1;
      continue;
    }
    if (arg.startsWith("-") || verb !== "save") return false;
  }
  return true;
}

/** `git tag <name> [<commit>]` or `git tag -a <name> -m <msg> [<commit>]`. Never `-d` or `-f`. */
function isGitTag(args: readonly string[]): boolean {
  const positionals: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg === "-a" || arg === "--annotate" || arg.startsWith("--message=")) continue;
    if (arg === "-m" || arg === "--message") {
      at += 1;
      continue;
    }
    if (arg.startsWith("-")) return false;
    positionals.push(arg);
  }
  return positionals.length >= 1 && positionals.length <= 2 && positionals.every((ref) => isPlainBranchRefspec(ref));
}

function isHarmlessLocalGit(tokens: readonly string[], cdDir: string | null, options: DeliveryClassOptions): boolean {
  if (tokens[0] !== "git") return false;
  const args = tokens.slice(2);
  switch (tokens[1]) {
    case "fetch":
      return isPlainFetch(tokens);
    case "add":
      return isGitAdd(args);
    case "commit":
      return isGitCommit(args);
    case "checkout":
      return isGitCheckout(args, cdDir, options);
    case "switch":
      return isGitSwitch(args);
    case "pull":
      return isGitPullFastForward(args);
    case "stash":
      return isGitStashPush(args);
    case "tag":
      return isGitTag(args);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// T1b: a quoted-delimiter heredoc as an argument value. `"$(cat <<'EOF' ...
// EOF\n)"` is the way agents pass a PR body or a commit message: with the
// delimiter quoted, the body is literal text, nothing in it expands or runs.
// It is replaced by one marker word before anything else reads the line, so
// a `;`, `|` or `rm` inside the body is never mistaken for a command. Any other
// substitution keeps the line null.
// ---------------------------------------------------------------------------

/** Fails every name check (isPlainBranchRefspec, isBareRemoteName) and carries no shell syntax, so it can only ever be read as text. */
const LITERAL_TEXT = "@{heredoc-text}";
const QUOTED_HEREDOC_ARGUMENT = /\$\(cat <<(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n[\s\S]*?\n\2\n[ \t]*\)/g;

/** The flags whose value is free text, the only place the marker may stand. */
const TEXT_FLAGS: ReadonlySet<string> = new Set(["--body", "-b", "--title", "-t", "--subject", "--notes", "-n", "--message", "-m"]);

function isTextFlag(flag: string): boolean {
  return TEXT_FLAGS.has(flag) || /^-[aqsv]*m$/.test(flag);
}

/** Every marker in `tokens` is the value of a text flag (`--body X`, `--body=X`). */
function literalTextOnlyAsFlagValue(tokens: readonly string[]): boolean {
  return tokens.every((token, at) => {
    if (!token.includes(LITERAL_TEXT)) return true;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1 && token.slice(eq + 1) === LITERAL_TEXT) return isTextFlag(token.slice(0, eq));
    return token === LITERAL_TEXT && isTextFlag(tokens[at - 1] ?? "");
  });
}

/**
 * A joiner with its line breaks read the way the shell reads them: a newline
 * alone ends a command like `;`, and one after `&&`, `;` or `|` only
 * continues it. Anything else (`||`, `&`) is returned as written and rejected.
 */
function joinerAsWritten(joiner: string | null): string | null {
  if (joiner === null || !joiner.includes("\n")) return joiner;
  const withoutBreaks = joiner.replace(/\n/g, "");
  return withoutBreaks.length === 0 ? ";" : withoutBreaks;
}

/**
 * The distinct delivery classes of `command`, or null when the line is not a
 * delivery line: some segment is neither obviously safe, a plain fetch nor a
 * delivery class, or no segment is a delivery class at all.
 */
export function deliveryClassesOf(command: string, options: DeliveryClassOptions = {}): readonly DeliveryClass[] | null {
  if (command.includes(LITERAL_TEXT)) return null;
  const line = command.replace(QUOTED_HEREDOC_ARGUMENT, LITERAL_TEXT);
  if (hasCommandSubstitution(line)) return null;
  const { segments, joiners, trailing } = splitOnCommandSeparatorsDetailed(line);
  if (segments.length === 0 || trailing !== null) return null;

  const joinerOf = (i: number): string | null => joinerAsWritten(joiners[i] ?? null);
  let first = 0;
  let cdDir: string | null = null;
  if (tokensWithoutQualifyingRedirections(segments[0] ?? "")?.[0] === "cd") {
    cdDir = parseCdSegment(segments[0] ?? "");
    if (cdDir === null || segments.length < 2 || joinerOf(1) !== "&&") return null;
    first = 1;
  }

  const found = new Set<DeliveryClass>();
  for (let i = first; i < segments.length; i += 1) {
    const joiner = i === first ? null : joinerOf(i);
    if (joiner !== null && joiner !== "&&" && joiner !== ";" && joiner !== "|") return null;
    const segment = segments[i] ?? "";
    const tokens = tokensWithoutQualifyingRedirections(segment);
    if (tokens === null || tokens.length === 0 || tokens[0] === "cd") return null;
    if (!literalTextOnlyAsFlagValue(tokens)) return null;
    if (joiner === "|") {
      if (!isObviouslySafeCommand(segment)) return null;
      continue;
    }
    if (tokens[0] === "git" && tokens[1] === "push") {
      if (!isBranchPush(tokens, cdDir, options)) return null;
      found.add("push-branch");
      continue;
    }
    if (tokens[0] === "gh") {
      if (namesAnotherRepository(tokens.slice(2))) return null;
      const gh = ghClass(tokens, options);
      if (gh !== null) found.add(gh);
      else if (!isReadOnlyGh(tokens)) return null;
      continue;
    }
    if (!discardsUncommittedWork(segment) && isHarmlessLocalGit(tokens, cdDir, options)) continue;
    if (isObviouslySafeCommand(segment)) continue;
    return null;
  }
  if (found.size === 0) return null;
  return DELIVERY_CLASSES.filter((cls) => found.has(cls));
}
