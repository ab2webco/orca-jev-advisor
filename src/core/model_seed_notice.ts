// ---------------------------------------------------------------------------
// Seeding the model catalog once, and offering a newer shipped baseline.
//
// The same contract the team policies follow (policy_seed.ts,
// policy_seed_notice.ts, policy_seed_import.ts), for seed/models.json:
//
//   1. Planted AT MOST ONCE per install, recorded by a marker rather than
//      inferred from an empty list: a person who removed every model has made
//      a choice, and an emptiness check would undo it.
//   2. Never overwritten. When a later release ships a newer baseline
//      version, the panel is told what changed (ids this install lacks, ids
//      whose content moved) and the person picks which changes to accept.
//      applyModelSeedChoices is the only function that can change a stored
//      entry, and only for ids a person named.
//
// `available` is never compared or taken from the seed: whether a person can
// run a model is theirs to say, whatever the baseline ships.
//
// Pure: the worker reads the seed file and storage and writes the result.
// ---------------------------------------------------------------------------

import type { ModelEntry } from "./model_catalog.ts";

/** Records that the shipped models have been offered to this install once. */
export const MODEL_SEED_MARKER_KEY = "modelsSeeded";
/** Records the shipped baseline version this install was last offered. */
export const MODEL_SEED_OFFERED_VERSION_KEY = "modelsSeedOfferedVersion";

export function shouldSeedModels(marker: unknown, existing: readonly ModelEntry[]): boolean {
  return marker !== true && existing.length === 0;
}

/** The version stored at MODEL_SEED_OFFERED_VERSION_KEY; absent or malformed reads 0. */
export function parseModelOfferedVersion(marker: unknown): number {
  if (typeof marker === "object" && marker !== null && !Array.isArray(marker) && "version" in marker) {
    const version = (marker as { version: unknown }).version;
    if (typeof version === "number" && Number.isInteger(version) && version >= 0) return version;
  }
  return 0;
}

export type ModelSeedField = "provider" | "label" | "rank" | "agentModel" | "source" | "summary";

const COMPARED_FIELDS: readonly ModelSeedField[] = ["provider", "label", "rank", "agentModel", "source", "summary"];

export interface ModelSeedDifference {
  readonly id: string;
  readonly existing: ModelEntry;
  readonly seed: ModelEntry;
  readonly fields: readonly ModelSeedField[];
}

export interface ModelSeedDiff {
  /** Shipped entries this install does not have at all, in seed order. */
  readonly added: readonly ModelEntry[];
  /** Shared ids whose content differs, in seed order. */
  readonly differing: readonly ModelSeedDifference[];
}

export function diffModelSeed(existing: readonly ModelEntry[], shipped: readonly ModelEntry[]): ModelSeedDiff {
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  const added: ModelEntry[] = [];
  const differing: ModelSeedDifference[] = [];
  for (const seed of shipped) {
    const current = existingById.get(seed.id);
    if (current === undefined) {
      added.push(seed);
      continue;
    }
    const fields = COMPARED_FIELDS.filter((field) => current[field] !== seed[field]);
    if (fields.length > 0) differing.push({ id: seed.id, existing: current, seed, fields });
  }
  return { added, differing };
}

export interface ModelSeedNoticeInput {
  readonly shippedVersion: number;
  readonly offeredVersion: number;
  readonly existing: readonly ModelEntry[];
  readonly shipped: readonly ModelEntry[];
}

export interface ModelSeedNoticeDecision {
  readonly due: boolean;
  readonly added: number;
  readonly differing: number;
  readonly shippedVersion: number;
  /** Record the shipped version as offered without showing anything: it is
   *  newer, but nothing differs for this install. Never lowers the marker. */
  readonly markOffered: boolean;
}

export function decideModelSeedNotice(input: ModelSeedNoticeInput): ModelSeedNoticeDecision {
  const diff = diffModelSeed(input.existing, input.shipped);
  const newer = input.shippedVersion > input.offeredVersion;
  const nothingToTell = diff.added.length + diff.differing.length === 0;
  return {
    due: newer && !nothingToTell,
    added: diff.added.length,
    differing: diff.differing.length,
    shippedVersion: input.shippedVersion,
    markOffered: newer && nothingToTell,
  };
}

export interface ModelSeedApplyResult {
  readonly result: readonly ModelEntry[];
  readonly replaced: number;
  readonly added: number;
}

/**
 * The only path that changes a stored entry. An accepted id already stored
 * is replaced in place by the shipped entry, keeping the person's
 * `available`; an accepted id the install lacks is appended. Ids that are in
 * neither list are ignored and a repeated id applies once. No "accept all"
 * default exists: nothing changes unless ids are named.
 */
export function applyModelSeedChoices(
  existing: readonly ModelEntry[],
  shipped: readonly ModelEntry[],
  acceptedIds: readonly string[],
): ModelSeedApplyResult {
  const accepted = new Set(acceptedIds);
  const shippedById = new Map(shipped.map((row) => [row.id, row] as const));
  const existingIds = new Set(existing.map((row) => row.id));
  let replaced = 0;
  const result: ModelEntry[] = existing.map((row) => {
    const seed = accepted.has(row.id) ? shippedById.get(row.id) : undefined;
    if (seed === undefined) return row;
    replaced += 1;
    return { ...seed, available: row.available };
  });
  let added = 0;
  for (const seed of shipped) {
    if (accepted.has(seed.id) && !existingIds.has(seed.id)) {
      result.push(seed);
      added += 1;
    }
  }
  return { result, replaced, added };
}
