// Loads and validates catalog.json: the list of destinations (services,
// client sites, projects, support inboxes) this supervisor is allowed to
// route encargos to, along with each destination's autonomy thresholds.

import { isArrayOf, isNumber, isRecord, isString } from "../guards.ts";
/**
 * How many levels a destination's `maxAutoDelicateness` can range over.
 *
 * It used to live in the prototype CLI's own `jev.ts`, which has been
 * deleted along with the rest of that dead layer. Kept here, next to the
 * only field that validates against it, rather than reaching across the
 * tree for a single number.
 */
const DELICATENESS_LEVELS = 5;

export type DestinationKind = "service" | "client-site" | "project" | "support";

function isDestinationKind(value: unknown): value is DestinationKind {
  return value === "service" || value === "client-site" || value === "project" || value === "support";
}

export interface AutonomyConfig {
  actThreshold: number;
  confirmThreshold: number;
  // The highest delicateness level index (0..DELICATENESS_LEVELS - 1,
  // zero-based, measured live against the real API) this destination may
  // reach and still be acted on automatically. Above it, decide.ts always
  // asks a human, regardless of how unambiguous the encargo was. Set to 0
  // for a destination where 'act' must stay effectively unreachable (see
  // the client-site policy in README.md): the real delicateness score is a
  // continuous expectation over the scale and only equals exactly 0 when
  // the model is fully certain the encargo is trivial, which practically
  // never happens for a client site.
  maxAutoDelicateness: number;
  // Optional per-destination override for the command gate's consequence
  // ceiling (src/core/decisions.ts's GATE_CONSEQUENCE_CEILING). Absent
  // means "use the global consequenceCeiling" -- same shape and meaning as
  // the store.ts runtime copy of this type; kept in sync deliberately.
  consequenceCeiling?: number;
}

function isAutonomyConfig(value: unknown): value is AutonomyConfig {
  if (!isRecord(value) || !isNumber(value.actThreshold) || !isNumber(value.confirmThreshold) || !isNumber(value.maxAutoDelicateness)) {
    return false;
  }
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

/**
 * Business rules beyond the raw shape: thresholds must live in (0, 1],
 * acting always requires at least as much confidence as merely confirming,
 * and maxAutoDelicateness must be a whole, zero-based level index within
 * the delicateness scale (see DELICATENESS_LEVELS above -- the two must
 * never drift).
 */
function validateAutonomyRules(catalog: Catalog): string[] {
  const errors: string[] = [];
  const maxLevelIndex = DELICATENESS_LEVELS - 1;
  for (const destination of catalog.destinations) {
    const { actThreshold, confirmThreshold, maxAutoDelicateness } = destination.autonomy;
    if (!(actThreshold > 0 && actThreshold <= 1)) {
      errors.push(`Destination '${destination.id}': actThreshold must be in (0, 1], got ${actThreshold}`);
    }
    if (!(confirmThreshold > 0 && confirmThreshold <= 1)) {
      errors.push(`Destination '${destination.id}': confirmThreshold must be in (0, 1], got ${confirmThreshold}`);
    }
    if (actThreshold < confirmThreshold) {
      errors.push(`Destination '${destination.id}': actThreshold (${actThreshold}) must be >= confirmThreshold (${confirmThreshold})`);
    }
    if (!Number.isInteger(maxAutoDelicateness) || maxAutoDelicateness < 0 || maxAutoDelicateness > maxLevelIndex) {
      errors.push(
        `Destination '${destination.id}': maxAutoDelicateness must be an integer between 0 and ${maxLevelIndex}, got ${maxAutoDelicateness}`,
      );
    }
  }
  return errors;
}
