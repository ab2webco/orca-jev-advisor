// Unit tests for tool_inventory.ts -- the injectable-lister seam and its
// guard, no real `$.tool.list()` involved. Run with:
//   node --test src/core/tool_inventory.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { asToolSummaries, listToolInventory } from "./tool_inventory.ts";
import type { ToolLister } from "./tool_inventory.ts";

test("listToolInventory returns the lister's tools, guarded and in order", async () => {
  const lister: ToolLister = () => Promise.resolve([{ name: "Read", description: "Reads a file.", mcp: false }, { name: "mcp__lab__run", description: "Runs a lab job.", mcp: true }]);
  const tools = await listToolInventory(lister);
  assert.deepEqual(tools, [
    { name: "Read", description: "Reads a file.", mcp: false },
    { name: "mcp__lab__run", description: "Runs a lab job.", mcp: true },
  ]);
});

test("listToolInventory drops malformed entries instead of throwing on them", async () => {
  const lister: ToolLister = () => Promise.resolve([{ name: "Read", description: "Reads a file.", mcp: false }, { name: "Bad", description: 5, mcp: false }, "not even an object", null, { name: "Grep", description: "Searches.", mcp: false }]);
  const tools = await listToolInventory(lister);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["Read", "Grep"],
  );
});

test("listToolInventory deduplicates by name, first occurrence wins", async () => {
  const lister: ToolLister = () =>
    Promise.resolve([
      { name: "Read", description: "First.", mcp: false },
      { name: "Read", description: "Second, should be dropped.", mcp: false },
    ]);
  const tools = await listToolInventory(lister);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.description, "First.");
});

test("listToolInventory never throws: a lister rejection yields an empty roster", async () => {
  const lister: ToolLister = () => Promise.reject(new Error("host unavailable"));
  const tools = await listToolInventory(lister);
  assert.deepEqual(tools, []);
});

test("listToolInventory yields an empty roster when the lister resolves to nothing usable", async () => {
  const lister: ToolLister = () => Promise.resolve([]);
  assert.deepEqual(await listToolInventory(lister), []);
});

test("asToolSummaries is the exact guard listToolInventory uses at the boundary", () => {
  const summaries = asToolSummaries([{ name: "Bash", description: "Runs a shell command.", mcp: false }, { name: "missing-mcp-flag", description: "x" }, 42]);
  assert.deepEqual(summaries, [{ name: "Bash", description: "Runs a shell command.", mcp: false }]);
});
