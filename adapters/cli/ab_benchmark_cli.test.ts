// Unit tests for the AB-benchmark CLI's own orchestration
// (runCompare/parseCliArgs) -- the IO shell around them (real fs reads,
// real `claude` spawn, real Jev network call, process.argv/console.log) is
// exercised by hand, never by this suite. Every test here injects a fake
// BigModelRunner and a fake JevCaller: no test may invoke the real `claude`
// CLI (spends real usage) and none needs to reach real Jev either, since
// runCompare only ever calls the JevCaller it is given.
//
// Real Jev IS exercised, deliberately, by a separate, non-`.test.`-named
// file (adapters/cli/ab_benchmark_live_jev.mjs) that node's default test
// discovery never picks up -- see that file's own header for why and how
// to run it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { serializeSampleEntry, type AbSampleEntry } from "../../src/core/ab_benchmark.ts";
import { DEFAULT_AB_BENCHMARK_CONFIG } from "../../src/core/ab_benchmark_config.ts";
import type { JevCaller } from "./ab_benchmark_cli.ts";

// src/core/paths.ts's resolveConfigDir/resolveCacheDir refuse to compute a
// real path at all under node's test runner unless an explicit override is
// set (see that module's doc) -- ab_benchmark_cli.ts resolves its own
// CACHE_DIR/CONFIG_DIR unconditionally at module scope (never used by
// parseCliArgs/runCompare themselves, which this file tests, but evaluated
// regardless on import). A static `import ... from "./ab_benchmark_cli.ts"`
// is hoisted ahead of any other top-level statement in this file, so the
// override could never be set first that way -- hence the plain dynamic
// import below, after the override is in place. `import type` above stays
// static: a type-only import is fully erased and never evaluates the
// module.
const PATHS_OVERRIDE_DIR = mkdtempSync(join(tmpdir(), "orca-jev-ab-benchmark-cli-test-"));
process.env.ORCA_SUPERVISOR_CONFIG_DIR = join(PATHS_OVERRIDE_DIR, "config");
process.env.ORCA_SUPERVISOR_CACHE_DIR = join(PATHS_OVERRIDE_DIR, "cache");
after(() => rmSync(PATHS_OVERRIDE_DIR, { recursive: true, force: true }));

const { parseCliArgs, runCompare } = await import("./ab_benchmark_cli.ts");

function queuedEntry(overrides: Partial<AbSampleEntry> = {}): AbSampleEntry {
  return {
    id: "q1",
    at: "2026-09-24T00:00:00.000Z",
    commandFamily: "git push",
    destinationKind: "project",
    jevVerdict: "ask",
    jevLatencyMs: 404,
    jevInputTokens: 80,
    jevOutputTokens: 20,
    ...overrides,
  };
}

const okBigModel = async () =>
  ({
    kind: "ok" as const,
    stdout: JSON.stringify({
      duration_api_ms: 5000,
      result: '{"verdict":"ask"}',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      is_error: false,
    }),
  });

const fakeJevCaller: JevCaller = async (command) => ({
  verdict: command.includes("rm") ? "ask" : "allow",
  latencyMs: 400,
  inputTokens: 50,
  outputTokens: 10,
});

// ---------------------------------------------------------------------------
// runCompare
// ---------------------------------------------------------------------------

