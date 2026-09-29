import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isRecord } from "../guards.ts";
import {
  availableLadder,
  isModelEntry,
  orderedLadder,
  parseModelCatalog,
  parseModelSeedEntries,
  parseModelSeedVersion,
  type ModelEntry,
} from "./model_catalog.ts";

const seedFile: unknown = JSON.parse(
  readFileSync(new URL("../../seed/models.json", import.meta.url), "utf8"),
);

function entry(overrides: Partial<ModelEntry> & { id: string }): ModelEntry {
  return {
    provider: "anthropic",
    label: overrides.id,
    rank: null,
    agentModel: overrides.id,
    source: "https://example.test/doc",
    available: true,
    ...overrides,
  };
}

test("the shipped seed is the versioned { version, models } shape and every row survives validation", () => {
  assert.ok(isRecord(seedFile) && Array.isArray(seedFile.models), "seed/models.json is not { version, models }");
  const rows = (seedFile as { models: unknown[] }).models;
  const parsed = parseModelSeedEntries(seedFile);
  assert.equal(parsed.length, rows.length, "some shipped rows are not valid model entries");
  assert.ok(parsed.length > 0, "the shipped seed is empty");
  assert.ok(parseModelSeedVersion(seedFile) >= 1, "the shipped seed has no version");
});

test("every shipped entry records the official page its position came from", () => {
  for (const row of parseModelSeedEntries(seedFile)) {
    assert.match(row.source, /^https:\/\//, `${row.id} has no https source`);
  }
});

test("shipped ids are unique and shipped ranks are unique", () => {
  const rows = parseModelSeedEntries(seedFile);
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "the shipped seed repeats an id");
  const ranks = rows.flatMap((row) => (row.rank === null ? [] : [row.rank]));
  assert.equal(new Set(ranks).size, ranks.length, "the shipped seed repeats a rank");
});

test("the shipped Claude ladder follows the models overview, largest first", () => {
  const ladder = orderedLadder(parseModelSeedEntries(seedFile)).filter((row) => row.rank !== null);
  assert.deepEqual(
    ladder.map((row) => row.id),
    ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"],
  );
});

