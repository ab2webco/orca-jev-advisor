// 0.6.7 T6: the subagents running now, in the status line -- which model
// each one runs and why that model (`agentes: 2 en Opus 5.5 (pedido
// explícito)`). Visibility only: nothing here decides anything; it reads
// what the router (model_router_subagent.ts) already decided at spawn.
//
// Pure: the hooks module keeps the running set (agent.spawn adds, the
// subagent's own turn.complete or `$.agent.list()` removes) and passes it in.

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import type { ModelRouterKey } from "./i18n_model_router.ts";
import { baseModelId, tierOfModel } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import type { SubagentDecision } from "./model_router_subagent.ts";

/** Why a running subagent is on the model it is on. */
export type SubagentWhy = "explicit" | "lowered" | "raised" | "chosen" | "same" | "kept-unsure" | "kept-pointer" | "measuring" | "inherited" | "no-jev";

export interface RunningSubagent {
  /** The model as a person reads it (`Opus 5.5`). */
  readonly label: string;
  readonly why: SubagentWhy;
}

export interface SubagentWhyInput {
  /** What routeSubagent decided; null when the router did not run (off, a fork, an error). */
  readonly decision: SubagentDecision | null;
  /** Whether the decision's model was actually sent (active mode and a change). */
  readonly applied: boolean;
  /** Whether the spawn came with a model of its own (the Agent call or the agent definition). */
  readonly explicit: boolean;
}

export function subagentWhy(input: SubagentWhyInput): SubagentWhy {
  const { decision, applied, explicit } = input;
  if (decision === null || decision.reason === "jev-failed") return explicit ? "explicit" : decision === null ? "inherited" : "no-jev";
  switch (decision.reason) {
    case "explicit":
      return "explicit";
    case "explicit-upgrade":
      return applied ? "raised" : "explicit";
    case "explicit-lowered":
      return applied ? "lowered" : "explicit";
    case "switch":
      return applied ? "chosen" : explicit ? "explicit" : "measuring";
    case "held-by-guard":
      return decision.guard === "pointer-prompt" ? "kept-pointer" : "kept-unsure";
    case "same":
      return "same";
  }
  return explicit ? "explicit" : "inherited";
}

const ALIAS_TIER: Readonly<Record<string, RouterTier>> = { haiku: "simple", sonnet: "standard", opus: "complex", fable: "frontier" };
const ALIAS_FAMILY: Readonly<Record<string, string>> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", fable: "Fable" };

/** The account's own label for the model (`Opus 5.5`), a family name for a bare alias with no account at hand, the id itself otherwise. */
export function subagentModelLabel(model: string, tiers: ResolvedTiers | null): string {
  const alias = model.toLowerCase();
  if (tiers !== null) {
    const aliasTier = ALIAS_TIER[alias];
    if (aliasTier !== undefined && tiers[aliasTier].modelId.toLowerCase().includes(alias)) return tiers[aliasTier].label;
    const tier = tierOfModel(tiers, baseModelId(model));
    if (tier !== null) return tiers[tier].label;
  }
  const family = Object.keys(ALIAS_FAMILY).find((name) => new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(alias));
  return ALIAS_FAMILY[alias] ?? (family !== undefined ? (ALIAS_FAMILY[family] as string) : model);
}

const WHY_KEY: Readonly<Record<SubagentWhy, ModelRouterKey>> = {
  explicit: "agents.why.explicit",
  lowered: "agents.why.lowered",
  raised: "agents.why.raised",
  chosen: "agents.why.chosen",
  same: "agents.why.same",
  "kept-unsure": "agents.why.kept-unsure",
  "kept-pointer": "agents.why.kept-pointer",
  measuring: "agents.why.measuring",
  inherited: "agents.why.inherited",
  "no-jev": "agents.why.no-jev",
};

/** One status-line part for every subagent running now, grouped by model and reason in the order they started; null when none runs. */
export function subagentsStatusPart(locale: Locale, running: readonly RunningSubagent[]): string | null {
  if (running.length === 0) return null;
  const groups: { label: string; why: SubagentWhy; count: number }[] = [];
  for (const agent of running) {
    const group = groups.find((g) => g.label === agent.label && g.why === agent.why);
    if (group !== undefined) group.count += 1;
    else groups.push({ label: agent.label, why: agent.why, count: 1 });
  }
  const parts = groups.map((g) =>
    translate(MODEL_ROUTER_CATALOG, locale, "agents.group", { n: String(g.count), model: g.label, why: translate(MODEL_ROUTER_CATALOG, locale, WHY_KEY[g.why]) }),
  );
  return translate(MODEL_ROUTER_CATALOG, locale, "agents.lead", { groups: parts.join(", ") });
}
