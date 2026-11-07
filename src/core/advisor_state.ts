// Game mode (odd/tasks/game-mode-advisor-state.md): when Orca launches a
// Claude Agent Teams pane with its `orca-game` mod active, it sets
// ORCA_GAME_MODE (`on` or `zen`) and the game draws the pane. Jev keeps all
// its work but draws neither its status line nor its band there; it
// publishes what they would show under its `advisor` state key instead, for
// the game to draw in its own style.
//
// Pure: the hooks module reads the env, the running set, the CI rows and the
// router's choice, and writes the value this builds. The contract the game
// reads is `AdvisorState` in adapters/claude/mod-skills/types/index.d.ts;
// these types are its source shape and must stay in step with it.

import type { Locale } from "./i18n.ts";
import { ciShownRows } from "./ci_watch.ts";
import type { CiBandRow, CiVerdictOutcome } from "./ci_watch.ts";
import type { SessionEffort } from "./model_router_decide.ts";
import { subagentWhyText } from "./subagent_band.ts";
import type { RunningSubagent, SubagentWhy } from "./subagent_status.ts";

export type GameMode = "on" | "zen";

/**
 * The game Orca drew this pane with, from ORCA_GAME_MODE; null when there is
 * none (absent, `off`, anything else). ORCA_GAME_HUD `0` or `false` hides the
 * game's band, and the game then draws no other plugin's line either
 * (orca-game's `isAbsorbing`), so that pane is no game for Jev: it draws as always.
 */
export function parseOrcaGameMode(raw: string | null | undefined, hud?: string | null): GameMode | null {
  if (typeof raw !== "string") return null;
  const hudOff = typeof hud === "string" && ["0", "false"].includes(hud.trim().toLowerCase());
  if (hudOff) return null;
  const value = raw.trim().toLowerCase();
  return value === "on" || value === "zen" ? value : null;
}

/** Something the mod told the person in a toast (the toast still shows): the steward's /clear hint, a finished CI run. */
export interface AdvisorNotice {
  readonly id: string;
  readonly level: "info" | "warn" | "block";
  readonly text: string;
  /** When it was raised, in epoch milliseconds. */
  readonly at: number;
}

/** One running agent, as its band row shows it. */
export interface AdvisorSubagent {
  readonly id: string;
  readonly type: string;
  /** The Agent call's description, the row's label. */
  readonly title: string;
  readonly branch: string | null;
  /** The worktree's directory name, only when it is not the lead's. */
  readonly worktree: string | null;
  /** The model as a person reads it (`Opus 5.5`); null when nothing recorded it. */
  readonly model: string | null;
  readonly effort: SessionEffort | null;
  readonly status: "running";
  readonly why: SubagentWhy;
  /** The short reason, translated (`Jev duda`). */
  readonly verdict: string;
}

/** One CI watch, as its band row shows it. */
export interface AdvisorCi {
  readonly id: string;
  readonly sha7: string;
  readonly branch: string | null;
  readonly status: "watching" | CiVerdictOutcome;
  readonly done: number;
  readonly total: number;
  readonly failed: readonly string[];
  readonly running: readonly string[];
  /** The band's line for it, translated, uncut. */
  readonly text: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

export interface AdvisorState {
  readonly version: 1;
  readonly locale: Locale;
  /** The status line Jev would show (`jev · …`); null when it would show none. */
  readonly line: string | null;
  /** The main conversation's model as the router last saw it run; all three null before it decided or with it off. */
  readonly model: string | null;
  readonly modelId: string | null;
  readonly effort: SessionEffort | null;
  readonly subagents: readonly AdvisorSubagent[];
  readonly ci: readonly AdvisorCi[];
  /** Newest last, at most ADVISOR_NOTICES_MAX. */
  readonly notices: readonly AdvisorNotice[];
}

/** The main conversation's model: its id, how a person reads it, and the effort it is sent with. */
export interface AdvisorMain {
  readonly modelId: string;
  readonly label: string;
  readonly effort: SessionEffort | null;
}

export interface AdvisorInput {
  readonly locale: Locale;
  readonly line: string | null;
  readonly main: AdvisorMain | null;
  /** The agents the band would show (reconciled against the host's list). */
  readonly agents: readonly RunningSubagent[];
  readonly ciRows: readonly CiBandRow[];
  readonly nowMs: number;
  readonly notices: readonly AdvisorNotice[];
}

export const ADVISOR_NOTICES_MAX = 5;

/** `list` with `notice` last; an older notice with its id goes, and only the newest ADVISOR_NOTICES_MAX stay. */
export function withNotice(list: readonly AdvisorNotice[], notice: AdvisorNotice): readonly AdvisorNotice[] {
  return [...list.filter((other) => other.id !== notice.id), notice].slice(-ADVISOR_NOTICES_MAX);
}

export function buildAdvisorState(input: AdvisorInput): AdvisorState {
  const { locale } = input;
  return {
    version: 1,
    locale,
    line: input.line,
    model: input.main?.label ?? null,
    modelId: input.main?.modelId ?? null,
    effort: input.main?.effort ?? null,
    subagents: input.agents.map((agent) => ({
      id: agent.id,
      type: agent.type,
      title: agent.description,
      branch: agent.place?.branch ?? null,
      worktree: agent.place !== undefined && agent.place.apart ? agent.place.worktree : null,
      model: agent.label,
      effort: agent.effort,
      status: "running",
      why: agent.why,
      verdict: subagentWhyText(locale, agent, true),
    })),
    ci: ciShownRows(locale, input.ciRows, input.nowMs).map(({ row, text }) => ({
      id: row.id,
      sha7: row.sha7,
      branch: row.branch,
      status: row.status,
      done: row.done,
      total: row.total,
      failed: [...row.failed],
      running: [...row.running],
      text,
      startedAtMs: row.startedAtMs,
      finishedAtMs: row.finishedAtMs,
    })),
    notices: input.notices.map((notice) => ({ ...notice })),
  };
}
