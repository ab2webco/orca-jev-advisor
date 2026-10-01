// 0.6.22 T2 (JEVADV-97): jev-health argument parsing.

import assert from "node:assert/strict";
import test from "node:test";

import { parseJevHealthArgs } from "./jev_health_args.ts";

test("usage: --days defaults to 7", () => {
  assert.deepEqual(parseJevHealthArgs(["usage"]), { command: "usage", days: 7 });
  assert.deepEqual(parseJevHealthArgs(["usage", "--days", "3"]), { command: "usage", days: 3 });
});

test("usage: a --days that is not a positive whole number is an error, not a default", () => {
  for (const bad of ["0", "-2", "x", "1.5"]) assert.equal(parseJevHealthArgs(["usage", "--days", bad]).command, "error");
  assert.equal(parseJevHealthArgs(["usage", "--days"]).command, "error");
});

test("no command or an unknown one is help", () => {
  assert.deepEqual(parseJevHealthArgs([]), { command: "help" });
  assert.deepEqual(parseJevHealthArgs(["bogus"]), { command: "help" });
});

test("flips: --runs defaults to 5, --commands-file to none (the default corpus)", () => {
  assert.deepEqual(parseJevHealthArgs(["flips"]), { command: "flips", runs: 5, commandsFile: null });
  assert.deepEqual(parseJevHealthArgs(["flips", "--runs", "3", "--commands-file", "c.txt"]), { command: "flips", runs: 3, commandsFile: "c.txt" });
});

test("flips: a bad --runs, or a --commands-file with no path, is an error", () => {
  assert.equal(parseJevHealthArgs(["flips", "--runs", "0"]).command, "error");
  assert.equal(parseJevHealthArgs(["flips", "--commands-file"]).command, "error");
});

test("redaction: --commands-file is required, there is no default corpus", () => {
  assert.deepEqual(parseJevHealthArgs(["redaction", "--commands-file", "c.txt"]), { command: "redaction", commandsFile: "c.txt" });
  assert.equal(parseJevHealthArgs(["redaction"]).command, "error");
  assert.equal(parseJevHealthArgs(["redaction", "--commands-file"]).command, "error");
});
