// JEVADV-118 T7: the acceptance measurement. For the Orca member sessions
// that started in a window, the steps and tokens they spent, the models and
// efforts those steps ran on, who chose the start (the pointer guard, an Orca
// pin, or Jev judging the brief), the mid-turn escalations, and the CI watches
// of those sessions. The baseline table in odd/tasks/jevadv-118.md uses the
// same measure names, so a run after a release pastes beside it.
//
// A member session is one whose FIRST `start` decision was held by the
// pointer guard, held by an Orca pin, or judged from a brief (`brief: true`).
// Its steps are all its turn-usage rows, also those after the window's end:
// a session that started inside the window is measured whole.
//
// Pure: rows in, a report out. The CLI (adapters/cli/member_routing_measure_cli.ts)
// reads the files. A null token figure is left out of every sum, never read
// as 0 (the turn-usage convention of consumption.ts).

import { isRecord } from "../guards.ts";
import { baseModelId } from "./model_router_accounts.ts";
import { medianOf } from "./model_router_stage.ts";
import { CI_WATCH_DECISIONS_FILE_PATTERN } from "./ci_watch.ts";
import { ROUTER_DECISIONS_FILE_PATTERN } from "./jev_health_usage.ts";

/** The turn-usage hourly files, written by hooks/index.ts's recordTurnUsage. */
export const TURN_USAGE_FILE_PATTERN = /^turn-usage-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

export type MemberStartClass = "pointer" | "orca-pin" | "brief";
export const MEMBER_START_CLASSES: readonly MemberStartClass[] = ["pointer", "orca-pin", "brief"];

export interface CountedLabel {
  readonly label: string;
  readonly count: number;
}

export interface MemberRoutingInput {
  readonly decisions: readonly unknown[];
  readonly usage: readonly unknown[];
  readonly ciWatches: readonly unknown[];
  /** Inclusive start of the window a member session's first start must fall in. */
  readonly fromMs: number;
  /** Exclusive end. */
  readonly toMs: number;
  /** Lines of the files that were not JSON, counted by the reader. */
  readonly malformedLines: number;
}

export interface MemberRoutingReport {
  readonly memberSessions: number;
  readonly startsByClass: Readonly<Record<MemberStartClass, number>>;
  readonly steps: number;
  readonly mainSteps: number;
  readonly subagentSteps: number;
  /** Steps whose four token figures were all null: counted as steps, left out of the sums. */
  readonly stepsWithoutTokens: number;
  readonly sessionsWithoutSteps: number;
  readonly medianStepsPerSession: number | null;
  readonly medianOutputPerSession: number | null;
  /** input + cacheRead + cacheWrite. */
  readonly medianInputPerSession: number | null;
  readonly totalOutput: number;
  /** "Opus 5.5 · high" and its step count, most used first. */
  readonly stepMix: readonly CountedLabel[];
  /** `reason: "escalate"` rows of member sessions by `signal` ("none" when absent), most first. */
  readonly escalationsBySignal: readonly { readonly signal: string; readonly count: number }[];
  readonly ci: {
    /** Member sessions with at least one CI watch row. */
    readonly sessionsWatched: number;
    /** One row is one watch on a push or a PR creation, not one PR. */
    readonly watches: number;
    readonly byOutcome: readonly { readonly outcome: string; readonly count: number }[];
    /** success / (success + failure) over the watches; null when none ended either way. */
    readonly passRate: number | null;
  };
  readonly skipped: {
    readonly malformedLines: number;
    readonly decisionRows: number;
    readonly usageRows: number;
    readonly ciRows: number;
  };
}

/** Who chose a start: null when it is not a member start. An Orca pin wins over a brief: the pin chose the model. */
export function memberStartClass(row: Record<string, unknown>): MemberStartClass | null {
  if (row.reason === "held-by-orca-pin") return "orca-pin";
  if (row.brief === true) return "brief";
  if (row.reason === "held-by-guard" && row.guard === "pointer-prompt") return "pointer";
  return null;
}

const FAMILY_LABELS: Readonly<Record<string, string>> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/** `claude-opus-5-5` → `Opus 5.5` (a context suffix or a date suffix dropped); any other id as it is. */
export function modelShortLabel(modelId: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(baseModelId(modelId));
  const family = match?.[1] === undefined ? undefined : FAMILY_LABELS[match[1]];
  if (match === null || family === undefined) return modelId;
  return match[3] === undefined ? `${family} ${match[2]}` : `${family} ${match[2]}.${match[3]}`;
}

