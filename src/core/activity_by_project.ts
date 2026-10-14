// ---------------------------------------------------------------------------
// Activity per project (JEVADV-63; odd/tasks/board-global-window.md W1): what
// really happened, per project, inside one of the board's windows -- gate
// outcomes, agent steps, tokens and an estimated cost, and the project's
// share of the router's saving estimate, folded from already-parsed rows.
//
// Pure, like the rest of src/core: no I/O. The sidecar (read-activity.mjs)
// reads the gate log and the hourly turn-usage/router files and calls this
// once per window (src/core/board_windows.ts), so "24 h" on Actividad is the
// same rolling span as "24 h" on every other tab.
//
// Only what the board's Actividad card shows is kept per window: one row per
// project with its totals (never per-day or per-token-kind detail), the
// first ACTIVITY_PROJECTS_SHOWN of them, and one `rest` row for the others,
// which still count in `totals`.
//
// The router share comes from routerByProject (model_router_summary.ts), the
// same per-switch estimate the Consumo tab's router total sums, so the
// per-project figures add up to it.
// ---------------------------------------------------------------------------

import type { BoardWindow } from "./board_windows.ts";
import { isInWindow, windowSpanMs } from "./board_windows.ts";
import type { TurnUsageRecord } from "./consumption.ts";
import type { RouterDecisionRecord } from "./model_router_decide.ts";
import { requestCostUsd } from "./model_cost.ts";
import { pricesForModel } from "./model_router_accounts.ts";
import type { ProjectRouterShare } from "./model_router_summary.ts";
import { routerByProject } from "./model_router_summary.ts";

/** How many projects a window keeps by name; the rest fold into one row. */
export const ACTIVITY_PROJECTS_SHOWN = 25;
/** How many models a project row names, dearest first. */
const MODELS_SHOWN = 3;

/**
 * A gate-decisions.jsonl row, structurally -- only what this fold needs.
 * `verdict` is deliberately wider than the known union: an unrecognized
 * value must never throw, just be ignored.
 */
export interface GateDecisionInput {
  readonly at: string;
  readonly project: string | null;
  readonly commandFamily: string;
  readonly verdict: "allow" | "ask" | "deny" | "advise" | string;
  readonly latencyMs: number | null;
}

export interface GateOutcomeTotals {
  readonly allowed: number;
  readonly advised: number;
  readonly asked: number;
  readonly blocked: number;
}

export interface StepTotals {
  readonly main: number;
  readonly subagent: number;
}

export interface ModelCost {
  readonly model: string;
  readonly steps: number;
  /** List-price estimate, never exact. 0 when the model has no resolvable price. */
  readonly estimatedCostUsd: number;
}

export interface ProjectActivity {
  readonly project: string | null;
  /** The latest instant anything of this project happened inside the window. */
  readonly lastActivityAt: string | null;
  /** Gate decisions with a known verdict. */
  readonly judged: number;
  readonly gateOutcomes: GateOutcomeTotals;
  readonly steps: StepTotals;
  /** Input, output, cache read and cache write together. */
  readonly tokens: number;
  /** Sum over every model, an estimate at list prices. */
  readonly estimatedCostUsd: number;
  /** The dearest MODELS_SHOWN models. */
  readonly models: readonly ModelCost[];
  /** null when the project has no router decision in the window (never zeros dressed up as data). */
  readonly router: ProjectRouterShare | null;
}

export interface ActivityRest {
  readonly projects: number;
  readonly judged: number;
  readonly steps: number;
  readonly tokens: number;
  readonly estimatedCostUsd: number;
}

export interface ActivityTotals extends ActivityRest {
  /** Sum of every project's router estimate; null when no project has one. */
  readonly routerSavedEstimate: number | null;
}

export interface WindowActivity {
  /** Dearest first, then by interactions (judged + steps), then by recency. */
  readonly projects: readonly ProjectActivity[];
  /** The projects past ACTIVITY_PROJECTS_SHOWN, folded; null when there are none. */
  readonly rest: ActivityRest | null;
  readonly totals: ActivityTotals;
}

interface MutableProject {
  lastActivityAtMs: number | null;
  gateOutcomes: { allowed: number; advised: number; asked: number; blocked: number };
  steps: { main: number; subagent: number };
  tokens: number;
  readonly models: Map<string, { steps: number; costUsd: number }>;
  router: ProjectRouterShare | null;
}

function projectKey(project: string | null | undefined): string | null {
  return project === undefined || project === null ? null : project;
}

function outcomeField(verdict: string): keyof GateOutcomeTotals | null {
  if (verdict === "allow") return "allowed";
  if (verdict === "advise") return "advised";
  if (verdict === "ask") return "asked";
  if (verdict === "deny") return "blocked";
  return null;
}

