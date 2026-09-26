// Unit tests for optional_import.mjs -- JEVADV-35 (odd/tasks/release-0.5.1.md,
// review-3ca73b9da09b0927 R2/R3). Uses real temporary modules loaded through
// dynamic `import()`, never a mock: the whole point of this module is
// telling apart node's real ERR_MODULE_NOT_FOUND shape from every other
// failure a real import can throw.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { importOptional, isMissingOptionalPackageError } from "./optional_import.mjs";

const tempDirs = [];
function makeTempModule(source) {
  const dir = mkdtempSync(join(tmpdir(), "orca-optional-import-test-"));
  tempDirs.push(dir);
  const path = join(dir, "module.mjs");
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isMissingOptionalPackageError
// ---------------------------------------------------------------------------

test("isMissingOptionalPackageError: true for ERR_MODULE_NOT_FOUND naming the optional package", () => {
  const error = new Error("Cannot find package 'playwright' imported from /repo/scripts/screenshot-panels.mjs");
  error.code = "ERR_MODULE_NOT_FOUND";
  assert.equal(isMissingOptionalPackageError(error, "playwright"), true);
});

test("isMissingOptionalPackageError: false for ERR_MODULE_NOT_FOUND naming an unrelated package", () => {
  const error = new Error("Cannot find package 'left-pad' imported from /repo/x.mjs");
  error.code = "ERR_MODULE_NOT_FOUND";
  assert.equal(isMissingOptionalPackageError(error, "playwright"), false);
});

test("isMissingOptionalPackageError: false for a syntax error, even one that mentions the package by name", () => {
  const error = new SyntaxError("Unexpected token ')' near a comment about playwright fixtures");
  assert.equal(isMissingOptionalPackageError(error, "playwright"), false);
});

test("isMissingOptionalPackageError: false for a plain object that is not an Error at all", () => {
  const notAnError = { code: "ERR_MODULE_NOT_FOUND", message: "playwright" };
  assert.equal(isMissingOptionalPackageError(notAnError, "playwright"), false);
});

// ---------------------------------------------------------------------------
// importOptional -- RED for the defect this task closes: a genuine failure
// (here, a syntax error standing in for "screenshot-panels.mjs is broken")
// must rethrow, never be treated as "the optional dependency is missing".
// ---------------------------------------------------------------------------

test("importOptional: a genuine failure (not the missing-package shape) rethrows instead of being swallowed", async () => {
  const specifier = makeTempModule("this is not valid javascript $$$ ((\n");
  await assert.rejects(() => importOptional(specifier, "playwright"));
});

test("importOptional: a throw at module scope unrelated to the optional package rethrows", async () => {
  const specifier = makeTempModule('throw new Error("boom, not a missing module at all");\n');
  await assert.rejects(() => importOptional(specifier, "playwright"), /boom, not a missing module at all/);
});

test("importOptional: an unrelated missing module rethrows rather than resolving to null", async () => {
  const specifier = makeTempModule('import "definitely-not-a-real-package-xyz";\n');
  await assert.rejects(() => importOptional(specifier, "playwright"));
});

test("importOptional: the optional package genuinely missing resolves to null", async () => {
  const specifier = makeTempModule('import "playwright-package-that-does-not-exist-in-this-test-fixture";\nexport const ok = true;\n');
  const result = await importOptional(specifier, "playwright-package-that-does-not-exist-in-this-test-fixture");
  assert.equal(result, null);
});

test("importOptional: a module that imports successfully resolves normally", async () => {
  const specifier = makeTempModule("export const value = 42;\n");
  const result = await importOptional(specifier, "playwright");
  assert.equal(result.value, 42);
});