test("runCompare: drains the queue up to the cap, leaving the rest for next time", async () => {
  const queueRaw = [queuedEntry({ id: "a" }), queuedEntry({ id: "b" }), queuedEntry({ id: "c" })].map(serializeSampleEntry).join("");
  const output = await runCompare({
    queueRaw,
    commandLines: [],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 2,
    bigModelRunner: okBigModel,
    jevCaller: null,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 2);
  assert.deepEqual(output.remainingQueueEntries.map((e) => e.id), ["c"]);
});

test("runCompare: an empty queue falls through to commands-file lines, calling the injected JevCaller for each", async () => {
  const output = await runCompare({
    queueRaw: "",
    commandLines: ["npm test", "rm -rf dist"],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: fakeJevCaller,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 2);
  assert.equal(output.results[0]?.commandFamily, "npm");
  assert.equal(output.results[1]?.commandFamily, "rm -rf");
  assert.equal(output.directBatchSkipped, 0);
});

test("runCompare: blank lines and '#' comment lines in the commands file are skipped, never counted or sent anywhere", async () => {
  const output = await runCompare({
    queueRaw: "",
    commandLines: ["", "  ", "# a comment", "npm test"],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: fakeJevCaller,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 1);
  assert.equal(output.directBatchSkipped, 0);
});

test("runCompare: with no JevCaller (no API key resolved), commands-file lines are reported skipped, never silently dropped", async () => {
  const output = await runCompare({
    queueRaw: "",
    commandLines: ["npm test", "rm -rf dist"],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: null,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 0);
  assert.equal(output.directBatchSkipped, 2);
});

test("runCompare: a JevCaller that fails for one command skips only that command, siblings still measured", async () => {
  const flaky: JevCaller = async (command) => (command.includes("fails") ? null : { verdict: "allow", latencyMs: 300, inputTokens: 1, outputTokens: 1 });
  const output = await runCompare({
    queueRaw: "",
    commandLines: ["npm test", "this-one fails", "npm run build"],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: flaky,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 2);
  assert.equal(output.directBatchSkipped, 1);
});

test("runCompare: the queue and commands-file together never exceed the cap in one run", async () => {
  const queueRaw = [queuedEntry({ id: "a" }), queuedEntry({ id: "b" })].map(serializeSampleEntry).join("");
  const output = await runCompare({
    queueRaw,
    commandLines: ["npm test", "npm run build", "git status"],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 3,
    bigModelRunner: okBigModel,
    jevCaller: fakeJevCaller,
    totalJevDecisions: null,
  });
  assert.equal(output.results.length, 3);
  assert.equal(output.directBatchSkipped, 0, "the unreached third command line is simply never attempted, not counted as skipped");
});

test("runCompare: onSample fires once per completed comparison, in order, with a running total", async () => {
  const queueRaw = [queuedEntry({ id: "a" }), queuedEntry({ id: "b" })].map(serializeSampleEntry).join("");
  const seen: Array<{ index: number; total: number }> = [];
  await runCompare({
    queueRaw,
    commandLines: [],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: null,
    totalJevDecisions: null,
    onSample: (_result, index, total) => seen.push({ index, total }),
  });
  assert.deepEqual(seen, [
    { index: 1, total: 2 },
    { index: 2, total: 2 },
  ]);
});

test("runCompare: report.decisionsBigModelSkipped reflects totalJevDecisions when the caller supplies it", async () => {
  const queueRaw = serializeSampleEntry(queuedEntry());
  const output = await runCompare({
    queueRaw,
    commandLines: [],
    config: DEFAULT_AB_BENCHMARK_CONFIG,
    cap: 5,
    bigModelRunner: okBigModel,
    jevCaller: null,
    totalJevDecisions: 1441,
  });
  assert.equal(output.report.decisionsBigModelSkipped, 1440);
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

test("parseCliArgs: 'compare' with no flags uses null cap/commandsFile (main() fills the default cap from config)", () => {
  assert.deepEqual(parseCliArgs(["compare"]), { command: "compare", cap: null, commandsFile: null });
});

test("parseCliArgs: 'compare --cap 5 --commands-file foo.txt'", () => {
  assert.deepEqual(parseCliArgs(["compare", "--cap", "5", "--commands-file", "foo.txt"]), {
    command: "compare",
    cap: 5,
    commandsFile: "foo.txt",
  });
});

test("parseCliArgs: 'config --enable --sample-rate 0.05 --daily-cap 10'", () => {
  assert.deepEqual(parseCliArgs(["config", "--enable", "--sample-rate", "0.05", "--daily-cap", "10"]), {
    command: "config",
    enable: true,
    sampleRate: 0.05,
    dailySampleCap: 10,
  });
});

test("parseCliArgs: 'config --disable'", () => {
  assert.deepEqual(parseCliArgs(["config", "--disable"]), { command: "config", enable: false, sampleRate: null, dailySampleCap: null });
});

test("parseCliArgs: no arguments, or an unrecognized command, yields 'help'", () => {
  assert.deepEqual(parseCliArgs([]), { command: "help" });
  assert.deepEqual(parseCliArgs(["bogus"]), { command: "help" });
});
