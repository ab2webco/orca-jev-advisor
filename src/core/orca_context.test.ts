import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveOrcaContext } from "./orca_context.ts";

test("resolveOrcaContext runs the CLI name it is given, so Linux can pass orca-ide", async () => {
  const seen: string[][] = [];
  const run = async (argv: readonly string[]) => {
    seen.push([...argv]);
    return { stdout: JSON.stringify({ id: "1", ok: true, result: { worktree: { path: "/w/app", projectId: "app", branch: "main", displayName: "app" } } }), exitCode: 0 };
  };
  const context = await resolveOrcaContext(run, "/w/app", "orca-ide");
  assert.deepEqual(seen, [["orca-ide", "worktree", "current", "--json"]]);
  assert.equal(context.source, "orca");
});

test("resolveOrcaContext still runs `orca` when no name is given", async () => {
  const seen: string[][] = [];
  const run = async (argv: readonly string[]) => {
    seen.push([...argv]);
    throw new Error("no binary");
  };
  const context = await resolveOrcaContext(run, "/w/app");
  assert.equal(seen[0]?.[0], "orca");
  assert.equal(context.source, "cwd");
});
