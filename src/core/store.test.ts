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

import { GATE_CONSEQUENCE_CEILING } from "./decisions.ts";
import { getCatalog, getConfig, getPolicies, setPolicies, type CatalogData, type PolicyRow, type StorageHost } from "./store.ts";

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

// ---------------------------------------------------------------------------
// config.thresholds -- odd/tasks/production-honesty-pass.md P2/P3.
//
// P2: actThreshold, confirmThreshold, reversibleGate and externalGate were
// declared here, validated, defaulted and editable from the config panel --
// and read by no decision anywhere in src/ or adapters/ (grepped whole tree,
// excluding tests/panels/i18n). Removed rather than wired: nobody could say
// what they were supposed to do, and inventing a meaning for a number is how
// this project got a wrong ceiling twice already.
//
// Only `consequenceCeiling` remains on PluginThresholds, kept per this
// task's explicit scope -- but the same grep found no decision reads this
// STORED value out either. gate-bash.ts's decideGateAction call takes its
// consequenceCeiling from the per-destination catalog.ts override
// (matched?.autonomy?.consequenceCeiling, a different object with the same
// field name) or straight from decisions.ts's own GATE_CONSEQUENCE_CEILING
// constant, never from getConfig()'s PluginConfig.thresholds. Only
// `jevBudgetMs` (this file's sibling field) is actually consumed, in
// main.mjs's cmdDecide. See this task's own report for this caveat.
//
// A config saved before this removal still has the four dead keys sitting in
// storage. That is not corruption -- isPluginThresholds only requires
// `consequenceCeiling` to be a number now, so the extra keys are ignored,
// never rejected.
//
// P3: the default `consequenceCeiling` used to repeat the literal 1.5 --
// the value measured wrong and replaced by GATE_CONSEQUENCE_CEILING (1.78)
// in decisions.ts. Third place that number went stale; it must come from
// the constant.
// ---------------------------------------------------------------------------

test("getConfig: default thresholds.consequenceCeiling comes from GATE_CONSEQUENCE_CEILING, not a repeated literal", async () => {
  const host = fakeHost();
  const config = await getConfig(host);
  assert.equal(config.thresholds.consequenceCeiling, GATE_CONSEQUENCE_CEILING);
});

test("getConfig: a config carrying ONLY consequenceCeiling (no dead threshold fields) loads through rather than falling back to the default", async () => {
  const host = fakeHost({
    config: { thresholds: { consequenceCeiling: 2.5 }, logMaxEntries: 250, jevBudgetMs: 9000 },
  });
  const config = await getConfig(host);
  assert.equal(config.thresholds.consequenceCeiling, 2.5);
  assert.equal(config.logMaxEntries, 250);
  assert.equal(config.jevBudgetMs, 9000);
});

test("getConfig: a config saved before the four dead threshold fields were removed still loads -- an old config is not a corrupt one", async () => {
  const host = fakeHost({
    config: {
      thresholds: { actThreshold: 0.9, confirmThreshold: 0.6, reversibleGate: 0.7, externalGate: 0.35, consequenceCeiling: 2.1 },
      logMaxEntries: 250,
      jevBudgetMs: 9000,
    },
  });
  const config = await getConfig(host);
  assert.equal(config.thresholds.consequenceCeiling, 2.1);
  assert.equal(config.logMaxEntries, 250);
});

test("getConfig: a config with a malformed (non-numeric) consequenceCeiling fails validation and falls back to the default config", async () => {
  const host = fakeHost({ config: { thresholds: { consequenceCeiling: "not-a-number" }, logMaxEntries: 250, jevBudgetMs: 9000 } });
  const config = await getConfig(host);
  assert.equal(config.thresholds.consequenceCeiling, GATE_CONSEQUENCE_CEILING);
  assert.equal(config.logMaxEntries, 500);
});
