// 0.6.8 T2: whether a command stays inside the team, decided from facts.
//
// A `requires_human` policy protects work that reaches a client ("anything
// that touches a client's product gets confirmed with a human"). Jev judged
// it from the policy sentence alone, and also asked about work that never
// leaves the team: pushing a work branch, opening a pull request in the
// team's own repository, replying to a review. Rewording the policy was
// tried live and did not help -- the sentence cannot tell Jev whose
// repository `origin` is. This module can, because the adapter hands it the
// facts: the team owners (team_owners.ts), the cwd repository's remotes and
// its current branch.
//
// Each segment of the command is `internal` or `unknown`, and `internal`
// ONLY for:
//   - a segment tier 1a already calls safe (gate_safe_command.ts's
//     isSafeSegment);
//   - local git that never touches a remote and never discards work (see
//     isLocalGitSegment for the exact list);
//   - `git push` of a non-shared branch to a team-owned remote, never a
//     force push, never a delete, never a `src:dst` refspec;
//   - `gh pr create|view|checks|diff|comment|edit|list|status` on a
//     team-owned repository -- never `merge`, and never `close` or
//     `review` either (a closed or approved pull request is a decision
//     about the work, not a step in doing it);
//   - `gh api graphql` whose only mutations reply to or resolve review
//     threads.
// Everything else is `unknown`, and a command is inside the team only when
// EVERY segment is `internal`. `unknown` changes nothing: gate-bash.ts (T3)
// keeps asking the policy exactly as before.
//
// Conservative on purpose, because a wrong `internal` skips a question a
// person wanted asked:
//   - When git or gh may pick the remote (a bare `git push`, `gh pr ...`
//     without `--repo`, a graphql call addressed by node id), EVERY remote
//     must be team-owned: in a fork workflow `gh` targets `upstream`, and a
//     graphql node id can name a pull request in any repository.
//   - A command substitution makes the whole command `unknown`, with one
//     exception: `$(cat <<'EOF' ... EOF)` with a QUOTED delimiter, the body
//     Claude Code writes for every pull request -- its text is never
//     expanded, so it is data. Anything after its closing delimiter is still
//     read as commands.
//   - The facts are read BEFORE the command runs. After a segment that can
//     change them -- a `cd`/`pushd`, a `git remote` change, `git config`,
//     `gh repo set-default` -- a later push or pull request is `unknown`;
//     after a branch switch, so is a push that resolves the current branch.
//   - A leading `NAME=value` (e.g. `GH_REPO=...`) is not read through.
//   - Shared branches are push_remote.ts's PROTECTED_BRANCH_NAMES plus
//     `develop` and `staging`, compared case-insensitively: a push there is
//     never called internal even on a team repository.
//
// Pure: no fs, no network, no clock. Reuses the gate's own quote-aware
// splitter (git_discard.ts) and tokenizer, and push_own_branch.ts's own push
// grammar, rather than a second reading of either.

import { hasCommandSubstitution } from "./command_shape.ts";
import { isSafeSegment } from "./gate_safe_command.ts";
import { cannotScanWithConfidence, splitOnCommandSeparators, startsWithGitDiscard, tokenize } from "./git_discard.ts";
import { isPlainBranchRefspec, parsePushSegment, tokensWithoutQualifyingRedirections } from "./push_own_branch.ts";
import { PROTECTED_BRANCH_NAMES, isBareRemoteName } from "./push_remote.ts";

export interface ReachRemote {
  readonly name: string;
  /** The remote's `url` (what fetch and `gh` read), or null when it has none. */
  readonly url: string | null;
  /** The remote's `pushurl`, when it has one -- `git push` sends there instead of `url`. */
  readonly pushUrl: string | null;
}

export interface ClientReachFacts {
  /** Already normalized (team_owners.ts's parseTeamOwners): lowercase owner names. Empty means nothing is internal. */
  readonly teamOwners: readonly string[];
  /** Every remote of the cwd repository. */
  readonly remotes: readonly ReachRemote[];
  /** The cwd repository's current branch, or null (detached HEAD, no repository). */
  readonly currentBranch: string | null;
}

export type SegmentReach = "internal" | "unknown";

export interface ClientReachResult {
  readonly segments: readonly { readonly segment: string; readonly reach: SegmentReach }[];
  /** True only when team owners are configured and every segment is `internal`. */
  readonly staysInsideTeam: boolean;
}

