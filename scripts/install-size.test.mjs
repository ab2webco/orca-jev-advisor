// Orca installs this repository by cloning a release tag and refuses a plugin
// tree over 50 MiB or 2,000 entries (files and directories, `.git` excluded;
// orca-oss `src/main/plugins/plugin-content-hash.ts`). 0.6.29 (54.6 MiB) and
// 0.7.0 (69.7 MiB) crossed it with committed QA screenshots, and every
// "Check for update" failed with "Could not prepare this plugin for review".
// The budget below keeps headroom under Orca's limits; QA screenshots live on
// the `qa-evidence` branch, which a tag clone never fetches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 1_600;

function insideGitCheckout() {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

/** @returns {{ bytes: number, entries: number, largest: string[] }} */
function trackedTree() {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const directories = new Set();
  /** @type {Map<string, number>} top two path segments -> bytes */
  const byArea = new Map();
  let bytes = 0;
  let files = 0;
  for (const path of paths) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      continue; // deleted but still tracked: not part of what would be committed
    }
    files += 1;
    bytes += size;
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) directories.add(dir);
    const area = path.split("/").slice(0, 3).join("/");
    byArea.set(area, (byArea.get(area) ?? 0) + size);
  }
  const largest = [...byArea]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([area, size]) => `${(size / 1048576).toFixed(1)} MiB ${area}`);
  return { bytes, entries: files + directories.size, largest };
}

test("the tracked tree fits what Orca will install, with headroom", (t) => {
  if (!insideGitCheckout()) return t.skip("not a git checkout (an installed copy has no .git)");
  const tree = trackedTree();
  assert.ok(
    tree.bytes <= MAX_BYTES,
    `tracked tree is ${(tree.bytes / 1048576).toFixed(1)} MiB, budget ${MAX_BYTES / 1048576} MiB (Orca refuses over 50). Largest:\n${tree.largest.join("\n")}`,
  );
  assert.ok(tree.entries <= MAX_ENTRIES, `tracked tree has ${tree.entries} entries, budget ${MAX_ENTRIES} (Orca refuses over 2000)`);
});
