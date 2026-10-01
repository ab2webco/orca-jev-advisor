// 0.6.14 T2: the subagents running now, one row each, in the band above the
// prompt: what it is (its agent type), what it is doing (its description),
// the model it runs, the effort its steps are sent with, and why that model.
// The 0.6.8 status line grouped them by model, so the person could not tell
// which agent ran which; the line now only counts them.
//
// Pure: the hooks module reconciles the running set (subagent_status.ts)
// and draws each row as one Text; this lays the rows out to the band's
// width. Every line it returns fits `columns`; narrow widths give way in
// this order: the effort column, the reason's long wording, the description.

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import type { ModelRouterKey } from "./i18n_model_router.ts";
import type { SessionEffort } from "./model_router_decide.ts";
import type { RunningSubagent, SubagentWhy } from "./subagent_status.ts";

/** One agent's row: `text` is every column but the reason (padded), `why` the reason, drawn dim. */
export interface BandRow {
  readonly text: string;
  readonly why: string;
}

export interface SubagentBand {
  readonly heading: string;
  readonly rows: readonly BandRow[];
}

const GAP = "  ";
/** The description keeps at least this many cells before the effort column goes. */
const DESC_ROOM = 24;
/** Below this many cells for the description, each agent takes two lines. */
const DESC_FLOOR = 16;
/** On the two-line layout: the least a type is cut to, and the cells it leaves its reason. */
const TYPE_FLOOR = 6;
const REASON_FLOOR = 12;
/** The most cells the one-line layout sets aside for the reason when it sizes the description. */
const REASON_ROOM = 16;

/**
 * The engine's own agent types: never a project's, so they never hold back
 * the prefix a project's agents share (the owner's four agents were three
 * `<project>-…` ones and a `general-purpose`).
 */
const ENGINE_TYPES: ReadonlySet<string> = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "fork", "teammate"]);

/**
 * The `word-` prefix (or `word-word-`, ...) every one of the project's agent
 * types shares, to drop from the rows: it says nothing that tells two rows
 * apart. Needs two different such types; the engine's own do not count.
 * "" when there is none.
 */
export function sharedTypePrefix(types: readonly string[]): string {
  const custom = [...new Set(types.filter((type) => !ENGINE_TYPES.has(type)))];
  if (custom.length < 2) return "";
  let common = custom[0] ?? "";
  for (const type of custom) {
    let i = 0;
    while (i < common.length && i < type.length && common[i] === type[i]) i += 1;
    common = common.slice(0, i);
  }
  const cut = common.lastIndexOf("-");
  return cut > 0 ? common.slice(0, cut + 1) : "";
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
  teammate: "agents.why.teammate",
  "teammate-routed": "agents.why.teammate-routed",
  "before-load": "agents.why.before-load",
  unseen: "agents.why.unseen",
};

const WHY_SHORT_KEY: Readonly<Record<SubagentWhy, ModelRouterKey>> = {
  explicit: "agents.short.explicit",
  lowered: "agents.short.lowered",
  raised: "agents.short.raised",
  chosen: "agents.short.chosen",
  same: "agents.short.same",
  "kept-unsure": "agents.short.kept-unsure",
  "kept-pointer": "agents.short.kept-pointer",
  measuring: "agents.short.measuring",
  inherited: "agents.short.inherited",
  "no-jev": "agents.short.no-jev",
  teammate: "agents.short.teammate",
  "teammate-routed": "agents.short.teammate-routed",
  "before-load": "agents.short.before-load",
  unseen: "agents.short.unseen",
};

function effortText(locale: Locale, agent: RunningSubagent): string {
  const { effort, effortSource } = agent;
  // 0.6.15 T4b: unknown before its first step, whatever the reason says.
  if (effortSource === null) return "?";
  if (effort === null) return "—";
  const level = typeof effort === "number" ? String(effort) : translate(MODEL_ROUTER_CATALOG, locale, `effort.${effort}`);
  if (effortSource === undefined || effortSource === "not-sent") return level;
  return translate(MODEL_ROUTER_CATALOG, locale, "agents.effort.withSource", { level, source: translate(MODEL_ROUTER_CATALOG, locale, `agents.effort.source.${effortSource}`) });
}

