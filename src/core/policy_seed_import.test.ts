// Unit tests for policy_seed_import.ts -- pure input to pure output, no
// filesystem. Run with:
//   node --test --experimental-strip-types src/core/policy_seed_import.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { mergePolicySeeds } from "./policy_seed_import.ts";

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
