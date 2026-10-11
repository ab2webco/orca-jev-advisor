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
// One narrow exception to "never changed without a choice" (0.6.29):
// upgradeLegacySimpleDefault. A stored Haiku 4.5 row that is still, field by
// field, the row every earlier release shipped is a default nobody chose, and
// leaving it would keep the simple tier on a model ten times dearer than its
// successor. Anything the person edited, added or switched is theirs and
// stays.
//
// Pure: the worker reads the seed file and storage and writes the result.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
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

export type ModelSeedField =
  | "provider"
  | "label"
  | "rank"
  | "agentModel"
  | "source"
  | "summary"
  | "tier"
  | "prices"
  | "supportsEffort"
  | "contextWindow"
  | "thinkingReadsFrom"
  | "defaultEffort"
  | "retiresNotBefore";

const COMPARED_FIELDS: readonly ModelSeedField[] = [
  "provider",
  "label",
  "rank",
  "agentModel",
  "source",
  "summary",
  "tier",
  "prices",
  "supportsEffort",
  "contextWindow",
  "thinkingReadsFrom",
  "defaultEffort",
  "retiresNotBefore",
];

/** Field values are primitives, a prices record or an id list: compared by content, key order aside. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
  }
  return a === b;
}

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
    const fields = COMPARED_FIELDS.filter((field) => !sameValue(current[field], seed[field]));
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

// ---------------------------------------------------------------------------
// The old default simple-tier model (0.6.29)
// ---------------------------------------------------------------------------

/** The Haiku 4.5 row every baseline up to version 2 shipped, exactly. */
export const LEGACY_SIMPLE_DEFAULT: ModelEntry = {
  id: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  label: "Claude Haiku 4.5",
  rank: 4,
  agentModel: "haiku",
  summary: "The fastest model with near-frontier intelligence",
  source: "https://platform.claude.com/docs/en/about-claude/models/overview",
  available: true,
  tier: "simple",
  prices: { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 },
  supportsEffort: false,
  contextWindow: 200_000,
  retiresNotBefore: "2026-10-15",
};

const SIMPLE_SUCCESSOR_ID = "claude-haiku-5-5";

/**
 * The catalog with the old default simple-tier model replaced by its
 * successor, or null when there is nothing to do. It applies only to an
 * install whose Haiku 4.5 row still equals LEGACY_SIMPLE_DEFAULT on every
 * compared field (`available` aside: it is the person's and is carried over
 * to the successor), that has no Haiku 5.5 row yet, and where no other model
 * holds the simple tier. The old row stays, unranked and without a tier, so
 * the person can place it again; the successor is the shipped row.
 */
export function upgradeLegacySimpleDefault(existing: readonly ModelEntry[], shipped: readonly ModelEntry[]): readonly ModelEntry[] | null {
  const old = existing.find((row) => row.id === LEGACY_SIMPLE_DEFAULT.id);
  const successor = shipped.find((row) => row.id === SIMPLE_SUCCESSOR_ID);
  if (old === undefined || successor === undefined || existing.some((row) => row.id === SIMPLE_SUCCESSOR_ID)) return null;
  if (existing.some((row) => row.tier === "simple" && row.id !== old.id)) return null;
  if (COMPARED_FIELDS.some((field) => !sameValue(old[field], LEGACY_SIMPLE_DEFAULT[field]))) return null;
  const { tier: _tier, ...rest } = old;
  void _tier;
  const demoted: ModelEntry = { ...rest, rank: null };
  return [...existing.map((row) => (row === old ? demoted : row)), { ...successor, available: old.available }];
}
