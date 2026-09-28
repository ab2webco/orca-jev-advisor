// Guards against the owner's private data (client names, account ids, home
// paths, emails, real usage figures) leaking back into this public repo.
// Every check reports only `<file>:<line>`, never the matched text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SELF = "scripts/private-data.test.mjs";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "test.com",
  "db.internal",
  "github.com",
]);

const USERS_PATH_RE = /(?<!:)\/Users\/[^\s/'"`]+\//;

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((path) => path !== SELF);
}

function forEachLine(path, fn) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return; // not a UTF-8 text file (e.g. a binary asset); nothing to scan
  }
  content.split("\n").forEach((line, index) => fn(line, index + 1));
}

test("no email outside example.com/example.org is tracked", () => {
  const hits = [];
  for (const path of trackedFiles()) {
    forEachLine(path, (line, lineNumber) => {
      for (const match of line.matchAll(EMAIL_RE)) {
        const domain = match[0].slice(match[0].indexOf("@") + 1).toLowerCase();
        if (!ALLOWED_EMAIL_DOMAINS.has(domain)) hits.push(`${path}:${lineNumber}`);
      }
    });
  }
  assert.deepEqual(hits, [], `private email domain found at:\n${hits.join("\n")}`);
});

test("no absolute /Users/<name>/ path is tracked", () => {
  const hits = [];
  for (const path of trackedFiles()) {
    forEachLine(path, (line, lineNumber) => {
      if (USERS_PATH_RE.test(line)) hits.push(`${path}:${lineNumber}`);
    });
  }
  assert.deepEqual(hits, [], `absolute /Users/ path found at:\n${hits.join("\n")}`);
});

test("no term from the owner's private-terms list is tracked", () => {
  const termsPath = join(homedir(), ".config", "orca-supervisor", "private-terms.txt");
  if (!existsSync(termsPath)) return; // absent for other users and CI: skip silently

  const terms = readFileSync(termsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (terms.length === 0) return;

  const hits = [];
  for (const path of trackedFiles()) {
    forEachLine(path, (line, lineNumber) => {
      if (terms.some((term) => line.includes(term))) hits.push(`${path}:${lineNumber}`);
    });
  }
  assert.deepEqual(hits, [], `private term found at:\n${hits.join("\n")}`);
});
