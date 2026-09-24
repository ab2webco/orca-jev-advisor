// Proves the one guard standing between a test process and the developer's
// real ~/.claude / ~/.config/orca-supervisor / claude-accounts actually
// fires. See write_guard.ts's module doc for why this exists: four separate
// incidents of a `node --test` run reaching real files, the last one wiping
// every gate hook out of settings.json in all five real Claude config roots
// with zero error output.
//
// Every assertion here is against the guard function itself -- a pure
// string check, no filesystem call before it throws -- so even a target
// path shaped exactly like a real developer file is completely safe to
// pass in: the whole point of this guard is that it decides BEFORE any
// write is attempted, never after.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  RealConfigWriteBlockedError,
  assertSafeWriteTarget,
  isRunningUnderNodeTestRunner,
} from "./write_guard.ts";

const NODE_TEST_ENV = { NODE_TEST_CONTEXT: "child-v8" };
const NOT_TEST_ENV = {};

test("isRunningUnderNodeTestRunner is true when NODE_TEST_CONTEXT is set", () => {
  assert.equal(isRunningUnderNodeTestRunner(NODE_TEST_ENV), true);
});

test("isRunningUnderNodeTestRunner is false when NODE_TEST_CONTEXT is absent", () => {
  assert.equal(isRunningUnderNodeTestRunner(NOT_TEST_ENV), false);
});

test("refuses a real-looking home config path under the test runner", () => {
  // The exact shape of the file that was wiped: ~/.claude/settings.json.
  // Passing the developer's REAL homedir() here is safe -- the guard must
  // reject it before ever touching a filesystem API.
  const realLookingTarget = join(homedir(), ".claude", "settings.json");
  assert.throws(
    () => assertSafeWriteTarget(realLookingTarget, NODE_TEST_ENV),
    (error: unknown) => {
      assert.ok(error instanceof RealConfigWriteBlockedError);
      assert.match(error.message, /refusing to write/);
      assert.ok(error.message.includes(realLookingTarget), "message must name the exact path");
      assert.equal(error.targetPath, realLookingTarget);
      return true;
    }
  );
});

test("refuses an Orca claude-accounts-shaped path under the test runner", () => {
  const accountLikeTarget = join(
    homedir(),
    "Library",
    "Application Support",
    "orca",
    "claude-accounts",
    "00000000-0000-0000-0000-000000000000",
    "auth",
    "settings.json"
  );
  assert.throws(() => assertSafeWriteTarget(accountLikeTarget, NODE_TEST_ENV), RealConfigWriteBlockedError);
});

test("allows a path under the OS temp directory under the test runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-jev-write-guard-test-"));
  try {
    assert.doesNotThrow(() => assertSafeWriteTarget(join(dir, "settings.json"), NODE_TEST_ENV));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing outside the test runner, even for a real-looking path", () => {
  const realLookingTarget = join(homedir(), ".claude", "settings.json");
  assert.doesNotThrow(() => assertSafeWriteTarget(realLookingTarget, NOT_TEST_ENV));
});

test("fires against the process's own ambient environment, with no env argument", () => {
  // This test file itself runs under `node --test`, so the real
  // process.env already carries NODE_TEST_CONTEXT -- proving the default
  // parameter (every real call site in this repo) behaves identically to
  // the explicit NODE_TEST_ENV used above.
  assert.equal(isRunningUnderNodeTestRunner(), true);
  const realLookingTarget = join(homedir(), ".claude", "settings.json");
  assert.throws(() => assertSafeWriteTarget(realLookingTarget), RealConfigWriteBlockedError);
});