test("seed v2: every shipped row carries its tier, prices, effort support and context window from the docs", () => {
  assert.ok(parseModelSeedVersion(seedFile) >= 2, "the seed must be version 2 so existing installs are offered Sonnet 5.5");
  const byId = new Map(parseModelSeedEntries(seedFile).map((row) => [row.id, row] as const));
  const sonnet = byId.get("claude-sonnet-5-5");
  assert.equal(sonnet?.label, "Claude Sonnet 5.5");
  assert.equal(sonnet?.summary, "The best combination of speed and intelligence");
  assert.equal(sonnet?.tier, "standard");
  assert.deepEqual(sonnet?.prices, { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 });
  assert.deepEqual(sonnet?.thinkingReadsFrom, ["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  assert.equal(sonnet?.defaultEffort, "high");
  const fable = byId.get("claude-fable-5-1");
  assert.equal(fable?.tier, "frontier");
  assert.deepEqual(fable?.prices, { input: 10, cacheWrite: 20, cacheRead: 0.25, output: 50 });
  assert.equal(fable?.contextWindow, 1_000_000);
  assert.equal(fable?.thinkingReadsFrom, undefined, "compatibility the docs do not state is never invented");
  const opus = byId.get("claude-opus-5-5");
  assert.equal(opus?.tier, "complex");
  assert.equal(opus?.defaultEffort, "medium");
  const haiku = byId.get("claude-haiku-4-5-20251001");
  assert.equal(haiku?.tier, "simple");
  assert.equal(haiku?.supportsEffort, false);
  assert.equal(haiku?.defaultEffort, undefined);
  assert.equal(haiku?.contextWindow, 200_000);
  assert.equal(haiku?.retiresNotBefore, "2026-10-15");
  assert.equal(byId.has("claude-sonnet-5"), false, "Sonnet 5 is legacy");
});

test("the optional docs fields validate when present and are not required", () => {
  const full = {
    ...entry({ id: "a" }),
    tier: "standard",
    prices: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 },
    supportsEffort: true,
    contextWindow: 1_000_000,
    thinkingReadsFrom: ["b"],
    defaultEffort: "high",
    retiresNotBefore: "2027-09-28",
  };
  assert.equal(isModelEntry(full), true);
  assert.equal(isModelEntry(entry({ id: "a" })), true);
  assert.equal(isModelEntry({ ...full, tier: "huge" }), false);
  assert.equal(isModelEntry({ ...full, prices: { input: 2, output: 10 } }), false);
  assert.equal(isModelEntry({ ...full, prices: { input: -1, cacheWrite: 4, cacheRead: 0.2, output: 10 } }), false);
  assert.equal(isModelEntry({ ...full, supportsEffort: "yes" }), false);
  assert.equal(isModelEntry({ ...full, contextWindow: 1.5 }), false);
  assert.equal(isModelEntry({ ...full, contextWindow: 0 }), false);
  assert.equal(isModelEntry({ ...full, thinkingReadsFrom: [3] }), false);
  assert.equal(isModelEntry({ ...full, defaultEffort: "" }), false);
  assert.equal(isModelEntry({ ...full, retiresNotBefore: "soon" }), false);
});

test("malformed rows cost only themselves", () => {
  const parsed = parseModelSeedEntries({
    version: 1,
    models: [
      entry({ id: "good", rank: 1 }),
      { id: "", provider: "x", label: "x", rank: 1, agentModel: "x", source: "x", available: true },
      { id: "no-label", provider: "x", rank: 2, agentModel: "x", source: "x", available: true },
      { id: "bad-rank", provider: "x", label: "x", rank: 0, agentModel: "x", source: "x", available: true },
      { id: "fraction", provider: "x", label: "x", rank: 1.5, agentModel: "x", source: "x", available: true },
      "not-an-object",
    ],
  });
  assert.deepEqual(parsed.map((row) => row.id), ["good"]);
});

test("summary is optional, but when present it must be a string", () => {
  assert.equal(isModelEntry({ ...entry({ id: "a" }), summary: "Fastest" }), true);
  assert.equal(isModelEntry({ ...entry({ id: "a" }), summary: 3 }), false);
  assert.equal(isModelEntry(entry({ id: "a" })), true);
});

test("a seed with no version, or a malformed one, reads as version 0", () => {
  assert.equal(parseModelSeedVersion([]), 0);
  assert.equal(parseModelSeedVersion({ models: [] }), 0);
  assert.equal(parseModelSeedVersion({ version: -1, models: [] }), 0);
  assert.equal(parseModelSeedVersion({ version: 1.5, models: [] }), 0);
  assert.equal(parseModelSeedVersion("nope"), 0);
});

test("the stored catalog tolerates garbage and keeps valid rows in stored order", () => {
  assert.deepEqual(parseModelCatalog(undefined), []);
  assert.deepEqual(parseModelCatalog("x"), []);
  const parsed = parseModelCatalog([entry({ id: "b" }), { id: 3 }, entry({ id: "a" })]);
  assert.deepEqual(parsed.map((row) => row.id), ["b", "a"]);
});

test("orderedLadder puts ranked entries by rank first, then unranked ones in stored order", () => {
  const ladder = orderedLadder([
    entry({ id: "unranked-1" }),
    entry({ id: "small", rank: 3 }),
    entry({ id: "big", rank: 1 }),
    entry({ id: "unranked-2" }),
    entry({ id: "mid", rank: 2 }),
  ]);
  assert.deepEqual(ladder.map((row) => row.id), ["big", "mid", "small", "unranked-1", "unranked-2"]);
});

test("availableLadder keeps only ranked entries the user marked available, largest first", () => {
  const ladder = availableLadder([
    entry({ id: "big", rank: 1, available: false }),
    entry({ id: "mid", rank: 2 }),
    entry({ id: "unranked" }),
    entry({ id: "small", rank: 3 }),
  ]);
  assert.deepEqual(ladder.map((row) => row.id), ["mid", "small"]);
});

test("availableLadder of an empty catalog is empty", () => {
  assert.deepEqual(availableLadder([]), []);
});
