// Whether a Bash command's only effect is a plain (non-force) push of the
// agent's own, non-shared branch -- odd/tasks/release-0.5.1-push-own-branch.md.
//
// Real evidence, 2026-09-26: the owner's gate log showed five identical
// `git push -u origin fabolivark/release-0.5.1` runs, four allowed and one
// asked, all through Jev's risk stage (the consequence score landed inside
// CONSEQUENCE_NOISE_MARGIN's noise band -- see decisions.ts). A plain,
// non-force push of a branch nobody else shares cannot destroy anything, so
// it should never need Jev's judgment at all -- but only once everything
// that can still stop it has already had its say:
//
//   1. gate-bash.ts's own NEVER_SILENTLY deny rules (forcePush,
//      pushProtected, ...) run first, completely unchanged -- this module is
//      only ever consulted for a command that already survived them.
//   2. A destination policy that resolves to `requires_human` or
//      `prohibits` (decisions.ts's PolicyKind) still wins -- gate-bash.ts
//      checks that itself, before ever calling qualifiesForOwnBranchPush,
//      because a policy's own coverage question can only be answered by
//      Jev, which this module exists to avoid calling in the first place.
//   3. Only then does this module decide whether the command qualifies for
//      a purely local 'allow', with no Jev call and no cache read/write.
//
// Deliberately conservative throughout: any shape this module cannot
// positively confirm is a plain push of a resolvable, non-shared branch
// answers `false`, sending the command to the ordinary Jev path exactly as
// before this feature existed. This never widens what is refused or asked
// about -- it only narrows the one shape the task names.
//
// Reuses the SAME parsing primitives the rest of this project's gate
// already uses, rather than a second, drifting shell parser:
//   - splitOnCommandSeparatorsDetailed (git_discard.ts) for the top-level
//     `cd <dir> && <push>` shape, including which exact joiner text was
//     used (only "&&" qualifies here -- "cd x || git push" would run the
//     push in the wrong directory on a failed `cd`, so it must not
//     qualify).
//   - tokenize (git_discard.ts) for the push (and `cd`) segment's own shell
//     words, quotes respected.
//   - hasCommandSubstitution (command_shape.ts) to bail out before any of
//     the above on a command carrying `$(...)`/backticks/`${...}` -- the
//     same early-exit isObviouslySafeCommand and isSafeSegment already use.
//   - PROTECTED_BRANCH_NAMES and isBareRemoteName (push_remote.ts) -- the
//     ONE shared/protected-branch list and the ONE bare-remote-name check,
//     never a second copy of either.
//   - resolveGitDirForHead (linked_worktree.ts) to read the CURRENT
//     worktree's own HEAD (never the main checkout's, for a linked
//     worktree) when the refspec is omitted or `HEAD`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hasCommandSubstitution } from "./command_shape.ts";
import { isObviouslySafeCommand } from "./gate_safe_command.ts";
import { splitOnCommandSeparatorsDetailed, tokenize } from "./git_discard.ts";
import { resolveGitDirForHead } from "./linked_worktree.ts";
import { PROTECTED_BRANCH_NAMES, isBareRemoteName } from "./push_remote.ts";

export interface OwnBranchPushInput {
  readonly command: string;
  readonly cwd: string;
  /** Injectable for tests -- defaults to a real, synchronous UTF-8 file read. */
  readonly readFile?: (path: string) => string;
}

/**
 * `git push`'s own options this module accepts -- exact tokens only, never a
 * short cluster (`-uq`) or a `--flag=value` form, both of which fail this
 * `Set`'s exact-string membership test and so disqualify without any extra
 * code. `--no-verify` is deliberately absent: it skips hooks, which is
 * exactly the kind of change-in-effect a "plain push" must not carry.
 * Anything starting with `-` that is not one of these six -- `--force`,
 * `--force-with-lease`, `--force-if-includes`, `--delete`/`-d`, `--mirror`,
 * `--all`, `--tags`, `--prune`, `--follow-tags`, `-o`/`--push-option`,
 * `--repo`, `--no-verify`, or anything else -- disqualifies the whole
 * command.
 */
