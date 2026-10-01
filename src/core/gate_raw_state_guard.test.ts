// 0.6.22 T4 (JEVADV-97): the gate's hook entry points never ask for an
// unredacted state. buildActionGateState takes an injected `redact` function
// (default redactSecretsForJev) so the redaction-impact probe can see what
// Jev would say about the raw text; that option must stay out of reach of
// anything a hook runs. This reads the source, so a later edit that passes it
// fails here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

/** The text between the parentheses of every `buildActionGateState(` call in `source`. */
function callArguments(source: string): string[] {
  const found: string[] = [];
  let from = source.indexOf("buildActionGateState(");
  while (from !== -1) {
    let depth = 0;
    let end = from + "buildActionGateState".length;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth += 1;
      if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(from, end + 1));
    from = source.indexOf("buildActionGateState(", end);
  }
  return found;
}

/** Every non-test source file that is shipped to run inside a hook or the core, except the probes and their CLI. */
function shippedSources(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts", "adapters/claude/**/*.ts", "adapters/claude/**/*.mjs"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.length > 0 && !/\.test\.(ts|mjs)$/.test(file) && !file.includes("jev_health"));
}

test("gate-bash.ts calls buildActionGateState and never passes a redact option", () => {
  const source = readFileSync(new URL("adapters/claude/gate-bash.ts", ROOT), "utf8");
  const calls = callArguments(source);
  assert.ok(calls.length > 0, "gate-bash.ts builds its state with buildActionGateState");
  for (const call of calls) assert.doesNotMatch(call, /\bredact\b/);
  assert.doesNotMatch(source, /jev_health/);
});

test("no shipped source passes a redact option to buildActionGateState, or reaches the probes", () => {
  for (const file of shippedSources()) {
    const source = readFileSync(new URL(file, ROOT), "utf8");
    for (const call of callArguments(source)) assert.doesNotMatch(call, /\bredact\b/, file);
    assert.doesNotMatch(source, /from ["'][^"']*jev_health/, file);
  }
});
