// ---------------------------------------------------------------------------
// Per-project 7-day activity (JEVADV-63): what really happened, per project,
// over the last week -- gate outcomes, agent steps, tokens/cost, and the
// router's own saving estimate, all folded from already-parsed rows.
//
// Pure, like the rest of src/core: no I/O. The sidecar (read-activity.mjs,
// A3) reads gate-decisions.jsonl and the hourly turn-usage/router files and
// hands the parsed rows in here.
//
// Windowing: every number in this summary is confined to the last 7 LOCAL
// calendar days (Date#getFullYear/getMonth/getDate, system timezone -- the
// worker and the board run on the same machine, odd/tasks/jev-063-activity.md
// "Decisions: Day bucketing"). A row whose local day falls outside that
// 7-day span is not counted anywhere, including toward `lastActivityAt`: this
// is a windowed 7-day summary end to end, not a lifetime tally with a 7-day
// chart bolted on. The router's own window uses `summarizeRouterDecisions`'s
// own `windowMs` parameter (a rolling 7*24h from `nowMs`) rather than the
// calendar-day set, since that function does its own `at`-based filtering
// and this reuses it as-is rather than reimplementing its math.
// ---------------------------------------------------------------------------

import type { TurnUsageRecord } from "./consumption.ts";
import type { RouterDecisionRecord } from "./model_router_decide.ts";
import { pricesForModel } from "./model_router_accounts.ts";
import type { RouterDecisionSummary } from "./model_router_summary.ts";
import { summarizeRouterDecisions } from "./model_router_summary.ts";

const DAY_MS = 24 * 3600_000;
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

/**
 * A gate-decisions.jsonl row, structurally -- only what this fold needs.
 * `verdict` is deliberately wider than the known union: an unrecognized
 * value must never throw, just be ignored (out of scope for this feature,
 * per the Decisions section).
 */
export interface GateDecisionInput {
  readonly at: string;
  readonly project: string | null;
  readonly commandFamily: string;
  readonly verdict: "allow" | "ask" | "deny" | "advise" | string;
  readonly latencyMs: number | null;
}

