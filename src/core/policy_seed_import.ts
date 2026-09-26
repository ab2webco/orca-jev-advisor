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
 * function must never reject or drop it for that. Same reasoning for
 * `scope`: a stored row's `scope` string is not re-validated here, only
 * compared through resolvePolicyScope, which already treats anything other
 * than a real PolicyScope value as "absent" (see that function's own doc).
 */
import { buildSeedScopeIndex, migratePolicyKind, resolvePolicyScope } from "./decisions.ts";
import type { PolicyScope } from "./decisions.ts";

export interface PolicySeedLike {
  readonly id: string;
  readonly rule: string;
  readonly kind: string;
  readonly destinations?: readonly string[];
  readonly scope?: PolicyScope;
}

/** The fields `mergePolicySeeds` compares between an existing row and the
 *  seed's version of the same id, in the order it checks them. */
export type PolicySeedDifferenceField = "rule" | "kind" | "destinations" | "scope";

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

/**
 * Compares `kind` by what it MEANS, not by its raw stored string.
 *
 * A row saved before the rename to English still carries the legacy Spanish
 * enum (`permite`/`prohibe`/`pregunta`) -- migratePolicyKind (decisions.ts)
 * is the exact same mapping interpretDestinationPolicy already applies at
 * decision time, so a stored `prohibe` and a shipped `prohibits` already
 * mean the same thing and must not be reported as differing. This was the
 * whole T6 defect: comparing the raw strings reported "20 differing" on an
 * install that had migrated nothing but its own reading of the seed, when
 * 17 of those were functionally identical. A kind that fails to normalize
 * on either side (blank, or genuinely unrecognised) never equals a kind that
 * does -- that IS a real difference, same as `interpretDestinationPolicy`
 * treating an unrecognised kind as "no policy applies" rather than a match.
 */
function kindsDiffer(a: PolicySeedLike, b: PolicySeedLike): boolean {
  return migratePolicyKind(a.kind) !== migratePolicyKind(b.kind);
}

/**
 * Compares `scope` by its EFFECTIVE (resolved) value, not by whether the
 * field is present -- same reasoning as kindsDiffer above, applied to the
 * field T2 just added.
 *
 * resolvePolicyScope's own default rule (decisions.ts) is precisely "a row
 * missing `scope` resolves to the seed's own scope for that id, or
 * `command` when the seed doesn't know it either" -- so a stored row that
 * simply never mentioned `scope` ALWAYS resolves to the exact same value its
 * seed counterpart resolves to (both look the same id up in the same
 * `seedScopeById`, and a seed row with no explicit scope of its own
 * contributes no entry, so an absent field on either side always reads as
 * "command" for both). Comparing the raw fields instead would have
 * reproduced the exact bug T2 fixed, one field later: every install that
 * already had `visual_evidence` stored (with no `scope`, since the field
 * did not exist yet) would see `scope` reported as differing the moment the
 * seed marked it `process`, even though nothing about what the gate DOES
 * with that row actually changed. Only a row that carries its OWN explicit,
 * conflicting `scope` -- a real, deliberate opt-out -- is a genuine
 * difference worth surfacing.
 */
function scopesDiffer(existingRow: PolicySeedLike, seed: PolicySeedLike, seedScopeById: ReadonlyMap<string, PolicyScope>): boolean {
  return resolvePolicyScope(existingRow, seedScopeById) !== resolvePolicyScope(seed, seedScopeById);
}

function differingFields(
  existingRow: PolicySeedLike,
  seed: PolicySeedLike,
  seedScopeById: ReadonlyMap<string, PolicyScope>,
): readonly PolicySeedDifferenceField[] {
  const fields: PolicySeedDifferenceField[] = [];
  if (existingRow.rule !== seed.rule) fields.push("rule");
  if (kindsDiffer(existingRow, seed)) fields.push("kind");
  if (destinationsDiffer(existingRow, seed)) fields.push("destinations");
  if (scopesDiffer(existingRow, seed, seedScopeById)) fields.push("scope");
  return fields;
}

export function mergePolicySeeds(
  existing: readonly PolicySeedLike[],
  seeds: readonly PolicySeedLike[],
): PolicySeedMergeResult {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  const additions = seeds.filter((seed) => !existingById.has(seed.id));
  // Built from THIS seed list, once, and reused for every row: the whole
  // point of comparing by resolved value is that a stored row and its seed
  // counterpart resolve their scope against the SAME index.
  const seedScopeById = buildSeedScopeIndex(seeds);

  const differing: PolicySeedDifference[] = [];
  for (const seed of seeds) {
    const existingRow = existingById.get(seed.id);
    if (existingRow === undefined) continue;
    const fields = differingFields(existingRow, seed, seedScopeById);
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
export interface PolicySeedImportResolution {
  /** The policies to store -- `merged` with the accepted subset replaced,
   *  same shape applyPolicySeedChoices already returns as `result`. */
  readonly policies: readonly PolicySeedLike[];
  readonly added: number;
  readonly skipped: number;
  readonly replaced: number;
  /** Ids still genuinely differing after this apply -- never the ORIGINAL
   *  pre-apply list. An id just accepted now matches the seed exactly and
   *  drops out; an id left unticked (or named in `acceptedIds` but stale)
   *  stays, so a caller can offer it again on the very next round. */
  readonly remaining: readonly PolicySeedDifference[];
  /** True only when `remaining` is empty -- nothing about the shipped
   *  baseline is left for this install to see. `added` can never be the
   *  reason this is false: additions are always merged into `policies`
   *  above regardless of `acceptedIds` (mergePolicySeeds's own contract), so
   *  a fresh comparison of `policies` against `seeds` can never report a
   *  missing id, only a differing one. */
  readonly settled: boolean;
}

/**
 * The one question cmdImportPolicySeeds (main.mjs) needs answered that
 * neither mergePolicySeeds nor applyPolicySeedChoices alone can: after
 * applying whatever the caller explicitly accepted, is anything about the
 * shipped baseline still left unresolved for this install?
 *
 * This is what makes JEVADV-27's fix possible without duplicating the merge
 * logic in main.mjs: the caller used to bump its own "offered this version"
 * marker unconditionally on every import, which silenced the notice the
 * moment additions landed even if a differing row nobody ticked was still
 * sitting there, unresolved, forever (the offered marker is never lowered).
 * `settled` is the caller's single, correct condition for whether marking
 * the shipped version as offered is honest.
 */
export function resolvePolicySeedImport(
  existing: readonly PolicySeedLike[],
  seeds: readonly PolicySeedLike[],
  acceptedIds: readonly string[],
): PolicySeedImportResolution {
  const merge = mergePolicySeeds(existing, seeds);
  const { result: policies, replaced } = applyPolicySeedChoices(merge.merged, seeds, acceptedIds);
  const remaining = mergePolicySeeds(policies, seeds).differing;
  return {
    policies,
    added: merge.added,
    skipped: merge.skipped,
    replaced,
    remaining,
    settled: remaining.length === 0,
  };
}

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
