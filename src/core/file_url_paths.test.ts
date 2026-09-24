import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Orca installs this plugin under "Application Support" on macOS, and a file
// URL percent-encodes that space. `new URL(...).pathname` therefore hands back
// "Application%20Support", and anything that spawns or reads that path fails
// with ENOENT at the one location that actually matters. This repository's own
// checkout has no spaces in it, so CI can never catch the mistake by running
// the code -- only by refusing to let it in.
//
// Five files already used fileURLToPath correctly and one did not; that one
// shipped. This is the guard that makes the convention enforceable rather than
// remembered.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".screenshots", ".private"]);
const SOURCE = /\.(ts|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE.test(entry)) found.push(path);
  }
  return found;
}

test("no source file reads a file URL's path with .pathname", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(ROOT)) {
    const source = readFileSync(path, "utf8");
    // Only the file-URL case: `.pathname` on an http URL is perfectly fine.
    if (/new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/.test(source)) {
      offenders.push(path.slice(ROOT.length));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `use fileURLToPath() instead -- .pathname leaves %20 in "Application Support":\n  ${offenders.join("\n  ")}`,
  );
});

test("the guard can actually see a violation", () => {
  // A guard nobody has watched fail is a guard nobody should trust.
  //
  // The sample is assembled at run time rather than written out, because a
  // literal one makes this file its own first offender -- which it did.
  const sample = ["new URL(", '"./x.ts", import.meta.url', ").", "pathname"].join("");
  assert.ok(/new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/.test(sample));
});
