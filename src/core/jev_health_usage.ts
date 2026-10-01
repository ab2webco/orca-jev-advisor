// 0.6.22 T2 (JEVADV-97): option usage. For each question Jev answers in the
// background (the router's tier per point, the subagent work kind, the
// steward's verdict), how often it picks each option, how sure it says it is,
// and how wide its lead over the runner-up is (the `margin` the rows carry
// since 0.6.22 T1). An option of the full set chosen 0 times is a finding:
// either the question never needs it, or Jev cannot reach it.
//
// Pure: rows in, a report out. The CLI (adapters/cli/jev_health_cli.ts) reads
// the files. Read-only, and it never calls Jev.

import { isRecord } from "../guards.ts";
import { buildStewardQuestions, STEWARD_DECISIONS_FILE_PATTERN } from "./context_steward.ts";
import { ROUTER_TIERS } from "./model_catalog.ts";
import { WORK_KINDS } from "./work_kind.ts";

/** The router's hourly decision files; the same pattern as adapters/orca/log-files.mjs, which is plain JavaScript. */
export const ROUTER_DECISIONS_FILE_PATTERN = /^model-router-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Router points that exist in the log; a point never seen is not listed. */
const ROUTER_POINTS: readonly string[] = ["start", "stage", "subagent", "teammate"];

export interface UsageOption {
  readonly option: string;
  readonly count: number;
  /** Of the answers to this question; 0 when there are none. */
  readonly share: number;
  /** Over the rows that carry a numeric confidence; null when none do. */
  readonly meanConfidence: number | null;
  /** Over the rows that carry a numeric margin; null when none do (never 0). */
  readonly meanMargin: number | null;
}

export interface UsageQuestion {
  readonly title: string;
  readonly answered: number;
  /** How many of the answers carry a numeric margin. */
  readonly marginRows: number;
  readonly options: readonly UsageOption[];
  readonly findings: readonly string[];
}

export interface UsageReport {
  readonly questions: readonly UsageQuestion[];
}

interface Answered {
  readonly option: string;
  readonly confidence: number | null;
  readonly margin: number | null;
}

