// Whether a Bash command's only effect is a plain (non-force) push of the
// agent's own, non-shared branch, or one of git's own guarded delete/
// worktree operations.
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
//      `prohibits` (decisions.ts's PolicyKind) still wins. This module only
//      decides the SHAPE question ("could this command even destroy
//      anything on its own"); whether a real policy actually covers it is
//      Jev's own coverage question (`same_kind`), which only Jev can
//      honestly answer -- Option D: when gate-bash.ts finds at least one
//      command-scoped policy for the matched destination, it still calls
//      Jev for the policy question, with decisions.ts's decideGateAction told
//      (`localAllowQualifies`) to let the risk axes never decide FOR this
//      qualifying command -- only a policy that actually resolves to
//      requires_human/prohibits can still stop it.
//   3. Only when NO command-scoped policy exists at all does gate-bash.ts
//      allow locally right here, with no Jev call and no cache read/write --
//      there being nothing left for Jev to judge.
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
import { isAbsolute, join, resolve } from "node:path";

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

/**
 * `cd`'s own segment: exactly two shell words, `cd` and a plain (non-flag)
 * directory argument -- that argument itself, or `null` when the segment is
 * not this exact shape.
 */
function parseCdSegment(segmentText: string): string | null {
  const tokens = tokenize(segmentText);
  if (tokens.length !== 2 || tokens[0] !== "cd") return null;
  const dir = tokens[1] ?? "";
  return dir.length > 0 && !dir.startsWith("-") ? dir : null;
}

/**
 * The leading `cd <dir> &&` prefix's own target directory, resolved against
 * `cwd` exactly the way a shell resolves `cd`'s own argument: absolute as
 * written, or joined onto `cwd` when relative -- never touching the
 * filesystem itself. This never confirms `dirArg` IS a git worktree root:
 * readCurrentBranch's own resolveGitDirForHead walks UP from whatever
 * directory it is given looking for the nearest `.git`, the exact same
 * tolerance `cwd` itself already gets with no `cd` prefix at all, so a `cd`
 * into a non-repository subdirectory that merely sits inside a real
 * worktree still resolves that worktree's branch (harmless: a real shell
 * would already be running the push from inside that same worktree). Only a
 * directory this walk cannot resolve to ANY git repository -- `cd
 * /nonexistent && ...` -- ever fails closed, through readCurrentBranch
 * returning `null`, never through a check of its own here.
 *
 * Real evidence, 2026-09-26: `cd /repo && git push` measured as NOT
 * qualifying, because the current-branch resolution this module already
 * does for a bare `git push` never accounted for a leading `cd` changing
 * which directory that resolution should read from -- exactly the gap
 * classifyPushSegment's own current-branch case now closes by resolving
 * against THIS directory instead of `cwd` whenever a `cd` prefix is present.
 */
