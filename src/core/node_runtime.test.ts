// Unit tests for node_runtime.ts -- pure input to pure output. Run with:
//   node --test --experimental-strip-types src/core/node_runtime.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_NODE_MAJOR,
  classifyNode,
  managedNodeRoots,
  nodeCandidatePaths,
  parseNodeVersion,
} from "./node_runtime.ts";

test("MIN_NODE_MAJOR is 24, the engines floor the .ts hooks rely on", () => {
  assert.equal(MIN_NODE_MAJOR, 24);
});

test("parseNodeVersion reads `node --version` output and rejects anything else", () => {
  assert.deepEqual(parseNodeVersion("v24.15.0\n"), { major: 24, minor: 15, patch: 0, raw: "v24.15.0" });
  assert.deepEqual(parseNodeVersion("v20.11.0"), { major: 20, minor: 11, patch: 0, raw: "v20.11.0" });
  assert.equal(parseNodeVersion(""), null);
  assert.equal(parseNodeVersion("bash: node: command not found"), null);
  assert.equal(parseNodeVersion("24.1.0"), null);
});

test("classifyNode: 24 and newer is ok, older is too-old with the version seen, unreadable is missing", () => {
  assert.deepEqual(classifyNode("/opt/homebrew/bin/node", "v24.0.0"), { state: "ok", path: "/opt/homebrew/bin/node", version: "v24.0.0" });
  assert.deepEqual(classifyNode("/opt/homebrew/bin/node", "v26.9.0\n"), { state: "ok", path: "/opt/homebrew/bin/node", version: "v26.9.0" });
  assert.deepEqual(classifyNode("/usr/local/bin/node", "v20.11.0"), { state: "too-old", path: "/usr/local/bin/node", version: "v20.11.0" });
  assert.deepEqual(classifyNode("/usr/local/bin/node", "v23.11.1"), { state: "too-old", path: "/usr/local/bin/node", version: "v23.11.1" });
  assert.deepEqual(classifyNode("/x/node", "garbage"), { state: "missing", path: null, version: null });
});

test("nodeCandidatePaths: PATH entries first, then the well-known places, without duplicates", () => {
  const list = nodeCandidatePaths({
    platform: "darwin",
    home: "/home/dev",
    pathEnv: "/usr/local/bin:/opt/homebrew/bin:/usr/local/bin",
    override: undefined,
    managed: {},
  });
  assert.equal(list[0], "/usr/local/bin/node");
  assert.equal(list[1], "/opt/homebrew/bin/node");
  assert.equal(list.filter((p) => p === "/usr/local/bin/node").length, 1);
  for (const expected of ["/home/dev/.volta/bin/node", "/home/dev/.asdf/shims/node", "/usr/bin/node"]) {
    assert.ok(list.includes(expected), expected);
  }
  assert.ok(list.indexOf("/usr/bin/node") > list.indexOf("/opt/homebrew/bin/node"));
});

test("nodeCandidatePaths: nvm and fnm installs come highest version first", () => {
  const roots = managedNodeRoots("linux", "/home/dev");
  const nvm = roots.find((r) => r.root === "/home/dev/.nvm/versions/node");
  const fnm = roots.find((r) => r.root === "/home/dev/.local/share/fnm/node-versions");
  assert.ok(nvm !== undefined && fnm !== undefined);
  const list = nodeCandidatePaths({
    platform: "linux",
    home: "/home/dev",
    pathEnv: "",
    override: undefined,
    managed: {
      [nvm.root]: ["v18.20.0", "v24.9.1", "v24.15.0", "v9.0.0"],
      [fnm.root]: ["v22.1.0", "v25.0.0"],
    },
  });
  const nvmOnes = list.filter((p) => p.startsWith("/home/dev/.nvm/"));
  assert.deepEqual(nvmOnes, [
    "/home/dev/.nvm/versions/node/v24.15.0/bin/node",
    "/home/dev/.nvm/versions/node/v24.9.1/bin/node",
    "/home/dev/.nvm/versions/node/v18.20.0/bin/node",
    "/home/dev/.nvm/versions/node/v9.0.0/bin/node",
  ]);
  const fnmOnes = list.filter((p) => p.startsWith("/home/dev/.local/share/fnm/"));
  assert.deepEqual(fnmOnes, [
    "/home/dev/.local/share/fnm/node-versions/v25.0.0/installation/bin/node",
    "/home/dev/.local/share/fnm/node-versions/v22.1.0/installation/bin/node",
  ]);
});

test("nodeCandidatePaths: an override list replaces every other source", () => {
  const list = nodeCandidatePaths({
    platform: "darwin",
    home: "/home/dev",
    pathEnv: "/usr/local/bin",
    override: "/tmp/a/node:/tmp/b/node",
    managed: {},
  });
  assert.deepEqual(list, ["/tmp/a/node", "/tmp/b/node"]);
});

test("nodeCandidatePaths: Windows uses node.exe and its own delimiter", () => {
  const list = nodeCandidatePaths({
    platform: "win32",
    home: "C:\\Users\\dev",
    pathEnv: "C:\\Program Files\\nodejs;C:\\tools",
    override: undefined,
    managed: {},
  });
  assert.equal(list[0], "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(list[1], "C:\\tools\\node.exe");
});
