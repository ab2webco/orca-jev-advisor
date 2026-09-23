// Unit tests for loadPolicies' validation, in particular the `kind` field
// added to fix interpretDestinationPolicy treating every policy as a
// prohibition. Run with:
//   node --test src/core/policies.test.ts
// (this project has no test runner configured yet; node:test is the
// built-in one, and Node 24's native TypeScript support runs this file
// directly, same as src/core/gate_stats.test.ts already does).

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPolicies } from "./policies.ts";

async function withPoliciesFile(content: unknown, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "policies-test-"));
  const path = join(dir, "policies.json");
  try {
    await writeFile(path, JSON.stringify(content), "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loads a well-formed policies file with a valid kind on every row", async () => {
  await withPoliciesFile(
    [
      { id: "a", rule: "rule a", kind: "permits" },
      { id: "b", rule: "rule b", kind: "requires_human" },
      { id: "c", rule: "rule c", kind: "prohibits" },
    ],
    async (path) => {
      const policies = await loadPolicies(path);
      assert.deepEqual(policies, [
        { id: "a", rule: "rule a", kind: "permits" },
        { id: "b", rule: "rule b", kind: "requires_human" },
        { id: "c", rule: "rule c", kind: "prohibits" },
      ]);
    },
  );
});

test("throws a descriptive error naming the row index when kind is missing", async () => {
  await withPoliciesFile([{ id: "a", rule: "rule a" }], async (path) => {
    await assert.rejects(() => loadPolicies(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /posicion 0/);
      assert.match(error.message, /'a'/);
      assert.match(error.message, /permits, requires_human, prohibits/);
      return true;
    });
  });
});

test("throws a descriptive error naming the row index when kind is an invalid value", async () => {
  await withPoliciesFile([{ id: "a", rule: "rule a", kind: "permits" }, { id: "b", rule: "rule b", kind: "maybe" }], async (path) => {
    await assert.rejects(() => loadPolicies(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /posicion 1/);
      assert.match(error.message, /'b'/);
      return true;
    });
  });
});

test("still rejects a row missing id/rule before it ever looks at kind", async () => {
  await withPoliciesFile([{ rule: "no id", kind: "permits" }], async (path) => {
    await assert.rejects(() => loadPolicies(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /'id' y 'rule'/);
      return true;
    });
  });
});
