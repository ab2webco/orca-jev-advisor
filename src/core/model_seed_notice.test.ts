import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseModelSeedEntries } from "./model_catalog.ts";
import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import {
  LEGACY_SIMPLE_DEFAULT,
  applyModelSeedChoices,
  decideModelSeedNotice,
  diffModelSeed,
  parseModelOfferedVersion,
  shouldSeedModels,
  upgradeLegacySimpleDefault,
} from "./model_seed_notice.ts";

const SHIPPED = parseModelSeedEntries(JSON.parse(readFileSync(new URL("../../seed/models.json", import.meta.url), "utf8")));

function entry(overrides: Partial<ModelEntry> & { id: string }): ModelEntry {
  return {
    provider: "anthropic",
    label: overrides.id,
    rank: 1,
    agentModel: overrides.id,
    source: "https://example.test/doc",
    available: true,
    ...overrides,
  };
}

test("seeds only when never seeded and the stored catalog is empty", () => {
  assert.equal(shouldSeedModels(undefined, []), true);
  assert.equal(shouldSeedModels(true, []), false, "an emptied catalog is a choice, not a fresh machine");
  assert.equal(shouldSeedModels(undefined, [entry({ id: "mine" })]), false, "an existing catalog is never touched");
});

test("the offered version reads 0 when absent or malformed", () => {
  assert.equal(parseModelOfferedVersion(undefined), 0);
  assert.equal(parseModelOfferedVersion({ version: "2" }), 0);
  assert.equal(parseModelOfferedVersion({ version: -3 }), 0);
  assert.equal(parseModelOfferedVersion({ version: 2 }), 2);
});

test("diff reports shipped ids the install lacks and fields that differ, never availability", () => {
  const existing = [
    entry({ id: "same" }),
    entry({ id: "moved", rank: 2 }),
    entry({ id: "toggled", available: false }),
    entry({ id: "mine-only" }),
  ];
  const shipped = [
    entry({ id: "same" }),
    entry({ id: "moved", rank: 3, source: "https://example.test/new" }),
    entry({ id: "toggled", available: true }),
    entry({ id: "new-one" }),
  ];
  const diff = diffModelSeed(existing, shipped);
  assert.deepEqual(diff.added.map((row) => row.id), ["new-one"]);
  assert.deepEqual(
    diff.differing.map((row) => ({ id: row.id, fields: row.fields })),
    [{ id: "moved", fields: ["rank", "source"] }],
  );
});

test("diff compares the docs fields by value: a changed price is a changed row, an equal copy is not", () => {
  const prices = { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 };
  const existing = [
    entry({ id: "same", tier: "standard", prices, thinkingReadsFrom: ["x"] }),
    entry({ id: "repriced", prices }),
    entry({ id: "grew", contextWindow: 200_000 }),
    entry({ id: "old-row" }),
  ];
  const shipped = [
    entry({ id: "same", tier: "standard", prices: { ...prices }, thinkingReadsFrom: ["x"] }),
    entry({ id: "repriced", prices: { ...prices, output: 12 } }),
    entry({ id: "grew", contextWindow: 1_000_000 }),
    entry({ id: "old-row", tier: "simple", supportsEffort: false }),
  ];
  const diff = diffModelSeed(existing, shipped);
  assert.deepEqual(
    diff.differing.map((row) => ({ id: row.id, fields: row.fields })),
    [
      { id: "repriced", fields: ["prices"] },
      { id: "grew", fields: ["contextWindow"] },
      { id: "old-row", fields: ["tier", "supportsEffort"] },
    ],
  );
});

test("a notice is due only when the shipped version is newer and something differs", () => {
  const shipped = [entry({ id: "a" }), entry({ id: "b" })];
  const due = decideModelSeedNotice({ shippedVersion: 2, offeredVersion: 1, existing: [entry({ id: "a" })], shipped });
  assert.deepEqual(due, { due: true, added: 1, differing: 0, shippedVersion: 2, markOffered: false });

  const noop = decideModelSeedNotice({ shippedVersion: 2, offeredVersion: 1, existing: shipped, shipped });
  assert.deepEqual(noop, { due: false, added: 0, differing: 0, shippedVersion: 2, markOffered: true });

  const same = decideModelSeedNotice({ shippedVersion: 2, offeredVersion: 2, existing: [], shipped });
  assert.equal(same.due, false);
  assert.equal(same.markOffered, false);

  const downgrade = decideModelSeedNotice({ shippedVersion: 1, offeredVersion: 3, existing: [], shipped });
  assert.equal(downgrade.due, false);
  assert.equal(downgrade.markOffered, false, "the marker is never lowered");
});

test("applying choices touches only the accepted ids and keeps the person's availability", () => {
  const existing = [
    entry({ id: "keep", rank: 5 }),
    entry({ id: "update", rank: 2, available: false }),
  ];
  const shipped = [
    entry({ id: "keep", rank: 1 }),
    entry({ id: "update", rank: 3, label: "New label", available: true }),
    entry({ id: "added", rank: 4 }),
    entry({ id: "declined", rank: 6 }),
  ];
  const { result, replaced, added } = applyModelSeedChoices(existing, shipped, ["update", "added", "added", "ghost"]);
  assert.equal(replaced, 1);
  assert.equal(added, 1);
  assert.deepEqual(result.map((row) => row.id), ["keep", "update", "added"]);
  assert.equal(result[0]?.rank, 5, "an id not accepted is left exactly as it was");
  assert.equal(result[1]?.label, "New label");
  assert.equal(result[1]?.rank, 3);
  assert.equal(result[1]?.available, false, "availability is the person's, never the seed's");
});

