import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import {
  applyModelSeedChoices,
  decideModelSeedNotice,
  diffModelSeed,
  parseModelOfferedVersion,
  shouldSeedModels,
} from "./model_seed_notice.ts";

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
