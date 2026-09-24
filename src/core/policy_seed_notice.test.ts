import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PolicySeedLike } from "./policy_seed_import.ts";
import { decidePolicySeedNotice, parseOfferedVersion } from "./policy_seed_notice.ts";

function row(id: string, rule: string, kind: PolicySeedLike["kind"] = "permits"): PolicySeedLike {
  return { id, rule, kind };
}

// ---------------------------------------------------------------------------
// parseOfferedVersion
// ---------------------------------------------------------------------------

test("parseOfferedVersion reads the version off a { version, at } marker", () => {
  assert.equal(parseOfferedVersion({ version: 2, at: "2026-09-24T00:00:00.000Z" }), 2);
  assert.equal(parseOfferedVersion({ version: 0, at: "2026-09-24T00:00:00.000Z" }), 0);
});

test("parseOfferedVersion reports 0 for an install that was never offered anything, rather than guessing", () => {
  for (const bad of [undefined, null, {}, [], 7, "text", { version: "1" }, { version: -1 }, { version: 1.5 }]) {
    assert.equal(parseOfferedVersion(bad), 0, `expected 0 for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// decidePolicySeedNotice
// ---------------------------------------------------------------------------

test("due when the shipped version is newer and the merge finds something to add", () => {
  const decision = decidePolicySeedNotice({
    shippedVersion: 2,
    offeredVersion: 1,
    existing: [row("own_branch", "old wording")],
    shipped: [row("own_branch", "old wording"), row("new_row", "brand new")],
  });
  assert.equal(decision.due, true);
  assert.equal(decision.added, 1);
  assert.equal(decision.differing, 0);
  assert.equal(decision.shippedVersion, 2);
});

test("due when the shipped version is newer and the merge finds something differing", () => {
  const decision = decidePolicySeedNotice({
    shippedVersion: 2,
    offeredVersion: 1,
    existing: [row("own_branch", "old wording")],
    shipped: [row("own_branch", "new wording")],
  });
  assert.equal(decision.due, true);
  assert.equal(decision.added, 0);
  assert.equal(decision.differing, 1);
});

test("not due when the shipped version is newer but nothing this install has actually differs", () => {
  const decision = decidePolicySeedNotice({
    shippedVersion: 2,
    offeredVersion: 1,
    existing: [row("own_branch", "same wording")],
    shipped: [row("own_branch", "same wording")],
  });
  assert.equal(decision.due, false);
  assert.equal(decision.added, 0);
  assert.equal(decision.differing, 0);
});

test("not due when this install was already offered the shipped version", () => {
  const decision = decidePolicySeedNotice({
    shippedVersion: 2,
    offeredVersion: 2,
    existing: [row("own_branch", "old wording")],
    shipped: [row("own_branch", "new wording"), row("new_row", "brand new")],
  });
  assert.equal(decision.due, false);
  // The counts are still real -- a dismissed notice does not lie about there
  // being nothing left, it just stops nagging about it.
  assert.equal(decision.added, 1);
  assert.equal(decision.differing, 1);
});

test("not due when the offered version is somehow ahead of the shipped one", () => {
  const decision = decidePolicySeedNotice({
    shippedVersion: 1,
    offeredVersion: 2,
    existing: [row("own_branch", "old wording")],
    shipped: [row("own_branch", "new wording")],
  });
  assert.equal(decision.due, false);
});

test("never invents a reason: an install with nothing stored and a shipped baseline is due, with real added counts", () => {
  const shipped = [row("a", "rule a"), row("b", "rule b"), row("c", "rule c")];
  const decision = decidePolicySeedNotice({
    shippedVersion: 1,
    offeredVersion: 0,
    existing: [],
    shipped,
  });
  assert.equal(decision.due, true);
  assert.equal(decision.added, shipped.length);
  assert.equal(decision.differing, 0);
});

test("markOffered only when the shipped version is newer and there is nothing to tell", () => {
  const same = [row("own_branch", "same wording")];
  assert.equal(decidePolicySeedNotice({ shippedVersion: 2, offeredVersion: 1, existing: same, shipped: same }).markOffered, true);
  // Already offered this version: nothing to record.
  assert.equal(decidePolicySeedNotice({ shippedVersion: 2, offeredVersion: 2, existing: same, shipped: same }).markOffered, false);
  // Offered ahead (a downgrade): recording the shipped version would LOWER
  // the marker and re-notify on the next upgrade.
  assert.equal(decidePolicySeedNotice({ shippedVersion: 1, offeredVersion: 2, existing: same, shipped: same }).markOffered, false);
  // Something to tell: the notice speaks instead.
  const due = decidePolicySeedNotice({ shippedVersion: 2, offeredVersion: 1, existing: [], shipped: same });
  assert.equal(due.due, true);
  assert.equal(due.markOffered, false);
});
