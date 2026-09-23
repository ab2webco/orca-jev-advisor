// Validates the read-only JSON mirrors gate-bash.ts reads from disk to
// scope the command gate's decision to the matched destination's policies
// and per-destination consequence-ceiling override.
//
// `<configDir>/catalog.json` and `<configDir>/policies.json` (configDir =
// src/core/paths.ts's resolveConfigDir -- the SAME directory gate-bash.ts
// already reads its locale from) are written by
// adapters/orca/write-secret-mirror.mjs, refreshed on plugin activation
// and on every config-panel save. gate-bash.ts runs as a plain CLI hook
// with no channel into Orca's own `storage`, so this file mirror is its
// only way to see the catalog/policies at all -- same reasoning as the
// locale mirror already documented in src/core/i18n.ts.
//
// Pure and dependency-free (no fs, no network): gate-bash.ts does the
// actual reading, wrapped in its own try/catch, and hands the parsed JSON
// value here. Anything that doesn't validate is treated as "no
// catalog"/"no policies" -- NEVER thrown -- so a missing file, a
// half-written mirror, or a stale/malformed shape degrades to today's
// global-constants behavior instead of turning into a crash or an extra
// prompt. This mirrors decideAction's own fail-open philosophy in
// decisions.ts, just at the input-shape boundary instead of the
// Jev-answers boundary.
import { isArrayOf, isNumber, isRecord, isString } from '../guards.ts'
import type { MatchableDestination } from './destination_match.ts'
import { migratePolicyKind } from './decisions.ts'
import type { Policy, PolicyKind } from './decisions.ts'

/**
 * A catalog destination as read from the mirror, narrowed to only what
 * the gate needs: enough for matchDestination, plus the one optional
 * per-destination override decideGateAction can use.
 */
export interface MirroredDestination extends MatchableDestination {
  readonly autonomy?: {
    readonly consequenceCeiling?: number
  }
}

export interface MirroredCatalog {
  readonly destinations: readonly MirroredDestination[]
}

/**
 * Accepts the pre-rename Spanish spellings as well as the current ones.
 *
 * A policy stored before the rename to English is valid data that needs
 * mapping, not a row to discard. Discarding it emptied the mirror silently
 * and the gate simply found no policy that applied -- no error, no warning,
 * just a stage that stopped working.
 */
function isPolicyKind(value: unknown): value is PolicyKind {
  return migratePolicyKind(value) !== null
}

function isAutonomyOverride(value: unknown): value is { readonly consequenceCeiling?: number } {
  if (!isRecord(value)) return false
  if (!('consequenceCeiling' in value) || value.consequenceCeiling === undefined) return true
  return isNumber(value.consequenceCeiling)
}

function isMirroredDestination(value: unknown): value is MirroredDestination {
  if (!isRecord(value) || !isString(value.id) || !isString(value.worktreePath)) return false
  if ('autonomy' in value && value.autonomy !== undefined && !isAutonomyOverride(value.autonomy)) return false
  return true
}

function isMirroredCatalog(value: unknown): value is MirroredCatalog {
  return isRecord(value) && isArrayOf(value.destinations, isMirroredDestination)
}

/**
 * Validates an already-`JSON.parse`d catalog mirror. Deliberately
 * all-or-nothing over `destinations` (one malformed row invalidates the
 * whole catalog) -- matching store.ts's real `getCatalog`/`isCatalogData`,
 * which validates the same way for the same field, not a stricter or
 * looser choice made independently here. Returns null for anything that
 * doesn't match; gate-bash.ts treats null exactly like a missing or
 * unreadable file.
 */
export function parseMirroredCatalog(value: unknown): MirroredCatalog | null {
  return isMirroredCatalog(value) ? value : null
}

function isMirroredPolicy(value: unknown): value is Policy {
  if (!isRecord(value) || !isString(value.id) || !isString(value.rule) || !isPolicyKind(value.kind)) return false
  if ('destinations' in value && value.destinations !== undefined && !isArrayOf(value.destinations, isString)) return false
  return true
}

/**
 * Validates an already-`JSON.parse`d policies mirror (a flat array, same
 * shape store.ts's `getPolicies` returns). Row-by-row tolerant, not
 * all-or-nothing -- again matching store.ts's real `getPolicies`, which
 * documents exactly why: one row missing/holding an invalid `kind` must
 * never silently disable every OTHER policy the user configured. Returns
 * null only when the top-level value isn't an array at all.
 */
export function parseMirroredPolicies(value: unknown): readonly Policy[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(isMirroredPolicy)
}
