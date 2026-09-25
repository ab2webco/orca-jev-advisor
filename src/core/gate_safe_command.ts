// Pure, side-effect-free classification of "obviously safe" Bash commands
// for adapters/claude/gate-bash.ts's tier-1 fast path.
//
// Kept out of gate-bash.ts itself -- that file ends in a top-level
// `await main()`, so importing it (even just for a function) would run the
// whole hook: read stdin, resolve an API key, maybe call Jev. A pure module
// lets a test import isObviouslySafeCommand with no process, network, or
// stdin side effect.
//
// The rule this implements: a command is obviously safe only when EVERY
// one of its segments -- after splitting on `&&`, `||`, `;`, `|` and
// stripping leading `VAR=value` assignments -- is itself obviously safe,
// AND carries no command/process substitution (`$(...)`, backticks,
// `${...}`, `<(...)`, `>(...)` -- see isSafeSegment/hasCommandSubstitution
// below): a segment starting with a safe verb but embedding one of these
// can do anything the embedded command can do, which a leading-verb check
// alone cannot see (measured: `grep foo $(rm -rf ~)`, `ls $(cat /tmp/x)`,
// `echo ${IFS}test` and others all passed tier 1a silently before this).
// Splitting and assignment-stripping reuse gate_measurement.ts's own
// `splitSegments`/`stripAssignments`, not a second implementation of the
// same thing. Anything that can't be confidently classified is NOT safe:
// an unclassifiable command only costs latency (it falls through to the
// existing NEVER_SILENTLY/Jev path), it never causes a wrong "safe".
import { commandFamily, splitSegments } from './gate_measurement.ts'
import { hasCommandSubstitution } from './command_shape.ts'

/**
 * The one command family gate_measurement.ts already judges by looking at
 * the WHOLE command before any split (`curl ... | bash`, `wget ... | sh` --
 * see commandFamily's `spansPipe` handling), reused here instead of
 * duplicating that regex. A pipe's danger can live only in how its stages
 * combine (a harmless-looking fetch feeding a shell), never in reading one
 * stage alone -- exactly what per-segment matching cannot see by itself.
 */
const DANGEROUS_PIPE_FAMILY = 'curl | shell'

/**
 * Tier 1a segment patterns. Each is tested against ONE already-split,
 * already-assignment-stripped segment -- never the whole compound string --
 * so a command that merely STARTS with a safe verb can no longer wave the
 * rest of a compound command through unseen.
 */
const SAFE_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|which|echo|date|whoami)\b/,
  // Bare `cd`: changing directory alone can't be dangerous, whatever the target.
  /^cd(\s|$)/,
  /^(jq|rg|grep|sed -n|awk)\b/,
  /^git\s+(status|diff|log|show|remote|rev-parse|blame)\b/,
  // `git branch` only in its read-only forms -- anything else (creating a
  // branch with a bare name, deleting with -d/-D, renaming with -m/-M) is
  // excluded by the trailing `$`, which requires the segment to end here.
  /^git\s+branch(\s+(-a|-r|-v|-vv|--all|--list|--show-current))*\s*$/,
  /^git\s+stash\s+list\b/,
  /^(npm|pnpm|yarn|bun)\s+(test|run test|run lint|run typecheck|run build)\b/,
  // Only the version check. Anything else about node/npx runs an arbitrary
  // script, which cannot be judged safe by looking at the invocation alone
  // -- that is out of scope, not a gap to close here.
  /^node\s+(--version|-v)\s*$/,
  /^npx\s+(--version|-v)\s*$/,
  /^gh\s+(pr|issue|run|repo)\s+(list|view|status|checks)\b/,
]

/** `find`'s destructive flags -- everything else is a plain search/list. */
const FIND_DANGEROUS_FLAGS = /-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprintf?\b|-fprint0?\b/

function isSafeFindSegment(segment: string): boolean {
  return /^find\b/.test(segment) && !FIND_DANGEROUS_FLAGS.test(segment)
}

/**
 * `env` with nothing but flags after it only prints the environment; `env
 * NAME=value cmd` or `env cmd` RUNS `cmd` with a modified environment --
 * the leading word alone cannot tell these apart, so a generic safe-verb
 * pattern (odd/tasks/release-0.5.1.md T8, JEVADV-24) waved `env A=1 git
 * reset --hard` through as obviously safe before anything -- the deny tier
 * included -- ever saw it. Safe only when NOTHING follows `env` except
 * short-flag clusters (`-i`, `-u NAME`'s flag itself, etc.); an assignment
 * or a bare command word means something is about to run.
 */
function isSafeEnvSegment(segment: string): boolean {
  return /^env(\s+-[A-Za-z-]+)*\s*$/.test(segment)
}

/**
 * The exact redirection forms that only DISCARD or MERGE a stream, never
 * write it anywhere a person or another process could read it back:
 *
 *   - `2>/dev/null` / `2> /dev/null` -- discard stderr
 *   - `2>&1`                         -- merge stderr into stdout
 *   - `>/dev/null` / `> /dev/null`   -- discard stdout (a bare `>` is fd 1)
 *
 * Silencing a stream cannot make a read-only command dangerous, and this is
 * the single most common habit in agent-written commands (measured: 5-6
 * such calls sinking pure-inspection commands into a paid Jev call in one
 * evening). Deliberately narrow and literal -- `>>` (append), any target
 * other than exactly `/dev/null`, and `1>&2` (merge the other direction)
 * are NOT matched here and fall straight through to hasRedirection's
 * catch-all below. Each pattern requires the redirection to start at the
 * beginning of the segment or after whitespace, so it can never accidentally
 * eat part of a `>>` or a real path that merely starts with `/dev/null`-like
 * text.
 */