const ALLOWED_PUSH_OPTIONS: ReadonlySet<string> = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose"]);

/** A plain branch name a refspec argument is allowed to name directly: no
 *  `:` (no `src:dst`, no `:branch` delete), no leading `+` (no forced
 *  update), no glob, and never `refs/...` -- the task's own words are "a
 *  plain branch name or HEAD", not a full ref path. `HEAD` itself is handled
 *  by the caller, not here. */
function isPlainBranchRefspec(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.includes(":")) return false;
  if (ref.startsWith("+")) return false;
  if (ref.includes("*")) return false;
  if (ref.startsWith("refs/")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
}

/** `cd`'s own segment: exactly two shell words, `cd` and a plain (non-flag) directory argument. Never resolved against the filesystem -- see the module note on why a `cd`-prefixed push requires an EXPLICIT refspec instead. */
function parseCdSegment(segmentText: string): boolean {
  const tokens = tokenize(segmentText);
  return tokens.length === 2 && tokens[0] === "cd" && (tokens[1] ?? "").length > 0 && !(tokens[1] ?? "").startsWith("-");
}

/**
 * The push segment's own positional arguments (remote, refspec), or `null`
 * when the segment is not exactly `git push` with only allowlisted options.
 * `tokens[0]` must be the bare word `git` -- no path prefix, no `sudo`/`env`
 * wrapper, no leading `NAME=value` assignment, no `-C`/`-c` global option --
 * unlike the deny tier's own rules (which must see through all of those to
 * catch an obfuscated destructive command), a local ALLOW has no such
 * obligation: anything even slightly unusual simply does not qualify and
 * falls through to the ordinary Jev path.
 */
function parsePushSegment(segmentText: string): readonly string[] | null {
  const tokens = tokenize(segmentText);
  if (tokens[0] !== "git" || tokens[1] !== "push") return null;
  const positionals: string[] = [];
  for (const token of tokens.slice(2)) {
    if (token.startsWith("-")) {
      if (!ALLOWED_PUSH_OPTIONS.has(token)) return null;
      continue;
    }
    positionals.push(token);
  }
  return positionals.length <= 2 ? positionals : null;
}

/**
 * The CURRENT branch of the repository at `cwd`, read straight off disk (no
 * `git` subprocess): `HEAD`'s own `ref: refs/heads/<name>` line, resolved
 * through resolveGitDirForHead so a linked worktree's OWN branch is read,
 * never its main checkout's. `null` on anything this cannot positively
 * resolve -- no repository, an unreadable HEAD, or a detached HEAD (a raw
 * commit SHA, with no `ref:` line at all) -- which the caller treats as
 * "does not qualify", never as some assumed default branch.
 */
