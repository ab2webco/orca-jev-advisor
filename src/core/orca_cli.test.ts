import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ORCA_CLI_ARGUMENTS, ORCA_CLI_TIMEOUT_MS, orcaCliOptions } from "./orca_cli.ts";

const mainSource = readFileSync(new URL("../../adapters/orca/main.mjs", import.meta.url), "utf8");

test("Windows runs the CLI through a shell, because a .cmd shim is not an executable image", () => {
  // Without this the three call sites fail with ENOENT on every Windows
  // install, and each one catches and reports an empty result instead.
  assert.equal(orcaCliOptions("win32").shell, true);
});

test("macOS and Linux do not, because a shebang already runs and a shell only adds a process", () => {
  assert.equal(orcaCliOptions("darwin").shell, false);
  assert.equal(orcaCliOptions("linux").shell, false);
});

test("every platform gets the same timeout and a maxBuffer well clear of the real output", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const options = orcaCliOptions(platform);
    assert.equal(options.timeout, ORCA_CLI_TIMEOUT_MS);
    // Measured on a real machine: 65 worktrees produce ~130KB of JSON, and
    // Node's own default is 1MB. Anything at or below the default is a
    // regression waiting for a developer with more worktrees.
    assert.ok(options.maxBuffer > 1024 * 1024, "maxBuffer is not above Node's default");
  }
});

test("every argument the plugin passes to the CLI is a literal", () => {
  // The shell on Windows re-parses arguments, and cmd.exe quoting cannot be
  // made safe for attacker-controlled input. The whole decision rests on this
  // staying true, so it is asserted rather than assumed.
  for (const args of Object.values(ORCA_CLI_ARGUMENTS)) {
    for (const arg of args) {
      assert.equal(typeof arg, "string");
      assert.match(arg, /^[a-z0-9-]+$/, `'${arg}' is not a plain literal`);
    }
  }
});

test("main.mjs invokes the CLI only through this helper, never with bare options", () => {
  // A fourth call site added the old way would be broken on Windows and
  // nothing else would notice. This is what notices.
  const bareCalls = [...mainSource.matchAll(/execFileAsync\(\s*ORCA_CLI_BIN\s*,\s*[^)]*?\{\s*timeout:/g)];
  assert.equal(bareCalls.length, 0, "a CLI call passes its own options instead of orcaCliOptions()");

  const invocations = [...mainSource.matchAll(/execFileAsync\(\s*ORCA_CLI_BIN\s*,/g)].length;
  const withHelper = [...mainSource.matchAll(/orcaCliOptions\(/g)].length;
  assert.ok(invocations > 0, "found no CLI invocations -- the matcher, not the code, is broken");
  assert.equal(withHelper, invocations, `${invocations} CLI call(s) but ${withHelper} use orcaCliOptions()`);
});
