// ---------------------------------------------------------------------------
// Model router summary for the board (JEV-060 slice 2, §8): what the router
// decided over a window, and an ESTIMATE of what its applied downgrades
// saved.
//
// The estimate follows §8: for every applied switch that carried
// break-even numbers, stepSaving × the main-loop steps that actually ran
// on the new model afterwards (same account, until that account's next
// applied switch), minus the switch's own cache-rewrite cost. Turn-usage
// records carry no session id, so "afterwards" is per account, not per
// session: an estimate, labelled as one. The unit is list-price dollars
// (the prices of §2.4), which the subscription weighs the same way.
//
// Pure: the worker's sidecar reads the files and hands the rows in.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { ROUTER_TIERS } from "./model_router_accounts.ts";
import type { RouterTier } from "./model_router_accounts.ts";

export type RouterPointName = "start" | "stage" | "subagent";

export type TierCounts = Record<RouterTier, number>;

export interface RouterDecisionSummary {
  readonly total: number;
  readonly applied: number;
  readonly measured: number;
  readonly byPoint: Readonly<Record<RouterPointName, TierCounts>>;
  /** Estimated list-price dollars saved by applied switches; null when no applied switch carried break-even numbers. */
  readonly savedEstimate: number | null;
  readonly switchesEstimated: number;
}

interface DecisionRow {
  readonly atMs: number;
  readonly account: string;
  readonly point: RouterPointName;
  readonly tier: RouterTier | null;
  readonly applied: boolean;
  readonly proposed: string | null;
  readonly switchCost: number | null;
  readonly stepSaving: number | null;
}

interface UsageRow {
  readonly atMs: number;
  readonly account: string;
  readonly model: string;
}

const POINTS: readonly RouterPointName[] = ["start", "stage", "subagent"];

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDecision(raw: unknown): DecisionRow | null {
  if (!isRecord(raw) || typeof raw.at !== "string" || typeof raw.account !== "string" || typeof raw.applied !== "boolean") return null;
  const point = POINTS.find((candidate) => candidate === raw.point);
  const atMs = Date.parse(raw.at);
  if (point === undefined || !Number.isFinite(atMs)) return null;
  const tier = ROUTER_TIERS.find((candidate) => candidate === raw.tier) ?? null;
  return {
    atMs,
    account: raw.account,
    point,
    tier,
    applied: raw.applied,
    proposed: typeof raw.proposed === "string" ? raw.proposed : null,
    switchCost: finiteOrNull(raw.switchCost),
    stepSaving: finiteOrNull(raw.stepSaving),
  };
}

function parseUsage(raw: unknown): UsageRow | null {
  if (!isRecord(raw) || raw.agent !== "main" || typeof raw.at !== "string" || typeof raw.account !== "string" || typeof raw.model !== "string") return null;
  const atMs = Date.parse(raw.at);
  return Number.isFinite(atMs) ? { atMs, account: raw.account, model: raw.model } : null;
}

function emptyCounts(): TierCounts {
  return { simple: 0, standard: 0, complex: 0, frontier: 0 };
}

export function summarizeRouterDecisions(decisionRows: readonly unknown[], usageRows: readonly unknown[], nowMs: number, windowMs: number): RouterDecisionSummary {
  const decisions = decisionRows.map(parseDecision).filter((row): row is DecisionRow => row !== null && row.atMs >= nowMs - windowMs && row.atMs <= nowMs);
  const usage = usageRows.map(parseUsage).filter((row): row is UsageRow => row !== null);
  const byPoint: Record<RouterPointName, TierCounts> = { start: emptyCounts(), stage: emptyCounts(), subagent: emptyCounts() };
  for (const row of decisions) if (row.tier !== null) byPoint[row.point][row.tier] += 1;
  const applied = decisions.filter((row) => row.applied).length;

  // Main-loop switches only: a subagent's model never changes the main loop's.
  const mainSwitches = decisions.filter((row) => row.applied && row.point !== "subagent").sort((a, b) => a.atMs - b.atMs);
  let saved = 0;
  let estimated = 0;
  for (const [index, row] of mainSwitches.entries()) {
    if (row.stepSaving === null || row.switchCost === null || row.proposed === null) continue;
    const until = mainSwitches.slice(index + 1).find((later) => later.account === row.account)?.atMs ?? Number.POSITIVE_INFINITY;
    const steps = usage.filter((step) => step.account === row.account && step.model === row.proposed && step.atMs > row.atMs && step.atMs < until).length;
    saved += row.stepSaving * steps - row.switchCost;
    estimated += 1;
  }
  return { total: decisions.length, applied, measured: decisions.length - applied, byPoint, savedEstimate: estimated === 0 ? null : saved, switchesEstimated: estimated };
}
