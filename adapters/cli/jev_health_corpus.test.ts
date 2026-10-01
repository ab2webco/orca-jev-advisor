// 0.6.22 T3 (JEVADV-97): the default corpus of `jev-health flips` is built
// only from command strings already committed in this repository's tests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseCommandsFile } from "../../src/core/commands_file.ts";

const CORPUS = new URL("./fixtures/jev-health-corpus.txt", import.meta.url);
const ROOT = new URL("../../", import.meta.url);

test("the corpus has about forty commands and no private data", () => {
  const text = readFileSync(CORPUS, "utf8");
  const commands = parseCommandsFile(text);
  assert.ok(commands.length >= 35 && commands.length <= 50, `${commands.length} commands`);
  assert.equal(new Set(commands).size, commands.length);
  assert.doesNotMatch(text, /\/Users\/|@[a-z0-9-]+\.[a-z]/i);
});

test("every corpus command appears as a quoted string in a committed test", () => {
  const tracked = execFileSync("git", ["ls-files", "*.test.ts", "*.test.mjs"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.length > 0 && !file.includes("jev_health"));
  const source = tracked.map((file) => readFileSync(new URL(file, ROOT), "utf8")).join("\n");
  for (const command of parseCommandsFile(readFileSync(CORPUS, "utf8"))) {
    assert.ok(['"', "'", "`"].some((quote) => source.includes(`${quote}${command}${quote}`)), `not in any test: ${command}`);
  }
});
