// Unit tests for loadCatalog's validation of AutonomyConfig.consequenceCeiling
// -- the optional per-destination override of the command gate's
// consequence ceiling (decisions.ts's GATE_CONSEQUENCE_CEILING). Mirrors
// store.ts's getCatalog tests for the same field on the in-memory copy of
// this type; this file covers the file-based loader instead.
// Run with:
//   node --test src/core/catalog.test.ts

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCatalog } from "./catalog.ts";

async function withCatalogFile(content: unknown, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
  const path = join(dir, "catalog.json");
  try {
    await writeFile(path, JSON.stringify(content), "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function destination(autonomyExtra: Record<string, unknown> = {}): unknown {
  return {
    id: "dest-a",
    label: "Destination A",
    kind: "project",
    worktreePath: "/path/to/dest-a",
    autonomy: { actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2, ...autonomyExtra },
  };
}

test("loadCatalog: a destination missing consequenceCeiling loads fine (today's real seeded data)", async () => {
  await withCatalogFile({ destinations: [destination()] }, async (path) => {
    const catalog = await loadCatalog(path);
    assert.equal(catalog.destinations[0]?.autonomy.consequenceCeiling, undefined);
  });
});

test("loadCatalog: a destination with a valid numeric consequenceCeiling loads it through", async () => {
  await withCatalogFile({ destinations: [destination({ consequenceCeiling: 2.0 })] }, async (path) => {
    const catalog = await loadCatalog(path);
    assert.equal(catalog.destinations[0]?.autonomy.consequenceCeiling, 2.0);
  });
});

test("loadCatalog: a destination with a malformed (non-numeric) consequenceCeiling throws a descriptive error", async () => {
  await withCatalogFile({ destinations: [destination({ consequenceCeiling: "not-a-number" })] }, async (path) => {
    await assert.rejects(() => loadCatalog(path), /expected shape/);
  });
});