function whyText(locale: Locale, agent: RunningSubagent, short: boolean): string {
  const why = translate(MODEL_ROUTER_CATALOG, locale, (short ? WHY_SHORT_KEY : WHY_KEY)[agent.why]);
  if (agent.wouldUse === null) return why;
  return translate(MODEL_ROUTER_CATALOG, locale, short ? "agents.row.wouldUse.short" : "agents.row.wouldUse", { why, model: agent.wouldUse });
}

/** `text` in `width` cells: cut with an ellipsis, or padded. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function widest(cells: readonly string[]): number {
  return cells.reduce((max, cell) => Math.max(max, cell.length), 0);
}

interface Cells {
  readonly type: string;
  readonly description: string;
  readonly model: string;
  readonly effort: string;
  readonly whyFull: string;
  readonly whyShort: string;
}

/** A row's reason: its full wording where it fits after `text`, else its short one, else cut at the edge. */
function reasonFor(text: string, cells: Cells, columns: number): string {
  if (text.length + cells.whyFull.length <= columns) return cells.whyFull;
  if (text.length + cells.whyShort.length <= columns) return cells.whyShort;
  return fit(cells.whyShort, columns - text.length).trimEnd();
}

/**
 * The band for the agents running now, sized to `columns`; null when none
 * runs. One line per agent: type, description, model, effort, reason. As
 * the band narrows: a reason that does not fit its row takes its short
 * wording (that row alone, so one long reason does not cost every row its
 * effort); the effort column goes once the description would get fewer than
 * DESC_ROOM cells; then the description is cut harder; below DESC_FLOOR
 * cells each agent takes two lines (type and reason; then the model and
 * the description, indented), so the description is still readable at 40.
 */
export function subagentBand(locale: Locale, agents: readonly RunningSubagent[], columns: number): SubagentBand | null {
  if (agents.length === 0) return null;
  const prefix = sharedTypePrefix(agents.map((agent) => agent.type));
  const cells: Cells[] = agents.map((agent) => ({
    type: prefix.length > 0 && agent.type.startsWith(prefix) ? agent.type.slice(prefix.length) : agent.type,
    description: agent.description,
    model: agent.label ?? "?",
    effort: effortText(locale, agent),
    whyFull: whyText(locale, agent, false),
    whyShort: whyText(locale, agent, true),
  }));
  const heading = translate(MODEL_ROUTER_CATALOG, locale, "agents.heading", { n: String(agents.length) });
  const typeW = widest(cells.map((c) => c.type));
  const descMax = widest(cells.map((c) => c.description));
  const modelW = widest(cells.map((c) => c.model));
  const effortW = widest(cells.map((c) => c.effort));
  // The reason keeps its short wording's width, up to REASON_ROOM: one long
  // reason (an agent with no record) is cut at the edge rather than cutting
  // every row's description.
  const shortW = Math.min(REASON_ROOM, widest(cells.map((c) => c.whyShort)));
  // What is left for the description once every other column, and the reasons, have theirs.
  const room = (withEffort: boolean): number => columns - typeW - modelW - (withEffort ? effortW + GAP.length : 0) - shortW - GAP.length * 3;

  const withEffort = room(true) >= Math.min(descMax, DESC_ROOM);
  const descWidth = Math.min(descMax, room(withEffort));
  if (descWidth >= Math.min(descMax, DESC_FLOOR)) {
    const rows = cells.map((c): BandRow => {
      const text = `${[fit(c.type, typeW), fit(c.description, descWidth), c.model.padEnd(modelW), ...(withEffort ? [c.effort.padEnd(effortW)] : [])].join(GAP)}${GAP}`;
      if (text.length >= columns) return { text: fit(text, columns).trimEnd(), why: "" };
      return { text, why: reasonFor(text, c, columns) };
    });
    return { heading: fit(heading, columns).trimEnd(), rows };
  }

  // Too narrow for one line each: two, the type and reason, then the model and description under them.
  const indent = "  ";
  const rows: BandRow[] = [];
  for (const c of cells) {
    const text = `${fit(c.type, Math.max(TYPE_FLOOR, Math.min(typeW, columns - GAP.length - REASON_FLOOR)))}${GAP}`;
    if (text.length >= columns) rows.push({ text: fit(text, columns).trimEnd(), why: "" });
    else rows.push({ text, why: reasonFor(text, c, columns) });
    rows.push({ text: fit(`${indent}${c.model.padEnd(modelW)}${GAP}${c.description}`, columns).trimEnd(), why: "" });
  }
  return { heading: fit(heading, columns).trimEnd(), rows };
}
