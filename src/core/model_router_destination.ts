// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, gap G6): the destination and policy guard.
//
// The session's working directory is resolved against the SAME catalog and
// policies mirrors the Bash gate reads (`catalog.json`, `policies.json`),
// with the gate's own parsers (gate_catalog_mirror.ts) and matcher
// (destination_match.ts): nothing about matching is re-implemented here.
// The candidates are tried in order, cwd first and then the linked
// worktree's main checkout, which is the gate's own fallback
// (linked_worktree.ts's matchDestinationForCwd, which reads the filesystem
// with Node and so cannot run in the hooks module; the caller resolves the
// main checkout through `$.process.run` instead).
//
// The guard holds when the destination is a client site, or when a
// `requires_human` / `prohibits` policy is scoped to THIS destination.
// Global policies do not count: every policy on the owner's machine is
// global, so counting them would hold the floor in every session and the
// router could never save anything; they are command rules the Bash gate
// already enforces on each command (see the feature document, G6).
//
// A missing or malformed catalog is "unknown", and unknown never holds the
// floor on its own. Pure.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { filterPoliciesForDestination } from "./decisions.ts";
import { matchDestination } from "./destination_match.ts";
import { parseMirroredCatalog, parseMirroredPolicies } from "./gate_catalog_mirror.ts";
import type { DestinationKind } from "./model_router_decide.ts";

export interface RouterDestination {
  readonly destinationKind: DestinationKind | null;
  readonly destinationId: string | null;
  /** A `requires_human` or `prohibits` policy is scoped to this destination. */
  readonly policyHit: boolean;
  readonly status: "matched" | "unmatched" | "unknown";
}

export interface RouterDestinationInput {
  /** `catalog.json`, already JSON.parse'd (null when missing or unreadable). */
  readonly catalog: unknown;
  /** `policies.json`, already JSON.parse'd (null when missing or unreadable). */
  readonly policies: unknown;
  /** Directories to match, in order: the session's cwd, then its linked worktree's main checkout. */
  readonly candidates: readonly string[];
}

const KINDS: readonly DestinationKind[] = ["client-site", "service", "project", "support"];

const NONE = { destinationKind: null, destinationId: null, policyHit: false } as const;

export function resolveRouterDestination(input: RouterDestinationInput): RouterDestination {
  const catalog = parseMirroredCatalog(input.catalog);
  if (catalog === null) return { ...NONE, status: "unknown" };
  const matched = input.candidates.map((candidate) => matchDestination(candidate, catalog.destinations)).find((row) => row !== null) ?? null;
  if (matched === null) return { ...NONE, status: "unmatched" };
  // The mirror row carries the catalog entry's `kind` (the gate reads it the
  // same way); the mirror's own type only declares what the gate matches on.
  const rawKind: unknown = isRecord(matched) ? matched.kind : undefined;
  const destinationKind = KINDS.find((kind) => kind === rawKind) ?? null;
  const policies = parseMirroredPolicies(input.policies) ?? [];
  const scoped = filterPoliciesForDestination(policies, matched.id).filter((policy) => policy.destinations !== undefined && policy.destinations.length > 0);
  const policyHit = scoped.some((policy) => policy.kind === "requires_human" || policy.kind === "prohibits");
  return { destinationKind, destinationId: matched.id, policyHit, status: "matched" };
}
