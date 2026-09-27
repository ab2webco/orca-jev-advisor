// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §5): which model
// each tier resolves to on ONE account.
//
// An Orca account is a vault (`CLAUDE_CONFIG_DIR=<orca>/claude-accounts/<uuid>/auth`)
// whose settings.json `env` decides the provider. Anthropic direct gets the
// fixed Anthropic ladder; a gateway (a non-Anthropic ANTHROPIC_BASE_URL) gets
// the models its own ANTHROPIC_DEFAULT_*_MODEL variables name, with unknown
// prices -- which is what disables break-even downgrades on that account.
//
// The one hard rule: never return a model the account cannot serve. On
// Anthropic direct a catalog row marked unavailable is skipped (to the next
// stronger available model first, so the quality floor holds); Fable needs
// BOTH the catalog's availability AND a fableWeekly quota window that is
// not exhausted. On a gateway only the ids its own env names are ever used.
//
// Pure, like the rest of src/core: no I/O. The hooks module reads the three
// inputs (vault env, models-catalog.json, quota.json) and hands them in.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import type { QuotaAccount } from "./consumption.ts";
import type { ModelEntry } from "./model_catalog.ts";

export type RouterTier = "simple" | "standard" | "complex" | "frontier";

/** Weakest first: an index into this list is a tier's strength. */
export const ROUTER_TIERS: readonly RouterTier[] = ["simple", "standard", "complex", "frontier"];

/** List prices in $ per million tokens (§2.4). Subscription usage is token-weighted in the same proportions. */
export interface ModelPrices {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface ResolvedTierModel {
  readonly modelId: string;
  /** Short display name for the status line ("Sonnet 5"); the id itself on a gateway. */
  readonly label: string;
  readonly supportsEffort: boolean;
  /** null = unknown (a gateway): break-even downgrades are disabled. */
  readonly prices: ModelPrices | null;
}

export type ResolvedTiers = Readonly<Record<RouterTier, ResolvedTierModel>>;

export const FABLE_ID = "claude-fable-5-1";
const OPUS_ID = "claude-opus-5-5";
const SONNET_ID = "claude-sonnet-5";
const HAIKU_ID = "claude-haiku-4-5-20251001";

/** Anthropic direct, weakest to strongest -- the ladder a tier falls along when its own model is unavailable. */
const ANTHROPIC_LADDER: readonly string[] = [HAIKU_ID, SONNET_ID, OPUS_ID, FABLE_ID];

const ANTHROPIC_TIER_MODEL: Readonly<Record<RouterTier, string>> = {
  simple: HAIKU_ID,
  standard: SONNET_ID,
  complex: OPUS_ID,
  frontier: FABLE_ID,
};

/** Fable's prices are not published (§2.4): it is priced as this multiple of Opus, never below Opus. */
export const DEFAULT_FABLE_PRICE_MULTIPLIER = 2;

export const ANTHROPIC_PRICES: Readonly<Record<string, ModelPrices>> = {
  [HAIKU_ID]: { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 },
  [SONNET_ID]: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 },
  [OPUS_ID]: { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 },
};

const ANTHROPIC_LABELS: Readonly<Record<string, string>> = {
  [HAIKU_ID]: "Haiku 4.5",
  [SONNET_ID]: "Sonnet 5",
  [OPUS_ID]: "Opus 5.5",
  [FABLE_ID]: "Fable 5.1",
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

function fablePrices(multiplier: number): ModelPrices {
  const opus = ANTHROPIC_PRICES[OPUS_ID] as ModelPrices;
  const factor = Number.isFinite(multiplier) ? Math.max(1, multiplier) : DEFAULT_FABLE_PRICE_MULTIPLIER;
  return { input: opus.input * factor, cacheWrite: opus.cacheWrite * factor, cacheRead: opus.cacheRead * factor, output: opus.output * factor };
}

function fableWindowOpen(quota: QuotaAccount | null): boolean {
  const used = quota?.fableWeekly?.usedPercent;
  return typeof used === "number" && used < 100;
}

/**
 * Whether this Anthropic account can serve `id`. Fable is opt-in (catalog
 * AND quota window, §5). The others are served by every Anthropic account
 * unless the catalog explicitly marks them unavailable; a missing catalog
 * row (no mirror yet) is not evidence against a model every account has.
 */
function anthropicServes(id: string, catalog: readonly ModelEntry[], quota: QuotaAccount | null): boolean {
  const row = catalog.find((candidate) => candidate.id === id);
  if (id === FABLE_ID) return row?.available === true && fableWindowOpen(quota);
  return row?.available !== false;
}

function anthropicModel(id: string, fableMultiplier: number): ResolvedTierModel {
  return {
    modelId: id,
    label: ANTHROPIC_LABELS[id] ?? id,
    supportsEffort: !ANTHROPIC_NO_EFFORT.has(id),
    prices: id === FABLE_ID ? fablePrices(fableMultiplier) : (ANTHROPIC_PRICES[id] ?? null),
  };
}

/** The tier's own model if served, else the next stronger served one, else the strongest served one below it. */
function pickServed(wanted: string, served: (id: string) => boolean): string {
  const at = ANTHROPIC_LADDER.indexOf(wanted);
  for (let i = at; i < ANTHROPIC_LADDER.length; i += 1) {
    const id = ANTHROPIC_LADDER[i] as string;
    if (served(id)) return id;
  }
  for (let i = at - 1; i >= 0; i -= 1) {
    const id = ANTHROPIC_LADDER[i] as string;
    if (served(id)) return id;
  }
  // Nothing on the ladder is served: the catalog marked everything
  // unavailable. Sonnet is the model every Claude Code account defaults
  // to, so it is the least-wrong answer; the hook still never switches to
  // a model below the session's own under a guard.
  return SONNET_ID;
}

function gatewayModel(id: string): ResolvedTierModel {
  return { modelId: id, label: id, supportsEffort: false, prices: null };
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

export interface ResolveAccountTiersInput {
  readonly env: Readonly<Record<string, string>>;
  readonly catalog: readonly ModelEntry[];
  readonly quota: QuotaAccount | null;
  readonly fablePriceMultiplier?: number;
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
  const multiplier = input.fablePriceMultiplier ?? DEFAULT_FABLE_PRICE_MULTIPLIER;
  const served = (id: string): boolean => anthropicServes(id, input.catalog, input.quota);
  const resolve = (tier: RouterTier): ResolvedTierModel => {
    const wanted = ANTHROPIC_TIER_MODEL[tier];
    // Frontier without Fable is Opus (§5), not "the next stronger" (there is none).
    const id = tier === "frontier" && !served(FABLE_ID) ? pickServed(OPUS_ID, served) : pickServed(wanted, served);
    return anthropicModel(id, multiplier);
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