/** The JSON lines of a log file's text; a blank or corrupt line is skipped, never thrown on. */
export function parseJsonlRows(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A half-written line: not a row.
    }
  }
  return rows;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inWindow(row: Record<string, unknown>, nowMs: number, days: number): boolean {
  const atMs = typeof row.at === "string" ? Date.parse(row.at) : Number.NaN;
  return Number.isFinite(atMs) && atMs >= nowMs - days * DAY_MS && atMs <= nowMs;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Below this many answers, an option nobody picked says nothing: one used a
 * tenth of the time still goes unpicked in 30 answers only 4% of the time.
 */
const MIN_ANSWERS_FOR_FINDING = 30;

function summarizeQuestion(title: string, options: readonly string[], answers: readonly Answered[]): UsageQuestion {
  const known = answers.filter((answer) => options.includes(answer.option));
  const rows: UsageOption[] = options.map((option) => {
    const mine = known.filter((answer) => answer.option === option);
    return {
      option,
      count: mine.length,
      share: known.length === 0 ? 0 : mine.length / known.length,
      meanConfidence: mean(mine.flatMap((answer) => (answer.confidence === null ? [] : [answer.confidence]))),
      meanMargin: mean(mine.flatMap((answer) => (answer.margin === null ? [] : [answer.margin]))),
    };
  });
  const unused = rows.filter((row) => row.count === 0);
  const findings =
    known.length === 0 || unused.length === 0
      ? []
      : known.length < MIN_ANSWERS_FOR_FINDING
        ? [`NOTE: ${title} has ${known.length} answers, too few (under ${MIN_ANSWERS_FOR_FINDING}) to call an unused option a finding`]
        : unused.map((row) => `FINDING: ${title} option ${row.option} chosen 0 of ${known.length}`);
  return { title, answered: known.length, marginRows: known.filter((answer) => answer.margin !== null).length, options: rows, findings };
}

function routerAnswers(rows: readonly Record<string, unknown>[], point: string): Answered[] {
  return rows
    .filter((row) => row.point === point && typeof row.tier === "string")
    .map((row) => ({ option: String(row.tier), confidence: numberOrNull(row.confidence), margin: numberOrNull(row.margin) }));
}

/** The work kind Jev gave a subagent; the keyword fallback is not a Jev answer. */
function workKindAnswers(rows: readonly Record<string, unknown>[]): Answered[] {
  const answers: Answered[] = [];
  for (const row of rows) {
    const kind = row.workKind;
    if (!isRecord(kind) || kind.source !== "jev" || typeof kind.kind !== "string") continue;
    answers.push({ option: kind.kind, confidence: numberOrNull(kind.confidence), margin: numberOrNull(row.margin) });
  }
  return answers;
}

function stewardAnswers(rows: readonly Record<string, unknown>[]): Answered[] {
  return rows
    .filter((row) => typeof row.verdict === "string")
    .map((row) => ({ option: String(row.verdict), confidence: numberOrNull(row.confidence), margin: numberOrNull(row.margin) }));
}

/** The steward's verdicts, read from its own question so the set is never a second copy. */
function stewardVerdicts(): string[] {
  return Object.keys(buildStewardQuestions().verdict?.criteria ?? {});
}

export function summarizeUsage(routerRows: readonly unknown[], stewardRows: readonly unknown[], nowMs: number, days: number): UsageReport {
  const router = routerRows.filter(isRecord).filter((row) => inWindow(row, nowMs, days));
  const steward = stewardRows.filter(isRecord).filter((row) => inWindow(row, nowMs, days));
  const tiers: readonly string[] = ROUTER_TIERS;
  return {
    questions: [
      ...ROUTER_POINTS.map((point) => summarizeQuestion(`router tier (${point})`, tiers, routerAnswers(router, point))),
      summarizeQuestion("router work kind", WORK_KINDS, workKindAnswers(router)),
      summarizeQuestion("steward verdict", stewardVerdicts(), stewardAnswers(steward)),
    ],
  };
}

/** The router and steward hourly files whose hour falls inside the window, in name order. */
export function usageFilesToRead(names: readonly string[], nowMs: number, days: number): { readonly router: string[]; readonly steward: string[] } {
  const inside = (name: string, pattern: RegExp): boolean => {
    const hour = pattern.exec(name)?.[1];
    const hourMs = hour === undefined ? Number.NaN : Date.parse(`${hour}:00:00.000Z`);
    return Number.isFinite(hourMs) && hourMs + HOUR_MS > nowMs - days * DAY_MS && hourMs <= nowMs;
  };
  return {
    router: names.filter((name) => inside(name, ROUTER_DECISIONS_FILE_PATTERN)).sort(),
    steward: names.filter((name) => inside(name, STEWARD_DECISIONS_FILE_PATTERN)).sort(),
  };
}

function cell(value: number | null, digits: number): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function formatUsageReport(report: UsageReport, days: number): string[] {
  const lines: string[] = [`=== Jev option usage, last ${days} day(s) ===`];
  for (const question of report.questions) {
    lines.push("");
    if (question.answered === 0) {
      lines.push(`${question.title}: no answers in the window`);
      continue;
    }
    lines.push(`${question.title}: ${question.answered} answers, margin on ${question.marginRows} of ${question.answered} rows`);
    lines.push("  option        count   share   confidence   margin");
    for (const row of question.options) {
      lines.push(`  ${row.option.padEnd(12)} ${String(row.count).padStart(6)} ${`${(row.share * 100).toFixed(1)}%`.padStart(7)} ${cell(row.meanConfidence, 2).padStart(12)} ${cell(row.meanMargin, 2).padStart(8)}`);
    }
  }
  const findings = report.questions.flatMap((question) => question.findings);
  if (findings.length > 0) lines.push("", ...findings);
  return lines;
}
