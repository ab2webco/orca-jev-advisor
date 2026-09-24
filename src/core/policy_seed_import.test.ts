// Unit tests for policy_seed_import.ts -- pure input to pure output, no
// filesystem. Run with:
//   node --test --experimental-strip-types src/core/policy_seed_import.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { applyPolicySeedChoices, mergePolicySeeds } from "./policy_seed_import.ts";

test("mergePolicySeeds adds only ids not already present, appended after the existing rows", () => {
  const existing = [{ id: "a", rule: "rule a", kind: "permits" }];
  const seeds = [
    { id: "a", rule: "seed a (must be ignored: id already present)", kind: "prohibits" },
    { id: "b", rule: "rule b", kind: "requires_human" },
  ];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.merged, [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "requires_human" },
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
});

test("mergePolicySeeds never overwrites an existing row, even one left incomplete (blank kind)", () => {
  // Mirrors store.ts's own getPolicies note: an incomplete row (blank/invalid
  // `kind`) is not lost, only ignored when deciding -- an import must not be
  // the thing that finally deletes it.
  const existing = [{ id: "half-done", rule: "not sure yet", kind: "" }];
  const seeds = [{ id: "half-done", rule: "seed version", kind: "permits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.merged, existing);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
});

test("mergePolicySeeds adds every seed when nothing exists yet", () => {
  const seeds = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "prohibits" },
  ];
  const result = mergePolicySeeds([], seeds);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.merged, seeds);
});

test("mergePolicySeeds is a no-op when every seed id is already present", () => {
  const existing = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "prohibits" },
  ];
  const seeds = [
    { id: "a", rule: "different text", kind: "requires_human" },
    { id: "b", rule: "different text 2", kind: "permits" },
  ];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.merged, existing);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 2);
});

test("mergePolicySeeds reports no differing entries when every shared id is byte-identical", () => {
  const existing = [{ id: "a", rule: "rule a", kind: "permits", destinations: ["x"] }];
  const seeds = [{ id: "a", rule: "rule a", kind: "permits", destinations: ["x"] }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
  assert.equal(result.skipped, 1);
});

test("mergePolicySeeds reports an id differing only in rule", () => {
  const existing = [{ id: "a", rule: "old rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "new rule", kind: "permits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, [
    {
      id: "a",
      existing: existing[0],
      seed: seeds[0],
      fields: ["rule"],
    },
  ]);
});

test("mergePolicySeeds reports an id differing only in kind", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "same rule", kind: "prohibits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, [
    {
      id: "a",
      existing: existing[0],
      seed: seeds[0],
      fields: ["kind"],
    },
  ]);
});

test("mergePolicySeeds reports an id differing only in destinations", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "permits", destinations: ["x"] }];
  const seeds = [{ id: "a", rule: "same rule", kind: "permits", destinations: ["x", "y"] }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, [
    {
      id: "a",
      existing: existing[0],
      seed: seeds[0],
      fields: ["destinations"],
    },
  ]);
});

test("mergePolicySeeds treats an absent destinations and an empty array as the same thing", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "same rule", kind: "permits", destinations: [] }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
});

test("mergePolicySeeds does not report destinations as differing when only reordered", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "permits", destinations: ["y", "x"] }];
  const seeds = [{ id: "a", rule: "same rule", kind: "permits", destinations: ["x", "y"] }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
});

test("mergePolicySeeds sorts several differing ids by id", () => {
  const existing = [
    { id: "z", rule: "old z", kind: "permits" },
    { id: "a", rule: "old a", kind: "permits" },
    { id: "m", rule: "old m", kind: "permits" },
  ];
  const seeds = [
    { id: "z", rule: "new z", kind: "permits" },
    { id: "a", rule: "new a", kind: "permits" },
    { id: "m", rule: "new m", kind: "permits" },
  ];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(
    result.differing.map((entry) => entry.id),
    ["a", "m", "z"],
  );
});

test("applyPolicySeedChoices changes nothing when acceptedIds is empty", () => {
  const existing = [{ id: "a", rule: "old a", kind: "permits" }];
  const seeds = [{ id: "a", rule: "new a", kind: "permits" }];
  const { result, replaced } = applyPolicySeedChoices(existing, seeds, []);
  assert.deepEqual(result, existing);
  assert.equal(replaced, 0);
});

test("applyPolicySeedChoices replaces only the accepted subset", () => {
  const existing = [
    { id: "a", rule: "old a", kind: "permits" },
    { id: "b", rule: "old b", kind: "permits" },
  ];
  const seeds = [
    { id: "a", rule: "new a", kind: "prohibits" },
    { id: "b", rule: "new b", kind: "prohibits" },
  ];
  const { result, replaced } = applyPolicySeedChoices(existing, seeds, ["a"]);
  assert.deepEqual(result, [
    { id: "a", rule: "new a", kind: "prohibits" },
    { id: "b", rule: "old b", kind: "permits" },
  ]);
  assert.equal(replaced, 1);
});

test("applyPolicySeedChoices ignores an accepted id that is not in the seed", () => {
  const existing = [{ id: "a", rule: "old a", kind: "permits" }];
  const seeds: { id: string; rule: string; kind: string }[] = [];
  const { result, replaced } = applyPolicySeedChoices(existing, seeds, ["a"]);
  assert.deepEqual(result, existing);
  assert.equal(replaced, 0);
});

test("applyPolicySeedChoices ignores an accepted id that is not in existing", () => {
  const existing = [{ id: "a", rule: "old a", kind: "permits" }];
  const seeds = [{ id: "unknown", rule: "new", kind: "permits" }];
  const { result, replaced } = applyPolicySeedChoices(existing, seeds, ["unknown"]);
  assert.deepEqual(result, existing);
  assert.equal(replaced, 0);
});

test("applyPolicySeedChoices counts a duplicated accepted id only once", () => {
  const existing = [{ id: "a", rule: "old a", kind: "permits" }];
  const seeds = [{ id: "a", rule: "new a", kind: "permits" }];
  const { result, replaced } = applyPolicySeedChoices(existing, seeds, ["a", "a"]);
  assert.deepEqual(result, [{ id: "a", rule: "new a", kind: "permits" }]);
  assert.equal(replaced, 1);
});

test("applyPolicySeedChoices preserves list order after a replacement", () => {
  const existing = [
    { id: "a", rule: "old a", kind: "permits" },
    { id: "b", rule: "old b", kind: "permits" },
    { id: "c", rule: "old c", kind: "permits" },
  ];
  const seeds = [
    { id: "a", rule: "new a", kind: "permits" },
    { id: "b", rule: "new b", kind: "permits" },
    { id: "c", rule: "new c", kind: "permits" },
  ];
  const { result } = applyPolicySeedChoices(existing, seeds, ["c", "a"]);
  assert.deepEqual(
    result.map((row) => row.id),
    ["a", "b", "c"],
  );
  assert.equal(result[0].rule, "new a");
  assert.equal(result[1].rule, "old b");
  assert.equal(result[2].rule, "new c");
});
