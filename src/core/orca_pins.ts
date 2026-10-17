// ---------------------------------------------------------------------------
// Orca Lab's launch pins (JEVADV-105, odd/tasks/router-honor-orca-pins.md).
//
// Orca sets ORCA_AGENT_MODEL_PINNED=1 / ORCA_AGENT_EFFORT_PINNED=1 in an
// agent's env when its launch asked for that model or effort and it took
// effect. The router leaves a pinned dimension alone, but only in a pane
// Orca's game draws: the game and Jev each work alone, so outside one the
// variables change nothing. Pure: the callers read the env.
// ---------------------------------------------------------------------------

import type { GameMode } from "./advisor_state.ts";
import { tierOfModel } from "./model_router_accounts.ts";
import type { ResolvedTiers } from "./model_router_accounts.ts";
import type { SessionEffort } from "./model_router_decide.ts";

export type PinnedDimension = "model" | "effort";

export interface OrcaPins {
  readonly model: boolean;
  readonly effort: boolean;
}

export const NO_ORCA_PINS: OrcaPins = { model: false, effort: false };

/** The pins that hold in this pane: none without the game, and only a value of exactly `1`. */
export function orcaPinsOf(game: GameMode | null, model: string | null | undefined, effort: string | null | undefined): OrcaPins {
  if (game === null) return NO_ORCA_PINS;
  return { model: model === "1", effort: effort === "1" };
}

export function hasOrcaPin(pins: OrcaPins | undefined): pins is OrcaPins {
  return pins !== undefined && (pins.model || pins.effort);
}

/** Every tier resolved to `model`, so a decision over them can move only the effort; null when the account's tiers do not hold it. */
export function modelPinnedTiers(tiers: ResolvedTiers, model: string): ResolvedTiers | null {
  const tier = tierOfModel(tiers, model);
  if (tier === null) return null;
  const pinned = tiers[tier];
  return { simple: pinned, standard: pinned, complex: pinned, frontier: pinned };
}

/** The effort sent on `model` under an effort pin: the session's own, or none on a model that takes none. */
export function pinnedEffort(tiers: ResolvedTiers, model: string, configuredModel: string, configuredEffort: SessionEffort | null): SessionEffort | null {
  if (model === configuredModel) return configuredEffort;
  const tier = tierOfModel(tiers, model);
  return tier === null || tiers[tier].supportsEffort ? configuredEffort : null;
}

/** The dimensions a pin held: the model when Jev's tier names another one, the effort when the router aimed elsewhere. */
export function heldDimensions(pins: OrcaPins, held: { readonly model: boolean; readonly effort: boolean }): readonly PinnedDimension[] {
  return [...(pins.model && held.model ? (["model"] as const) : []), ...(pins.effort && held.effort ? (["effort"] as const) : [])];
}
