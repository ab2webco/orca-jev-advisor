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
//
// That "never overwrites" guarantee has a cost nothing here used to surface:
// a corrected baseline never reaches an install that already imported the
// old one, silently. `mergePolicySeeds` now also reports which shared ids
// genuinely differ (`differing`), so a caller can show the person what
// changed and let them choose. `applyPolicySeedChoices` is the only function
// in this module -- or anywhere in core -- that can replace a stored row,
// and it only ever does so for ids the caller explicitly names.

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

/** The fields `mergePolicySeeds` compares between an existing row and the
 *  seed's version of the same id, in the order it checks them. */
export type PolicySeedDifferenceField = "rule" | "kind" | "destinations";

/** One id present on both sides whose content genuinely differs -- reported
 *  so a caller can offer it for review, never applied automatically. */
export interface PolicySeedDifference {
  readonly id: string;
  readonly existing: PolicySeedLike;
  readonly seed: PolicySeedLike;
  readonly fields: readonly PolicySeedDifferenceField[];
}

export interface PolicySeedMergeResult {
  readonly merged: readonly PolicySeedLike[];
  readonly added: number;
  readonly skipped: number;
  readonly differing: readonly PolicySeedDifference[];
}

// An absent `destinations` and an empty array both mean "no destination
// restriction", so they must compare equal to each other. Sorting a copy
// before comparing makes the check order-insensitive while still keying off
// every element (membership and count), which a naive Set comparison would
// blur for a duplicated entry.
function normalizedDestinations(row: PolicySeedLike): readonly string[] {
  return [...(row.destinations ?? [])].sort();
}

function destinationsDiffer(a: PolicySeedLike, b: PolicySeedLike): boolean {
  const left = normalizedDestinations(a);
  const right = normalizedDestinations(b);
  if (left.length !== right.length) return true;
  return left.some((value, index) => value !== right[index]);
}

function differingFields(
  existingRow: PolicySeedLike,
  seed: PolicySeedLike,
): readonly PolicySeedDifferenceField[] {
  const fields: PolicySeedDifferenceField[] = [];
  if (existingRow.rule !== seed.rule) fields.push("rule");
  if (existingRow.kind !== seed.kind) fields.push("kind");
  if (destinationsDiffer(existingRow, seed)) fields.push("destinations");
  return fields;
}

export function mergePolicySeeds(
  existing: readonly PolicySeedLike[],
  seeds: readonly PolicySeedLike[],
): PolicySeedMergeResult {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  const additions = seeds.filter((seed) => !existingById.has(seed.id));

  const differing: PolicySeedDifference[] = [];
  for (const seed of seeds) {
    const existingRow = existingById.get(seed.id);
    if (existingRow === undefined) continue;
    const fields = differingFields(existingRow, seed);
    if (fields.length > 0) {
      differing.push({ id: seed.id, existing: existingRow, seed, fields });
    }
  }
  differing.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    merged: [...existing, ...additions],
    added: additions.length,
    skipped: seeds.length - additions.length,
    differing,
  };
}

export interface PolicySeedApplyResult {
  readonly result: readonly PolicySeedLike[];
  readonly replaced: number;
}

/**
 * The only path that can overwrite a stored policy row. It replaces, in
 * place and preserving list order, only the rows whose id is both in
 * `acceptedIds` and present in `seeds` -- an id from a stale panel selection
 * that no longer exists on either side is ignored rather than throwing, and
 * a duplicated id in `acceptedIds` is applied once. There is no "accept all"
 * default here or anywhere else in core: the caller must pass explicit ids
 * for anything to change.
 */
export function applyPolicySeedChoices(
  existing: readonly PolicySeedLike[],
  seeds: readonly PolicySeedLike[],
  acceptedIds: readonly string[],
): PolicySeedApplyResult {
  const acceptedSet = new Set(acceptedIds);
  const seedsById = new Map(seeds.map((seed) => [seed.id, seed] as const));
  let replaced = 0;
  const result = existing.map((row) => {
    if (!acceptedSet.has(row.id)) return row;
    const seed = seedsById.get(row.id);
    if (seed === undefined) return row;
    replaced += 1;
    return seed;
  });
  return { result, replaced };
}
