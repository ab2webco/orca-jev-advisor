// ---------------------------------------------------------------------------
// Planting the shipped policies on a machine that has none.
//
// `seed/policies.json` has shipped inside this plugin since the beginning and
// nothing has ever read it. The catalog got a bootstrap of its own
// (deriveInitialCatalogIfEmpty, from `orca worktree ps`); the policies got
// none, and DEFAULT_POLICIES is the empty array. So every install started --
// and stayed -- with zero policies unless the developer retyped all twenty by
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
//      resurrect all twenty on the next activation -- including three
//      `prohibits` rows, which would change what the gate refuses. Deciding
//      from a marker is what keeps an empty list a legitimate resting state.
//   2. A machine that already holds policies is never touched, marker or not.
//      That is the upgrade path: this code ships to installs whose owners
//      wrote their own rules long ago, and those must survive it untouched.
// ---------------------------------------------------------------------------

import { isPolicyRow, type PolicyRow } from "./store.ts";

/** Records that the shipped policies have been offered to this install once. */
export const POLICY_SEED_MARKER_KEY = "policiesSeeded";

/**
 * Keeps only the rows that are valid policies.
 *
 * Row by row, never all-or-nothing: the same choice getPolicies makes and for
 * the same reason. One malformed row in a hand-edited seed should cost that
 * row, not the other nineteen.
 */
export function parseSeedPolicies(payload: unknown): readonly PolicyRow[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isPolicyRow);
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
  // An install with policies already keeps them, whatever they are: even a
  // single valid row is someone's decision and outranks the defaults.
  if (Array.isArray(stored) && stored.some(isPolicyRow)) return false;
  return true;
}
