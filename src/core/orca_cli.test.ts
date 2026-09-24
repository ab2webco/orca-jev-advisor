// Unit tests for orca_cli.ts -- pure input to pure output, no filesystem, no
// process.execPath/process.platform read (same convention as paths.test.ts:
// every test drives execPath/platform explicitly). Run with:
//   node --test --experimental-strip-types src/core/orca_cli.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { cliBinaryName, isMissingCommandError, resolveBundledOrcaCliPath, resolveOrcaCliCandidates } from "./orca_cli.ts";

test("cliBinaryName appends .exe only on win32", () => {
  assert.equal(cliBinaryName("win32"), "orca.exe");
  assert.equal(cliBinaryName("darwin"), "orca");
  assert.equal(cliBinaryName("linux"), "orca");
});

test("resolveBundledOrcaCliPath on darwin walks up from Contents/MacOS to Contents/Resources/bin", () => {
  assert.equal(
    resolveBundledOrcaCliPath("/Applications/Orca.app/Contents/MacOS/Orca", "darwin"),
    "/Applications/Orca.app/Contents/Resources/bin/orca",
  );
});

test("resolveBundledOrcaCliPath on linux looks for resources/bin next to the executable", () => {
  assert.equal(resolveBundledOrcaCliPath("/opt/Orca/orca-supervisor", "linux"), "/opt/Orca/resources/bin/orca");
});

test("resolveBundledOrcaCliPath on win32 looks for resources\\bin\\orca.exe next to the executable", () => {
  assert.equal(
    resolveBundledOrcaCliPath("C:\\Users\\dev\\AppData\\Local\\Programs\\Orca\\Orca.exe", "win32"),
    "C:\\Users\\dev\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe",
  );
});

test("resolveOrcaCliCandidates puts the bundled path first, then a bare PATH fallback, on darwin/linux", () => {
  assert.deepEqual(resolveOrcaCliCandidates("/Applications/Orca.app/Contents/MacOS/Orca", "darwin"), [
    "/Applications/Orca.app/Contents/Resources/bin/orca",
    "orca",
  ]);
  assert.deepEqual(resolveOrcaCliCandidates("/opt/Orca/orca-supervisor", "linux"), [
    "/opt/Orca/resources/bin/orca",
    "orca",
  ]);
});

test("resolveOrcaCliCandidates on win32 tries .exe then .cmd before the bare name -- execFile does not apply PATHEXT", () => {
  assert.deepEqual(resolveOrcaCliCandidates("C:\\Programs\\Orca\\Orca.exe", "win32"), [
    "C:\\Programs\\Orca\\resources\\bin\\orca.exe",
    "orca.exe",
    "orca.cmd",
    "orca",
  ]);
});

test("isMissingCommandError recognizes ENOENT and rejects everything else", () => {
  assert.equal(isMissingCommandError({ code: "ENOENT" }), true);
  assert.equal(isMissingCommandError({ code: "EACCES" }), false);
  assert.equal(isMissingCommandError(new Error("boom")), false);
  assert.equal(isMissingCommandError(null), false);
  assert.equal(isMissingCommandError("ENOENT"), false);
});
