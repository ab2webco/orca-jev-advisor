import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import type { QuotaAccount } from "./consumption.ts";
import { parseModelSeedEntries, type ModelEntry } from "./model_catalog.ts";
import {
  ANTHROPIC_PRICES,
  collapseTier,
  isGatewayEnv,
  modelRank,
  parseVaultEnv,
  pricesForModel,
  resolveAccountTiers,
  tierOfModel,
} from "./model_router_accounts.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: `Claude ${id}`, rank, agentModel: id, source: "", available };
}

const SEED_CATALOG: readonly ModelEntry[] = parseModelSeedEntries(
  JSON.parse(readFileSync(new URL("../../seed/models.json", import.meta.url), "utf8")),
);

/** An install that never accepted seed v2: rows without tier, prices or windows. */
const V1_CATALOG: readonly ModelEntry[] = [
  entry("claude-fable-5-1", 1, false),
  entry("claude-opus-5-5", 2, true),
  entry("claude-sonnet-5", 3, true),
  entry("claude-haiku-4-5-20251001", 4, true),
];

const CATALOG_WITH_FABLE: readonly ModelEntry[] = SEED_CATALOG.map((row) => (row.id === "claude-fable-5-1" ? { ...row, available: true } : row));

function quota(fable: { usedPercent: number | null } | null): QuotaAccount {
  return {
    id: "aaaaaaaa",
    status: "ok",
    sessionUsedPercent: 10,
    weeklyUsedPercent: 20,
    resetsAt: null,
    ...(fable === null ? {} : { fableWeekly: { usedPercent: fable.usedPercent, resetsAt: null } }),
  };
}

const GATEWAY_ENV = {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
  ANTHROPIC_MODEL: "glm-5.3",
};

test("parseVaultEnv: reads the string values of settings.json's env block, ignoring the rest", () => {
  assert.deepEqual(parseVaultEnv({ env: { A: "1", B: 2, C: "x" }, model: "opus" }), { A: "1", C: "x" });
  assert.deepEqual(parseVaultEnv(null), {});
  assert.deepEqual(parseVaultEnv({ env: "nope" }), {});
});

test("isGatewayEnv: only a non-Anthropic ANTHROPIC_BASE_URL is a gateway", () => {
  assert.equal(isGatewayEnv({}), false);
  assert.equal(isGatewayEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), false);
  assert.equal(isGatewayEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" }), false);
  assert.equal(isGatewayEnv({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }), true);
  assert.equal(isGatewayEnv({ ANTHROPIC_BASE_URL: "not a url" }), true);
});

test("Anthropic direct: the four tiers map to Haiku, Sonnet, Opus and (without Fable) Opus again", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: SEED_CATALOG, quota: null });
  assert.equal(tiers.simple.modelId, "claude-haiku-4-5-20251001");
  assert.equal(tiers.standard.modelId, "claude-sonnet-5-5");
  assert.equal(tiers.complex.modelId, "claude-opus-5-5");
  assert.equal(tiers.frontier.modelId, "claude-opus-5-5");
  assert.equal(tiers.simple.supportsEffort, false);
  assert.equal(tiers.standard.supportsEffort, true);
  assert.deepEqual(tiers.standard.prices, { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 });
  assert.equal(tiers.standard.label, "Sonnet 5.5");
  assert.equal(tiers.simple.contextWindow, 200_000);
  assert.equal(tiers.standard.contextWindow, 1_000_000);
});

test("the catalog drives the ladder: a tier takes its model, label, prices, effort and window from the row carrying that tier", () => {
  const next: ModelEntry = {
    ...entry("claude-sonnet-6", 3, true),
    label: "Claude Sonnet 6",
    tier: "standard",
    prices: { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 },
    supportsEffort: false,
    contextWindow: 2_000_000,
  };
  const legacy: ModelEntry = { ...entry("claude-sonnet-5-5", 5, true), tier: "standard" };
  const tiers = resolveAccountTiers({ env: {}, catalog: [...SEED_CATALOG.filter((row) => row.tier !== "standard"), legacy, next], quota: null });
  assert.equal(tiers.standard.modelId, "claude-sonnet-6", "the best-ranked row of a tier wins");
  assert.equal(tiers.standard.label, "Sonnet 6");
  assert.deepEqual(tiers.standard.prices, next.prices);
  assert.equal(tiers.standard.supportsEffort, false);
  assert.equal(tiers.standard.contextWindow, 2_000_000);
  const unranked = resolveAccountTiers({ env: {}, catalog: [...SEED_CATALOG.filter((row) => row.tier !== "standard"), { ...next, rank: null }], quota: null });
  assert.equal(unranked.standard.modelId, "claude-sonnet-5-5", "an unranked row is never chosen: the built-in fallback serves the tier");
});

