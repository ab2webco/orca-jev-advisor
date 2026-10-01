// Guards against the owner's private data (client names, account ids, home
// paths, emails, real usage figures) leaking back into this public repo.
// Every check reports only `<file>:<line>`, never the matched text.
//
// Run plainly it scans the tracked files of the working tree. `.githooks/pre-push`
// runs it on what a push would send instead, through two variables:
//   PRIVATE_DATA_TIPS     the pushed commits: every tracked file at each
//   PRIVATE_DATA_COMMITS  every commit in the pushed range: the files it
//                         changes and its message
// A hit there reads `<commit>:<file>:<line>` or `<commit>:message:<line>`.
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

/** @typedef {{ label: string, content: string }} Document */

/** @returns {Document[]} */
function workingTreeDocuments() {
  const documents = [];
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((path) => path !== SELF);
  for (const path of paths) {
    try {
      documents.push({ label: path, content: readFileSync(path, "utf8") });
    } catch {
      // not a readable file (e.g. a deleted but still tracked path); nothing to scan
    }
  }
  return documents;
}

/** @param {string | undefined} value */
function shas(value) {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

/** @param {string} sha */
const short = (sha) => sha.slice(0, 12);

/**
 * Reads many blobs in one `git cat-file --batch` call.
 * @param {string[]} blobShas
 * @returns {Map<string, string>}
 */
function readBlobs(blobShas) {
  const contents = new Map();
  if (blobShas.length === 0) return contents;
  const out = execFileSync("git", ["cat-file", "--batch"], {
    input: `${blobShas.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    const [sha, type, size] = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (type === "missing" || size === undefined) throw new Error(`git object ${sha} is missing`);
    const start = headerEnd + 1;
    const end = start + Number(size);
    contents.set(sha, out.subarray(start, end).toString("utf8"));
    offset = end + 1;
  }
  return contents;
}

/**
 * What a push would send: the files at each pushed tip, the files each
 * pushed commit changes (a leak removed later is still in the history), and
 * each pushed commit's message.
 * @param {string[]} tips
 * @param {string[]} commits
 * @returns {Document[]}
 */
function pushedDocuments(tips, commits) {
  /** @type {Map<string, string>} blob sha -> first label that names it */
  const blobs = new Map();
  const note = (/** @type {string} */ sha, /** @type {string} */ label) => {
    if (!blobs.has(sha)) blobs.set(sha, label);
  };

  for (const tip of tips) {
    const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", tip], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const entry of entries.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (type === "blob" && path !== SELF) note(sha, `${short(tip)}:${path}`);
    }
  }

  for (const commit of commits) {
    const raw = execFileSync(
      "git",
      ["diff-tree", "-r", "-z", "--root", "--no-commit-id", "--no-renames", "--diff-filter=d", commit],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const fields = raw.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, newMode, , newSha] = fields[i].split(" ");
      const path = fields[i + 1];
      if (newMode !== "160000" && path !== SELF) note(newSha, `${short(commit)}:${path}`);
    }
  }

  const contents = readBlobs([...blobs.keys()]);
  /** @type {Document[]} */
  const documents = [...blobs].map(([sha, label]) => ({ label, content: contents.get(sha) ?? "" }));

  if (commits.length > 0) {
    const log = execFileSync("git", ["log", "--no-walk=unsorted", "--stdin", "-z", "--format=%H%n%B"], {
      input: `${commits.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const record of log.split("\0").filter(Boolean)) {
      const newline = record.indexOf("\n");
      documents.push({
        label: `${short(record.slice(0, newline))}:message`,
        content: record.slice(newline + 1),
      });
    }
  }
  return documents;
}

/** @type {Document[] | undefined} */
let cachedDocuments;

/**
 * 0.6.17 T4 (JEVADV-92): whether there is a checkout to scan at all. An
 * installed copy of the plugin has no `.git`, and `git ls-files` there used
 * to fail the whole suite; with nothing tracked there is nothing to leak.
 * A pre-push run always has one.
 */
function insideGitCheckout() {
  if (process.env.PRIVATE_DATA_TIPS !== undefined) return true;
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

const NOT_A_CHECKOUT = "not a git checkout (an installed copy has no .git): nothing tracked to scan";

/** @returns {Document[]} */
function documents() {
  cachedDocuments ??=
    process.env.PRIVATE_DATA_TIPS === undefined
      ? workingTreeDocuments()
      : pushedDocuments(shas(process.env.PRIVATE_DATA_TIPS), shas(process.env.PRIVATE_DATA_COMMITS));
  return cachedDocuments;
}

/**
 * @param {Document} document
 * @param {(line: string, lineNumber: number) => void} fn
 */
function forEachLine(document, fn) {
  document.content.split("\n").forEach((line, index) => fn(line, index + 1));
}

test("no email outside example.com/example.org is tracked", (t) => {
  if (!insideGitCheckout()) return t.skip(NOT_A_CHECKOUT);
  const hits = [];
  for (const document of documents()) {
    // 0.6.23: a binary blob (a NUL byte, git's own test) is skipped by this
    // rule only: compressed PNG bytes spelled `CB@G8.Zx` once, and an email
    // in a screenshot lives in its pixels, not its bytes. The path and
    // private-terms rules still read every blob.
    if (document.content.includes("\0")) continue;
    forEachLine(document, (line, lineNumber) => {
      for (const match of line.matchAll(EMAIL_RE)) {
        const domain = match[0].slice(match[0].indexOf("@") + 1).toLowerCase();
        if (!ALLOWED_EMAIL_DOMAINS.has(domain)) hits.push(`${document.label}:${lineNumber}`);
      }
    });
  }
  assert.deepEqual(hits, [], `private email domain found at:\n${hits.join("\n")}`);
});

test("no absolute /Users/<name>/ path is tracked", (t) => {
  if (!insideGitCheckout()) return t.skip(NOT_A_CHECKOUT);
  const hits = [];
  for (const document of documents()) {
    forEachLine(document, (line, lineNumber) => {
      if (USERS_PATH_RE.test(line)) hits.push(`${document.label}:${lineNumber}`);
    });
  }
  assert.deepEqual(hits, [], `absolute /Users/ path found at:\n${hits.join("\n")}`);
});

test("no term from the owner's private-terms list is tracked", (t) => {
  if (!insideGitCheckout()) return t.skip(NOT_A_CHECKOUT);
  const termsPath = join(homedir(), ".config", "orca-supervisor", "private-terms.txt");
  if (!existsSync(termsPath)) {
    t.skip("no private-terms file; absent for other users and CI");
    return;
  }

  const terms = readFileSync(termsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    t.skip("the private-terms file is empty");
    return;
  }

  const hits = [];
  for (const document of documents()) {
    forEachLine(document, (line, lineNumber) => {
      if (terms.some((term) => line.includes(term))) hits.push(`${document.label}:${lineNumber}`);
    });
  }
  assert.deepEqual(hits, [], `private term found at:\n${hits.join("\n")}`);
});
