/**
 * Pure, testable logic shared by both panels (config.html, board.html) for
 * deciding whether a live Orca worker is behind the numbers they show.
 *
 * Both panels are single-file HTML with inline ES5-style JS, sandboxed in an
 * opaque-origin iframe with no module graph and no bundler reaching them
 * (see the plugin's manifest and odd/tasks/panel-worker-wakeup.md) -- so
 * this file cannot be imported by them at runtime. Its functions are
 * hand-copied into each panel's inline <script>, verbatim, converted to
 * ES5 `var`/`function` syntax; this file's only job is to be the one place
 * that logic is unit-tested by `node --test`. Whenever a copy changes,
 * mirror the change in the other two places -- `grep -n` for the function
 * name across both panels and this file is how to check they still agree.
 */

/**
 * Whether a heartbeat object `{ at: <ISO string> }` published by the Orca
 * worker (see main.mjs's WORKER_HEARTBEAT_KEY) is recent enough to treat the
 * worker as alive right now.
 *
 * @param {unknown} heartbeat  Whatever storage.get returned for the
 *   heartbeat key -- untrusted: may be null, a stale shape, or garbage.
 * @param {number} nowMs
 * @param {number} staleAfterMs
 * @returns {boolean}
 */
export function isHeartbeatFresh (heartbeat, nowMs, staleAfterMs) {
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat) || typeof heartbeat.at !== 'string') {
    return false
  }
  const at = Date.parse(heartbeat.at)
  if (Number.isNaN(at)) return false
  const age = nowMs - at
  return age >= 0 && age <= staleAfterMs
}

/**
 * A redacted stand-in a panel writes over its own pending secret request
 * when it gives up waiting for a result (see attendSecretRequest's
 * `tombstone` check in main.mjs). Carries no `intent` and no `value`, so
 * even a worker that wakes later and reads this key cannot mistake it for a
 * live request -- main.mjs checks the same `tombstone` flag before ever
 * looking at `intent`.
 *
 * @param {string} id  The abandoned request's own id, kept only for
 *   traceability in logs -- nothing keys off it once tombstoned.
 * @param {string} atIso
 */
export function buildSecretTombstone (id, atIso) {
  return { id, at: atIso, tombstone: true }
}