/** The JSON lines of a file's text and how many were corrupt; a blank line is neither. */
export function parseJsonlCounted(text: string): { rows: unknown[]; malformed: number } {
  const rows: unknown[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function atMsOf(row: Record<string, unknown>): number {
  return typeof row.at === "string" ? Date.parse(row.at) : Number.NaN;
}

/** Counts in the order first seen, then most first (a stable sort keeps ties in that order). */
function tally(keys: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

interface SessionTotals {
  steps: number;
  output: number;
  input: number;
}

export function measureMemberRouting(input: MemberRoutingInput): MemberRoutingReport {
  let decisionSkipped = 0;
  const decisions: Record<string, unknown>[] = [];
  for (const row of input.decisions) {
    if (!isRecord(row) || typeof row.sessionId !== "string" || !Number.isFinite(atMsOf(row))) decisionSkipped += 1;
    else decisions.push(row);
  }

  const firstStart = new Map<string, { atMs: number; row: Record<string, unknown> }>();
  for (const row of decisions) {
    if (row.point !== "start") continue;
    const sessionId = row.sessionId as string;
    const atMs = atMsOf(row);
    const seen = firstStart.get(sessionId);
    if (seen === undefined || atMs < seen.atMs) firstStart.set(sessionId, { atMs, row });
  }

  const startsByClass: Record<MemberStartClass, number> = { pointer: 0, "orca-pin": 0, brief: 0 };
  const members = new Map<string, SessionTotals>();
  for (const [sessionId, { atMs, row }] of firstStart) {
    const kind = memberStartClass(row);
    if (kind === null || atMs < input.fromMs || atMs >= input.toMs) continue;
    startsByClass[kind] += 1;
    members.set(sessionId, { steps: 0, output: 0, input: 0 });
  }

  let usageSkipped = 0;
  let mainSteps = 0;
  let subagentSteps = 0;
  let stepsWithoutTokens = 0;
  let totalOutput = 0;
  const mixKeys: string[] = [];
  for (const row of input.usage) {
    if (!isRecord(row) || typeof row.sessionId !== "string" || typeof row.model !== "string") {
      usageSkipped += 1;
      continue;
    }
    const totals = members.get(row.sessionId);
    if (totals === undefined) continue;
    totals.steps += 1;
    if (row.agent === "main") mainSteps += 1;
    else if (row.agent === "subagent") subagentSteps += 1;
    const figures = [row.input, row.output, row.cacheRead, row.cacheWrite].map(finiteOrNull);
    if (figures.every((figure) => figure === null)) stepsWithoutTokens += 1;
    const [inputTokens, output, cacheRead, cacheWrite] = figures;
    totals.output += output ?? 0;
    totals.input += (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    totalOutput += output ?? 0;
    const label = modelShortLabel(row.model);
    mixKeys.push(typeof row.effort === "string" ? `${label} · ${row.effort}` : label);
  }

  const escalationSignals = decisions
    .filter((row) => row.reason === "escalate" && members.has(row.sessionId as string))
    .map((row) => (typeof row.signal === "string" ? row.signal : "none"));

  let ciSkipped = 0;
  const ciOutcomes: string[] = [];
  const watched = new Set<string>();
  for (const row of input.ciWatches) {
    if (!isRecord(row) || typeof row.sessionId !== "string" || typeof row.outcome !== "string") {
      ciSkipped += 1;
      continue;
    }
    if (!members.has(row.sessionId)) continue;
    watched.add(row.sessionId);
    ciOutcomes.push(row.outcome);
  }
  const passed = ciOutcomes.filter((outcome) => outcome === "success").length;
  const failed = ciOutcomes.filter((outcome) => outcome === "failure").length;

  const sessions = [...members.values()];
  return {
    memberSessions: members.size,
    startsByClass,
    steps: sessions.reduce((sum, session) => sum + session.steps, 0),
    mainSteps,
    subagentSteps,
    stepsWithoutTokens,
    sessionsWithoutSteps: sessions.filter((session) => session.steps === 0).length,
    medianStepsPerSession: medianOf(sessions.map((session) => session.steps)),
    medianOutputPerSession: medianOf(sessions.map((session) => session.output)),
    medianInputPerSession: medianOf(sessions.map((session) => session.input)),
    totalOutput,
    stepMix: tally(mixKeys).map(({ key, count }) => ({ label: key, count })),
    escalationsBySignal: tally(escalationSignals).map(({ key, count }) => ({ signal: key, count })),
    ci: {
      sessionsWatched: watched.size,
      watches: ciOutcomes.length,
      byOutcome: tally(ciOutcomes).map(({ key, count }) => ({ outcome: key, count })),
      passRate: passed + failed === 0 ? null : passed / (passed + failed),
    },
    skipped: { malformedLines: input.malformedLines, decisionRows: decisionSkipped, usageRows: usageSkipped, ciRows: ciSkipped },
  };
}

function whole(value: number | null): string {
  return value === null ? "n/a" : Math.round(value).toLocaleString("en-US");
}

function joined(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join("; ");
}

export function formatMemberRoutingMarkdown(report: MemberRoutingReport, from: string, to: string): string[] {
  const ci = report.ci;
  const passRate = ci.passRate === null ? "n/a" : `${(ci.passRate * 100).toFixed(1)}%`;
  return [
    `Member sessions whose first start fell in ${from} to ${to} (end exclusive); each session's steps are counted whole, also after ${to}.`,
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Member sessions | ${whole(report.memberSessions)} |`,
    `| Main and subagent steps | ${whole(report.steps)} |`,
    `| Median steps per session | ${whole(report.medianStepsPerSession)} |`,
    `| Median output tokens per session | ${whole(report.medianOutputPerSession)} |`,
    `| Median input tokens per session (input + cache read + cache write) | ${whole(report.medianInputPerSession)} |`,
    `| Total output tokens | ${whole(report.totalOutput)} |`,
    `| Step mix | ${joined(report.stepMix.map((row) => `${row.label} ${whole(row.count)}`))} |`,
    `| Main steps; subagent steps | ${whole(report.mainSteps)}; ${whole(report.subagentSteps)} |`,
    `| Member starts by class | ${MEMBER_START_CLASSES.map((kind) => `${kind} ${whole(report.startsByClass[kind])}`).join("; ")} |`,
    `| Escalations by signal | ${joined(report.escalationsBySignal.map((row) => `${row.signal} ${whole(row.count)}`))} |`,
    `| CI watches (one per push or PR creation; member sessions watched) | ${whole(ci.watches)} (${whole(ci.sessionsWatched)} sessions): ${joined(ci.byOutcome.map((row) => `${row.outcome} ${whole(row.count)}`))} |`,
    `| CI pass rate (success / (success + failure), per watch) | ${passRate} |`,
    "",
    "5h/7d use per session: not recorded per session (the router rows carry only the account's quota band at each decision; quota.json is the accounts' live percentage, with no history).",
    `Steps without token figures (left out of the sums): ${whole(report.stepsWithoutTokens)}. Member sessions with no recorded step: ${whole(report.sessionsWithoutSteps)}.`,
    `Skipped: ${whole(report.skipped.malformedLines)} corrupt lines; ${whole(report.skipped.decisionRows)} decision, ${whole(report.skipped.usageRows)} usage and ${whole(report.skipped.ciRows)} CI rows with no session or a bad field.`,
  ];
}

export type MemberRoutingArgs =
  | { readonly command: "measure"; readonly from: string; readonly to: string; readonly fromMs: number; readonly toMs: number; readonly json: boolean }
  | { readonly command: "help" }
  | { readonly command: "error"; readonly message: string };

function isoDateMs(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(raw) ? ms : null;
}

/** `--from YYYY-MM-DD --to YYYY-MM-DD [--json]`, UTC days, end exclusive. */
export function parseMemberRoutingArgs(argv: readonly string[]): MemberRoutingArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const from = value("--from");
  const to = value("--to");
  const fromMs = isoDateMs(from);
  const toMs = isoDateMs(to);
  if (from === undefined || fromMs === null) return { command: "error", message: "--from needs an ISO date (YYYY-MM-DD)" };
  if (to === undefined || toMs === null) return { command: "error", message: "--to needs an ISO date (YYYY-MM-DD)" };
  if (fromMs >= toMs) return { command: "error", message: "--from must be before --to" };
  return { command: "measure", from, to, fromMs, toMs, json: argv.includes("--json") };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Every decision file (a session's first start may precede the window, and
 * then it is not a member), and the usage and CI files whose hour ends after
 * the window's start: a member's steps may run past the window's end.
 */
export function memberRoutingFilesToRead(names: readonly string[], fromMs: number): { decisions: string[]; usage: string[]; ci: string[] } {
  const fromWindow = (pattern: RegExp): string[] =>
    names
      .filter((name) => {
        const hour = pattern.exec(name)?.[1];
        const hourMs = hour === undefined ? Number.NaN : Date.parse(`${hour}:00:00.000Z`);
        return Number.isFinite(hourMs) && hourMs + HOUR_MS > fromMs;
      })
      .sort();
  return {
    decisions: names.filter((name) => ROUTER_DECISIONS_FILE_PATTERN.test(name)).sort(),
    usage: fromWindow(TURN_USAGE_FILE_PATTERN),
    ci: fromWindow(CI_WATCH_DECISIONS_FILE_PATTERN),
  };
}