/** Shared branches: never the target of an `internal` push, on any repository. */
const SHARED_BRANCHES: ReadonlySet<string> = new Set([...PROTECTED_BRANCH_NAMES, "develop", "staging"]);

const OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The owner of a hosted repository URL, lowercased: `https://host/owner/repo`,
 * `ssh://[user@]host[:port]/owner/repo` and the scp-like `[user@]host:owner/repo`.
 * Null for a local path, a `file://` URL, or a URL naming no owner/repo pair
 * -- a remote this cannot place on a host is never a team remote.
 */
export function remoteOwner(url: string): string | null {
  const text = url.trim();
  let path: string | null = null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?[^/:]+(?::\d+)?\/(.*)$/i.exec(text);
  if (scheme !== null) {
    if ((scheme[1] ?? "").toLowerCase() === "file") return null;
    path = scheme[2] ?? null;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // A URL with no host (`file:///srv/...`) is never an scp-like remote.
    return null;
  } else {
    // scp-like: a `:` before the first `/`, and never a Windows drive (`C:/`).
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/.exec(text);
    if (scp !== null && (scp[1] ?? "").length > 1) path = scp[2] ?? null;
  }
  if (path === null) return null;
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = (parts[0] ?? "").toLowerCase();
  return OWNER_PATTERN.test(owner) ? owner : null;
}

/** `gh --repo`'s value: `OWNER/REPO`, `HOST/OWNER/REPO`, or a URL. */
function repoArgOwner(value: string): string | null {
  if (value.includes("://") || /^[^/]+@/.test(value)) return remoteOwner(value);
  const parts = value.split("/").filter((part) => part.length > 0);
  const owner = (parts.length === 2 ? parts[0] : parts.length === 3 ? parts[1] : undefined)?.toLowerCase();
  return owner !== undefined && OWNER_PATTERN.test(owner) ? owner : null;
}

function isTeamOwner(owner: string | null, facts: ClientReachFacts): boolean {
  return owner !== null && facts.teamOwners.includes(owner);
}

/** Every remote, fetch and push URL alike, is team-owned -- whichever one git or gh picks, it is the team's. */
function everyRemoteIsTeamOwned(facts: ClientReachFacts): boolean {
  if (facts.remotes.length === 0) return false;
  return facts.remotes.every((remote) =>
    remote.url !== null && isTeamOwner(remoteOwner(remote.url), facts) && (remote.pushUrl === null || isTeamOwner(remoteOwner(remote.pushUrl), facts)));
}

// ---------------------------------------------------------------------------
// The one command substitution that is data: `$(cat <<'EOF' ... EOF)`
// ---------------------------------------------------------------------------

const QUOTED_CAT_HEREDOC = /\$\(\s*cat\s+<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n/g;

/**
 * `command` with every `$(cat <<'DELIM' ... DELIM)` replaced by a plain
 * word. Only a QUOTED delimiter qualifies (the shell never expands such a
 * body), the body ends at the first line that is exactly the delimiter (or,
 * for `<<-`, the delimiter after leading tabs -- the shell's own rule), and
 * the `)` must follow it directly. Anything else is left in place, where
 * hasCommandSubstitution then reads it as unknowable.
 */
function withoutInertHeredocSubstitutions(command: string): string {
  let result = "";
  let cursor = 0;
  QUOTED_CAT_HEREDOC.lastIndex = 0;
  for (let match = QUOTED_CAT_HEREDOC.exec(command); match !== null; match = QUOTED_CAT_HEREDOC.exec(command)) {
    if (match.index < cursor) continue;
    const stripTabs = match[1] === "-";
    const delimiter = match[3] ?? "";
    const bodyStart = match.index + match[0].length;
    let lineStart = bodyStart;
    let end: number | null = null;
    while (lineStart <= command.length) {
      const newline = command.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? command.length : newline;
      const line = command.slice(lineStart, lineEnd);
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        const close = /^\s*\)/.exec(command.slice(lineEnd));
        if (close !== null) end = lineEnd + close[0].length;
        break;
      }
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    if (end === null) continue;
    result += `${command.slice(cursor, match.index)}HEREDOC_TEXT`;
    cursor = end;
    QUOTED_CAT_HEREDOC.lastIndex = end;
  }
  return result + command.slice(cursor);
}

// ---------------------------------------------------------------------------
// Local git
// ---------------------------------------------------------------------------

