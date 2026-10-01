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
