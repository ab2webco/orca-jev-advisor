/**
 * Pure, testable logic for adapters/orca/panels/config.html's own "shape a
 * row, then send it to storage.set" step -- same "hand-copied into the
 * panel's inline <script>, verbatim, converted to ES5 var/function syntax"
 * contract as worker-status.mjs (see that file's own module comment for why
 * this cannot be imported by the panel at runtime: a single-file sandboxed
 * HTML document, no module graph, no bundler reaching it). Whenever a copy
 * changes, mirror the change in config.html -- `grep -n stripUndefinedValues`
 * (or buildDestinationRow/buildPolicyRow) across both files is how to check
 * they still agree.
 *
 * The defect this closes: config.html's postMessage bridge to Orca uses the
 * structured clone algorithm, not JSON.stringify. An object property
 * explicitly set to `undefined` SURVIVES structured clone (the key stays,
 * the value is `undefined`), where JSON.stringify would have quietly
 * dropped it:
 *
 *   structuredClone({t: undefined})  -> key present, value undefined
 *   JSON.stringify({t: undefined})   -> key dropped
 *
 * Orca's own `storage.set` validates its `value` param with `z.json()` (a
 * JSON-compatible value), which refuses a plain `undefined` anywhere in the
 * object graph. config.html's own `entry._read` closures used to write
 * `terminalTitleMatch: field.value.trim() || undefined` (and the same shape
 * for a policy row's `kind`/`destinations`) -- so the destination-catalog
 * and policy saves were refused for EVERY developer who had not typed
 * something into every optional field of every row: 20 of 20 destinations
 * on the reporting developer's real catalog had this happen.
 */

/**
 * Deep copy of `value` with every object key whose value is `undefined`
 * removed -- recursing into nested objects and arrays, so a value built
 * anywhere in this panel (not only the two call sites that caused this
 * defect) is safe to hand to `write`/`writeBackground`. Never mutates its
 * input. Only `undefined` itself is ever removed -- a falsy-but-real value
 * like `0`, `''`, `false` or `null` is left exactly as it was.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripUndefinedValues(value) {
  if (Array.isArray(value)) return value.map(stripUndefinedValues);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined) continue;
      result[key] = stripUndefinedValues(v);
    }
    return result;
  }
  return value;
}

/**
 * Shapes one destination-catalog row from its raw field values, fixed at
 * the source: `terminalTitleMatch` is omitted entirely when blank, never
 * set to `undefined`. Mirrors config.html's addCatalogRow's `entry._read`.
 *
 * `autonomy` used to also carry `actThreshold`/`confirmThreshold`/
 * `maxAutoDelicateness`, seeded by a bare literal next to the widget
 * (`{ actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2 }`)
 * every new row got. Traced and removed: no decision anywhere reads them
 * (see `src/core/store.ts`'s own note on `AutonomyConfig`), so `autonomy`
 * is an empty object here -- there is no panel control left for
 * `consequenceCeiling` (`AutonomyConfig`'s one surviving field) either; it
 * can only be set today by editing the catalog file directly.
 *
 * @param {{ id: string, label: string, kind: string, worktreePath: string,
 *   terminalTitleMatch: string }} fields
 * @returns {Record<string, unknown>}
 */
export function buildDestinationRow(fields) {
  const row = {
    id: fields.id,
    label: fields.label,
    kind: fields.kind,
    worktreePath: fields.worktreePath,
    autonomy: {},
  };
  if (fields.terminalTitleMatch) row.terminalTitleMatch = fields.terminalTitleMatch;
  return row;
}

/**
 * Shapes one policy row from its raw field values, fixed at the source:
 * `kind` and `destinations` are each omitted entirely when unset, the same
 * "empty means unset" convention config.html's own comment already
 * documents (the `''` sentinel for "nobody has chosen a kind yet"; an empty
 * scope means "applies globally"). Mirrors config.html's addPolicyRow's
 * `entry._read`.
 *
 * @param {{ id: string, rule: string, kind: string, destinations: readonly string[] }} fields
 * @returns {Record<string, unknown>}
 */
export function buildPolicyRow(fields) {
  const row = {
    id: fields.id,
    rule: fields.rule,
  };
  if (fields.kind) row.kind = fields.kind;
  if (fields.destinations.length > 0) row.destinations = fields.destinations;
  return row;
}

// ---------- board.html -------------------------------------------------------
// odd/tasks/panel-interventions-and-mod-copy.md T11. Same hand-copy contract
// as above, but into board.html: `grep -n defaultWindowKey` (or
// relativeAge/liveEntryView) across both files is how to check they agree.

/**
 * Which window the board opens on. The current plugin version first, since
 * an accumulated count mixes rule semantics across releases; the last 7 days
 * while no record carries a version yet (read-measurements.mjs marks that
 * window `available: false`); all time when the last 7 days are empty but
 * older decisions exist. An empty log opens on all time, which is empty too
 * and renders the board's empty state.
 *
 * @param {Record<string, { available: boolean, totalDecisions: number }> | null | undefined} windows
 * @returns {'version' | 'week' | 'all'}
 */
export function defaultWindowKey(windows) {
  if (!windows) return "all";
  const order = ["version", "week", "all"];
  for (const key of order) {
    const w = windows[key];
    if (w && w.available && w.totalDecisions > 0) return key;
  }
  return "all";
}

/**
 * How long ago `iso` was, in whole units rounded down, for a "4 min ago"
 * label. A timestamp up to a minute old -- or slightly in the future, which a
 * skewed clock produces -- is "now". Null when there is nothing to parse, so
 * the caller prints nothing rather than "NaN min ago".
 *
 * @param {string | null | undefined} iso
 * @param {number} nowMs
 * @returns {{ unit: 'now' | 'min' | 'h' | 'd', n: number } | null}
 */
export function relativeAge(iso, nowMs) {
  if (typeof iso !== "string") return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 60) return { unit: "now", n: 0 };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "min", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "h", n: hours };
  return { unit: "d", n: Math.floor(hours / 24) };
}

/**
 * What a live-status row shows. A pane key is a pair of UUIDs
 * (`1e1fff06-...:a62d09bd-...`) that tells a person nothing, so it is never a
 * label: the project and branch are the chips, and the worktree and pane ids
 * go only into the tooltip, for whoever is debugging. `name` is null when the
 * worktree could not be resolved (main.mjs leaves project/branch null then);
 * the board prints its own "unknown worktree" text for that.
 *
 * @param {{ worktreeId?: string | null, project?: string | null, rama?: string | null, paneKey?: string } | null | undefined} entry
 * @returns {{ name: string | null, branch: string | null, title: string }}
 */
export function liveEntryView(entry) {
  const e = entry || {};
  const present = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    name: present(e.project),
    branch: present(e.rama),
    title: [present(e.worktreeId), present(e.paneKey)].filter((part) => part !== null).join(" · "),
  };
}
