// Pure decision behind adapters/claude/gate-bash.ts's "Jev is unreachable"
// one-time-per-run warning -- the same shape as that file's existing
// AUTH_WARNED_PATH marker for a 401/403 rejection and gate_key_notice.ts's
// no-key marker, applied to the third way Jev goes quiet: a key that is
// present and accepted, but the backend never answers at all (network
// error, timeout, or budget exceeded -- see askJev's `{ kind: 'none' }`
// outcome in adapters/claude/gate-bash.ts).
//
// Extracted for the same reason gate_key_notice.ts is: gate-bash.ts ends in
// a top-level `await main()`, so importing anything from it runs the whole
// hook (stdin, secrets, maybe a network call). A pure module lets a test
// exercise the warn-after-N-failures/reset rule with no filesystem, no
// process, no network.
//
// Fail-open stays intact: an unreachable backend must never block or delay
// a command. What this fixes is that the disarmed state was invisible -- a
// gate-decisions.jsonl log kept filling with `cache` and `local-rule` rows,
// looking healthy, while the Jev-backed half of the gate silently judged
// nothing.
//
// This one warns after a THRESHOLD of consecutive failures rather than on
// the very first one, unlike decideNoKeyNotice: a single dropped request is
// normal network noise, not a signal the gate is disarmed. Once the warning
// has fired, it stays silent through every further failure -- repeating it
// on every command would be as useless as never warning at all -- and only
// a reached backend resets the run, so a later outage earns a fresh warning
// instead of the marker going stale forever.

export interface UnreachableNoticeDecision {
  /** True when gate-bash.ts should emit the one-time-per-run "Jev is unreachable" notice this call. */
  readonly shouldWarn: boolean;
  /** The consecutive-failure count gate-bash.ts should persist to its marker file after this call. */
  readonly nextConsecutiveFailures: number;
}

/**
 * `reached` is whether askJev got an answer back this call (a `'verdict'`
 * or an `'auth-rejected'` outcome both count as reached -- the backend
 * responded; only `{ kind: 'none' }` did not). `consecutiveFailures` is the
 * marker's last persisted value (0 when the marker file is missing,
 * unreadable or malformed -- same fail-open default the existing
 * AUTH_WARNED_PATH/NO_KEY_WARNED_PATH readers already use). `threshold` is
 * how many consecutive unreached calls must happen before the notice
 * fires; a value below 1 is treated as 1.
 */
export function decideUnreachableNotice(
  reached: boolean,
  consecutiveFailures: number,
  threshold: number,
): UnreachableNoticeDecision {
  if (reached) return { shouldWarn: false, nextConsecutiveFailures: 0 };
  const effectiveThreshold = threshold < 1 ? 1 : threshold;
  const nextConsecutiveFailures = consecutiveFailures + 1;
  return { shouldWarn: nextConsecutiveFailures === effectiveThreshold, nextConsecutiveFailures };
}