test("fallback: a catalog without the docs fields still resolves the current lineup with the verified facts", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: V1_CATALOG, quota: null });
  assert.equal(tiers.standard.modelId, "claude-sonnet-5-5");
  assert.equal(tiers.standard.label, "Sonnet 5.5");
  assert.deepEqual(tiers.standard.prices, { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 });
  assert.equal(tiers.simple.supportsEffort, false);
  assert.equal(tiers.simple.contextWindow, 200_000);
  assert.equal(tiers.complex.contextWindow, 1_000_000);
  const fable = resolveAccountTiers({ env: {}, catalog: V1_CATALOG.map((row) => (row.id === "claude-fable-5-1" ? { ...row, available: true } : row)), quota: quota({ usedPercent: 0 }) });
  assert.deepEqual(fable.frontier.prices, { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 });
});

test("a frontier row from the catalog still needs the person's availability AND an open Fable window", () => {
  const frontier: ModelEntry = { ...entry("claude-fable-6", 1, true), tier: "frontier", prices: { input: 12, cacheWrite: 24, cacheRead: 0.3, output: 60 } };
  const catalog = [...SEED_CATALOG.filter((row) => row.tier !== "frontier"), frontier];
  assert.equal(resolveAccountTiers({ env: {}, catalog, quota: quota({ usedPercent: 10 }) }).frontier.modelId, "claude-fable-6");
  assert.equal(resolveAccountTiers({ env: {}, catalog, quota: quota({ usedPercent: 100 }) }).frontier.modelId, "claude-opus-5-5");
  const off = catalog.map((row) => (row.id === "claude-fable-6" ? { ...row, available: false } : row));
  assert.equal(resolveAccountTiers({ env: {}, catalog: off, quota: quota({ usedPercent: 10 }) }).frontier.modelId, "claude-opus-5-5");
});

test("Fable gate: frontier is Fable only when the catalog marks it available AND the quota has a non-exhausted fableWeekly window", () => {
  assert.equal(resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 40 }) }).frontier.modelId, "claude-fable-5-1");
  // Catalog says unavailable.
  assert.equal(resolveAccountTiers({ env: {}, catalog: SEED_CATALOG, quota: quota({ usedPercent: 40 }) }).frontier.modelId, "claude-opus-5-5");
  // No fableWeekly window at all.
  assert.equal(resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota(null) }).frontier.modelId, "claude-opus-5-5");
  // Window exhausted (the aaaaaaaa case on the owner's machine).
  assert.equal(resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 100 }) }).frontier.modelId, "claude-opus-5-5");
  // Unknown usage is not "not exhausted".
  assert.equal(resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: null }) }).frontier.modelId, "claude-opus-5-5");
  // No quota mirror at all.
  assert.equal(resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: null }).frontier.modelId, "claude-opus-5-5");
});

test("Fable prices are the published ones, from the catalog", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 0 }) });
  assert.deepEqual(tiers.frontier.prices, { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 });
  assert.equal(tiers.frontier.label, "Fable 5.1");
});

test("gateway: tiers come from the vault's ANTHROPIC_DEFAULT_*_MODEL, prices unknown, no effort", () => {
  const tiers = resolveAccountTiers({ env: GATEWAY_ENV, catalog: SEED_CATALOG, quota: null });
  assert.equal(tiers.simple.modelId, "glm-4.5-air");
  assert.equal(tiers.standard.modelId, "glm-5.2");
  assert.equal(tiers.complex.modelId, "glm-5.3");
  assert.equal(tiers.frontier.modelId, "glm-5.3");
  for (const tier of ["simple", "standard", "complex", "frontier"] as const) {
    assert.equal(tiers[tier].prices, null);
    assert.equal(tiers[tier].supportsEffort, false);
    assert.equal(tiers[tier].contextWindow, null);
  }
});

