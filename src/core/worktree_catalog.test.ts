// The cases here are the real shapes measured on a machine with 52
// worktrees across 42 repositories, because the interesting ones are not
// what you would invent: a repository whose extra worktrees live INSIDE it,
// another whose extra worktree is a SIBLING sharing a name prefix, and a
// plugin workspace listed three times under the identical path.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DEFAULT_DERIVED_AUTONOMY, coveringPaths, deriveDestinations, parseWorktreeList } from "./worktree_catalog.ts";

const P = "/Users/dev/Projects/";

test("a worktree nested inside another is already covered by prefix matching", () => {
  assert.deepEqual(
    coveringPaths([`${P}orca-oss`, `${P}orca-oss/feature-a`, `${P}orca-oss/feature-b`]),
    [`${P}orca-oss`],
  );
});

test("a SIBLING sharing a name prefix is NOT covered and must survive", () => {
  // Measured: team-helpdesk and team-helpdesk-hotfix are different
  // directories. Collapsing them would judge one under the other's
  // thresholds, silently.
  const paths = [`${P}repo`, `${P}repo-hero197`, `${P}repo/sub-133`];
  assert.deepEqual(coveringPaths(paths).sort(), [`${P}repo`, `${P}repo-hero197`]);
});

test("identical paths collapse to one", () => {
  const same = "/Users/dev/Library/Application Support/orca/plugin-workspaces/x";
  assert.deepEqual(coveringPaths([same, same, same]), [same]);
});

test("a trailing separator does not create a second root", () => {
  assert.deepEqual(coveringPaths([`${P}repo`, `${P}repo/`]), [`${P}repo`]);
});

test("Windows separators are compared by segment too", () => {
  const paths = ["C:\\src\\repo", "C:\\src\\repo\\feature", "C:\\src\\repo-2"];
  assert.deepEqual(coveringPaths(paths).sort(), ["C:\\src\\repo", "C:\\src\\repo-2"]);
});

test("one destination per repository when it has a single root", () => {
  const out = deriveDestinations([
    { repo: "orca-oss", path: `${P}orca-oss` },
    { repo: "orca-oss", path: `${P}orca-oss/feature-a` },
    { repo: "other", path: `${P}other` },
  ]);
  assert.deepEqual(out.map((d) => d.id), ["orca-oss", "other"]);
  assert.equal(out[0]?.worktreePath, `${P}orca-oss`);
});

test("a repository with separate roots gets one destination each, named apart", () => {
  const out = deriveDestinations([
    { repo: "helpdesk", path: `${P}helpdesk` },
    { repo: "helpdesk", path: `${P}helpdesk-hero197` },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((d) => d.id).sort(), ["helpdesk", "helpdesk-hero197"]);
  assert.equal(new Set(out.map((d) => d.label)).size, 2, "two rows must not share a label");
});

test("archived worktrees are left out", () => {
  const out = deriveDestinations([
    { repo: "live", path: `${P}live` },
    { repo: "old", path: `${P}old`, isArchived: true },
  ]);
  assert.deepEqual(out.map((d) => d.id), ["live"]);
});

test("ids are stable, lowercase and free of punctuation, because they key the developer's own settings", () => {
  const out = deriveDestinations([{ repo: "WhatsApp Inbox (plugin)", path: `${P}wa` }]);
  assert.equal(out[0]?.id, "whatsapp-inbox-plugin");
  assert.deepEqual(deriveDestinations([{ repo: "WhatsApp Inbox (plugin)", path: `${P}wa` }]), out);
});

test("every derived destination carries the same cautious default, because nothing in the list says which is riskier", () => {
  const out = deriveDestinations([
    { repo: "a", path: `${P}a` },
    { repo: "b", path: `${P}b` },
  ]);
  for (const d of out) assert.deepEqual(d.autonomy, DEFAULT_DERIVED_AUTONOMY);
});

test("the CLI envelope is unwrapped, and anything unexpected yields an empty list rather than throwing", () => {
  assert.equal(parseWorktreeList({ ok: true, result: { worktrees: [{ repo: "r", path: "/p" }] } }).length, 1);
  for (const bad of [null, undefined, {}, { result: {} }, { result: { worktrees: "no" } }, "text", 3]) {
    assert.deepEqual(parseWorktreeList(bad), []);
  }
});
