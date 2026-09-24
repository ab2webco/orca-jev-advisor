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
 * @param {{ id: string, label: string, kind: string, worktreePath: string,
 *   terminalTitleMatch: string, actThreshold: number,
 *   confirmThreshold: number, maxAutoDelicateness: number }} fields
 * @returns {Record<string, unknown>}
 */
export function buildDestinationRow(fields) {
  const row = {
    id: fields.id,
    label: fields.label,
    kind: fields.kind,
    worktreePath: fields.worktreePath,
    autonomy: {
      actThreshold: fields.actThreshold,
      confirmThreshold: fields.confirmThreshold,
      maxAutoDelicateness: fields.maxAutoDelicateness,
    },
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