function resolveCdTargetDir(cwd: string, dirArg: string): string {
  return isAbsolute(dirArg) ? dirArg : resolve(cwd, dirArg);
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
 * `null` when the segment is not a qualifying push at all -- called once per
 * push-shaped segment by `qualifiesForLocalGitAllow` below (see that
 * function's own doc for the full command-level shape this composes into:
 * a single push segment, or one led by exactly `cd <dir> &&`).
 *
 * An omitted or explicit `HEAD` refspec resolves the CURRENT branch through
 * resolveGitDirForHead/readCurrentBranch, read from `branchResolutionCwd` --
 * `cwd` itself with no `cd` prefix, or the leading `cd <dir> &&` prefix's OWN
 * resolved target (resolveCdTargetDir) when one is present, so a
 * `cd`-prefixed push's current branch is read from the directory the push
 * actually runs in, never from the hook's own `cwd` (2026-09-26 fix -- see
 * resolveCdTargetDir's own doc for the real command this closes). An
 * explicit, non-`HEAD` refspec never needs any of this: the branch is right
 * there in the command, `cd`-prefixed or not.
 */
function classifyPushSegment(segmentText: string, branchResolutionCwd: string, readFile: (path: string) => string): string | null {
  const positionals = parsePushSegment(segmentText);
  if (positionals === null) return null;

  const remote = positionals[0];
  if (remote !== undefined && !isBareRemoteName(remote)) return null;
  const refspecToken = positionals.length === 2 ? positionals[1] : undefined;

  let branch: string | null;
  if (refspecToken !== undefined && refspecToken !== "HEAD") {
    if (!isPlainBranchRefspec(refspecToken)) return null;
    branch = refspecToken;
  } else {
    branch = readCurrentBranch(branchResolutionCwd, readFile);
    if (branch === null) return null;
  }

  return PROTECTED_BRANCH_NAMES.includes(branch) ? null : branch;
}

// ===========================================================================
// qualifiesForLocalGitAllow -- the guarded-deletes extension, a follow-up
// to the own-branch-push allow above. Generalizes
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
// `;` (never a bare `&` or a newline), with one exception: a `|` IS accepted
// between two real segments when everything after it is a downstream reader
// already tier-1a-safe on its own (2026-09-26 fix -- see the output-plumbing
// section further down this file), never a fresh push/delete action in its
// own right.
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

/**
 * A positional argument (a branch name, a path, a commit-ish) this module
 * is willing to trust AS WRITTEN: never empty, never a flag, and carrying
 * none of `$` (an unexpanded shell variable -- its REAL value is unknown at
 * gate time; `BRANCH='-D main'` would make `git branch -d $BRANCH` actually
 * run `git branch -d -D main`), `*`, `?` or `[` (a glob the shell may expand
 * to anything, including zero, one or many real arguments). `git push`'s own
 * remote/refspec positions are already covered by isBareRemoteName/
 * isPlainBranchRefspec's own, stricter regexes; this is the same discipline
 * for the three guarded-delete/worktree classifiers below, which otherwise
 * only ever checked "does it start with `-`".
 */
function isPlainArgument(token: string): boolean {
  return token.length > 0 && !token.startsWith("-") && !/[$*?[]/.test(token);
}

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
    if (!isPlainArgument(token)) return false;
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
  if (rest.length !== 1) return false;
  return isPlainArgument(rest[0] ?? "");
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
      if (token === "-b") {
        // -b's own value (the new branch's name) is a positional too, and
        // must be trusted the same way as every other one -- see
        // isPlainArgument's own doc comment.
        if (!isPlainArgument(rest[i + 1] ?? "")) return false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (!isPlainArgument(token)) return false;
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

// ===========================================================================
// Output plumbing acceptance (2026-09-26 fix, real evidence measured the
// same day): a plain push or guarded delete/worktree segment almost always
// arrives from a real agent wrapped in `2>&1`/`>&2`/a `/dev/null` discard, or
// piped into a read-only summarizer (`| tail -2`) -- none of which can
// change what the command ITSELF does, only where its own stderr/stdout end
// up, or what merely READS them afterwards. The bare-form-only match before
// this fix barely ever recognized either shape, sending almost every real
// push through the ordinary (noisier) Jev path regardless of how plainly
// safe it was.
// ===========================================================================

/**
 * The exact redirection forms this module accepts, checked as a whole shell
 * WORD -- via the same `tokenize` every other classifier here already uses,
 * never a raw-string suffix match: `2>&1`, `>&2` (the reverse merge), and
 * discarding stdout/stderr to `/dev/null` in each of its three spellings
 * (`2>`, a bare `>`, or the combined `&>`). A redirect to anywhere else
 * (`> out.txt`, `>> log`) is deliberately NOT in this set, so
 * stripQualifyingRedirections' own leftover `<`/`>` check below catches it
 * and disqualifies -- conservative on purpose, per the task's own framing.
 *
 * Checked as an EXACT token, not a suffix, because a suffix match on the raw
 * text cannot tell a real redirection apart from one glued to a leading file
 * descriptor digit that is NOT part of it: a real shell reads `1>&2` (no
 * space) as ONE token -- redirect fd 1 to fd 2, nothing left over -- but a
 * naive `/>&2$/` suffix strip on the raw string leaves the `1` behind as if
 * it were a separate word. That stray `1` then read as a perfectly valid,
 * unprotected explicit branch refspec (`isPlainBranchRefspec("1")` is true),
 * which silently skipped the protected-branch check entirely for whatever
 * branch the command REALLY pushes (measured: `git push origin 1>&2` on a
 * repo checked out on `main` qualified as an explicit push to branch "1",
 * even though the real command -- `git push origin`, since `1>&2` is pure
 * redirection -- pushes `main` itself). Token-exact matching closes this:
 * `1>&2` tokenizes to one word that is not `>&2`, so it is simply not in
 * this set, and the segment disqualifies rather than partially parses.
 */
const SAFE_REDIRECTION_TOKENS: ReadonlySet<string> = new Set(["2>&1", ">&2", "2>/dev/null", ">/dev/null", "&>/dev/null"]);

/**
 * `segmentText` with every trailing safe redirection TOKEN (see
 * SAFE_REDIRECTION_TOKENS above) removed, or `null` when any OTHER token
 * carries a `<`/`>` -- a redirect this module does not positively recognise
 * as safe must disqualify the whole segment, never silently pass through to
 * the classifiers below (parsePushSegment, classifyBranchDeleteSegment, ...),
 * which have no redirection vocabulary of their own and would otherwise
 * misread it as a stray positional argument -- a fake remote name, a fake
 * branch to delete.
 */
function stripQualifyingRedirections(segmentText: string): string | null {
  const kept: string[] = [];
  for (const token of tokenize(segmentText)) {
    if (token.includes("<") || token.includes(">")) {
      if (!SAFE_REDIRECTION_TOKENS.has(token)) return null;
      continue;
    }
    kept.push(token);
  }
  return kept.join(" ");
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
 * (current-branch resolution running against THAT directory, not `cwd`,
 * when one is present -- 2026-09-26 fix) and optionally carrying the output
 * plumbing real agents almost always add: `2>&1`/`>&2`/a `/dev/null`
 * discard, or a pipe into a downstream reader already tier-1a-safe on its
 * own -- see the module note above for the full shape and the real command
 * this generalizes from. Composes with (never replaces) gate-bash.ts's own
 * deny tier and destination-policy check.
 */
export function qualifiesForLocalGitAllow(input: OwnBranchPushInput): LocalGitAllowResult {
  const { command, cwd } = input;
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (hasCommandSubstitution(command)) return DOES_NOT_QUALIFY;

  const { segments, joiners, trailing } = splitOnCommandSeparatorsDetailed(command);
  if (segments.length === 0) return DOES_NOT_QUALIFY;
  if (joiners[0] !== null) return DOES_NOT_QUALIFY;
  // A trailing separator with nothing real after it -- most notably a bare
  // `&`, which BACKGROUNDS the last segment instead of joining it to
  // anything -- disqualifies: see CommandSeparatorSplit.trailing's own doc.
  if (trailing !== null) return DOES_NOT_QUALIFY;

  const firstSegment = segments[0] ?? "";
  let firstActionIndex = 0;
  // `cwd` unless a leading `cd <dir> &&` resolves to a different directory --
  // the directory every push segment's own omitted/`HEAD` refspec resolves
  // its CURRENT branch from (classifyPushSegment), not just the first one.
  let branchResolutionCwd = cwd;
  if (isCdShaped(firstSegment)) {
    // A `cd`-shaped FIRST segment is only ever handled here, as the
    // prefix -- never falls through to be judged an ordinary action segment
    // (which would let it slip in via isObviouslySafeCommand's own,
    // position-blind "bare cd is safe" rule and bypass the "&&"-only,
    // "at most one" constraints below).
    const cdDir = parseCdSegment(firstSegment);
    if (segments.length < 2 || cdDir === null || joiners[1] !== "&&") return DOES_NOT_QUALIFY;
    branchResolutionCwd = resolveCdTargetDir(cwd, cdDir);
    firstActionIndex = 1;
  }

  let sawPush = false;
  let sawGuardedDelete = false;
  for (let i = firstActionIndex; i < segments.length; i += 1) {
    const joiner = i === firstActionIndex ? null : joiners[i];
    if (joiner !== null && joiner !== "&&" && joiner !== ";" && joiner !== "|") return DOES_NOT_QUALIFY;

    const cleaned = stripQualifyingRedirections(segments[i] ?? "");
    if (cleaned === null) return DOES_NOT_QUALIFY;

    // A `cd` anywhere other than the already-consumed leading prefix is
    // never a valid action segment, piped-to or not -- see isCdShaped's own
    // doc comment.
    if (isCdShaped(cleaned)) return DOES_NOT_QUALIFY;

    if (joiner === "|") {
      // Downstream of a pipe: never a fresh action in its own right, only
      // ever accepted when it is already tier-1a-safe -- a read-only reader
      // (`tail`, `head`, `grep`, `cat`, `sed -n`, `jq`, ...), reusing
      // gate_safe_command.ts's own list rather than a second one.
      if (!isObviouslySafeCommand(cleaned)) return DOES_NOT_QUALIFY;
      continue;
    }

    if (classifyPushSegment(cleaned, branchResolutionCwd, readFile) !== null) {
      sawPush = true;
      continue;
    }
    if (classifyBranchDeleteSegment(cleaned) || classifyWorktreeRemoveSegment(cleaned) || classifyWorktreePruneSegment(cleaned) || classifyWorktreeAddSegment(cleaned)) {
      sawGuardedDelete = true;
      continue;
    }
    if (isObviouslySafeCommand(cleaned)) continue;
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
