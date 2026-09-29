// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §5): which model
// each tier resolves to on ONE account.
//
// An Orca account is a vault (`CLAUDE_CONFIG_DIR=<orca>/claude-accounts/<uuid>/auth`)
// whose settings.json `env` decides the provider. Anthropic direct gets the
// Anthropic ladder, read from the catalog rows that carry a `tier` (with the
// built-in facts below as the fallback); a gateway (a non-Anthropic
// ANTHROPIC_BASE_URL) gets the models its own ANTHROPIC_DEFAULT_*_MODEL
// variables name, with unknown prices -- which is what disables break-even
// downgrades on that account.
//
// The one hard rule: never return a model the account cannot serve. On
// Anthropic direct a catalog row marked unavailable is skipped (to the next
// stronger available model first, so the quality floor holds); the frontier
// model needs BOTH the catalog's availability AND a fableWeekly quota window
// that is not exhausted. On a gateway only the ids its own env names are
// ever used.
//
// Pure, like the rest of src/core: no I/O. The hooks module reads the three
// inputs (vault env, models-catalog.json, quota.json) and hands them in.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import type { QuotaAccount } from "./consumption.ts";
import { ROUTER_TIERS } from "./model_catalog.ts";
import type { ModelEntry, ModelPrices, RouterTier } from "./model_catalog.ts";

export { ROUTER_TIERS };
export type { ModelPrices, RouterTier };

export interface ResolvedTierModel {
  readonly modelId: string;
  /** Short display name for the status line ("Sonnet 5.5"); the id itself on a gateway. */
  readonly label: string;
  readonly supportsEffort: boolean;
  /** null = unknown (a gateway): break-even downgrades are disabled. */
  readonly prices: ModelPrices | null;
  /** Tokens; null = unknown (a gateway): no context-window floor applies. */
  readonly contextWindow: number | null;
}

export type ResolvedTiers = Readonly<Record<RouterTier, ResolvedTierModel>>;

// The built-in facts (platform.claude.com models overview and pricing,
// 2026-09-29): the fallback when the catalog has no usable row or field.
export const FABLE_ID = "claude-fable-5-1";
const OPUS_ID = "claude-opus-5-5";
const SONNET_ID = "claude-sonnet-5-5";
const HAIKU_ID = "claude-haiku-4-5-20251001";
const LEGACY_SONNET_ID = "claude-sonnet-5";

const ANTHROPIC_TIER_MODEL: Readonly<Record<RouterTier, string>> = {
  simple: HAIKU_ID,
  standard: SONNET_ID,
  complex: OPUS_ID,
  frontier: FABLE_ID,
};

export const ANTHROPIC_PRICES: Readonly<Record<string, ModelPrices>> = {
  [HAIKU_ID]: { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 },
  [SONNET_ID]: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 },
  [LEGACY_SONNET_ID]: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 },
  [OPUS_ID]: { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 },
  [FABLE_ID]: { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 },
};

const ANTHROPIC_LABELS: Readonly<Record<string, string>> = {
  [HAIKU_ID]: "Haiku 4.5",
  [SONNET_ID]: "Sonnet 5.5",
  [LEGACY_SONNET_ID]: "Sonnet 5",
  [OPUS_ID]: "Opus 5.5",
  [FABLE_ID]: "Fable 5.1",
};

const ANTHROPIC_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  [HAIKU_ID]: 200_000,
  [SONNET_ID]: 1_000_000,
  [LEGACY_SONNET_ID]: 1_000_000,
  [OPUS_ID]: 1_000_000,
  [FABLE_ID]: 1_000_000,
};

/** Haiku takes no effort parameter (§4). */
const ANTHROPIC_NO_EFFORT: ReadonlySet<string> = new Set([HAIKU_ID]);

