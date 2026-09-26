// Unit tests for auditPoliciesWithoutKind -- pure input to pure output, no
// filesystem, no process. Run with:
//   node --test src/core/policy_kind_audit.test.ts
//
// JEVADV-49: a config-panel save (before a panel fix for legacy Spanish
// kinds was loaded) left 20 of 23 stored policies with no `kind` at all.
// store.ts's getPolicies silently excludes exactly those rows from the
// policy stage, with no error and no trace -- this audit is what makes that
// state visible instead of silent.

import assert from "node:assert/strict";
import test from "node:test";

import { auditPoliciesWithoutKind } from "./policy_kind_audit.ts";

test("every row carries a valid kind: count is 0 and ids is empty", () => {
  const rows = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "requires_human" },
  ];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 0, ids: [] });
});

test("a row with no kind field at all is reported by id", () => {
  const rows = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b" },
  ];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 1, ids: ["b"] });
});

test("the real incident: 20 of 23 rows missing kind are all reported", () => {
  const withKind = Array.from({ length: 3 }, (_, i) => ({ id: `k${i}`, rule: `rule ${i}`, kind: "permits" }));
  const withoutKind = Array.from({ length: 20 }, (_, i) => ({ id: `nk${i}`, rule: `rule ${i}` }));
  const audit = auditPoliciesWithoutKind([...withKind, ...withoutKind]);
  assert.equal(audit.count, 20);
  assert.deepEqual([...audit.ids].sort(), withoutKind.map((r) => r.id).sort());
});

test("a row with an unrecognised (not just missing) kind string is reported too", () => {
  const rows = [{ id: "a", rule: "rule a", kind: "not-a-real-kind" }];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 1, ids: ["a"] });
});

test("a row with a legacy Spanish kind (permite/prohibe/pregunta) is NOT reported -- migratePolicyKind still recognises it", () => {
  const rows = [
    { id: "a", rule: "rule a", kind: "permite" },
    { id: "b", rule: "rule b", kind: "prohibe" },
    { id: "c", rule: "rule c", kind: "pregunta" },
  ];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 0, ids: [] });
});

test("a row with no string id is skipped -- it is not a policy this audit can name", () => {
  const rows = [{ rule: "rule with no id" }, { id: 42, rule: "numeric id" }];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 0, ids: [] });
});

test("non-record entries (null, a string, an array) are skipped rather than crashing", () => {
  const rows = [null, "not a policy", ["also not a policy"], { id: "real", rule: "r" }];
  assert.deepEqual(auditPoliciesWithoutKind(rows), { count: 1, ids: ["real"] });
});

test("an empty array reports zero, not an error", () => {
  assert.deepEqual(auditPoliciesWithoutKind([]), { count: 0, ids: [] });
});