/** Flags each local subcommand may carry and still be `internal`; any other flag makes it `unknown`. */
const CHECKOUT_FLAGS: ReadonlySet<string> = new Set(["-b", "-q", "--quiet", "-t", "--track", "--no-track"]);
const SWITCH_FLAGS: ReadonlySet<string> = new Set(["-c", "--create", "-d", "--detach", "-q", "--quiet", "-t", "--track", "--no-track"]);
const BRANCH_FLAGS: ReadonlySet<string> = new Set(["-a", "-r", "-v", "-vv", "--all", "--list", "--show-current", "-t", "--track", "--no-track", "-q", "--quiet"]);
const STASH_SUBCOMMANDS: ReadonlySet<string> = new Set(["push", "save", "list", "show"]);

function onlyFlagsFrom(tokens: readonly string[], allowed: ReadonlySet<string>): boolean {
  return tokens.every((token) => !token.startsWith("-") || allowed.has(token));
}

/**
 * Local git that never touches a remote and never discards work: `add`,
 * `commit`, `status`/`diff`/`log`/`show`, a branch switch or creation
 * (`switch`, `checkout` of a branch, `branch <name>`), `stash`/`stash push`/
 * `list`/`show`, and `restore --staged` (the index only). A checkout or
 * restore that overwrites the working tree (git_discard.ts's
 * startsWithGitDiscard), a forced switch, a branch delete/rename, `stash
 * pop`/`drop`, and every other subcommand (`fetch`, `pull`, `merge`,
 * `rebase`, `reset`, `tag`, ...) stay `unknown`. `git -C`/`-c` before the
 * subcommand is not read through.
 */
