// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md §3 point B, T8):
// which model a subagent runs on.
//
// A subagent starts with a cold context, so choosing its model costs no
// cache. The rules:
//   - no explicit model: the tier's model, down or up from the parent's,
//     with the guards keeping at least the parent's;
//   - an explicit `model` from the parent (the Agent call's, or the one an
//     agent definition fixes) is intent: upgraded only when a guard holds,
//     and lowered only when the person chose to have it judged (0.6.8 T7,
//     `explicitModels: "judge"`) and none of the floors below holds;
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
import { activeGuards, mentionsSensitiveTopic, shiftForPressure } from "./model_router_decide.ts";
import type { DestinationKind, GuardContext, QuotaBand, RouterGuard, SessionEffort, TierEffort, TierJudgment } from "./model_router_decide.ts";

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

export type SubagentReason = "jev-failed" | "same" | "switch" | "held-by-guard" | "explicit" | "explicit-upgrade" | "explicit-lowered";

/** 0.6.8 T7: what the router does with a model the spawn already fixed. */
export type ExplicitModelsPolicy = "judge" | "keep";

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
  /** 0.6.8 T7: "judge" lets a confident verdict lower an explicit model; "keep" (the default here) never does. */
  readonly explicitModels?: ExplicitModelsPolicy;
  /** The session's destination kind; in a client's site an explicit model is never lowered below the parent's. */
  readonly destinationKind?: DestinationKind | null;
}

/**
 * 0.6.8 T7: the model a judged explicit model is lowered to, or null when it
 * stays. Only below the explicit model's own rank, and never when a guard
 * holds (Jev unsure, a pointer prompt), the work is sensitive or already
 * failing -- the same floors every other router decision keeps. In a
 * client's site the floor is also the session's own model: lowered at most
 * to it, exactly as the parent runs it.
 */
function loweredExplicitModel(input: SubagentDecisionInput, guards: readonly RouterGuard[], targetId: string, proposedRank: number | null, explicitRank: number | null): string | null {
  if ((input.explicitModels ?? "keep") !== "judge" || guards.length > 0) return null;
  if (proposedRank === null || explicitRank === null || proposedRank >= explicitRank) return null;
  if (mentionsSensitiveTopic(input.guards.text)) return null;
  const activity = input.guards.activity;
  if (activity !== null && (activity.testsFailed > 0 || activity.errors > 0)) return null;
  if (input.destinationKind === "client-site") {
    const parentRank = modelRank(input.tiers, input.parentModel);
    if (parentRank === null) return null;
    if (proposedRank < parentRank) return parentRank < explicitRank ? input.parentModel : null;
  }
  return targetId;
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
    const lowered = loweredExplicitModel(input, guards, target.modelId, proposedRank, explicitRank);
    if (lowered !== null) return { ...base, current, model: lowered, changed: true, reason: "explicit-lowered", guard: null };
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
