// Merges the plugin's shipped baseline policies (seed/policies.json) into a
// developer's already-stored policy list, without ever overwriting an id
// they already have.
//
// Why this exists: `loadPolicies` (src/core/policies.ts) already knows how
// to read and validate the seed file, but nothing could bring it IN --
// main.mjs's mirrorCatalogAndPolicies only ever mirrors the developer's own
// policies OUT to gate-bash.ts's JSON file, so every fresh install starts
// with an empty policy list and no way to adopt the shared baseline this
// repo already carries.
//
// Merge-only, by id: an id already present -- however that row looks,
// complete or not -- is left exactly as it is; only genuinely new ids are
// added. Losing a policy a person already edited would be far worse than
// not having this feature at all, so this never replaces, reorders or drops
// an existing row, including one left incomplete (a blank/invalid `kind` --
// see store.ts's own getPolicies for why that row is meaningful and kept,
// not silently discarded, until a human picks its kind).
//
// Pure: takes the two already-parsed arrays and returns the merge result.
// Reading the seed file and the stored value, and writing the merged result
// back, belongs to the caller (main.mjs's cmdImportPolicySeeds).

/**
 * The only shape this module needs from a policy-like row: enough to match
 * by id and carry the rest through untouched. Deliberately looser than
 * store.ts's own `PolicyRow` (whose `kind` must already be one of the three
 * valid values) -- a row already in storage can be incomplete, and this
 * function must never reject or drop it for that.
 */
export interface PolicySeedLike {
  readonly id: string;
  readonly rule: string;
  readonly kind: string;
  readonly destinations?: readonly string[];
}

export interface PolicySeedMergeResult {
  readonly merged: readonly PolicySeedLike[];
  readonly added: number;
  readonly skipped: number;
}

export function mergePolicySeeds(
  existing: readonly PolicySeedLike[],
  seeds: readonly PolicySeedLike[],
): PolicySeedMergeResult {
  const existingIds = new Set(existing.map((row) => row.id));
  const additions = seeds.filter((seed) => !existingIds.has(seed.id));
  return {
    merged: [...existing, ...additions],
    added: additions.length,
    skipped: seeds.length - additions.length,
  };
}