test("applying no choices changes nothing", () => {
  const existing = [entry({ id: "a" })];
  const { result, replaced, added } = applyModelSeedChoices(existing, [entry({ id: "a", rank: 9 }), entry({ id: "b" })], []);
  assert.deepEqual(result, existing);
  assert.equal(replaced, 0);
  assert.equal(added, 0);
});

// ---------------------------------------------------------------------------
// 0.6.29: the one catalog change made without an offer -- the old default
// simple-tier model nobody chose.
// ---------------------------------------------------------------------------

/** An install seeded by any release before 0.6.29: the v2 baseline, rows exactly as shipped (Fable off, as the baseline ships it). */
const V2_INSTALL: readonly ModelEntry[] = [
  { ...(SHIPPED.find((row) => row.id === "claude-fable-5-1") as ModelEntry) },
  { ...(SHIPPED.find((row) => row.id === "claude-opus-5-5") as ModelEntry) },
  { ...(SHIPPED.find((row) => row.id === "claude-sonnet-5-5") as ModelEntry) },
  { ...LEGACY_SIMPLE_DEFAULT },
];

function simpleModelOf(catalog: readonly ModelEntry[]): string {
  return resolveAccountTiers({ env: {}, catalog, quota: null }).simple.modelId;
}

test("legacy default: an install still on the old simple-tier row moves to Haiku 5.5, and Haiku 4.5 stays in the catalog unranked", () => {
  assert.equal(simpleModelOf(V2_INSTALL), "claude-haiku-4-5-20251001", "the starting point is the old default");
  const upgraded = upgradeLegacySimpleDefault(V2_INSTALL, SHIPPED);
  assert.ok(upgraded !== null);
  assert.equal(simpleModelOf(upgraded), "claude-haiku-5-5");
  const old = upgraded.find((row) => row.id === "claude-haiku-4-5-20251001");
  assert.ok(old !== undefined, "the row is kept, not deleted");
  assert.equal(old.rank, null);
  assert.equal(old.tier, undefined);
  assert.deepEqual(old.prices, LEGACY_SIMPLE_DEFAULT.prices, "its price and window stay, so it can still be placed and costed");
  assert.equal(old.contextWindow, 200_000);
  assert.deepEqual(upgraded.filter((row) => row.id !== "claude-haiku-4-5-20251001" && row.id !== "claude-haiku-5-5"), V2_INSTALL.slice(0, 3), "no other row is touched");
  assert.deepEqual(upgraded.find((row) => row.id === "claude-haiku-5-5"), SHIPPED.find((row) => row.id === "claude-haiku-5-5"));
});

test("legacy default: the person's availability carries over to Haiku 5.5", () => {
  const off = V2_INSTALL.map((row) => (row.id === "claude-haiku-4-5-20251001" ? { ...row, available: false } : row));
  const upgraded = upgradeLegacySimpleDefault(off, SHIPPED);
  assert.equal(upgraded?.find((row) => row.id === "claude-haiku-5-5")?.available, false, "a model they turned off is not turned on for them");
});

test("legacy default: once migrated there is nothing left to do", () => {
  const upgraded = upgradeLegacySimpleDefault(V2_INSTALL, SHIPPED);
  assert.ok(upgraded !== null);
  assert.equal(upgradeLegacySimpleDefault(upgraded, SHIPPED), null);
});

test("legacy default: a row the person edited is a choice and is never migrated", () => {
  for (const edit of [{ rank: 5 }, { label: "Claude Haiku (mine)" }, { agentModel: "claude-haiku-4-5" }, { prices: { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 4 } }, { tier: "standard" as const }]) {
    const edited = V2_INSTALL.map((row) => (row.id === "claude-haiku-4-5-20251001" ? { ...row, ...edit } : row));
    assert.equal(upgradeLegacySimpleDefault(edited, SHIPPED), null, JSON.stringify(edit));
  }
});

test("legacy default: a catalog that already has Haiku 5.5, or another simple-tier model, is left alone", () => {
  const withHaiku55 = [...V2_INSTALL, { ...(SHIPPED.find((row) => row.id === "claude-haiku-5-5") as ModelEntry), available: false }];
  assert.equal(upgradeLegacySimpleDefault(withHaiku55, SHIPPED), null, "an accepted offer, or a Haiku 5.5 they switched off");
  const mine: ModelEntry = { ...entry({ id: "my-small-model", tier: "simple" }), rank: 5 };
  assert.equal(upgradeLegacySimpleDefault([...V2_INSTALL, mine], SHIPPED), null, "someone else already serves the simple tier");
});

test("legacy default: no Haiku 4.5 row, an empty catalog, or a baseline without Haiku 5.5 changes nothing", () => {
  assert.equal(upgradeLegacySimpleDefault([], SHIPPED), null);
  assert.equal(upgradeLegacySimpleDefault(V2_INSTALL.slice(0, 3), SHIPPED), null);
  assert.equal(upgradeLegacySimpleDefault(V2_INSTALL, SHIPPED.filter((row) => row.id !== "claude-haiku-5-5")), null);
});

test("legacy default: after the migration the shipped baseline has nothing left to offer for the simple tier", () => {
  const upgraded = upgradeLegacySimpleDefault(V2_INSTALL, SHIPPED);
  assert.ok(upgraded !== null);
  const diff = diffModelSeed(upgraded, SHIPPED);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.differing.map((row) => row.id).filter((id) => id.startsWith("claude-haiku")), []);
});
