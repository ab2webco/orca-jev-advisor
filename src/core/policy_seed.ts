// ---------------------------------------------------------------------------
// Planting the shipped policies on a machine that has none.
//
// `seed/policies.json` has shipped inside this plugin since the beginning and
// nothing has ever read it. The catalog got a bootstrap of its own
// (deriveInitialCatalogIfEmpty, from `orca worktree ps`); the policies got
// none, and DEFAULT_POLICIES is the empty array. So every install started --
// and stayed -- with zero policies unless the developer retyped every row by
// hand, which nobody does. The gate still worked, because an empty policy
// stage simply falls through to the risk-based fallback, and that is exactly
// why the hole went unseen: nothing broke, the judgments were just
// consistently less informed than the shipped defaults intended.
//
// Two rules shape what follows, and both are about not overwriting a person:
//
//   1. Seeding happens AT MOST ONCE per install, recorded by its own marker
//      key rather than inferred from the list being empty. A developer who
//      deletes every policy on purpose has expressed a preference, and an
//      emptiness check would read that preference as "fresh machine" and
//      resurrect every shipped row on the next activation -- including ten
//      `prohibits` rows, which would change what the gate refuses. Deciding
//      from a marker is what keeps an empty list a legitimate resting state.
//   2. A machine that already holds policies is never touched, marker or not.
//      That is the upgrade path: this code ships to installs whose owners
//      wrote their own rules long ago, and those must survive it untouched.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { withNormalizedPolicyScope } from "./decisions.ts";
import { isPolicyRow, type PolicyRow } from "./store.ts";

/** Records that the shipped policies have been offered to this install once. */
export const POLICY_SEED_MARKER_KEY = "policiesSeeded";

/**
 * The rows inside a seed payload, tolerating both shapes this file has ever
 * shipped as: the original bare array, and the versioned
 * `{ version, policies }` object added so an install can be told when the
 * baseline changes (see parseSeedVersion below, and policy_seed_notice.ts
 * for what reads the two together). Anything else -- not an array, and not
 * an object with a `policies` array -- yields no rows rather than throwing;
 * parseSeedPolicies' row-by-row tolerance starts from whatever this returns.
 */
function seedRowsOf(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.policies)) return payload.policies;
  return [];
}

/**
 * Keeps only the rows that are valid policies.
 *
 * Row by row, never all-or-nothing: the same choice getPolicies makes and for
 * the same reason. One malformed row in a hand-edited seed should cost that
 * row, not the other rows around it.
 *
 * isPolicyRow (store.ts) is deliberately silent on `scope`'s VALUE -- only
 * its presence matters there -- so a row with a typo'd or unrecognised
 * `scope` still survives that filter. withNormalizedPolicyScope
 * (decisions.ts) is what turns that into ABSENT rather than letting it leak
 * through as though it satisfied PolicyScope: store.ts's getPolicies and
 * gate_catalog_mirror.ts's parseMirroredPolicies already normalize this way,
 * and buildSeedScopeIndex's own map is only as honest as the rows it is
 * built from (odd/tasks/release-0.5.1.md JEVADV-36).
 */
export function parseSeedPolicies(payload: unknown): readonly PolicyRow[] {
  return seedRowsOf(payload).filter(isPolicyRow).map(withNormalizedPolicyScope);
}

/**
 * The shipped baseline's hand-bumped integer version, read from the same
 * payload seedRowsOf reads its rows from.
 *
 * The original bare-array shape (and anything malformed: not an object, a
 * missing `version`, a non-integer, a negative one) has no version at all --
 * rather than guessing, this reports 0, which is deliberately lower than any
 * real shipped version. That is what makes an install that has only ever
 * seen the pre-version seed (or none at all) read as "never offered
 * anything" to policy_seed_notice.ts's decidePolicySeedNotice, so it is told
 * about the baseline the very first time this code runs on it.
 */
export function parseSeedVersion(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const version = payload.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/**
 * Whether the shipped policies should be planted now.
 *
 * `marker` is whatever sits at {@link POLICY_SEED_MARKER_KEY} and `stored` is
 * the raw policies value, both straight from storage and both therefore
 * `unknown` -- a storage read can return anything, including the `undefined`
 * of a key that was never written.
 */
export function shouldSeedPolicies(marker: unknown, stored: unknown): boolean {
  // Any marker at all means this install has already been offered the seed.
  // Its shape is deliberately not inspected: a marker written by a future
  // version, or corrupted, still answers the only question asked here, and
  // treating an unrecognised one as "never seeded" would re-plant the rows
  // this rule exists to protect.
  if (marker !== undefined && marker !== null) return false;
  // An install with anything stored keeps it, whatever shape it is in.
  //
  // Deliberately `length > 0` and NOT `some(isPolicyRow)`. A row that fails
  // validation today is still something a person wrote: store.ts preserves
  // exactly those rows on purpose (see getPolicies' note -- before `kind`
  // existed, EVERY row lacked it) and the config panel keeps showing them,
  // id and rule intact, until a human picks the missing kind. Deciding from
  // the validator here would read that half-migrated list as an empty machine
  // and replace the person's rules with the shipped ones. Emptiness is a fact
  // about the array, not about what the gate can currently judge with.
  if (Array.isArray(stored) && stored.length > 0) return false;
  return true;
}
