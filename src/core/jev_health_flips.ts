// 0.6.22 T3 (JEVADV-97): flip rate. The command gate puts three questions to
// Jev (`reversible`, `external`, `consequence`) and decides from the answers.
// Asked the same thing again, Jev does not always answer the same: this puts
// the gate's own state and questions for each command to Jev several times
// and counts how often the answer changes, whether the change crosses a gate
// threshold, and whether the gate's own outcome flips.
//
// The outcome is decideAction's verdict (allow | ask): the risk axes alone,
// the way the gate reads a command with no policies. `advise` and `deny` come
// from the local floors and from destination policies, which this does not
// build, so they are not reachable here.
//
// Pure: the Jev call is injected (the CLI passes the real one; every test a
// fake). Calls run one after another. A call that fails, or whose answers are
// incomplete, is counted apart and is never a flip.

import { buildActionGateQuestions, buildActionGateState, CONSEQUENCE_NOISE_MARGIN, decideAction, GATE_CONSEQUENCE_CEILING, GATE_EXTERNAL_GATE, GATE_REVERSIBLE_GATE } from "./decisions.ts";
import { getNoulAnswer, getScoreAnswer } from "./jev.ts";
import type { Answer, JsonValue, Question } from "./jev.ts";
import { redactSecretsForJev } from "./secret_redaction.ts";

/** Puts one state and its questions to Jev; throws when the call fails. */
export type AnswersCaller = (state: JsonValue, questions: Record<string, Question>) => Promise<Record<string, Answer>>;

export interface GateAxes {
  readonly reversible: number;
  readonly external: number;
  readonly consequence: number;
}

/** What the gate reads from one call: the three axes and its outcome on them. */
export interface GateReading {
  readonly axes: GateAxes;
  readonly verdict: "allow" | "ask";
}

/** The three axes and the gate's verdict on them, or null when an axis is missing (the gate itself fails open on that; a probe must not count it). */
export function readGate(answers: Record<string, Answer>): GateReading | null {
  const reversible = getNoulAnswer(answers, "reversible");
  const external = getNoulAnswer(answers, "external");
  const consequence = getScoreAnswer(answers, "consequence");
  if (reversible === null || external === null || consequence === null) return null;
  return {
    axes: { reversible: reversible.noul, external: external.noul, consequence: consequence.score },
    verdict: decideAction(answers).verdict,
  };
}

/** One call, read: null when it failed or came back incomplete. */
export async function readCall(caller: AnswersCaller, state: JsonValue): Promise<GateReading | null> {
  try {
    return readGate(await caller(state, buildActionGateQuestions()));
  } catch {
    return null;
  }
}

/** The score at which the gate stops asking being allowed: the ceiling less the noise margin (decideAction's own line). */
export const GATE_ASK_LINE = GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN;

/** Which side of each gate threshold the axes fall on. */
export function thresholdSides(axes: GateAxes): { readonly cannotUndo: boolean; readonly someoneNotices: boolean; readonly asks: boolean } {
  return { cannotUndo: axes.reversible < GATE_REVERSIBLE_GATE, someoneNotices: axes.external >= GATE_EXTERNAL_GATE, asks: axes.consequence > GATE_ASK_LINE };
}

/** The two readings cross a gate threshold between them. */
export function crossesThreshold(a: GateAxes, b: GateAxes): { readonly reversible: boolean; readonly external: boolean; readonly consequence: boolean } {
  const x = thresholdSides(a);
  const y = thresholdSides(b);
  return { reversible: x.cannotUndo !== y.cannotUndo, external: x.someoneNotices !== y.someoneNotices, consequence: x.asks !== y.asks };
}