function judgedOf(p: { readonly gateOutcomes: GateOutcomeTotals }): number {
  const { allowed, advised, asked, blocked } = p.gateOutcomes;
  return allowed + advised + asked + blocked;
}

export function aggregateActivityForWindow(
  gateRows: readonly GateDecisionInput[],
  turnUsageRows: readonly TurnUsageRecord[],
  routerDecisionRows: readonly RouterDecisionRecord[],
  nowMs: number,
  window: BoardWindow,
): WindowActivity {
  const projects = new Map<string | null, MutableProject>();
  const getProject = (project: string | null): MutableProject => {
    const existing = projects.get(project);
    if (existing !== undefined) return existing;
    const created: MutableProject = {
      lastActivityAtMs: null,
      gateOutcomes: { allowed: 0, advised: 0, asked: 0, blocked: 0 },
      steps: { main: 0, subagent: 0 },
      tokens: 0,
      models: new Map(),
      router: null,
    };
    projects.set(project, created);
    return created;
  };
  const touch = (project: MutableProject, atMs: number): void => {
    if (project.lastActivityAtMs === null || atMs > project.lastActivityAtMs) project.lastActivityAtMs = atMs;
  };

  for (const row of gateRows) {
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || !isInWindow(atMs, window, nowMs)) continue;
    const field = outcomeField(row.verdict);
    if (field === null) continue; // unrecognized verdict: never counted, never throws
    const project = getProject(projectKey(row.project));
    project.gateOutcomes[field] += 1;
    touch(project, atMs);
  }

  for (const row of turnUsageRows) {
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || !isInWindow(atMs, window, nowMs)) continue;
    const project = getProject(projectKey(row.project));
    if (row.agent === "main") project.steps.main += 1;
    else project.steps.subagent += 1;
    project.tokens += (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
    const model = project.models.get(row.model) ?? { steps: 0, costUsd: 0 };
    model.steps += 1;
    const prices = pricesForModel(row.model);
    if (prices !== null) model.costUsd += requestCostUsd(prices, row);
    project.models.set(row.model, model);
    touch(project, atMs);
  }

  // Every usage row goes to the router estimate, not only the window's: a
  // switch inside the window is credited with the steps that followed it.
  const routerShares = routerByProject(routerDecisionRows, turnUsageRows, nowMs, windowSpanMs(window, nowMs));
  for (const [name, share] of routerShares) getProject(name).router = share;
  for (const row of routerDecisionRows) {
    const atMs = Date.parse(row.at);
    if (Number.isFinite(atMs) && isInWindow(atMs, window, nowMs)) touch(getProject(projectKey(row.project)), atMs);
  }

  const rows: ProjectActivity[] = [...projects.entries()].map(([project, mutable]) => {
    const models = [...mutable.models.entries()]
      .map(([model, entry]) => ({ model, steps: entry.steps, estimatedCostUsd: entry.costUsd }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.steps - a.steps || a.model.localeCompare(b.model));
    return {
      project,
      lastActivityAt: mutable.lastActivityAtMs === null ? null : new Date(mutable.lastActivityAtMs).toISOString(),
      judged: judgedOf(mutable),
      gateOutcomes: mutable.gateOutcomes,
      steps: mutable.steps,
      tokens: mutable.tokens,
      estimatedCostUsd: models.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
      models: models.slice(0, MODELS_SHOWN),
      router: mutable.router,
    };
  });

  const interactions = (p: ProjectActivity): number => p.judged + p.steps.main + p.steps.subagent;
  const lastMs = (p: ProjectActivity): number => (p.lastActivityAt === null ? Number.NEGATIVE_INFINITY : Date.parse(p.lastActivityAt));
  rows.sort((a, b) =>
    b.estimatedCostUsd - a.estimatedCostUsd ||
    interactions(b) - interactions(a) ||
    lastMs(b) - lastMs(a) ||
    String(a.project).localeCompare(String(b.project)));

  const fold = (list: readonly ProjectActivity[]): ActivityRest => ({
    projects: list.length,
    judged: list.reduce((sum, p) => sum + p.judged, 0),
    steps: list.reduce((sum, p) => sum + p.steps.main + p.steps.subagent, 0),
    tokens: list.reduce((sum, p) => sum + p.tokens, 0),
    estimatedCostUsd: list.reduce((sum, p) => sum + p.estimatedCostUsd, 0),
  });
  const estimates = rows.map((p) => p.router?.savedEstimate ?? null).filter((value): value is number => value !== null);
  const leftover = rows.slice(ACTIVITY_PROJECTS_SHOWN);

  return {
    projects: rows.slice(0, ACTIVITY_PROJECTS_SHOWN),
    rest: leftover.length === 0 ? null : fold(leftover),
    totals: { ...fold(rows), routerSavedEstimate: estimates.length === 0 ? null : estimates.reduce((sum, value) => sum + value, 0) },
  };
}