const SAFE_REDIRECTIONS: readonly RegExp[] = [
  /(?:^|\s)2>\s*\/dev\/null(?=\s|$)/,
  /(?:^|\s)2>&1(?=\s|$)/,
  /(?:^|\s)[1]?>\s*\/dev\/null(?=\s|$)/,
]

/** Removes every safe-redirection occurrence (see SAFE_REDIRECTIONS) so hasRedirection only ever sees what is left. Global so `> /dev/null 2>&1` (both in one segment) is fully cleared. */
function stripSafeRedirections(segment: string): string {
  let stripped = segment
  for (const pattern of SAFE_REDIRECTIONS) {
    stripped = stripped.replace(new RegExp(pattern, 'g'), ' ')
  }
  return stripped
}

/**
 * `splitSegments` only splits on `&&`/`||`/`;`/`|`, never on redirection --
 * so `echo x > /etc/passwd` or `cat a > b` stays ONE segment that still
 * starts with a safe verb. Any `<`/`>` left in a segment AFTER stripping the
 * safe discard/merge forms above means it can write to, or read from, a
 * file outside its own arguments, so it is never obviously safe -- it just
 * falls through to the existing path, same as any other unclassifiable
 * command. Tested against the ORIGINAL segment text (SAFE_SEGMENT_PATTERNS
 * below still match a safe verb regardless of trailing redirection), only
 * this check itself runs against the stripped copy.
 */
function hasRedirection(segment: string): boolean {
  return /[<>]/.test(stripSafeRedirections(segment))
}

/**
 * Checked FIRST, before hasRedirection or any safe-verb pattern -- exactly
 * the same placement hasRedirection itself uses, so no safe verb can ever
 * carry a substitution through on a technicality. `hasCommandSubstitution`
 * is imported from src/core/command_shape.ts rather than reimplemented
 * here: that module already refuses to CACHE a command for the identical
 * reason ("cannot be known without running it"), and tier 1a needs that
 * same fact at least as much, since it skips judgment entirely rather than
 * merely skipping a cache.
 *
 * Running this ahead of hasRedirection also sidesteps the question of
 * whether stripSafeRedirections' `/dev/null`/`2>&1` patterns could ever
 * accidentally clear the `<`/`>` that opens `<(...)`/`>(...)`: it can't (the
 * `(?=\s|$)` boundary in every SAFE_REDIRECTIONS pattern refuses to match
 * unless a clean token follows, and `<(`/`>(` never leaves one), but this
 * ordering means that question never even has to be asked at call time.
 *
 * Safe against splitSegments' own naive split, too: `String.split` only
 * ever removes the separator text it matches (`&&`, `||`, `;`, `|`), never
 * any other character, so a substitution's opening token can never be torn
 * apart by a split -- it always survives intact inside whichever resulting
 * segment it started in, even when the substitution's own argument (e.g.
 * `$(a; b)`) contains one of those same separator characters.
 */
function isSafeSegment(segment: string): boolean {
  if (hasCommandSubstitution(segment)) return false
  if (hasRedirection(segment)) return false
  if (isSafeFindSegment(segment)) return true
  if (isSafeEnvSegment(segment)) return true
  return SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
}

/**
 * True only when every segment of `command` is independently, confidently
 * safe. Used by gate-bash.ts BEFORE the NEVER_SILENTLY check and before any
 * network call, so it must never accept something the old whole-string
 * regexes used to wave through "by accident" (a compound command that
 * merely started with a safe verb, e.g. `git status && rm -rf /`) -- see
 * the module comment for the rule this implements.
 */
export function isObviouslySafeCommand(command: string): boolean {
  if (commandFamily(command) === DANGEROUS_PIPE_FAMILY) return false
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  return segments.every(isSafeSegment)
}

/**
 * Whether a command only *mentions* a dangerous phrase rather than running it.
 *
 * Found live: `grep -n "terraform apply stays ask" file.mjs` was refused as
 * "creates, changes or destroys real infrastructure", because the tier-1b
 * rules test the whole command string and the phrase sat inside a quoted
 * search pattern. Under `ask` that cost a click. Under `deny` it makes an
 * agent unable to grep this very repository, whose source is full of these
 * phrases -- so the two changes had to land together.
 *
 * Deliberately conservative: this answers true only when EVERY segment leads
 * with a verb that reads or prints and cannot execute its argument. Anything
 * else -- an unrecognised verb, a shell, a segment the splitter mangled
 * because a quoted `|` confused it -- answers false and the rule stands. The
 * cost of a false "mention" is a dangerous command waved through; the cost of
 * a false "run" is one interruption. They are not symmetric.
 */
const MENTION_ONLY_VERBS =
  /^(grep|rg|ag|ack|echo|printf|cat|bat|head|tail|less|more|wc|nl|comm|diff|sort|uniq|column|jq|yq|fgrep|egrep|sed\s+-n|awk)\b/;

export function mentionsRatherThanRuns(command: string): boolean {
  // odd/tasks/release-0.5.1.md T8 (JEVADV-24): `echo "$(git reset --hard)"`
  // leads with a read/print verb, but its argument carries a REAL command
  // substitution -- the exact reasoning isSafeSegment already applies via
  // hasCommandSubstitution. Without this, this function broke the
  // NEVER_SILENTLY loop before the deny tier ever got a chance to look at
  // the substitution's body, waving a genuine `git reset --hard` through.
  if (hasCommandSubstitution(command)) return false;
  // Reuses the gate's own splitter rather than a second, drifting copy.
  const segments = splitSegments(command).map((segment) => segment.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every((segment) => MENTION_ONLY_VERBS.test(segment));
}
