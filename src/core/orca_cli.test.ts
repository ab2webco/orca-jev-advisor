import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ORCA_CLI_ARGUMENTS, ORCA_CLI_TIMEOUT_MS, orcaCliOptions } from "./orca_cli.ts";

const mainSource = readFileSync(new URL("../../adapters/orca/main.mjs", import.meta.url), "utf8");

test("Windows runs the CLI through a shell, because a .cmd shim is not an executable image", () => {
  // Without this the three call sites fail with ENOENT on every Windows
  // install, and each one catches and reports an empty result instead.
  assert.equal(orcaCliOptions("win32", "/plugin").shell, true);
});

test("macOS and Linux do not, because a shebang already runs and a shell only adds a process", () => {
  assert.equal(orcaCliOptions("darwin", "/plugin").shell, false);
  assert.equal(orcaCliOptions("linux", "/plugin").shell, false);
});

test("every platform gets the same timeout and a maxBuffer well clear of the real output", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const options = orcaCliOptions(platform, "/plugin");
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

test("main.mjs invokes the CLI only through this helper, never by name", () => {
  // A fourth call site added the old way would be broken on Windows and
  // nothing else would notice. The earlier version of this test only counted
  // calls that ALREADY used ORCA_CLI_BIN, so the one shape it existed to
  // catch -- a literal 'orca' -- slipped straight past it. This matches the
  // literal instead, which is what a person reaching for the old pattern
  // actually types.
  const byName = [...mainSource.matchAll(/execFileAsync\(\s*['"]orca['"]/g)];
  assert.equal(byName.length, 0, "a CLI call names 'orca' directly instead of using ORCA_CLI_BIN + orcaCliOptions()");

  const invocations = [...mainSource.matchAll(/execFileAsync\(\s*ORCA_CLI_BIN\s*,/g)].length;
  const withHelper = [...mainSource.matchAll(/orcaCliOptions\(/g)].length;
  assert.ok(invocations > 0, "found no CLI invocations -- the matcher, not the code, is broken");
  assert.equal(withHelper, invocations, `${invocations} CLI call(s) but ${withHelper} use orcaCliOptions()`);
});

test("the cwd is always the caller's, never inherited, and the console never flashes", () => {
  // Exposure 2 in orca_cli.ts: cmd.exe resolves a bare command name from the
  // current directory BEFORE PATH, so a checkout carrying its own `orca.cmd`
  // would run at plugin activation if cwd were inherited from the worker.
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const options = orcaCliOptions(platform, "/plugin/root");
    assert.equal(options.cwd, "/plugin/root", "cwd is not the one the caller passed");
    assert.equal(options.windowsHide, true);
  }
});

test("every CLI call site passes a cwd this plugin controls", () => {
  // The guarantee is only worth as much as the value actually passed, so the
  // call sites are checked too, not just the helper's signature.
  const calls = [...mainSource.matchAll(/orcaCliOptions\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, "found no orcaCliOptions call -- the matcher is broken");
  for (const args of calls) {
    assert.equal(args, "PLATFORM, PLUGIN_ROOT", `a CLI call passes '${args}' instead of the plugin root`);
  }
});
