// odd/tasks/release-0.5.1.md JEVADV-11: which repositories Orca's worktree
// list already knows about are missing from the developer's own catalog --
// the pure "what to propose" half of the fix. The impure half (running
// `orca worktree ps --json`, resolving a linked worktree's main checkout
// from the real filesystem) belongs to the caller (main.mjs); this takes
// already-parsed worktrees, the current catalog, and a plain lookup
// function for "does this path resolve to some other main checkout", and
// never touches a filesystem or a child process itself.
//
// Never invents a `kind` -- see deriveCatalogProposals's own doc for why
// every proposal comes back with none.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveCatalogProposals } from "./catalog_proposals.ts";
import type { OrcaWorktree } from "./worktree_catalog.ts";
import type { CatalogDestination } from "./store.ts";

function worktree(repo: string, path: string, overrides: Partial<OrcaWorktree> = {}): OrcaWorktree {
  return { repo, path, ...overrides };
}

function destination(id: string, worktreePath: string): CatalogDestination {
  return { id, label: id, kind: "project", worktreePath, autonomy: {} };
}

/** No path resolves to any other main checkout -- every candidate is judged purely on its own worktreePath. */
const noLinkedWorktrees = () => null;

test("deriveCatalogProposals: a worktree whose exact path is already catalogued is not proposed", () => {
  const worktrees = [worktree("cineco-frontend", "/Users/dev/Projects/cineco-frontend")];
  const catalog = [destination("cineco-frontend", "/Users/dev/Projects/cineco-frontend")];
  const proposals = deriveCatalogProposals(worktrees, catalog, noLinkedWorktrees);
  assert.deepEqual(proposals, []);
});

test("deriveCatalogProposals: a worktree nested under an already-catalogued destination is not proposed", () => {
  const worktrees = [worktree("cineco-frontend", "/Users/dev/Projects/cineco-frontend/packages/app")];
  const catalog = [destination("cineco-frontend", "/Users/dev/Projects/cineco-frontend")];
  const proposals = deriveCatalogProposals(worktrees, catalog, noLinkedWorktrees);
  assert.deepEqual(proposals, []);
});

test("deriveCatalogProposals: a linked worktree of an already-catalogued repo's main checkout is not proposed", () => {
  const worktrees = [worktree("cineco-frontend", "/Users/dev/Projects/cineco-frontend-cin-985")];
  const catalog = [destination("cineco-frontend", "/Users/dev/Projects/cineco-frontend")];
  const mainCheckoutOf = (path: string) =>
    path === "/Users/dev/Projects/cineco-frontend-cin-985" ? "/Users/dev/Projects/cineco-frontend" : null;
  const proposals = deriveCatalogProposals(worktrees, catalog, mainCheckoutOf);
  assert.deepEqual(proposals, [], "a linked worktree of a repo already in the catalog must not be proposed a second time");
});

test("deriveCatalogProposals: two linked worktrees of the SAME uncatalogued main checkout collapse into one proposal, at the main checkout", () => {
  const worktrees = [
    worktree("poptwin-backend", "/Users/dev/Projects/poptwin-backend-a"),
    worktree("poptwin-backend", "/Users/dev/Projects/poptwin-backend-b"),
  ];
  const mainCheckoutOf = (path: string) =>
    path === "/Users/dev/Projects/poptwin-backend-a" || path === "/Users/dev/Projects/poptwin-backend-b"
      ? "/Users/dev/Projects/poptwin-backend"
      : null;
  const proposals = deriveCatalogProposals(worktrees, [], mainCheckoutOf);
  assert.equal(proposals.length, 1, "two linked worktrees of the same uncatalogued repo must collapse to one proposal");
  assert.equal(proposals[0].worktreePath, "/Users/dev/Projects/poptwin-backend");
});

test("deriveCatalogProposals: a genuinely new repository (no linked-worktree resolution) is proposed as itself", () => {
  const worktrees = [worktree("myparkplanner-be", "/Users/dev/Projects/myparkplanner-be")];
  const proposals = deriveCatalogProposals(worktrees, [], noLinkedWorktrees);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].worktreePath, "/Users/dev/Projects/myparkplanner-be");
  assert.equal(proposals[0].label, "myparkplanner-be");
});

test("deriveCatalogProposals: never invents a kind -- a proposal carries no kind field at all", () => {
  const worktrees = [worktree("myparkplanner-be", "/Users/dev/Projects/myparkplanner-be")];
  const proposals = deriveCatalogProposals(worktrees, [], noLinkedWorktrees);
  assert.equal("kind" in proposals[0], false);
});

test("deriveCatalogProposals: an id that collides with an EXISTING catalog id (unrelated repo, same slug) gets a numeric suffix", () => {
  const worktrees = [worktree("frontend", "/Users/dev/Projects/other-org/frontend")];
  // A pre-existing, unrelated destination that happens to slug to the same id.
  const catalog = [destination("frontend", "/Users/dev/Projects/original-org/frontend")];
  const proposals = deriveCatalogProposals(worktrees, catalog, noLinkedWorktrees);
  assert.equal(proposals.length, 1);
  assert.notEqual(proposals[0].id, "frontend", "must not collide with the existing catalog id");
  assert.match(proposals[0].id, /^frontend-\d+$/);
});

test("deriveCatalogProposals: archived worktrees are never proposed", () => {
  const worktrees = [worktree("archived-repo", "/Users/dev/Projects/archived-repo", { isArchived: true })];
  const proposals = deriveCatalogProposals(worktrees, [], noLinkedWorktrees);
  assert.deepEqual(proposals, []);
});

test("deriveCatalogProposals: results are sorted by id", () => {
  const worktrees = [worktree("zeta", "/Users/dev/Projects/zeta"), worktree("alpha", "/Users/dev/Projects/alpha")];
  const proposals = deriveCatalogProposals(worktrees, [], noLinkedWorktrees);
  assert.deepEqual(proposals.map((p) => p.id), ["alpha", "zeta"]);
});
