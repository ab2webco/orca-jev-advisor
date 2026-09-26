// Unit tests for policy_seed_import.ts -- pure input to pure output, no
// filesystem. Run with:
//   node --test --experimental-strip-types src/core/policy_seed_import.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { applyPolicySeedChoices, mergePolicySeeds, resolvePolicySeedImport } from "./policy_seed_import.ts";

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

// ===========================================================================
// T6 -- odd/tasks/release-0.5.1.md. mergePolicySeeds must normalize `kind`
// with migratePolicyKind before comparing, and compare `scope` by its
// EFFECTIVE (resolved) value, not its raw presence, so an install that only
// carries the legacy Spanish kind or an unscoped row is not reported as
// differing from a seed that already means the same thing.
// ===========================================================================

test("mergePolicySeeds: a stored legacy Spanish kind equal in meaning to the seed's English kind is NOT reported as differing", () => {
  // The exact false positive this task exists to fix: every install still
  // carrying the pre-rename enum saw '20 differing' when most were
  // functionally identical, because the old comparison was a raw string
  // equality that never normalized either side.
  const existing = [{ id: "a", rule: "same rule", kind: "prohibe" }];
  const seeds = [{ id: "a", rule: "same rule", kind: "prohibits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
});

test("mergePolicySeeds: a stored kind that genuinely differs from the seed's (after normalization) is still reported", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "permite" }];
  const seeds = [{ id: "a", rule: "same rule", kind: "prohibits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing.map((d) => d.fields), [["kind"]]);
});

test("mergePolicySeeds: a stored kind that fails to normalize (blank/invalid) against a valid seed kind is reported as differing", () => {
  const existing = [{ id: "a", rule: "same rule", kind: "" }];
  const seeds = [{ id: "a", rule: "same rule", kind: "permits" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing.map((d) => d.fields), [["kind"]]);
});

test("mergePolicySeeds: a stored row missing scope next to a seed that declares one is NOT reported as differing -- it already resolves to the seed's own value under the T2 default rule", () => {
  const existing = [{ id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits" }];
  const seeds = [{ id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits", scope: "process" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
});

test("mergePolicySeeds: an explicit scope that disagrees with the seed's resolved scope IS a real, reportable difference", () => {
  // Unlike the omitted-scope case above, this row has genuinely opted out --
  // a person set scope: 'command' on purpose, and the seed now says
  // 'process'. That changes what the gate does with it, so it must surface.
  const existing = [{ id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits", scope: "command" }];
  const seeds = [{ id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits", scope: "process" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing.map((d) => d.fields), [["scope"]]);
});

// odd/tasks/release-0.5.1.md T10 (JEVADV-34): no_force_push and
// discard_uncommitted_work move from resolving to "command" (seed v2, no
// explicit scope) to the new "local-rule" scope (seed v3) -- the same shape
// of change T2 made for the five process policies, now for a THIRD scope
// value. A stored row that already carries the OLD, explicit resolution
// ("command") is a real, adoptable difference a caller must be able to
// offer; a row that simply never mentioned scope silently follows the seed,
// exactly like T2's own "missing scope" case above.
test("mergePolicySeeds: a stored row with the OLD explicit 'command' scope next to a seed newly marking it 'local-rule' IS a real, reportable difference", () => {
  const existing = [{ id: "no_force_push", rule: "never rewrites history on a remote", kind: "prohibits", scope: "command" }];
  const seeds = [{ id: "no_force_push", rule: "never rewrites history on a remote", kind: "prohibits", scope: "local-rule" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing.map((d) => d.fields), [["scope"]]);
});

test("mergePolicySeeds: a stored row missing scope next to a seed newly marking it 'local-rule' is NOT reported -- it already resolves to the seed's value", () => {
  const existing = [{ id: "no_force_push", rule: "never rewrites history on a remote", kind: "prohibits" }];
  const seeds = [{ id: "no_force_push", rule: "never rewrites history on a remote", kind: "prohibits", scope: "local-rule" }];
  const result = mergePolicySeeds(existing, seeds);
  assert.deepEqual(result.differing, []);
});

test("mergePolicySeeds: two rows that both omit scope never report a scope difference, seed scope notwithstanding", () => {
  const existing = [{ id: "own_branch", rule: "same rule", kind: "permits" }];
  const seeds = [{ id: "own_branch", rule: "same rule", kind: "permits" }];
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

// ===========================================================================
// resolvePolicySeedImport -- odd/tasks/release-0.5.1.md JEVADV-27. The one
// question cmdImportPolicySeeds needs answered and mergePolicySeeds/
// applyPolicySeedChoices alone cannot: after applying whatever the caller
// accepted, is anything genuinely left differing? Additions are always
// merged in regardless of acceptedIds, so `settled` can only ever be about
// `differing` -- see this function's own doc.
// ===========================================================================

test("resolvePolicySeedImport: nothing accepted, a real difference stays reported and unsettled", () => {
  const existing = [{ id: "a", rule: "my own edited rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "seed rule", kind: "permits" }];
  const resolution = resolvePolicySeedImport(existing, seeds, []);
  assert.equal(resolution.replaced, 0);
  assert.equal(resolution.settled, false);
  assert.deepEqual(resolution.remaining.map((d) => d.id), ["a"]);
  assert.deepEqual(resolution.policies, existing, "an unaccepted id must not be replaced");
});

test("resolvePolicySeedImport: accepting the only differing id settles the import", () => {
  const existing = [{ id: "a", rule: "my own edited rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "seed rule", kind: "permits" }];
  const resolution = resolvePolicySeedImport(existing, seeds, ["a"]);
  assert.equal(resolution.replaced, 1);
  assert.equal(resolution.settled, true);
  assert.deepEqual(resolution.remaining, []);
  assert.deepEqual(resolution.policies, seeds);
});

test("resolvePolicySeedImport: accepting one of two differing ids leaves the other reported, unsettled", () => {
  const existing = [
    { id: "a", rule: "my own edited a", kind: "permits" },
    { id: "b", rule: "my own edited b", kind: "permits" },
  ];
  const seeds = [
    { id: "a", rule: "seed a", kind: "permits" },
    { id: "b", rule: "seed b", kind: "permits" },
  ];
  const resolution = resolvePolicySeedImport(existing, seeds, ["a"]);
  assert.equal(resolution.settled, false);
  assert.deepEqual(resolution.remaining.map((d) => d.id), ["b"]);
});

test("resolvePolicySeedImport: pure additions with nothing differing settle immediately, even with acceptedIds empty", () => {
  const existing: { id: string; rule: string; kind: string }[] = [];
  const seeds = [{ id: "a", rule: "seed a", kind: "permits" }];
  const resolution = resolvePolicySeedImport(existing, seeds, []);
  assert.equal(resolution.added, 1);
  assert.equal(resolution.settled, true);
  assert.deepEqual(resolution.remaining, []);
  assert.deepEqual(resolution.policies, seeds);
});

test("resolvePolicySeedImport: an accepted id that does not exist on either side changes nothing and stays unsettled if a real difference remains", () => {
  const existing = [{ id: "a", rule: "my own edited rule", kind: "permits" }];
  const seeds = [{ id: "a", rule: "seed rule", kind: "permits" }];
  const resolution = resolvePolicySeedImport(existing, seeds, ["stale-panel-selection"]);
  assert.equal(resolution.replaced, 0);
  assert.equal(resolution.settled, false);
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
