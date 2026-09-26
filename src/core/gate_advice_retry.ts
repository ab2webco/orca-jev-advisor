// Pure state for the advice mechanism's retry pass (the advise-model
// release): adapters/claude/gate-bash.ts's own small JSON file in the cache
// dir, keyed by sha256(session_id + NUL + command).
//
// Product rule (odd/tasks, 10-escenarios-reales-y-decision.md): when Jev sees
// risk, the gate no longer stops a PERSON -- it hands the coding MODEL a
// concrete reason and lets it decide. An identical retry -- the SAME
// session_id, the SAME exact command, within the window below -- passes,
// so the model can act on its own judgment (or the user's explicit request)
// without paying for a second Jev call. A missing session_id means no retry
// pass at all (conservative): see gate-bash.ts's own caller, which only
// looks this up when a real session_id was present on the hook's stdin.
//
// Extracted as its own pure module for the same reason gate_cache.ts is:
// adapters/claude/gate-bash.ts ends in a top-level `await main()`, so
// importing anything from it runs the whole hook. A pure module lets a test
// exercise the expiry/validation rule with no filesystem, no process, no
// clock beyond an injected `now`.

import { createHash } from "node:crypto";

/**
 * How long an advice's retry pass stays open: 10 minutes, the exact window
 * validated live in the advice experiment (report.md, 30 real `claude -p`
 * sessions) -- long enough for the coding model to decide and, when the user
 * really did ask for the risky action, retry within the same turn or two;
 * short enough that a retry hours later is judged fresh again rather than
 * riding a stale decision.
 */
export const ADVICE_RETRY_WINDOW_MS = 10 * 60 * 1000;

/**
 * The retry-state key for one (session, command) pair. A NUL separator
 * between the two keeps `adviceRetryKey("s1", "2x")` from ever colliding
 * with `adviceRetryKey("s12", "x")` -- string concatenation alone cannot
 * tell those apart, and sha256 has no notion of "where one field ends".
 */
export function adviceRetryKey(sessionId: string, command: string): string {
  return createHash("sha256").update(`${sessionId}\u0000${command}`).digest("hex");
}

/** Strictly less-than the window, same discipline as gate_cache.ts's isFreshGateCacheEntry: an entry exactly at the boundary is already stale, never fresh. */
export function isAdviceRetryFresh(advisedAt: number, now: number): boolean {
  return now - advisedAt < ADVICE_RETRY_WINDOW_MS;
}

export interface PrunedAdviceRetryState {
  readonly fresh: Readonly<Record<string, number>>;
  /** True when at least one entry was dropped -- expired, or shaped wrong -- so the caller knows whether the pruned result is worth persisting. */
  readonly changed: boolean;
}

/**
 * Keeps only fresh, well-shaped (a finite number timestamp) entries from a
 * raw parsed state object. Never throws: a non-object payload, a malformed
 * entry (not a finite number) or an expired one is silently dropped, same
 * fail-open discipline as gate_cache.ts's pruneGateCache -- a corrupt retry
 * state is never a reason to block anything, it is just an empty retry
 * window (every retry re-advises, which is the conservative default anyway).
 */
export function pruneAdviceRetryState(raw: unknown, now: number = Date.now()): PrunedAdviceRetryState {
  const fresh: Record<string, number> = {};
  let changed = false;
  if (typeof raw !== "object" || raw === null) return { fresh, changed: true };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && isAdviceRetryFresh(value, now)) {
      fresh[key] = value;
    } else {
      changed = true;
    }
  }
  return { fresh, changed };
}