export interface DayActivity {
  readonly day: string; // YYYY-MM-DD, local calendar day
  readonly judgedCommands: number;
  readonly mainSteps: number;
  readonly subagentSteps: number;
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

export interface ModelTokenSummary {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** List-price estimate, never exact -- see the module note on cost. 0 when the model has no resolvable price; the token counts are still reported. */
  readonly estimatedCostUsd: number;
}

export interface ProjectActivity {
  readonly project: string | null;
  /** ISO string, or null when nothing for this project fell inside the 7-day window. */
  readonly lastActivityAt: string | null;
  /** Always 7 entries, oldest to newest, present even when empty. */
  readonly days: readonly DayActivity[];
  readonly gateOutcomes: GateOutcomeTotals;
  readonly steps: StepTotals;
  readonly tokensByModel: readonly ModelTokenSummary[];
  /** Sum of every model's estimatedCostUsd -- an estimate, never exact. */
  readonly totalEstimatedCostUsd: number;
  /** `summarizeRouterDecisions`'s own summary for this project's rows, or null when the project has no router-decision rows in the window (never zeros dressed up as data). */
  readonly router: RouterDecisionSummary | null;
}

export interface ActivityByProjectSummary {
  /** Ranked by lastActivityAt descending (null last), ties broken by total interactions (judged commands + steps) descending. */
  readonly projects: readonly ProjectActivity[];
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The 7 local calendar-day keys ending on `nowMs`'s own day, oldest to newest. */
function dayKeysFor(nowMs: number): string[] {
  const now = new Date(nowMs);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const keys: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
    keys.push(localDayKey(new Date(y, m, d - i).getTime()));
  }
  return keys;
}

function emptyGateOutcomes(): { allowed: number; advised: number; asked: number; blocked: number } {
  return { allowed: 0, advised: 0, asked: 0, blocked: 0 };
}

interface MutableDay {
  judgedCommands: number;
  mainSteps: number;
  subagentSteps: number;
}

interface MutableTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface MutableProject {
  readonly days: Map<string, MutableDay>;
  gateOutcomes: { allowed: number; advised: number; asked: number; blocked: number };
  steps: { main: number; subagent: number };
  readonly tokensByModel: Map<string, MutableTokens>;
  lastActivityAtMs: number | null;
  readonly routerRows: RouterDecisionRecord[];
  readonly routerUsageRows: TurnUsageRecord[];
}

function newProject(dayKeys: readonly string[]): MutableProject {
  const days = new Map<string, MutableDay>();
  for (const key of dayKeys) days.set(key, { judgedCommands: 0, mainSteps: 0, subagentSteps: 0 });
  return {
    days,
    gateOutcomes: emptyGateOutcomes(),
    steps: { main: 0, subagent: 0 },
    tokensByModel: new Map(),
    lastActivityAtMs: null,
    routerRows: [],
    routerUsageRows: [],
  };
}

function bumpLastActivity(project: MutableProject, atMs: number): void {
  if (project.lastActivityAtMs === null || atMs > project.lastActivityAtMs) project.lastActivityAtMs = atMs;
}

function projectKey(project: string | null | undefined): string | null {
  return project === undefined || project === null ? null : project;
}

export function aggregateActivityByProject(
  gateRows: readonly GateDecisionInput[],
  turnUsageRows: readonly TurnUsageRecord[],
  routerDecisionRows: readonly RouterDecisionRecord[],
  nowMs: number,
): ActivityByProjectSummary {
  const dayKeys = dayKeysFor(nowMs);
  const dayKeySet = new Set(dayKeys);
  const projects = new Map<string | null, MutableProject>();

  const getProject = (project: string | null): MutableProject => {
    const existing = projects.get(project);
    if (existing !== undefined) return existing;
    const created = newProject(dayKeys);
    projects.set(project, created);
    return created;
  };

  for (const row of gateRows) {
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs)) continue;
    const dayKey = localDayKey(atMs);
    if (!dayKeySet.has(dayKey)) continue;
    const outcomeField =
      row.verdict === "allow" ? "allowed" : row.verdict === "advise" ? "advised" : row.verdict === "ask" ? "asked" : row.verdict === "deny" ? "blocked" : null;
    if (outcomeField === null) continue; // unrecognized verdict: out of scope, never counted, never throws
    const project = getProject(projectKey(row.project));
    const day = project.days.get(dayKey) as MutableDay;
    day.judgedCommands += 1;
    project.gateOutcomes[outcomeField] += 1;
    bumpLastActivity(project, atMs);
  }

  for (const row of turnUsageRows) {
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs)) continue;
    const dayKey = localDayKey(atMs);
    if (!dayKeySet.has(dayKey)) continue;
    const project = getProject(projectKey(row.project));
    const day = project.days.get(dayKey) as MutableDay;
    if (row.agent === "main") {
      day.mainSteps += 1;
      project.steps.main += 1;
    } else {
      day.subagentSteps += 1;
      project.steps.subagent += 1;
    }
    bumpLastActivity(project, atMs);

    const tokens = project.tokensByModel.get(row.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens.input += row.input ?? 0;
    tokens.output += row.output ?? 0;
    tokens.cacheRead += row.cacheRead ?? 0;
    tokens.cacheWrite += row.cacheWrite ?? 0;
    project.tokensByModel.set(row.model, tokens);
  }

  // Every project's own turn-usage rows are kept aside (unwindowed by
  // calendar day, since summarizeRouterDecisions applies its own rolling
  // windowMs) so the router's saving estimate reflects only this project's
  // steps -- an account shared across projects must not have one project's
  // savings inflated by another's activity on the same account.
  for (const row of turnUsageRows) {
    const project = projectKey(row.project);
    if (!projects.has(project)) continue;
    (projects.get(project) as MutableProject).routerUsageRows.push(row);
  }

  for (const row of routerDecisionRows) {
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || atMs < nowMs - WINDOW_MS || atMs > nowMs) continue;
    const project = getProject(projectKey(row.project));
    project.routerRows.push(row);
    bumpLastActivity(project, atMs);
  }

  const result: ProjectActivity[] = [];
  for (const [project, mutable] of projects) {
    const days: DayActivity[] = dayKeys.map((key) => {
      const day = mutable.days.get(key) as MutableDay;
      return { day: key, judgedCommands: day.judgedCommands, mainSteps: day.mainSteps, subagentSteps: day.subagentSteps };
    });

    const tokensByModel: ModelTokenSummary[] = [...mutable.tokensByModel.entries()].map(([model, tokens]) => {
      const prices = pricesForModel(model);
      const estimatedCostUsd =
        prices === null ? 0 : (tokens.input * prices.input + tokens.cacheWrite * prices.cacheWrite + tokens.cacheRead * prices.cacheRead + tokens.output * prices.output) / 1_000_000;
      return { model, input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, estimatedCostUsd };
    });
    const totalEstimatedCostUsd = tokensByModel.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0);

    const router = mutable.routerRows.length === 0 ? null : summarizeRouterDecisions(mutable.routerRows, mutable.routerUsageRows, nowMs, WINDOW_MS);

    result.push({
      project,
      lastActivityAt: mutable.lastActivityAtMs === null ? null : new Date(mutable.lastActivityAtMs).toISOString(),
      days,
      gateOutcomes: mutable.gateOutcomes,
      steps: mutable.steps,
      tokensByModel,
      totalEstimatedCostUsd,
      router,
    });
  }

  const totalInteractions = (p: ProjectActivity): number => {
    const { allowed, advised, asked, blocked } = p.gateOutcomes;
    return allowed + advised + asked + blocked + p.steps.main + p.steps.subagent;
  };

  result.sort((a, b) => {
    const aMs = a.lastActivityAt === null ? null : Date.parse(a.lastActivityAt);
    const bMs = b.lastActivityAt === null ? null : Date.parse(b.lastActivityAt);
    if (aMs === null && bMs === null) return totalInteractions(b) - totalInteractions(a);
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    if (aMs !== bMs) return bMs - aMs;
    return totalInteractions(b) - totalInteractions(a);
  });

  return { projects: result };
}