function isLocalGitSegment(tokens: readonly string[], segmentText: string): boolean {
  const sub = tokens[1];
  const rest = tokens.slice(2);
  switch (sub) {
    case "add":
    case "commit":
    case "status":
    case "diff":
    case "log":
    case "show":
      return true;
    case "switch":
      return onlyFlagsFrom(rest, SWITCH_FLAGS) && rest.filter((t) => !t.startsWith("-")).length <= 2;
    case "checkout":
      return !startsWithGitDiscard(segmentText) && onlyFlagsFrom(rest, CHECKOUT_FLAGS) && rest.filter((t) => !t.startsWith("-")).length <= (rest.includes("-b") ? 2 : 1);
    case "branch":
      return onlyFlagsFrom(rest, BRANCH_FLAGS) && rest.filter((t) => !t.startsWith("-")).length <= 2;
    case "stash":
      return rest.length === 0 || STASH_SUBCOMMANDS.has(rest[0] ?? "");
    case "restore":
      return (rest.includes("--staged") || rest.includes("-S")) && !rest.includes("--worktree") && !rest.includes("-W") && !startsWithGitDiscard(segmentText);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

function isInternalPush(tokens: readonly string[], facts: ClientReachFacts, stale: StaleFacts): boolean {
  if (stale.remotes) return false;
  const positionals = parsePushSegment(tokens.map(quoteForReparse).join(" "));
  if (positionals === null) return false;
  const remoteArg = positionals[0];
  const refspec = positionals[1];

  let branch: string | null;
  if (refspec === undefined || refspec === "HEAD") branch = stale.branch ? null : facts.currentBranch;
  else branch = isPlainBranchRefspec(refspec) ? refspec : null;
  if (branch === null || SHARED_BRANCHES.has(branch.toLowerCase())) return false;

  // No remote named: git picks one (pushRemote, pushDefault, the upstream,
  // origin) -- internal only when every candidate is the team's.
  if (remoteArg === undefined) return everyRemoteIsTeamOwned(facts);
  if (!isBareRemoteName(remoteArg)) return isTeamOwner(remoteOwner(remoteArg), facts);
  const remote = facts.remotes.find((candidate) => candidate.name === remoteArg);
  const destination = remote?.pushUrl ?? remote?.url ?? null;
  return destination !== null && isTeamOwner(remoteOwner(destination), facts);
}

/** Tokens are already unquoted; parsePushSegment re-tokenizes, so a word carrying whitespace or a quote must be requoted to stay one word. */
function quoteForReparse(token: string): string {
  return /^[A-Za-z0-9._/:+@=,%^~-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// gh pr
// ---------------------------------------------------------------------------

/** Never `merge`, `close`, `review`, `ready`, `reopen`, `checkout` or anything else. */
const GH_PR_INTERNAL: ReadonlySet<string> = new Set(["create", "view", "checks", "diff", "comment", "edit", "list", "status"]);

function isInternalGhPr(tokens: readonly string[], facts: ClientReachFacts, stale: StaleFacts): boolean {
  if (stale.remotes) return false;
  if (!GH_PR_INTERNAL.has(tokens[2] ?? "")) return false;
  let repo: string | null = null;
  const rest = tokens.slice(3);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? "";
    if (token === "--repo" || token === "-R") repo = rest[i + 1] ?? "";
    else if (token.startsWith("--repo=")) repo = token.slice("--repo=".length);
    // A pull request named by URL lives wherever that URL says.
    else if (/^https?:\/\//i.test(token) && !isTeamOwner(remoteOwner(token), facts)) return false;
  }
  if (repo !== null) return isTeamOwner(repoArgOwner(repo), facts);
  // Without --repo, gh resolves the repository from the remotes -- and in a
  // fork it picks `upstream`, so every remote must be the team's.
  return everyRemoteIsTeamOwned(facts);
}

// ---------------------------------------------------------------------------
// gh api graphql
// ---------------------------------------------------------------------------

/** Replying to and resolving review conversations -- nothing that merges, approves, closes or edits anything else. */
const REVIEW_CONVERSATION_MUTATIONS: ReadonlySet<string> = new Set([
  "addPullRequestReviewThreadReply",
  "addPullRequestReviewComment",
  "resolveReviewThread",
  "unresolveReviewThread",
]);

const GH_API_FIELD_FLAGS: ReadonlySet<string> = new Set(["-f", "--raw-field", "-F", "--field"]);
const GH_API_VALUE_FLAGS: ReadonlySet<string> = new Set(["--jq", "-q", "--template", "-t", "-H", "--header"]);
const GH_API_BARE_FLAGS: ReadonlySet<string> = new Set(["--paginate", "--slurp", "--silent", "-i", "--include", "--verbose"]);

/** The inline `query=` value of a `gh api graphql` call, or null when the call carries anything this cannot vouch for (a query read from a file, an unknown flag, a positional). */
function graphqlQueryOf(tokens: readonly string[]): string | null {
  let query: string | null = null;
  for (let i = 3; i < tokens.length; i += 1) {
    const raw = tokens[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? null : raw.slice(eq + 1);
    if (GH_API_BARE_FLAGS.has(flag) && inlineValue === null) continue;
    if (!GH_API_FIELD_FLAGS.has(flag) && !GH_API_VALUE_FLAGS.has(flag)) return null;
    const value = inlineValue ?? tokens[i + 1];
    if (inlineValue === null) i += 1;
    if (value === undefined) return null;
    if (!GH_API_FIELD_FLAGS.has(flag)) continue;
    const separator = value.indexOf("=");
    if (separator === -1) return null;
    if (value.slice(0, separator) !== "query") continue;
    const text = value.slice(separator + 1);
    // `-F query=@file` reads the query from disk, which this cannot see.
    if ((flag === "-F" || flag === "--field") && text.startsWith("@")) return null;
    query = text;
  }
  return query;
}

/**
 * The top-level fields of every operation in `query`, or null when any
 * operation is not a `mutation` (an anonymous `{ ... }` or a `query` is a
 * read, not a reply -- left `unknown` rather than widened), or the document
 * uses a fragment spread or directive this does not follow. String literals
 * and `#` comments are skipped, so a body that merely NAMES a mutation is
 * never counted as one; aliases (`a: resolveReviewThread`) count the field.
 */
function mutationFields(query: string): readonly string[] | null {
  const fields: string[] = [];
  let braces = 0;
  let parens = 0;
  let keyword: string | null = null;
  let i = 0;
  while (i < query.length) {
    const char = query[i] ?? "";
    if (char === '"') {
      const block = query.startsWith('"""', i);
      const close = block ? query.indexOf('"""', i + 3) : -1;
      if (block) {
        if (close === -1) return null;
        i = close + 3;
        continue;
      }
      let j = i + 1;
      while (j < query.length && query[j] !== '"') j += query[j] === "\\" ? 2 : 1;
      if (j >= query.length) return null;
      i = j + 1;
      continue;
    }
    if (char === "#") {
      const newline = query.indexOf("\n", i);
      i = newline === -1 ? query.length : newline + 1;
      continue;
    }
    if (char === "@" || query.startsWith("...", i)) return null;
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "{") {
      if (braces === 0 && parens === 0) {
        if (keyword !== "mutation") return null;
        keyword = null;
      }
      braces += 1;
    } else if (char === "}") {
      braces -= 1;
      if (braces < 0) return null;
    } else if (/[A-Za-z_]/.test(char)) {
      let j = i + 1;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j] ?? "")) j += 1;
      const word = query.slice(i, j);
      if (braces === 0 && parens === 0) {
        if (keyword === null) keyword = word;
      } else if (braces === 1 && parens === 0) {
        let k = j;
        while (k < query.length && /\s/.test(query[k] ?? "")) k += 1;
        // An alias names the field that follows it; only the field counts.
        if (query[k] !== ":") fields.push(word);
      }
      i = j;
      continue;
    }
    i += 1;
  }
  if (braces !== 0 || parens !== 0 || fields.length === 0) return null;
  return fields;
}

function isInternalGhGraphql(tokens: readonly string[], facts: ClientReachFacts, stale: StaleFacts): boolean {
  if (stale.remotes) return false;
  const query = graphqlQueryOf(tokens);
  if (query === null) return false;
  const fields = mutationFields(query);
  if (fields === null || !fields.every((field) => REVIEW_CONVERSATION_MUTATIONS.has(field))) return false;
  // A node id can name a thread in any repository; the cwd's remotes are the
  // only repository fact there is, so all of them must be the team's.
  return everyRemoteIsTeamOwned(facts);
}

// ---------------------------------------------------------------------------
// One segment, and the whole command
// ---------------------------------------------------------------------------

/** Which of the facts an earlier segment of the same command may have changed. */
interface StaleFacts {
  readonly remotes: boolean;
  readonly branch: boolean;
}

const GIT_REMOTE_READS: ReadonlySet<string> = new Set(["-v", "--verbose", "show", "get-url"]);

/** What running `segment` may change about the facts: the directory (both), the remotes or their config, or the current branch. */
function staleAfter(segment: string, stale: StaleFacts): StaleFacts {
  const tokens = tokenize(segment);
  const [first, second, third] = tokens;
  if (first === "cd" || first === "pushd" || first === "popd") return { remotes: true, branch: true };
  const remotes =
    (first === "git" && second === "remote" && third !== undefined && !GIT_REMOTE_READS.has(third)) ||
    (first === "git" && second === "config") ||
    (first === "gh" && second === "repo" && third === "set-default");
  const branch = first === "git" && (second === "switch" || second === "checkout");
  return { remotes: stale.remotes || remotes, branch: stale.branch || branch };
}

function classifySegment(segment: string, facts: ClientReachFacts, stale: StaleFacts): SegmentReach {
  if (isSafeSegment(segment)) return "internal";
  const tokens = tokensWithoutQualifyingRedirections(segment);
  if (tokens === null) return "unknown";
  if (tokens[0] === "git") {
    if (tokens[1] === "push") return isInternalPush(tokens, facts, stale) ? "internal" : "unknown";
    return isLocalGitSegment(tokens, segment) ? "internal" : "unknown";
  }
  if (tokens[0] === "gh" && tokens[1] === "pr") return isInternalGhPr(tokens, facts, stale) ? "internal" : "unknown";
  if (tokens[0] === "gh" && tokens[1] === "api" && tokens[2] === "graphql") return isInternalGhGraphql(tokens, facts, stale) ? "internal" : "unknown";
  return "unknown";
}

/**
 * Classifies every segment of `command` against `facts`. `staysInsideTeam`
 * is true only when team owners are configured, the command can be read
 * with confidence (balanced quotes, no command substitution beyond the
 * inert quoted heredoc above), and every segment is `internal`.
 */
export function classifyClientReach(command: string, facts: ClientReachFacts): ClientReachResult {
  const text = withoutInertHeredocSubstitutions(command);
  if (hasCommandSubstitution(text) || cannotScanWithConfidence(text)) {
    return { segments: [{ segment: command, reach: "unknown" }], staysInsideTeam: false };
  }
  const segments: { segment: string; reach: SegmentReach }[] = [];
  let stale: StaleFacts = { remotes: false, branch: false };
  for (const segment of splitOnCommandSeparators(text)) {
    segments.push({ segment, reach: classifySegment(segment, facts, stale) });
    stale = staleAfter(segment, stale);
  }
  const staysInsideTeam = facts.teamOwners.length > 0 && segments.length > 0 && segments.every((s) => s.reach === "internal");
  return { segments, staysInsideTeam };
}
