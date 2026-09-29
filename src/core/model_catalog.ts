// ---------------------------------------------------------------------------
// The model catalog: the ordered ladder of models a subagent may run on.
//
// Jev reclassifies the model a Claude Code subagent (`Agent` tool call) runs
// on, and it may only pick from this list. The list belongs to the person:
// it ships as a versioned baseline (seed/models.json, read by the functions
// below) exactly like the team policies, is planted once, and is never
// overwritten afterwards -- see model_seed_notice.ts for how a newer shipped
// baseline is offered instead of applied.
//
// Rank 1 is the largest / most capable model. A shipped rank always comes
// from official provider documentation, recorded per entry in `source`; an
// entry nobody documented a position for carries `rank: null` ("unranked")
// and is never chosen until the person places it.
//
// `agentModel` is the exact value written into the Agent tool's `model`
// parameter. That parameter takes an alias (`sonnet`, `opus`, `haiku`,
// `fable`) or a full model ID
// (https://code.claude.com/docs/en/sub-agents#choose-a-model), and an alias
// resolves per provider (https://code.claude.com/docs/en/model-config: on the
// Anthropic API `opus` is Opus 5.5 and `sonnet` is Sonnet 5). The seed uses
// the aliases because they are what the Agent tool's own input schema
// enumerates; the person can change it per entry.
//
// Pure, like the rest of src/core: no I/O.
// ---------------------------------------------------------------------------

import { isBoolean, isRecord, isString } from "../guards.ts";

export type RouterTier = "simple" | "standard" | "complex" | "frontier";

/** Weakest first: an index into this list is a tier's strength. */
export const ROUTER_TIERS: readonly RouterTier[] = ["simple", "standard", "complex", "frontier"];

/** List prices in $ per million tokens. `cacheWrite` is the 1-hour cache write price. */
export interface ModelPrices {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface ModelEntry {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  /** 1 = largest / most capable. null = unranked, never chosen. */
  readonly rank: number | null;
  /** The value written into the Agent tool's `model` parameter. */
  readonly agentModel: string;
  /** The official page this entry's position came from. */
  readonly source: string;
  /** Whether the person can run this model. Only available entries are chosen. */
  readonly available: boolean;
  /** The provider's own one-line description, quoted from `source`. */
  readonly summary?: string;
  /** The router tier this model serves on an Anthropic account. */
  readonly tier?: RouterTier;
  readonly prices?: ModelPrices;
  readonly supportsEffort?: boolean;
  /** Context window in tokens. */
  readonly contextWindow?: number;
  /** Model ids whose thinking blocks this model can read; absent = only its own. */
  readonly thinkingReadsFrom?: readonly string[];
  /** The API's default effort level; informational. */
  readonly defaultEffort?: string;
  /** ISO date before which the provider will not retire the model; informational. */
  readonly retiresNotBefore?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isRank(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

export function isRouterTier(value: unknown): value is RouterTier {
  return ROUTER_TIERS.some((tier) => tier === value);
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isModelPrices(value: unknown): value is ModelPrices {
  return (
    isRecord(value) && isPrice(value.input) && isPrice(value.cacheWrite) && isPrice(value.cacheRead) && isPrice(value.output)
  );
}

function isContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function optional(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

export function isModelEntry(value: unknown): value is ModelEntry {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.label) &&
    isRank(value.rank) &&
    isNonEmptyString(value.agentModel) &&
    isString(value.source) &&
    isBoolean(value.available) &&
    (value.summary === undefined || isString(value.summary)) &&
    optional(value.tier, isRouterTier) &&
    optional(value.prices, isModelPrices) &&
    optional(value.supportsEffort, isBoolean) &&
    optional(value.contextWindow, isContextWindow) &&
    optional(value.thinkingReadsFrom, (ids) => Array.isArray(ids) && ids.every(isNonEmptyString)) &&
    optional(value.defaultEffort, isNonEmptyString) &&
    optional(value.retiresNotBefore, isIsoDate)
  );
}

/**
 * The valid entries of a stored catalog, row by row and in stored order: one
 * malformed row costs that row, never the rows around it (the same choice
 * getPolicies makes).
 */
export function parseModelCatalog(value: unknown): readonly ModelEntry[] {
  return Array.isArray(value) ? value.filter(isModelEntry) : [];
}

/** The rows of a `{ version, models }` seed payload; anything else yields none. */
export function parseModelSeedEntries(payload: unknown): readonly ModelEntry[] {
  return isRecord(payload) ? parseModelCatalog(payload.models) : [];
}

/**
 * The seed's hand-bumped integer version. Missing or malformed reads as 0,
 * lower than any real shipped version, so an install that was never offered
 * a baseline is told about the first one (model_seed_notice.ts).
 */
export function parseModelSeedVersion(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const version = payload.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/** Ranked entries by rank (largest first), then unranked ones in stored order. */
export function orderedLadder(entries: readonly ModelEntry[]): readonly ModelEntry[] {
  const ranked = entries
    .filter((row) => row.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const unranked = entries.filter((row) => row.rank === null);
  return [...ranked, ...unranked];
}

/** What Jev may choose from: ranked, available entries, largest first. */
export function availableLadder(entries: readonly ModelEntry[]): readonly ModelEntry[] {
  return orderedLadder(entries).filter((row) => row.rank !== null && row.available);
}