function readCurrentBranch(cwd: string, readFile: (path: string) => string): string | null {
  try {
    const gitDir = resolveGitDirForHead(cwd);
    if (gitDir === null) return null;
    const raw = readFile(join(gitDir, "HEAD")).trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
    if (match === null) return null;
    const branch = (match[1] ?? "").trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * One push segment's own resolved (non-protected) destination branch, or
 * `null` when the segment is not a qualifying push at all -- the shared
 * building block both `qualifiesForOwnBranchPush` (below, its own narrower,
 * single-segment contract, unchanged since it first shipped) and
 * `qualifiesForLocalGitAllow` (odd/tasks/release-0.5.1-push-own-branch.md,
 * the guarded-deletes extension) call, so the push-qualification rule is
 * never duplicated between the two.
 */
function classifyPushSegment(segmentText: string, cwd: string, cdPrefixPresent: boolean, readFile: (path: string) => string): string | null {
  const positionals = parsePushSegment(segmentText);
  if (positionals === null) return null;

  const remote = positionals[0];
  if (remote !== undefined && !isBareRemoteName(remote)) return null;
  const refspecToken = positionals.length === 2 ? positionals[1] : undefined;

  let branch: string | null;
  if (cdPrefixPresent) {
    // See qualifiesForOwnBranchPush's own doc: a `cd`-prefixed push must
    // name its branch explicitly, never resolve HEAD from the wrong
    // directory.
    if (refspecToken === undefined || refspecToken === "HEAD") return null;
    if (!isPlainBranchRefspec(refspecToken)) return null;
    branch = refspecToken;
  } else if (refspecToken !== undefined && refspecToken !== "HEAD") {
    if (!isPlainBranchRefspec(refspecToken)) return null;
    branch = refspecToken;
  } else {
    branch = readCurrentBranch(cwd, readFile);
    if (branch === null) return null;
  }

  return PROTECTED_BRANCH_NAMES.includes(branch) ? null : branch;
}

/**
 * Whether `input.command` qualifies for the own-branch-push local allow --
 * see the module note above for the full decision this composes with (the
 * deny tier and the destination-policy check both run BEFORE this, in
 * gate-bash.ts's own main(), not here). Pure except for the one HEAD read
 * this needs when the refspec is omitted or `HEAD`; injectable via
 * `input.readFile` for tests, exactly like push_remote.ts's own
 * resolvePushRemoteIsLocal.
 *
 * Qualifies only when ALL of these hold:
 *   - `command` carries no command/process substitution.
 *   - It is either exactly one `git push` segment, or exactly
 *     `cd <dir> && git push ...` (that literal `&&`, nothing else) --
 *     never any other segment, joiner or count.
 *   - The push carries only allowlisted options (see ALLOWED_PUSH_OPTIONS)
 *     and 0-2 positional arguments (`[remote] [refspec]`).
 *   - A given remote is a bare remote NAME, never a URL or a path.
 *   - The destination branch resolves to something OTHER than one of
 *     PROTECTED_BRANCH_NAMES. With a `cd` prefix, the refspec must be given
 *     explicitly and must not be `HEAD` -- resolving the CURRENT branch
 *     would read it from the hook's own `cwd`, not from the directory the
 *     push actually runs in, which is not a fact this module can safely
 *     assume without also resolving where `cd`'s own argument points (out
 *     of scope, per the task's own conservative framing). Without a `cd`
 *     prefix, an omitted or explicit `HEAD` refspec resolves the CURRENT
 *     branch from `cwd` itself.
 */
export function qualifiesForOwnBranchPush(input: OwnBranchPushInput): boolean {
  const { command, cwd } = input;
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (hasCommandSubstitution(command)) return false;

  const { segments, joiners } = splitOnCommandSeparatorsDetailed(command);
  if (segments.length === 0 || segments.length > 2) return false;
  if (joiners[0] !== null) return false;

  let pushSegmentText: string;
  let cdPrefixPresent: boolean;
  if (segments.length === 1) {
    pushSegmentText = segments[0] ?? "";
    cdPrefixPresent = false;
  } else {
    if (joiners[1] !== "&&") return false;
    if (!parseCdSegment(segments[0] ?? "")) return false;
    pushSegmentText = segments[1] ?? "";
    cdPrefixPresent = true;
  }

  return classifyPushSegment(pushSegmentText, cwd, cdPrefixPresent, readFile) !== null;
}

// ===========================================================================
// qualifiesForLocalGitAllow -- the guarded-deletes extension
// (odd/tasks/release-0.5.1-push-own-branch.md, follow-up task). Generalizes
// the single-push shape above into a SEQUENCE of one or more segments,
// optionally led by exactly one `cd <dir> &&`, where every remaining
// segment is EITHER a qualifying own-branch push, one of git's own three
// GUARDED destructive-looking operations (a plain `git branch -d`/`--delete`,
// `git worktree remove` with no `--force`/`-f`, or `git worktree prune`),
// `git worktree add` with no `--force`/`-f`/`-B` (creates/updates metadata
// only, never destroys anything, but is grouped with the guarded deletes
// because it is part of the SAME real-world sequence: adding a fresh
// worktree right after removing an old one), or already tier-1a-safe on its
// own (gate_safe_command.ts's isObviouslySafeCommand) -- joined by `&&` or
// `;` (never `|`, a bare `&`, or a newline).
//
// Real evidence, 2026-09-26: the owner had to confirm by hand
//   `git worktree remove ../orca-supervisor-lane-m && git branch -d
//   fabolivark/release-0.5.1-lane-m && git worktree add -q -b <new>
//   ../lane-s 9ebb862`
// -- Jev's own reason was "no automatic way to undo it", but none of it can
// actually lose work: `git worktree remove` without `--force` already
// refuses a worktree carrying uncommitted or untracked changes, and
// `git branch -d` (lowercase) already refuses an unmerged branch -- it is
// git's OWN guard, not this gate's, that stands between the command and any
// real loss. `-D`/`--force`/`-f` bypass exactly that guard, which is why
// they are the one thing that disqualifies each of these.
// ===========================================================================

/** `git branch`'s own delete flags this module accepts -- `-d`/`--delete`
 *  only. `-D` (force-delete, skips the "already merged" check), `-f`,
 *  `--force`, or a short cluster combining `-d` with anything else all
 *  disqualify: any token starting with `-` that is not exactly one of these
 *  two fails the whole segment. */
const BRANCH_DELETE_FLAGS: ReadonlySet<string> = new Set(["-d", "--delete"]);

/** `git branch -d`/`--delete <name>...` -- one or more plain branch names, no other flag. */
function classifyBranchDeleteSegment(segmentText: string): boolean {
  const tokens = tokenize(segmentText);
  if (tokens[0] !== "git" || tokens[1] !== "branch") return false;
  let sawDeleteFlag = false;
  let nameCount = 0;
  for (const token of tokens.slice(2)) {
    if (token.startsWith("-")) {
      if (!BRANCH_DELETE_FLAGS.has(token)) return false;
      sawDeleteFlag = true;
      continue;
    }
    nameCount += 1;
  }
  return sawDeleteFlag && nameCount >= 1;
}

/** `git worktree remove <path>` -- exactly one positional, no flags at all
 *  (not only `--force`/`-f`: nothing else this command takes is worth
 *  trusting sight-unseen). */
function classifyWorktreeRemoveSegment(segmentText: string): boolean {
  const tokens = tokenize(segmentText);
  if (tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "remove") return false;
  const rest = tokens.slice(3);
  if (rest.some((token) => token.startsWith("-"))) return false;
  return rest.length === 1;
}

/** `git worktree prune` -- no arguments at all. */
function classifyWorktreePruneSegment(segmentText: string): boolean {
  const tokens = tokenize(segmentText);
  return tokens.length === 3 && tokens[0] === "git" && tokens[1] === "worktree" && tokens[2] === "prune";
}

/** A short option cluster (`-Bf`, `-qB`) containing `f` or `B` -- the same
 *  folded-flag reasoning gate_safe_command.ts's own isSafeSegment applies
 *  elsewhere in this project (`-df`, `-fx` for `git clean`). */
function clusterHasForceOrBFlag(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token) && !token.startsWith("--") && (token.includes("f") || token.includes("B"));
}

/** `git worktree add ...` -- creates or resets metadata only, never
 *  destroys anything, EXCEPT `--force`/`-f` (adds a worktree for an
 *  already-checked-out branch, or over an existing path) and `-B`
 *  (force-resets an existing branch's tip) -- both reject a positive guard
 *  the same way `-D` does for `git branch`. `-b <name>` consumes its own
 *  value, so a branch name that happens to start with `-` is never
 *  misread as another flag. */
function classifyWorktreeAddSegment(segmentText: string): boolean {
  const tokens = tokenize(segmentText);
  if (tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "add") return false;
  const rest = tokens.slice(3);
  let i = 0;
  while (i < rest.length) {
    const token = rest[i] ?? "";
    if (token.startsWith("-")) {
      if (token === "-f" || token === "--force" || token === "-B") return false;
      if (clusterHasForceOrBFlag(token)) return false;
      i += token === "-b" ? 2 : 1;
      continue;
    }
    i += 1;
  }
  return true;
}

/** Whether `segmentText` is a bare `cd <dir>` -- used both to recognise the
 *  one allowed LEADING `cd` prefix and to explicitly REJECT one appearing
 *  anywhere else in the sequence (see qualifiesForLocalGitAllow below):
 *  gate_safe_command.ts's own isObviouslySafeCommand treats a bare `cd` as
 *  safe wherever it appears, which is correct for THAT check (changing
 *  directory alone is harmless) but wrong for this one, where only the
 *  FIRST segment may ever change the directory the rest of the sequence
 *  reasons about. */
function isCdShaped(segmentText: string): boolean {
  return tokenize(segmentText)[0] === "cd";
}

export type LocalGitAllowReasonKind = "ownBranchPush" | "guardedGitDelete";

export interface LocalGitAllowResult {
  readonly qualifies: boolean;
  /** Present only when `qualifies` is true -- which reason key the caller should show. When the sequence mixes a push with a guarded delete/worktree action, the delete reason wins (see the module note above). */
  readonly reasonKind?: LocalGitAllowReasonKind;
}

const DOES_NOT_QUALIFY: LocalGitAllowResult = { qualifies: false };

/**
 * The general local-allow check: a plain own-branch push, one or more of
 * git's own guarded delete/worktree operations, or a mix of either with an
 * already tier-1a-safe command, optionally led by exactly one `cd <dir> &&`
 * -- see the module note above for the full shape and the real command this
 * generalizes from. Composes with (never replaces) gate-bash.ts's own deny
 * tier and destination-policy check, exactly like qualifiesForOwnBranchPush.
 */
export function qualifiesForLocalGitAllow(input: OwnBranchPushInput): LocalGitAllowResult {
  const { command, cwd } = input;
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (hasCommandSubstitution(command)) return DOES_NOT_QUALIFY;

  const { segments, joiners } = splitOnCommandSeparatorsDetailed(command);
  if (segments.length === 0) return DOES_NOT_QUALIFY;
  if (joiners[0] !== null) return DOES_NOT_QUALIFY;

  const firstSegment = segments[0] ?? "";
  let cdPrefixPresent = false;
  let firstActionIndex = 0;
  if (isCdShaped(firstSegment)) {
    // A `cd`-shaped FIRST segment is only ever handled here, as the
    // prefix -- never falls through to be judged an ordinary action segment
    // (which would let it slip in via isObviouslySafeCommand's own,
    // position-blind "bare cd is safe" rule and bypass the "&&"-only,
    // "at most one" constraints below).
    if (segments.length < 2 || !parseCdSegment(firstSegment) || joiners[1] !== "&&") return DOES_NOT_QUALIFY;
    cdPrefixPresent = true;
    firstActionIndex = 1;
  }

  for (let i = firstActionIndex + 1; i < segments.length; i += 1) {
    if (joiners[i] !== "&&" && joiners[i] !== ";") return DOES_NOT_QUALIFY;
  }

  let sawPush = false;
  let sawGuardedDelete = false;
  for (let i = firstActionIndex; i < segments.length; i += 1) {
    const segmentText = segments[i] ?? "";
    // A `cd` anywhere other than the already-consumed leading prefix is
    // never a valid action segment -- see isCdShaped's own doc comment.
    if (isCdShaped(segmentText)) return DOES_NOT_QUALIFY;

    const isFirstActionSegment = i === firstActionIndex;
    if (classifyPushSegment(segmentText, cwd, isFirstActionSegment && cdPrefixPresent, readFile) !== null) {
      sawPush = true;
      continue;
    }
    if (classifyBranchDeleteSegment(segmentText) || classifyWorktreeRemoveSegment(segmentText) || classifyWorktreePruneSegment(segmentText) || classifyWorktreeAddSegment(segmentText)) {
      sawGuardedDelete = true;
      continue;
    }
    if (isObviouslySafeCommand(segmentText)) continue;
    return DOES_NOT_QUALIFY;
  }

  // A sequence made ENTIRELY of already tier-1a-safe segments never reaches
  // this module in practice -- gate-bash.ts's own isObviouslySafeCommand
  // check on the WHOLE command already passes it through before the deny
  // tier or this stage ever run. Kept as an explicit guard anyway, so this
  // function's own contract stays correct for a direct unit-test call too.
  if (!sawPush && !sawGuardedDelete) return DOES_NOT_QUALIFY;

  return { qualifies: true, reasonKind: sawGuardedDelete ? "guardedGitDelete" : "ownBranchPush" };
}
