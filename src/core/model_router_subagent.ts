// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §3 point B, T8):
// which model a subagent runs on.
//
// A subagent starts with a cold context, so choosing its model costs no
// cache. The rules:
//   - no explicit model: the tier's model, down or up from the parent's,
//     with the guards keeping at least the parent's;
//   - an explicit `model` from the parent is intent: never downgraded,
//     upgraded only when a guard holds;
//   - always a FULL model id: a family alias (`opus`) collapses to the
//     parent's exact model when the parent is already in that family (§2.6).
//
// JEV-061 slice 2: a subagent's FIRST step is the other place a switch costs
// nothing (a cold context, same as its model), but it inherits the parent's
// own effort, clamped to whatever the subagent's model supports -- a
// standard-work subagent on Sonnet ran every step at the parent's `xhigh`,
// clamped to `high`, never the tier's own `medium`. `subagentStepEffort`
// below applies the tier's own effort to that inherited value, in both
// directions, on every one of that agent's steps (see hooks/index.ts's own
// `subagentEffortTarget` map): the tier and eligibility (no explicit model,
// no guard, active mode) are decided once at spawn time, same as the model
// above. Unguarded, the tier's effort wins outright, up or down (0.6.3:
// F0 -- no guard ever blocks an effort raise, and an unguarded step has no
// guard to hold anything back). Guarded, the effort only ever rises to the
// tier's, never falls. Neither case touches a person's own `max` or numeric
// budget. Pure: no I/O.
// ---------------------------------------------------------------------------

import { FABLE_ID, baseModelId, collapseTier, modelRank } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { activeGuards, shiftForPressure } from "./model_router_decide.ts";
import type { GuardContext, QuotaBand, RouterGuard, SessionEffort, TierEffort, TierJudgment } from "./model_router_decide.ts";

const ALIAS_TIER: Readonly<Record<string, RouterTier>> = { haiku: "simple", sonnet: "standard", opus: "complex", fable: "frontier" };

/** Where the Agent tool's `model` parameter (an alias or an id) sits on this account's ladder; null for `inherit` or anything the account does not resolve. */
export function explicitModelRank(tiers: ResolvedTiers, model: string): number | null {
  const tier = ALIAS_TIER[model.toLowerCase()];
  if (tier !== undefined) {
    const collapsed = collapseTier(tiers, tier === "frontier" && tiers.frontier.modelId !== FABLE_ID ? "complex" : tier);
    return modelRank(tiers, tiers[collapsed].modelId);
  }
  return modelRank(tiers, model);
}

export type SubagentReason = "jev-failed" | "same" | "switch" | "held-by-guard" | "explicit" | "explicit-upgrade";

export interface SubagentDecision {
  readonly tier: RouterTier | null;
  readonly confidence: number | null;
  /** What the subagent would run on without the router: the explicit model, else the parent's. */
  readonly current: string;
  readonly proposed: string | null;
  /** The value for the spawn's `model`: a full id when changed, the input unchanged otherwise. */
  readonly model: string;
  readonly changed: boolean;
  readonly reason: SubagentReason;
  readonly guard: RouterGuard | null;
}

export interface SubagentDecisionInput {
  readonly tiers: ResolvedTiers;
  readonly jev: TierJudgment | null;
  readonly parentModel: string;
  /** The Agent tool's `model` as the parent gave it; undefined (or `inherit`) when it gave none. */
  readonly explicitModel: string | undefined;
  readonly guards: GuardContext;
  readonly band?: QuotaBand;
}

export function decideSubagent(input: SubagentDecisionInput): SubagentDecision {
  const explicit = input.explicitModel !== undefined && input.explicitModel !== "inherit" ? input.explicitModel : null;
  const current = explicit ?? input.parentModel;
  const stay = { current, model: current, changed: false } as const;
  if (input.jev === null) return { ...stay, tier: null, confidence: null, proposed: null, reason: "jev-failed", guard: null };

  const guards = activeGuards(input.guards);
  const tier = collapseTier(input.tiers, shiftForPressure(input.jev.tier, input.band ?? "normal", guards, null));
  const target = input.tiers[tier];
  const base = { tier, confidence: input.jev.confidence, proposed: target.modelId };
  const proposedRank = modelRank(input.tiers, target.modelId);

  if (explicit !== null) {
    const explicitRank = explicitModelRank(input.tiers, explicit);
    const upgrade = guards.length > 0 && proposedRank !== null && explicitRank !== null && proposedRank > explicitRank;
    if (!upgrade) return { ...stay, ...base, reason: "explicit", guard: guards[0] ?? null };
    return { ...base, current, model: target.modelId, changed: true, reason: "explicit-upgrade", guard: guards[0] ?? null };
  }

  const parentRank = modelRank(input.tiers, input.parentModel);
  const isDowngrade = parentRank === null || proposedRank === null || proposedRank < parentRank;
  if (isDowngrade && guards.length > 0) return { ...stay, ...base, reason: "held-by-guard", guard: guards[0] ?? null };
  // A guard that holds is named even when nothing changes: it decides how the
  // subagent's effort may move, and the log records it (review finding 2).
  if (target.modelId === baseModelId(input.parentModel)) return { ...stay, ...base, reason: "same", guard: guards[0] ?? null };
  return { ...base, current, model: target.modelId, changed: true, reason: "switch", guard: guards[0] ?? null };
}

// ---------------------------------------------------------------------------
// JEV-061 slice 2: the subagent's own first-step effort.
// ---------------------------------------------------------------------------

const EFFORT_RANK: Readonly<Record<TierEffort, number>> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/**
 * What a subagent's step should actually send for `effort`, given the tier
 * the router chose for it at spawn (`target`; null when that tier's model
 * takes no effort at all, Haiku) and what the step already carries
 * (`current`: the parent's own, inherited and clamped to what the
 * subagent's model supports).
 *
 * Unguarded, the tier's own effort wins outright, raised or lowered from
 * `current` (mirrors `decideStart`'s own unguarded branch in
 * model_router_decide.ts: no comparison, the tier's decision stands).
 * Guarded, `current` may only rise to `target`, never fall (mirrors
 * `guardedEffort`: a guard blocks a lowering, never a raise -- 0.6.3 F0). A
 * person's own `max` or numeric budget is never touched either way, the
 * same floor `isPersonEffort` (model_router_decide.ts) protects elsewhere in
 * the router -- it is intent, not something inherited.
 */
export function subagentStepEffort(target: TierEffort | null, current: SessionEffort | undefined, guarded = false): SessionEffort | undefined {
  if (current === "max" || typeof current === "number") return current;
  if (current === undefined) return target ?? undefined;
  if (target === null) return undefined;
  // 0.6.2 F0: under a guard the effort may rise to the tier's, never fall.
  if (guarded) return EFFORT_RANK[target] > EFFORT_RANK[current] ? target : current;
  // Unguarded: the tier's own effort applies outright, both directions.
  return target;
}
