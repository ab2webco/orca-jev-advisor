// 0.6.8 T6: the subagents running now -- which model each one runs and why
// that model. Visibility only: nothing here decides anything; it reads what
// the router (model_router_subagent.ts) already decided at spawn. 0.6.14:
// the status line only counts them (`agentes: 4`); each one's row is drawn
// above the prompt (subagent_band.ts).
//
// Pure: the hooks module keeps the running set (agent.spawn adds, the
// subagent's own turn.complete or `$.agent.list()` removes) and passes it in.

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import { baseModelId, tierOfModel } from "./model_router_accounts.ts";
import type { ResolvedTiers, RouterTier } from "./model_router_accounts.ts";
import type { SubagentDecision } from "./model_router_subagent.ts";
import type { SessionEffort } from "./model_router_decide.ts";

/** Where a subagent's effort came from (see RunningSubagent.effortSource). */
export type SubagentEffortSource = "inherited" | "jev" | "frontmatter" | "not-sent";
const EFFORT_SOURCES: readonly SubagentEffortSource[] = ["inherited", "jev", "frontmatter", "not-sent"];

/**
 * The source of the effort a subagent step is sent with: what the engine put
 * on the step (`carried`) against what the plugin sends (`sent`). 0.6.16 T3:
 * the level the agent's definition declares (`declared`) is named as such
 * when that is what is sent, lifted to it or carried as it was.
 */
export function subagentEffortSource(carried: SessionEffort | null, sent: SessionEffort | null, declared: SessionEffort | null = null): SubagentEffortSource {
  if (sent === null) return "not-sent";
  if (declared !== null && sent === declared) return "frontmatter";
  return carried === sent ? "inherited" : "jev";
}

/** Why a running subagent is on the model it is on. */
/** Why a running subagent is on the model it is on; `unknown` when nothing recorded it (0.6.14 T1: it started before the plugin loaded). */
export type SubagentWhy = "explicit" | "lowered" | "raised" | "chosen" | "same" | "kept-unsure" | "kept-pointer" | "measuring" | "inherited" | "no-jev" | "unknown";

const WHYS: readonly SubagentWhy[] = ["explicit", "lowered", "raised", "chosen", "same", "kept-unsure", "kept-pointer", "measuring", "inherited", "no-jev", "unknown"];

/**
 * One subagent running now (0.6.14 T1): what it is and what it is doing,
 * as the tasks list shows it, and what the router gave it at spawn.
 */
export interface RunningSubagent {
  /** `$.agent.list()`'s id, the one its loop's events carry as `agentId`. */
  readonly id: string;
  /** The agent definition it runs as (`general-purpose`, `acme-frontend-developer`). */
  readonly type: string;
  /** Its row's label in the tasks list: the Agent call's `description`. */
  readonly description: string;
  /** The model as a person reads it (`Opus 5.5`); null when nothing recorded it. */
  readonly label: string | null;
  /** The effort its last step was sent with; null when none was sent (or none seen yet). */
  readonly effort: SessionEffort | null;
  /**
   * 0.6.15 T4b: where that effort came from, read off the step it sent:
   * `inherited` the level the engine resolved for it (the session or its model
   * settings), `frontmatter` the one its definition declares (0.6.16 T3),
   * `jev` the one the router set, `not-sent` no
   * effort at all; null before its first step. Absent on a row stored
   * before 0.6.15.
   */
  readonly effortSource?: SubagentEffortSource | null;
  readonly why: SubagentWhy;
  /** Measure mode: the model the router would have given it, when that is another one. */
  readonly wouldUse: string | null;
}

/** An agent as `$.agent.list()` returns it, the fields read here. */
export interface ListedAgent {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly status: string;
}

/**
 * The running set against what the host runs now: `kept` is what stays
 * recorded (a recorded agent the host lists as running, or `keep`, the one
 * just started), `shown` adds a row for each agent the host runs that no
 * spawn recorded (it started before this plugin loaded), first, in the
 * host's order -- so the count always matches the host's. With no list
 * (the host has none, or it failed) what spawn recorded stands.
 */
export function reconcileRunning(recorded: readonly RunningSubagent[], listed: readonly ListedAgent[] | null, keep: string | null): { kept: RunningSubagent[]; shown: RunningSubagent[] } {
  if (listed === null) return { kept: [...recorded], shown: [...recorded] };
  const live = listed.filter((agent) => agent.status === "running");
  const liveIds = new Set(live.map((agent) => agent.id));
  const kept = recorded.filter((agent) => agent.id === keep || liveIds.has(agent.id));
  const known = new Set(kept.map((agent) => agent.id));
  const unknown: RunningSubagent[] = live
    .filter((agent) => !known.has(agent.id))
    .map((agent) => ({ id: agent.id, type: agent.type, description: agent.description, label: null, effort: null, why: "unknown", wouldUse: null }));
  return { kept, shown: [...unknown, ...kept] };
}

function isEffort(value: unknown): value is SessionEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || (typeof value === "number" && Number.isFinite(value));
}

function parseOne(value: unknown): RunningSubagent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.type !== "string" || typeof v.description !== "string") return null;
  if (v.label !== null && typeof v.label !== "string") return null;
  if (v.effort !== null && !isEffort(v.effort)) return null;
  if (!WHYS.includes(v.why as SubagentWhy)) return null;
  if (v.wouldUse !== null && typeof v.wouldUse !== "string") return null;
  const base = { id: v.id, type: v.type, description: v.description, label: v.label, effort: v.effort, why: v.why as SubagentWhy, wouldUse: v.wouldUse };
  if (v.effortSource === undefined) return base;
  if (v.effortSource !== null && !EFFORT_SOURCES.includes(v.effortSource as SubagentEffortSource)) return null;
  return { ...base, effortSource: v.effortSource as SubagentEffortSource | null };
}

/** The running set as `$.state` keeps it (`{ agents }`); anything malformed is dropped, never thrown. */
export function parseRunningSubagents(value: unknown): RunningSubagent[] {
  if (typeof value !== "object" || value === null) return [];
  const agents = (value as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  return agents.map(parseOne).filter((agent): agent is RunningSubagent => agent !== null);
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

/**
 * The status-line part for the subagents running now: how many (0.6.14 T2).
 * Which one runs what, and why, is the band's (subagent_band.ts): grouped
 * by model on one line, the person could not tell the agents apart. null
 * when none runs.
 */
export function subagentsStatusPart(locale: Locale, running: readonly unknown[]): string | null {
  if (running.length === 0) return null;
  return translate(MODEL_ROUTER_CATALOG, locale, "agents.count", { n: String(running.length) });
}