/** Two answers are the same when they agree to two decimals. */
export function sameAnswer(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** A command as it is shown in a report: secrets out, and cut short. */
export function commandLabel(command: string): string {
  const shown = redactSecretsForJev(command).text.replace(/\s+/g, " ").trim();
  return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
}

export interface AxisFlips {
  /** Commands with more than one distinct answer (to two decimals) across their runs. */
  readonly changed: number;
  /** Commands whose answers fall on both sides of the gate's threshold for this question. */
  readonly crossing: number;
  readonly maxSpread: number;
}

export interface FlipReport {
  readonly commands: number;
  readonly runs: number;
  readonly failedCalls: number;
  /** Commands with at least two good readings: the only ones a flip can be seen on. */
  readonly measured: number;
  readonly unmeasured: number;
  readonly reversible: AxisFlips;
  readonly external: AxisFlips;
  readonly consequence: AxisFlips;
  /** Commands whose gate outcome differs between runs. */
  readonly verdictFlips: number;
  /** Commands whose consequence spread (max - min) is above CONSEQUENCE_NOISE_MARGIN. */
  readonly overNoiseMargin: readonly { readonly command: string; readonly spread: number }[];
}

function spreadOf(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function axisFlips(per: readonly GateAxes[][], pick: (axes: GateAxes) => number, sideOf: (axes: GateAxes) => boolean): AxisFlips {
  let changed = 0;
  let crossing = 0;
  let maxSpread = 0;
  for (const readings of per) {
    const values = readings.map(pick);
    if (new Set(values.map((value) => Math.round(value * 100))).size > 1) changed += 1;
    if (new Set(readings.map(sideOf)).size > 1) crossing += 1;
    maxSpread = Math.max(maxSpread, spreadOf(values));
  }
  return { changed, crossing, maxSpread };
}

export interface RunFlipsInput {
  readonly commands: readonly string[];
  readonly runs: number;
  readonly caller: AnswersCaller;
  readonly onProgress?: (done: number, total: number) => void;
}

export async function runFlips(input: RunFlipsInput): Promise<FlipReport> {
  const perCommand: { readonly command: string; readonly readings: GateReading[] }[] = [];
  let failedCalls = 0;
  let done = 0;
  for (const command of input.commands) {
    const state = buildActionGateState(command, "");
    const readings: GateReading[] = [];
    for (let run = 0; run < input.runs; run++) {
      const reading = await readCall(input.caller, state);
      if (reading === null) failedCalls += 1;
      else readings.push(reading);
      done += 1;
      input.onProgress?.(done, input.commands.length * input.runs);
    }
    perCommand.push({ command, readings });
  }

  const measured = perCommand.filter((entry) => entry.readings.length >= 2);
  const axes = measured.map((entry) => entry.readings.map((reading) => reading.axes));
  const overNoiseMargin = measured
    .map((entry) => ({ command: entry.command, spread: spreadOf(entry.readings.map((reading) => reading.axes.consequence)) }))
    .filter((entry) => entry.spread > CONSEQUENCE_NOISE_MARGIN);
  return {
    commands: input.commands.length,
    runs: input.runs,
    failedCalls,
    measured: measured.length,
    unmeasured: perCommand.length - measured.length,
    reversible: axisFlips(axes, (a) => a.reversible, (a) => thresholdSides(a).cannotUndo),
    external: axisFlips(axes, (a) => a.external, (a) => thresholdSides(a).someoneNotices),
    consequence: axisFlips(axes, (a) => a.consequence, (a) => thresholdSides(a).asks),
    verdictFlips: measured.filter((entry) => new Set(entry.readings.map((reading) => reading.verdict)).size > 1).length,
    overNoiseMargin,
  };
}

export function formatFlipReport(report: FlipReport): string[] {
  const lines = [`=== Jev flip rate: ${report.commands} commands x ${report.runs} runs ===`];
  lines.push(`failed calls: ${report.failedCalls} (counted apart, never flips)`);
  lines.push(`measured commands: ${report.measured} of ${report.commands} (at least two good answers)${report.unmeasured > 0 ? `, ${report.unmeasured} not measured` : ""}`);
  lines.push("");
  lines.push("commands whose answer changed across runs (to two decimals), and of those how many crossed the gate's threshold:");
  lines.push(`  reversible: ${report.reversible.changed} of ${report.measured}, ${report.reversible.crossing} crossing ${GATE_REVERSIBLE_GATE}; largest spread ${report.reversible.maxSpread.toFixed(2)}`);
  lines.push(`  external: ${report.external.changed} of ${report.measured}, ${report.external.crossing} crossing ${GATE_EXTERNAL_GATE}; largest spread ${report.external.maxSpread.toFixed(2)}`);
  lines.push(`  consequence: ${report.consequence.changed} of ${report.measured}, ${report.consequence.crossing} crossing ${GATE_ASK_LINE.toFixed(2)}; largest spread ${report.consequence.maxSpread.toFixed(2)}`);
  lines.push(`gate outcome (allow or ask, from the risk axes alone) flipped: ${report.verdictFlips} of ${report.measured}`);
  lines.push("");
  if (report.overNoiseMargin.length === 0) {
    lines.push(`consequence spread over the noise margin (${CONSEQUENCE_NOISE_MARGIN}): none`);
  } else {
    lines.push(`consequence spread over the noise margin (${CONSEQUENCE_NOISE_MARGIN}):`);
    for (const entry of report.overNoiseMargin) lines.push(`  ${entry.spread.toFixed(2)}  ${commandLabel(entry.command)}`);
  }
  return lines;
}