/** The string values of a vault settings.json's `env` block (already JSON.parse'd); anything else reads as none. */
export function parseVaultEnv(settings: unknown): Readonly<Record<string, string>> {
  if (!isRecord(settings) || !isRecord(settings.env)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** A gateway is any ANTHROPIC_BASE_URL whose host is not anthropic.com (an unparseable one included: it is certainly not Anthropic's). */
export function isGatewayEnv(env: Readonly<Record<string, string>>): boolean {
  const base = env.ANTHROPIC_BASE_URL;
  if (base === undefined || base.trim().length === 0) return false;
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return true;
  }
  return !(host === "anthropic.com" || host.endsWith(".anthropic.com"));
}

function fableWindowOpen(quota: QuotaAccount | null): boolean {
  const used = quota?.fableWeekly?.usedPercent;
  return typeof used === "number" && used < 100;
}

function catalogRow(catalog: readonly ModelEntry[], id: string): ModelEntry | undefined {
  return catalog.find((candidate) => candidate.id === id);
}

/** A frontier model: its catalog row says so, or (no tier recorded) it is the built-in Fable id. */
function isFrontierModel(id: string, catalog: readonly ModelEntry[]): boolean {
  const tier = catalogRow(catalog, id)?.tier;
  return tier === undefined ? id === FABLE_ID : tier === "frontier";
}

/**
 * Whether this Anthropic account can serve `id`. A frontier model is opt-in
 * (catalog AND the Fable quota window, §5). The others are served by every
 * Anthropic account unless the catalog explicitly marks them unavailable; a
 * missing catalog row (no mirror yet) is not evidence against a model every
 * account has.
 */
function anthropicServes(id: string, catalog: readonly ModelEntry[], quota: QuotaAccount | null): boolean {
  const row = catalogRow(catalog, id);
  if (isFrontierModel(id, catalog)) return row?.available === true && fableWindowOpen(quota);
  return row?.available !== false;
}

/**
 * Classify a raw model id string into its list price (JEVADV-63) from the
 * built-in table. Tolerant of a context-window suffix (`baseModelId`, same
 * as `tierOfModel`). `null` for an id this file has no price for (a gateway
 * model); callers must still count its tokens, just at zero estimated cost.
 */
export function pricesForModel(modelId: string): ModelPrices | null {
  return ANTHROPIC_PRICES[baseModelId(modelId)] ?? null;
}

/** "Claude Sonnet 5.5" → "Sonnet 5.5": the status line's short form. */
function shortLabel(label: string): string {
  const short = label.replace(/^Claude\s+/, "").trim();
  return short.length > 0 ? short : label;
}

function anthropicModel(id: string, catalog: readonly ModelEntry[]): ResolvedTierModel {
  const row = catalogRow(catalog, id);
  return {
    modelId: id,
    label: ANTHROPIC_LABELS[id] ?? (row === undefined ? id : shortLabel(row.label)),
    supportsEffort: row?.supportsEffort ?? !ANTHROPIC_NO_EFFORT.has(id),
    prices: row?.prices ?? ANTHROPIC_PRICES[id] ?? null,
    contextWindow: row?.contextWindow ?? ANTHROPIC_CONTEXT_WINDOWS[id] ?? null,
  };
}

/**
 * The best-ranked catalog row carrying `tier` that the account serves (else
 * the best-ranked one at all), or the built-in id. On a tied rank the later
 * row wins: an accepted offer is appended after the row it supersedes.
 */
function tierModelId(tier: RouterTier, catalog: readonly ModelEntry[], served: (id: string) => boolean): string {
  const rows = catalog
    .filter((row) => row.tier === tier && row.rank !== null)
    .reverse()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return (rows.find((row) => served(row.id)) ?? rows[0])?.id ?? ANTHROPIC_TIER_MODEL[tier];
}

/** The model at `at` if served, else the next stronger served one, else the strongest served one below it. */
function pickServed(ladder: readonly string[], at: number, served: (id: string) => boolean): string {
  for (let i = at; i < ladder.length; i += 1) {
    const id = ladder[i] as string;
    if (served(id)) return id;
  }
  for (let i = at - 1; i >= 0; i -= 1) {
    const id = ladder[i] as string;
    if (served(id)) return id;
  }
  // Nothing on the ladder is served: the catalog marked everything
  // unavailable. The standard model is the one every Claude Code account
  // defaults to, so it is the least-wrong answer; the hook still never
  // switches to a model below the session's own under a guard.
  return ladder[ROUTER_TIERS.indexOf("standard")] ?? SONNET_ID;
}

function gatewayModel(id: string): ResolvedTierModel {
  return { modelId: id, label: id, supportsEffort: false, prices: null, contextWindow: null };
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

export interface ResolveAccountTiersInput {
  readonly env: Readonly<Record<string, string>>;
  readonly catalog: readonly ModelEntry[];
  readonly quota: QuotaAccount | null;
}

export function resolveAccountTiers(input: ResolveAccountTiersInput): ResolvedTiers {
  if (isGatewayEnv(input.env)) {
    const opus = nonEmpty(input.env.ANTHROPIC_DEFAULT_OPUS_MODEL);
    const sonnet = nonEmpty(input.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    const haiku = nonEmpty(input.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    const fallback = nonEmpty(input.env.ANTHROPIC_MODEL);
    // Missing ones fall UP to the next declared model: the quality floor
    // wins over the saving, and an id the gateway never declared is never
    // invented.
    const strong = opus ?? sonnet ?? haiku ?? fallback ?? SONNET_ID;
    const middle = sonnet ?? opus ?? fallback ?? haiku ?? strong;
    const weak = haiku ?? sonnet ?? opus ?? fallback ?? strong;
    return { simple: gatewayModel(weak), standard: gatewayModel(middle), complex: gatewayModel(strong), frontier: gatewayModel(strong) };
  }
  const served = (id: string): boolean => anthropicServes(id, input.catalog, input.quota);
  // Weakest to strongest: the ladder a tier falls along when its own model is unavailable.
  const ladder = ROUTER_TIERS.map((tier) => tierModelId(tier, input.catalog, served));
  const frontierAt = ROUTER_TIERS.indexOf("frontier");
  const resolve = (tier: RouterTier): ResolvedTierModel => {
    const at = ROUTER_TIERS.indexOf(tier);
    // Frontier without its model is complex (§5), not "the next stronger" (there is none).
    const from = at === frontierAt && !served(ladder[at] as string) ? at - 1 : at;
    return anthropicModel(pickServed(ladder, from, served), input.catalog);
  };
  return { simple: resolve("simple"), standard: resolve("standard"), complex: resolve("complex"), frontier: resolve("frontier") };
}

/** §5 collapse: a tier is the lowest tier resolving to the same model id. */
export function collapseTier(tiers: ResolvedTiers, tier: RouterTier): RouterTier {
  const id = tiers[tier].modelId;
  return ROUTER_TIERS.find((candidate) => tiers[candidate].modelId === id) ?? tier;
}

/** `claude-opus-5-5[1m]` → `claude-opus-5-5`: a context-window suffix names the same model. */
export function baseModelId(modelId: string): string {
  const bracket = modelId.indexOf("[");
  return bracket === -1 ? modelId : modelId.slice(0, bracket);
}

/** The (collapsed) tier a model id resolves from on this account, or null when no tier resolves to it. */
export function tierOfModel(tiers: ResolvedTiers, modelId: string): RouterTier | null {
  const id = baseModelId(modelId);
  const found = ROUTER_TIERS.find((tier) => tiers[tier].modelId === id);
  return found ?? null;
}

/** A comparable strength for a model on this account (higher = stronger), or null when the account's tiers do not include it. */
export function modelRank(tiers: ResolvedTiers, modelId: string): number | null {
  const tier = tierOfModel(tiers, modelId);
  return tier === null ? null : ROUTER_TIERS.indexOf(tier);
}
