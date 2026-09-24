// Pure decision behind adapters/claude/gate-bash.ts's "no API key" one-time
// warning -- the same shape as that file's existing AUTH_WARNED_PATH marker
// for a 401/403 rejection, applied to the other way Jev goes quiet: no key
// configured at all.
//
// Extracted for the same reason gate_safe_command.ts is: gate-bash.ts ends
// in a top-level `await main()`, so importing anything from it runs the
// whole hook (stdin, secrets, maybe a network call). A pure module lets a
// test exercise the warn-once/reset rule with no filesystem, no process, no
// network.
//
// Fail-open stays intact: a missing key must never block or delay a
// command. What this fixes is that the disarmed state was invisible -- a
// plugin whose whole purpose is judging commands, quietly judging nothing,
// forever, with the local (no-key-needed) rules still running to mask it.
// The fix is a warning shown exactly once per absence, never on every
// command, and reset as soon as a key is seen again so a LATER absence
// still earns a fresh warning instead of the marker going stale forever.

export interface NoKeyNoticeDecision {
  /** True when gate-bash.ts should emit the one-time "Jev isn't judging anything" notice this call. */
  readonly shouldWarn: boolean;
  /** The value gate-bash.ts should persist to its warned-marker file after this call. */
  readonly nextWarned: boolean;
}

/**
 * `hasKey` is whether resolveApiKey() resolved a key just now. `warned` is
 * the marker's last persisted value (false when the marker file is
 * missing, unreadable or malformed -- same fail-open default the existing
 * AUTH_WARNED_PATH reader already uses).
 */
export function decideNoKeyNotice(hasKey: boolean, warned: boolean): NoKeyNoticeDecision {
  if (hasKey) return { shouldWarn: false, nextWarned: false };
  if (warned) return { shouldWarn: false, nextWarned: true };
  return { shouldWarn: true, nextWarned: true };
}