test("gateway: a missing tier variable falls back to the next stronger one, never to an Anthropic id the gateway cannot serve", () => {
  const tiers = resolveAccountTiers({ env: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_DEFAULT_OPUS_MODEL: "big" }, catalog: SEED_CATALOG, quota: null });
  assert.equal(tiers.simple.modelId, "big");
  assert.equal(tiers.standard.modelId, "big");
  assert.equal(tiers.complex.modelId, "big");
  // Nothing declared at all: ANTHROPIC_MODEL is what the gateway serves.
  const bare = resolveAccountTiers({ env: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_MODEL: "only" }, catalog: SEED_CATALOG, quota: null });
  assert.equal(bare.simple.modelId, "only");
  assert.equal(bare.frontier.modelId, "only");
});

test("never an unavailable model: a tier whose model the catalog marks unavailable moves to the next stronger available one", () => {
  const noHaiku = SEED_CATALOG.map((row) => (row.id === "claude-haiku-4-5-20251001" ? { ...row, available: false } : row));
  const tiers = resolveAccountTiers({ env: {}, catalog: noHaiku, quota: null });
  assert.equal(tiers.simple.modelId, "claude-sonnet-5-5");
  const noOpus = SEED_CATALOG.map((row) => (row.id === "claude-opus-5-5" ? { ...row, available: false } : row));
  const noOpusTiers = resolveAccountTiers({ env: {}, catalog: noOpus, quota: null });
  // Nothing stronger is available: the strongest available one below it.
  assert.equal(noOpusTiers.complex.modelId, "claude-sonnet-5-5");
  assert.equal(noOpusTiers.frontier.modelId, "claude-sonnet-5-5");
  for (const tier of ["simple", "standard", "complex", "frontier"] as const) {
    const row = noOpus.find((candidate) => candidate.id === noOpusTiers[tier].modelId);
    assert.notEqual(row?.available, false);
  }
});

test("collapse: two tiers resolving to the same id are the same tier (the lowest of them)", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: SEED_CATALOG, quota: null });
  assert.equal(collapseTier(tiers, "frontier"), "complex");
  assert.equal(collapseTier(tiers, "complex"), "complex");
  assert.equal(collapseTier(tiers, "simple"), "simple");
  const gateway = resolveAccountTiers({ env: GATEWAY_ENV, catalog: SEED_CATALOG, quota: null });
  assert.equal(collapseTier(gateway, "frontier"), "complex");
});

test("tierOfModel / modelRank: a session's model maps back to its tier, ignoring a context-window suffix", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: SEED_CATALOG, quota: null });
  assert.equal(tierOfModel(tiers, "claude-sonnet-5-5"), "standard");
  assert.equal(tierOfModel(tiers, "claude-opus-5-5[1m]"), "complex");
  assert.equal(tierOfModel(tiers, "some-other-model"), null);
  assert.ok(modelRank(tiers, "claude-opus-5-5") > modelRank(tiers, "claude-haiku-4-5-20251001"));
  assert.equal(modelRank(tiers, "some-other-model"), null);
});

test("pricesForModel (JEVADV-63): a known Anthropic id resolves to ANTHROPIC_PRICES exactly", () => {
  assert.deepEqual(pricesForModel("claude-sonnet-5-5"), { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 });
  assert.deepEqual(pricesForModel("claude-opus-5-5"), ANTHROPIC_PRICES["claude-opus-5-5"]);
  assert.deepEqual(pricesForModel("claude-haiku-4-5-20251001"), ANTHROPIC_PRICES["claude-haiku-4-5-20251001"]);
});

test("pricesForModel: legacy Sonnet 5 keeps its price, so past turns are still costed", () => {
  assert.deepEqual(pricesForModel("claude-sonnet-5"), { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 });
});

test("pricesForModel: a context-window suffix is stripped the same way tierOfModel strips it", () => {
  assert.deepEqual(pricesForModel("claude-opus-5-5[1m]"), ANTHROPIC_PRICES["claude-opus-5-5"]);
});

test("pricesForModel: Fable at its published price", () => {
  assert.deepEqual(pricesForModel("claude-fable-5-1"), { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 });
});

test("pricesForModel: an unrecognized model id resolves to null (tokens must still be counted at zero cost)", () => {
  assert.equal(pricesForModel("some-gateway-model"), null);
});
