// Unit tests for getPolicies/setPolicies' row-level `kind` validation.
//
// Covers the gap described alongside PolicyRow gaining `kind`: a policy row
// written before `kind` existed (or with a stray invalid value) must NOT
// silently wipe out every OTHER policy the user configured, and must not be
// guessed into a kind either. See the long comment on getPolicies in
// store.ts for the full reasoning.
//
// Run with:
//   node --test src/core/store.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { getCatalog, getPolicies, setPolicies, type CatalogData, type PolicyRow, type StorageHost } from "./store.ts";

/** Minimal in-memory StorageHost, enough for getPolicies/setPolicies. */
function fakeHost(initial: Record<string, unknown> = {}): StorageHost {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key: string): Promise<unknown> {
      return data.has(key) ? data.get(key) : undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...data.keys()];
    },
  };
}

test("getPolicies returns [] when nothing was ever stored", async () => {
  const host = fakeHost();
  assert.deepEqual(await getPolicies(host), []);
});

test("getPolicies loads every row when all of them have a valid kind", async () => {
  const rows: PolicyRow[] = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "requires_human" },
    { id: "c", rule: "rule c", kind: "prohibits" },
  ];
  const host = fakeHost({ policies: rows });
  assert.deepEqual(await getPolicies(host), rows);
});

test("a row with no kind at all is excluded, but sibling valid rows are still returned (no whole-array wipeout)", async () => {
  const host = fakeHost({
    policies: [
      { id: "a", rule: "rule a", kind: "permits" },
      { id: "legacy", rule: "written before kind existed" }, // missing `kind`
      { id: "c", rule: "rule c", kind: "prohibits" },
    ],
  });
  const policies = await getPolicies(host);
  assert.deepEqual(policies, [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "c", rule: "rule c", kind: "prohibits" },
  ]);
});

test("a row with an invalid kind value is excluded the same way a missing one is", async () => {
  const host = fakeHost({
    policies: [
      { id: "a", rule: "rule a", kind: "permits" },
      { id: "typo", rule: "rule with a typo'd kind", kind: "mayve" },
    ],
  });
  const policies = await getPolicies(host);
  assert.deepEqual(policies, [{ id: "a", rule: "rule a", kind: "permits" }]);
});

test("when every row is invalid, getPolicies returns an empty array rather than throwing", async () => {
  const host = fakeHost({ policies: [{ id: "a", rule: "no kind here" }] });
  assert.deepEqual(await getPolicies(host), []);
});

test("a non-array stored value falls back to the empty default instead of throwing", async () => {
  const host = fakeHost({ policies: { not: "an array" } });
  assert.deepEqual(await getPolicies(host), []);
});

test("setPolicies writes the raw value verbatim (including an incomplete row) -- it is not this function's job to drop it", async () => {
  const host = fakeHost();
  const rows = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "legacy", rule: "still needs a kind chosen" },
  ] as unknown as readonly PolicyRow[];
  await setPolicies(host, rows);
  assert.deepEqual(await host.get("policies"), rows);
  // But reading it back through getPolicies still only surfaces the valid one.
  assert.deepEqual(await getPolicies(host), [{ id: "a", rule: "rule a", kind: "permits" }]);
});

// ===========================================================================
// PolicyRow.destinations -- optional per-destination policy scope
// ===========================================================================

test("getPolicies: a row with no destinations field at all is today's global behavior, still valid", async () => {
  const rows: PolicyRow[] = [{ id: "a", rule: "rule a", kind: "permits" }];
  const host = fakeHost({ policies: rows });
  assert.deepEqual(await getPolicies(host), rows);
});

test("getPolicies: an empty destinations array is valid (global, same as absent)", async () => {
  const rows: PolicyRow[] = [{ id: "a", rule: "rule a", kind: "permits", destinations: [] }];
  const host = fakeHost({ policies: rows });
  assert.deepEqual(await getPolicies(host), rows);
});

test("getPolicies: a non-empty destinations array of strings is valid and preserved", async () => {
  const rows: PolicyRow[] = [{ id: "a", rule: "rule a", kind: "permits", destinations: ["site-a", "site-b"] }];
  const host = fakeHost({ policies: rows });
  assert.deepEqual(await getPolicies(host), rows);
});

test("getPolicies: a row with a malformed destinations value (not an array of strings) is excluded, siblings survive", async () => {
  const host = fakeHost({
    policies: [
      { id: "a", rule: "rule a", kind: "permits", destinations: ["site-a"] },
      { id: "bad", rule: "malformed destinations", kind: "permits", destinations: [1, 2, 3] },
      { id: "also-bad", rule: "destinations is not an array", kind: "permits", destinations: "site-a" },
      { id: "c", rule: "rule c", kind: "prohibits" },
    ],
  });
  const policies = await getPolicies(host);
  assert.deepEqual(policies, [
    { id: "a", rule: "rule a", kind: "permits", destinations: ["site-a"] },
    { id: "c", rule: "rule c", kind: "prohibits" },
  ]);
});

// ===========================================================================
// AutonomyConfig.consequenceCeiling -- optional per-destination gate override
// ===========================================================================

function destination(autonomyExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dest-a",
    label: "Destination A",
    kind: "project",
    worktreePath: "/path/to/dest-a",
    autonomy: { actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2, ...autonomyExtra },
  };
}

test("getCatalog: a destination missing consequenceCeiling loads fine (today's real seeded data)", async () => {
  const host = fakeHost({ catalog: { destinations: [destination()] } });
  const catalog: CatalogData = await getCatalog(host);
  assert.equal(catalog.destinations.length, 1);
  assert.equal(catalog.destinations[0]?.autonomy.consequenceCeiling, undefined);
});

test("getCatalog: a destination with a valid numeric consequenceCeiling loads it through", async () => {
  const host = fakeHost({ catalog: { destinations: [destination({ consequenceCeiling: 2.0 })] } });
  const catalog: CatalogData = await getCatalog(host);
  assert.equal(catalog.destinations[0]?.autonomy.consequenceCeiling, 2.0);
});

test("getCatalog: a destination with a malformed (non-numeric) consequenceCeiling fails validation and falls back to the default empty catalog", async () => {
  // isCatalogData's isArrayOf is all-or-nothing (same pre-existing design as
  // the rest of getCatalog's validation) -- one malformed destination fails
  // the whole array, which then falls back to the documented empty default,
  // rather than throwing.
  const host = fakeHost({ catalog: { destinations: [destination({ consequenceCeiling: "not-a-number" })] } });
  const catalog: CatalogData = await getCatalog(host);
  assert.deepEqual(catalog, { destinations: [] });
});
