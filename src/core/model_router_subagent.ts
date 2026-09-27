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
// Subagent effort has no field (§2.6): out of scope. Pure: no I/O.
// ---------------------------------------------------------------------------

import { FABLE_ID, baseModelId, collapseTier, modelRank } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import { activeGuards, shiftForPressure } from "./model_router_decide.ts";
import type { GuardContext, QuotaBand, RouterGuard, TierJudgment } from "./model_router_decide.ts";

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
  if (target.modelId === baseModelId(input.parentModel)) return { ...stay, ...base, reason: "same", guard: null };
  return { ...base, current, model: target.modelId, changed: true, reason: "switch", guard: null };
}
