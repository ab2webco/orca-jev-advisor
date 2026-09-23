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
// stripping leading `VAR=value` assignments -- is itself obviously safe.
// Splitting and assignment-stripping reuse gate_measurement.ts's own
// `splitSegments`/`stripAssignments`, not a second implementation of the
// same thing. Anything that can't be confidently classified is NOT safe:
// an unclassifiable command only costs latency (it falls through to the
// existing NEVER_SILENTLY/Jev path), it never causes a wrong "safe".
import { commandFamily, splitSegments } from './gate_measurement.ts'

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
  /^(ls|pwd|cat|head|tail|wc|which|echo|date|whoami|env)\b/,
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
 * `splitSegments` only splits on `&&`/`||`/`;`/`|`, never on redirection --
 * so `echo x > /etc/passwd` or `cat a > b` stays ONE segment that still
 * starts with a safe verb. Any `<`/`>` in a segment means it can write to,
 * or read from, a file outside its own arguments, so it is never obviously
 * safe -- it just falls through to the existing path, same as any other
 * unclassifiable command.
 */
function hasRedirection(segment: string): boolean {
  return /[<>]/.test(segment)
}

function isSafeSegment(segment: string): boolean {
  if (hasRedirection(segment)) return false
  if (isSafeFindSegment(segment)) return true
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
