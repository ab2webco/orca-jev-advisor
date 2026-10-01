// 0.6.22 T4 (JEVADV-97): redaction impact. The gate takes secrets out of a
// command before Jev sees it (redactSecretsForJev). That could change what
// Jev says about the command: an `Authorization` header with a marker where
// the token was may read as less alarming, or more. This puts each command to
// Jev twice, once with the gate's redacted state and once with a raw one, and
// lists where the gate outcome or an answer crossing a gate threshold differs.
//
// The raw state comes from an injected redactor (buildActionGateState's
// `redact` option), here the identity function. Only this probe builds it; no
// hook entry point does (src/core/gate_raw_state_guard.test.ts). A command
// the redactor leaves unchanged has the same state both ways and is not asked
// (two answers to one state would show Jev's noise, which `flips` measures).
//
// Pure, with the Jev call injected. Reports show a command with its secrets
// out, whatever the corpus holds.

import { buildActionGateState, CONSEQUENCE_NOISE_MARGIN } from "./decisions.ts";
import { commandLabel, crossesThreshold, readCall, sameAnswer } from "./jev_health_flips.ts";
import type { AnswersCaller, GateReading } from "./jev_health_flips.ts";

/** No redaction: the text as it is. */
function identityRedactor(text: string): { readonly text: string; readonly redactedCount: number } {
  return { text, redactedCount: 0 };
}

export interface RedactionDifference {
  readonly line: number;
  readonly command: string;
  readonly redacted: GateReading;
  readonly raw: GateReading;
  /** Which of reversible, external and consequence fall on the other side of a gate threshold. */
  readonly questions: readonly string[];
}

export interface RedactionReport {
  readonly commands: number;
  /** Commands the redactor leaves as they are: not asked. */
  readonly identical: number;
  /** Commands with both answers good. */
  readonly compared: number;
  /** Commands where either call failed or came back incomplete. */
  readonly failed: number;
  /** Compared commands whose answers differ on any axis by more than rounding. */
  readonly axesDiffer: number;
  readonly verdictDiffers: readonly RedactionDifference[];
  readonly crossing: readonly RedactionDifference[];
}

function axesDiffer(a: GateReading, b: GateReading): boolean {
  return !sameAnswer(a.axes.reversible, b.axes.reversible) || !sameAnswer(a.axes.external, b.axes.external) || !sameAnswer(a.axes.consequence, b.axes.consequence);
}

export interface RunRedactionInput {
  readonly commands: readonly string[];
  readonly caller: AnswersCaller;
}

export async function runRedaction(input: RunRedactionInput): Promise<RedactionReport> {
  let identical = 0;
  let compared = 0;
  let failed = 0;
  let differ = 0;
  const verdictDiffers: RedactionDifference[] = [];
  const crossing: RedactionDifference[] = [];
  for (const [index, command] of input.commands.entries()) {
    const redactedState = buildActionGateState(command, "");
    const rawState = buildActionGateState(command, "", undefined, undefined, undefined, { redact: identityRedactor });
    if (JSON.stringify(redactedState) === JSON.stringify(rawState)) {
      identical += 1;
      continue;
    }
    const redacted = await readCall(input.caller, redactedState);
    const raw = await readCall(input.caller, rawState);
    if (redacted === null || raw === null) {
      failed += 1;
      continue;
    }
    compared += 1;
    if (axesDiffer(redacted, raw)) differ += 1;
    const sides = crossesThreshold(redacted.axes, raw.axes);
    const questions = (["reversible", "external", "consequence"] as const).filter((question) => sides[question]);
    const difference: RedactionDifference = { line: index + 1, command, redacted, raw, questions };
    if (redacted.verdict !== raw.verdict) verdictDiffers.push(difference);
    if (questions.length > 0) crossing.push(difference);
  }
  return { commands: input.commands.length, identical, compared, failed, axesDiffer: differ, verdictDiffers, crossing };
}

function axesText(reading: GateReading): string {
  const { reversible, external, consequence } = reading.axes;
  return `reversible ${reversible.toFixed(2)}, external ${external.toFixed(2)}, consequence ${consequence.toFixed(2)}`;
}

function listDifference(difference: RedactionDifference): string[] {
  return [
    `  #${difference.line} ${commandLabel(difference.command)}`,
    `    redacted: ${difference.redacted.verdict} (${axesText(difference.redacted)})`,
    `    raw:      ${difference.raw.verdict} (${axesText(difference.raw)})`,
  ];
}

export function formatRedactionReport(report: RedactionReport): string[] {
  const lines = [`=== Jev redaction impact: ${report.commands} commands ===`];
  lines.push(`same state with or without redaction (not asked): ${report.identical}`);
  lines.push(`compared: ${report.compared}; failed calls: ${report.failed} (counted apart, never differences)`);
  lines.push(`answers differing on any axis, to two decimals: ${report.axesDiffer} of ${report.compared} (noise included: a consequence gap under ${CONSEQUENCE_NOISE_MARGIN} is within Jev's own repeat noise)`);
  lines.push("");
  lines.push(report.verdictDiffers.length === 0 ? "gate outcome differs: none" : `gate outcome differs (${report.verdictDiffers.length}):`);
  for (const difference of report.verdictDiffers) lines.push(...listDifference(difference), `    ${difference.redacted.verdict} -> ${difference.raw.verdict} when raw`);
  lines.push("");
  lines.push(report.crossing.length === 0 ? "an answer crosses a gate threshold: none" : `an answer crosses a gate threshold (${report.crossing.length}):`);
  for (const difference of report.crossing) lines.push(...listDifference(difference), `    crossing: ${difference.questions.join(", ")}`);
  return lines;
}
