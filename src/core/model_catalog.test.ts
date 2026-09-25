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
    ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  );
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
