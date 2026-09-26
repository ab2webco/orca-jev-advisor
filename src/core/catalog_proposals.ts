// odd/tasks/release-0.5.1.md JEVADV-11 -- the destination catalog only ever
// grows through two paths: a person typing a row by hand, or
// cmdRefreshCatalog (main.mjs) silently ADDING one, always with `kind:
// "project"` hardcoded (worktree_catalog.ts's deriveDestinations has no
// other information to guess from). That silent default is exactly why a
// real client repository -- e.g. `~/Projects/cineco-backend` -- never gets
// "client-site" treatment: nothing ever asks. This module is the pure half
// of the fix: given the same `orca worktree ps --json` data
// cmdRefreshCatalog already reads, and the developer's current catalog,
// which worktrees does the catalog not yet cover, so the panel can PROPOSE
// them and let the person pick a kind -- never invent one.
//
// Documented limit (the task's own escape hatch: no other API exists to
// reach for): this can only propose a repository Orca's `worktree ps`
// already reports. `src/core/orca_cli.ts`'s own module doc calls that
// payload "every worktree Orca knows" -- OrcaWorktree's doc says the raw
// payload "carries far more" fields than this plugin reads, but nothing in
// this codebase (no `workspace.readContext`, no other CLI subcommand -- see
// orca_cli.ts's ORCA_CLI_ARGUMENTS, the complete literal list) exposes a
// broader "every repository on this machine" listing. A repository Orca has
// never opened as a worktree is invisible to this plugin's host surface,
// full stop; inventing a new CLI call to reach further was explicitly out
// of scope for this fix.
//
// Pure: no filesystem, no child process. `mainCheckoutOf` -- "does this
// worktree path resolve to some OTHER path as its linked worktree's main
// checkout" -- is the one piece of real I/O this needs (a `.git` file read;
// see src/core/linked_worktree.ts's resolveLinkedWorktreeMainCheckout), so
// the caller (main.mjs) supplies it as a plain function; this module never
// calls the real one itself.

import { matchDestination } from "./destination_match.ts";
import type { CatalogDestination } from "./store.ts";
import { deriveDestinations, type OrcaWorktree } from "./worktree_catalog.ts";

/**
 * One repository the catalog does not yet cover -- deliberately missing a
 * `kind`. `deriveDestinations` (the same function cmdRefreshCatalog already
 * calls) defaults every derived row to `"project"`; a proposal must not
 * repeat that guess, since guessing "project" for what might be a client's
 * own repository is the exact bug this exists to fix. The panel renders one
 * of these per row with an EMPTY kind selector, and only a person's explicit
 * choice ever reaches the catalog (see main.mjs's
 * attendCatalogProposalAcceptRequest).
 */
export interface CatalogProposal {
  readonly id: string;
  readonly label: string;
  readonly worktreePath: string;
}

/**
 * Which repositories `worktrees` (a real `orca worktree ps --json` payload,
 * already parsed) report that `catalog` does not already cover.
 *
 * `mainCheckoutOf(path)` resolves a worktree path to its LINKED worktree's
 * main checkout, or `null` when it is not a linked worktree (or resolution
 * fails) -- the caller's job, not this function's (see the module doc).
 * Two worktrees that both resolve to the same uncatalogued main checkout
 * collapse into exactly one proposal, AT that main checkout path -- so
 * accepting it produces a destination T3's own longest-prefix matching
 * (src/core/destination_match.ts) already covers every sibling worktree
 * under, not just the one that happened to be reported first.
 *
 * A candidate is dropped, never proposed, when its resolved path (the main
 * checkout, or the worktree's own path when it is not linked) already
 * matches an existing catalog destination (matchDestination's own
 * longest-prefix rule) -- exact path, nested under one, or a linked
 * worktree of one, all read the same way here.
 *
 * A surviving candidate's id may still collide with an UNRELATED existing
 * catalog id (deriveDestinations only disambiguates candidates against each
 * other, never against the real catalog) -- resolved the same way
 * deriveDestinations resolves a collision among its own candidates: a
 * numeric suffix, appended until unique.
 */
export function deriveCatalogProposals(
  worktrees: readonly OrcaWorktree[],
  catalog: readonly CatalogDestination[],
  mainCheckoutOf: (worktreePath: string) => string | null,
): readonly CatalogProposal[] {
  const candidates = deriveDestinations(worktrees);

  // Collapse to one candidate per resolved path -- first one encountered
  // wins, since every candidate for the same resolved path names the same
  // underlying repository.
  const byResolvedPath = new Map<string, CatalogDestination>();
  for (const candidate of candidates) {
    const resolvedPath = mainCheckoutOf(candidate.worktreePath) ?? candidate.worktreePath;
    if (!byResolvedPath.has(resolvedPath)) byResolvedPath.set(resolvedPath, candidate);
  }

  const usedIds = new Set(catalog.map((d) => d.id));
  const proposals: CatalogProposal[] = [];
  for (const [resolvedPath, candidate] of byResolvedPath) {
    if (matchDestination(resolvedPath, catalog) !== null) continue;

    let id = candidate.id;
    let n = 2;
    while (usedIds.has(id)) id = `${candidate.id}-${n++}`;
    usedIds.add(id);

    proposals.push({ id, label: candidate.label, worktreePath: resolvedPath });
  }

  return proposals.sort((a, b) => a.id.localeCompare(b.id));
}
