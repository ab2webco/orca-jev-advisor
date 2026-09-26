// Unit tests for parseMirroredCatalog/parseMirroredPolicies -- pure input
// to pure output, no filesystem, no network. Run with:
//   node --test src/core/gate_catalog_mirror.test.ts
//
// These are the only gate the disk-mirrored catalog/policies files pass
// through before they can influence the live command gate's verdict, so
// the point of this suite is the fail-open side: anything malformed must
// resolve to null/dropped, never throw and never get handed to
// matchDestination/decideGateAction half-shaped.

import assert from "node:assert/strict";
import test from "node:test";

import { parseMirroredCatalog, parseMirroredPolicies } from "./gate_catalog_mirror.ts";

test("a well-formed catalog mirror parses through", () => {
  const raw = {
    destinations: [
      { id: "a", worktreePath: "/Users/x/a" },
      { id: "b", worktreePath: "/Users/x/b", autonomy: { consequenceCeiling: 2 } },
    ],
  };
  const parsed = parseMirroredCatalog(raw);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.destinations.length, 2);
  assert.equal(parsed?.destinations[1]?.autonomy?.consequenceCeiling, 2);
});

test("a destination with no autonomy field at all is still valid -- it's optional", () => {
  const raw = { destinations: [{ id: "a", worktreePath: "/Users/x/a" }] };
  assert.notEqual(parseMirroredCatalog(raw), null);
});

test("catalog validation is all-or-nothing over destinations, matching store.ts's own getCatalog", () => {
  const raw = {
    destinations: [
      { id: "a", worktreePath: "/Users/x/a" },
      { id: "b" /* missing worktreePath */ },
    ],
  };
  assert.equal(parseMirroredCatalog(raw), null);
});

test("a destination with a non-numeric consequenceCeiling invalidates the whole catalog", () => {
  const raw = { destinations: [{ id: "a", worktreePath: "/Users/x/a", autonomy: { consequenceCeiling: "high" } }] };
  assert.equal(parseMirroredCatalog(raw), null);
});

test("catalog: not an object, missing destinations, or destinations not an array all resolve to null", () => {
  assert.equal(parseMirroredCatalog(null), null);
  assert.equal(parseMirroredCatalog("catalog"), null);
  assert.equal(parseMirroredCatalog([]), null);
  assert.equal(parseMirroredCatalog({}), null);
  assert.equal(parseMirroredCatalog({ destinations: "not-an-array" }), null);
});

test("a well-formed, empty catalog (destinations: []) is valid, not null", () => {
  const parsed = parseMirroredCatalog({ destinations: [] });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.destinations.length, 0);
});

test("a well-formed policies mirror parses through, including the optional destinations scope", () => {
  const raw = [
    { id: "p1", rule: "never force-push", kind: "prohibits" },
    { id: "p2", rule: "npm test is fine", kind: "permits", destinations: ["a", "b"] },
  ];
  const parsed = parseMirroredPolicies(raw);
  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.[1]?.destinations, ["a", "b"]);
});

test("policies: one malformed row is dropped, sibling valid rows survive -- row-by-row, not all-or-nothing", () => {
  const raw = [
    { id: "p1", rule: "ok", kind: "permits" },
    { id: "p2", rule: "bad kind" /* missing kind */ },
    { id: "p3", rule: "also bad", kind: "not-a-real-kind" },
    { id: "p4", rule: "ok too", kind: "requires_human" },
  ];
  const parsed = parseMirroredPolicies(raw);
  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.map((p) => p.id), ["p1", "p4"]);
});

test("policies: a row whose destinations field isn't an array of strings is dropped", () => {
  const raw = [{ id: "p1", rule: "ok", kind: "permits", destinations: "not-an-array" }];
  assert.equal(parseMirroredPolicies(raw)?.length, 0);
});

test("policies: top-level value not an array at all resolves to null, not an empty array", () => {
  assert.equal(parseMirroredPolicies({ policies: [] }), null);
  assert.equal(parseMirroredPolicies(null), null);
  assert.equal(parseMirroredPolicies("policies"), null);
});

test("policies: an empty array is valid -- distinct from the null case above", () => {
  assert.deepEqual(parseMirroredPolicies([]), []);
});

// ---------------------------------------------------------------------------
// scope -- odd/tasks/release-0.5.1.md T2. Same row-by-row tolerance as
// destinations above: a bad `scope` costs only that FIELD (T10, JEVADV-28,
// R4), never the whole row.
// ---------------------------------------------------------------------------

test("policies: a valid 'command', 'process' or 'local-rule' scope parses through", () => {
  const raw = [
    { id: "p1", rule: "screenshots get looked at", kind: "prohibits", scope: "process" },
    { id: "p2", rule: "never force-push", kind: "prohibits", scope: "command" },
    { id: "p3", rule: "already denied locally", kind: "prohibits", scope: "local-rule" },
  ];
  const parsed = parseMirroredPolicies(raw);
  assert.equal(parsed?.length, 3);
  assert.equal(parsed?.[0]?.scope, "process");
  assert.equal(parsed?.[1]?.scope, "command");
  assert.equal(parsed?.[2]?.scope, "local-rule");
});

test("policies: a row with no scope field at all is still valid -- absent means 'resolve it later'", () => {
  const raw = [{ id: "p1", rule: "ok", kind: "permits" }];
  const parsed = parseMirroredPolicies(raw);
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.scope, undefined);
});

// R4: an invalid `scope` used to drop the whole row -- MORE permissive on
// what is probably a typo (a `prohibits` row silently stopped applying at
// all, instead of resolving to `"command"` or its seed's own scope). The row
// must survive, with `scope` resolved to absent.
test("policies: a row with an invalid scope value keeps the row, with scope resolved to absent", () => {
  const raw = [
    { id: "p1", rule: "ok", kind: "permits", scope: "command" },
    { id: "bad", rule: "bad scope", kind: "permits", scope: "sometimes" },
  ];
  const parsed = parseMirroredPolicies(raw);
  assert.deepEqual(parsed?.map((p) => p.id), ["p1", "bad"]);
  assert.equal(parsed?.find((p) => p.id === "bad")?.scope, undefined);
});
