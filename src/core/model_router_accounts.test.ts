import assert from "node:assert/strict";
import test from "node:test";

import type { QuotaAccount } from "./consumption.ts";
import type { ModelEntry } from "./model_catalog.ts";
import {
  ANTHROPIC_PRICES,
  DEFAULT_FABLE_PRICE_MULTIPLIER,
  collapseTier,
  isGatewayEnv,
  modelRank,
  parseVaultEnv,
  resolveAccountTiers,
  tierOfModel,
} from "./model_router_accounts.ts";

function entry(id: string, rank: number, available: boolean): ModelEntry {
  return { id, provider: "anthropic", label: `Claude ${id}`, rank, agentModel: id, source: "", available };
}

const SEED_CATALOG: readonly ModelEntry[] = [
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
  assert.equal(tiers.standard.modelId, "claude-sonnet-5");
  assert.equal(tiers.complex.modelId, "claude-opus-5-5");
  assert.equal(tiers.frontier.modelId, "claude-opus-5-5");
  assert.equal(tiers.simple.supportsEffort, false);
  assert.equal(tiers.standard.supportsEffort, true);
  assert.deepEqual(tiers.standard.prices, ANTHROPIC_PRICES["claude-sonnet-5"]);
  assert.equal(tiers.standard.label, "Sonnet 5");
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

test("Fable prices: at least Opus, a configurable multiple of Opus, 2x by default", () => {
  const tiers = resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 0 }) });
  const opus = ANTHROPIC_PRICES["claude-opus-5-5"];
  assert.equal(DEFAULT_FABLE_PRICE_MULTIPLIER, 2);
  assert.deepEqual(tiers.frontier.prices, { input: opus.input * 2, cacheWrite: opus.cacheWrite * 2, cacheRead: opus.cacheRead * 2, output: opus.output * 2 });
  const triple = resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 0 }), fablePriceMultiplier: 3 });
  assert.equal(triple.frontier.prices?.output, opus.output * 3);
  // A multiplier below 1 would price Fable under Opus: floored at 1.
  const under = resolveAccountTiers({ env: {}, catalog: CATALOG_WITH_FABLE, quota: quota({ usedPercent: 0 }), fablePriceMultiplier: 0.5 });
  assert.equal(under.frontier.prices?.output, opus.output);
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
  assert.equal(tiers.simple.modelId, "claude-sonnet-5");
  const noOpus = SEED_CATALOG.map((row) => (row.id === "claude-opus-5-5" ? { ...row, available: false } : row));
  const noOpusTiers = resolveAccountTiers({ env: {}, catalog: noOpus, quota: null });
  // Nothing stronger is available: the strongest available one below it.
  assert.equal(noOpusTiers.complex.modelId, "claude-sonnet-5");
  assert.equal(noOpusTiers.frontier.modelId, "claude-sonnet-5");
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
  assert.equal(tierOfModel(tiers, "claude-sonnet-5"), "standard");
  assert.equal(tierOfModel(tiers, "claude-opus-5-5[1m]"), "complex");
  assert.equal(tierOfModel(tiers, "some-other-model"), null);
  assert.ok(modelRank(tiers, "claude-opus-5-5") > modelRank(tiers, "claude-haiku-4-5-20251001"));
  assert.equal(modelRank(tiers, "some-other-model"), null);
});
