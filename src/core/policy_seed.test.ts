import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { POLICY_SEED_MARKER_KEY, parseSeedPolicies, shouldSeedPolicies } from "./policy_seed.ts";

const seedFile: unknown = JSON.parse(
  readFileSync(new URL("../../seed/policies.json", import.meta.url), "utf8"),
);

test("the shipped seed is readable, and every row in it survives validation", () => {
  // The whole defect was a seed nobody read. If a row is ever added that the
  // validator rejects, it would be dropped in silence exactly the way the
  // entire file used to be -- so the count is asserted, not just the parse.
  assert.ok(Array.isArray(seedFile), "seed/policies.json is not an array");
  const parsed = parseSeedPolicies(seedFile);
  assert.equal(parsed.length, (seedFile as unknown[]).length, "some shipped rows are not valid policies");
  assert.ok(parsed.length > 0, "the shipped seed is empty");
});

test("every shipped row carries a kind the gate actually understands", () => {
  const kinds = new Set(parseSeedPolicies(seedFile).map((row) => row.kind));
  for (const kind of kinds) {
    assert.ok(["permits", "requires_human", "prohibits"].includes(kind), `unknown kind: ${kind}`);
  }
});

test("shipped ids are unique, because an id is how a person edits a row later", () => {
  const ids = parseSeedPolicies(seedFile).map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "the shipped seed repeats an id");
});

test("malformed rows cost only themselves", () => {
  const parsed = parseSeedPolicies([
    { id: "good", kind: "permits", rule: "fine" },
    { id: "no-kind", rule: "missing its kind" },
    null,
    "text",
    { id: "bad-kind", kind: "maybe", rule: "unknown kind" },
  ]);
  assert.deepEqual(parsed.map((row) => row.id), ["good"]);
});

test("anything that is not an array yields no rows rather than throwing", () => {
  for (const bad of [null, undefined, {}, 7, "text", { rows: [] }]) {
    assert.deepEqual(parseSeedPolicies(bad), []);
  }
});

test("a machine that has never been seeded and holds no policies gets the seed", () => {
  assert.equal(shouldSeedPolicies(undefined, undefined), true);
  assert.equal(shouldSeedPolicies(undefined, null), true);
  assert.equal(shouldSeedPolicies(undefined, []), true);
  // An array holding nothing valid is as empty as the gate is concerned.
  assert.equal(shouldSeedPolicies(undefined, [{ id: "half" }]), true);
});

test("a marker means never again, which is what keeps a deliberately empty list empty", () => {
  // The reason this is a marker and not an emptiness check: someone who
  // deletes all twenty rows would otherwise get them back -- three of them
  // `prohibits` -- on the very next activation.
  assert.equal(shouldSeedPolicies({ at: "2026-09-24T00:00:00.000Z" }, []), false);
  assert.equal(shouldSeedPolicies({ at: "2026-09-24T00:00:00.000Z" }, undefined), false);
});

test("an unrecognised or corrupted marker still counts as seeded", () => {
  // Re-planting is the destructive direction, so anything present wins.
  for (const marker of [true, 0, "", "yes", {}, [], { shape: "from a later version" }]) {
    assert.equal(shouldSeedPolicies(marker, []), false, `marker ${JSON.stringify(marker)} re-seeded`);
  }
});

test("policies already on the machine are never overwritten, marker or not", () => {
  const mine = [{ id: "mine", kind: "prohibits", rule: "my own rule" }];
  assert.equal(shouldSeedPolicies(undefined, mine), false);
  assert.equal(shouldSeedPolicies({ at: "now" }, mine), false);
});

test("the marker key is the literal the worker reads, so a rename cannot go unnoticed", () => {
  assert.equal(POLICY_SEED_MARKER_KEY, "policiesSeeded");
});
