// ---------------------------------------------------------------------------
// Telling an install its baseline moved.
//
// `parseSeedPolicies`/`shouldSeedPolicies` (policy_seed.ts) only ever answer
// "should I plant the seed on a machine that has none". Nothing answered the
// other question this file exists for: a machine that already seeded or
// imported the baseline has no way to learn a LATER release corrected it --
// merge-only-by-id (mergePolicySeeds, policy_seed_import.ts) is what protects
// an edited row, and that protection is exactly why a corrected shipped row
// never reaches an install that already has that id. Silence was the cost of
// that protection; this module is what removes it, without ever touching a
// stored row itself -- see main.mjs's cmdImportPolicySeeds/
// applyPolicySeedChoices for the only path that can, and only for ids a
// person explicitly picks.
//
// Pure, like the rest of src/core: no I/O, no clock. main.mjs reads the seed
// file and storage, stamps `at` itself, and calls the two functions below.
// ---------------------------------------------------------------------------

import { mergePolicySeeds, type PolicySeedLike } from "./policy_seed_import.ts";

/**
 * The baseline version this install was last offered, read from whatever
 * sits at main.mjs's own offered-version marker key -- straight from
 * storage and therefore `unknown`, the same contract parseSeedVersion has
 * for the seed file itself.
 *
 * Absent, malformed, or negative all report 0: an install this code has
 * never run on (no marker at all) has been offered nothing, and 0 is lower
 * than any real shipped version, which is what makes decidePolicySeedNotice
 * below tell it about the baseline the first time this runs.
 */
export function parseOfferedVersion(marker: unknown): number {
  if (
    typeof marker === "object" &&
    marker !== null &&
    !Array.isArray(marker) &&
    "version" in marker
  ) {
    const version = (marker as { version: unknown }).version;
    if (typeof version === "number" && Number.isInteger(version) && version >= 0) return version;
  }
  return 0;
}

export interface PolicySeedNoticeInput {
  /** The seed file's own `version` (parseSeedVersion). */
  readonly shippedVersion: number;
  /** What this install was last offered (parseOfferedVersion). */
  readonly offeredVersion: number;
  /** This install's own stored policies, raw -- never `getPolicies`'s
   *  filtered view, for the same reason cmdImportPolicySeeds reads raw. */
  readonly existing: readonly PolicySeedLike[];
  /** The seed file's rows (parseSeedPolicies). */
  readonly shipped: readonly PolicySeedLike[];
}

export interface PolicySeedNoticeDecision {
  /** Whether the panel should show the notice. */
  readonly due: boolean;
  /** How many shipped ids this install does not have at all. */
  readonly added: number;
  /** How many ids this install already has whose content the shipped
   *  version now disagrees with. */
  readonly differing: number;
  /** Carried straight through so the panel never has to ask storage for it
   *  separately, and never sees the number itself either -- see main.mjs's
   *  module note on why the panel never learns the shipped version. */
  readonly shippedVersion: number;
}

/**
 * Whether an install should be told the shipped baseline moved, and by how
 * much -- computed, never guessed, from the same `mergePolicySeeds` the
 * import flow already uses.
 *
 * `due` only when the shipped version is genuinely newer than what this
 * install was offered AND that gap actually changes something
 * (`added + differing > 0`). A version bump with nothing for this
 * particular install to see (every id already matches) must not surface an
 * empty notice -- see main.mjs's publishPolicySeedNoticeStatus, which marks
 * the install as offered in exactly that case so the next activation does
 * not keep recomputing the same no-op merge.
 */
export function decidePolicySeedNotice(input: PolicySeedNoticeInput): PolicySeedNoticeDecision {
  const { added, differing } = mergePolicySeeds(input.existing, input.shipped);
  const differingCount = differing.length;
  const due = input.shippedVersion > input.offeredVersion && added + differingCount > 0;
  return { due, added, differing: differingCount, shippedVersion: input.shippedVersion };
}
