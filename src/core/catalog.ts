// Loads and validates catalog.json: the list of destinations (services,
// client sites, projects, support inboxes) this supervisor is allowed to
// route encargos to, along with each destination's autonomy thresholds.
//
// TRACED, AB-benchmark pass: this module is imported by nothing in `src/`
// or `adapters/` (confirmed by grep across the whole tree, and this file
// has no test of its own) -- the runtime catalog is `store.ts`'s
// `CatalogDestination`/`getCatalog`/`setCatalog`, which `adapters/orca/
// main.mjs` actually imports. This file is a leftover, presumably from the
// "prototype CLI" the DELICATENESS_LEVELS comment (removed below) referred
// to. Left in place rather than deleted -- out of scope for the fields this
// pass was asked to fix -- but flagged here so the next person does not
// assume it is load-bearing.

import { isArrayOf, isNumber, isRecord, isString } from "../guards.ts";

export type DestinationKind = "service" | "client-site" | "project" | "support";

function isDestinationKind(value: unknown): value is DestinationKind {
  return value === "service" || value === "client-site" || value === "project" || value === "support";
}

/**
 * `actThreshold`, `confirmThreshold` and `maxAutoDelicateness` used to live
 * here too, alongside a `DELICATENESS_LEVELS = 5` constant and a
 * `validateAutonomyRules` business-rule check for all three. Traced and
 * removed: this module has no importer at all (see the module note above),
 * so the destructuring `validateAutonomyRules` did at its own line 90 never
 * ran against real data, and the three fields never reached a decision
 * anywhere -- `decideDestination` (decisions.ts) takes `{ action, policies,
 * policyAnswers, riskAnswers }`, never a destination's `AutonomyConfig`, and
 * judges every destination against the same module-level
 * `REVERSIBLE_GATE`/`EXTERNAL_GATE`/`CONSEQUENCE_CEILING` constants. Matches
 * production-honesty-pass P2's precedent for the same class of defect on
 * `store.ts`'s copy of this type (see that file's own note on
 * `AutonomyConfig`).
 */
export interface AutonomyConfig {
  // Optional per-destination override for the command gate's consequence
  // ceiling (src/core/decisions.ts's GATE_CONSEQUENCE_CEILING). Absent
  // means "use the global consequenceCeiling" -- same shape and meaning as
  // the store.ts runtime copy of this type; kept in sync deliberately.
  consequenceCeiling?: number;
}

function isAutonomyConfig(value: unknown): value is AutonomyConfig {
  if (!isRecord(value)) return false;
  if ("consequenceCeiling" in value && value.consequenceCeiling !== undefined && !isNumber(value.consequenceCeiling)) {
    return false;
  }
  return true;
}

export interface Destination {
  id: string;
  label: string;
  kind: DestinationKind;
  worktreePath: string;
  terminalTitleMatch?: string;
  autonomy: AutonomyConfig;
}

function isDestination(value: unknown): value is Destination {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.label) || !isDestinationKind(value.kind)) return false;
  if (!isString(value.worktreePath)) return false;
  if ("terminalTitleMatch" in value && value.terminalTitleMatch !== undefined && !isString(value.terminalTitleMatch)) {
    return false;
  }
  return isAutonomyConfig(value.autonomy);
}

export interface Catalog {
  destinations: Destination[];
}

function isCatalogShape(value: unknown): value is Catalog {
  return isRecord(value) && isArrayOf(value.destinations, isDestination);
}

// validateAutonomyRules used to live here: business rules (thresholds in
// (0, 1], a delicateness level index within a fixed scale) for the three
// fields removed from AutonomyConfig above. Nothing left to validate once
// those fields were gone -- removed rather than kept as a no-op.
