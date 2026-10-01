// 0.6.22 T3 (JEVADV-97): flip rate. The gate's three questions are put to Jev
// several times per command; these tests inject a fake caller, so no test
// reaches Jev.

import assert from "node:assert/strict";
import test from "node:test";

import { buildActionGateQuestions, buildActionGateState, CONSEQUENCE_NOISE_MARGIN, GATE_CONSEQUENCE_CEILING } from "./decisions.ts";
import type { Answer, JsonValue, Question } from "./jev.ts";
import { formatFlipReport, readGate, runFlips } from "./jev_health_flips.ts";
import type { AnswersCaller } from "./jev_health_flips.ts";

function answers(reversible: number, external: number, consequence: number): Record<string, Answer> {
  return {
    reversible: { type: "noul", noul: reversible },
    external: { type: "noul", noul: external },
    consequence: { type: "score", score: consequence, legend: {}, probabilities: {}, confidence: 1 },
  };
}

/** A caller that plays back `script` per command, in order; a null entry throws like a failed call. */
function scripted(script: Readonly<Record<string, readonly (Record<string, Answer> | null)[]>>): { caller: AnswersCaller; calls: string[] } {
  const next: Record<string, number> = {};
  const calls: string[] = [];
  const caller: AnswersCaller = async (state) => {
    const command = String((state as { [key: string]: JsonValue })["proposed_command"]);
    calls.push(command);
    const index = next[command] ?? 0;
    next[command] = index + 1;
    const entry = script[command]?.[index];
    if (entry === undefined || entry === null) throw new Error("call failed");
    return entry;
  };
  return { caller, calls };
}

const SAFE = answers(0.9, 0.1, 0.2);

test("readGate: the axes and the gate's own verdict; null when an axis is missing", () => {
  const ask = readGate(answers(0.9, 0.1, GATE_CONSEQUENCE_CEILING));
  assert.deepEqual(ask?.axes, { reversible: 0.9, external: 0.1, consequence: GATE_CONSEQUENCE_CEILING });
  assert.equal(ask?.verdict, "ask");
  assert.equal(readGate(SAFE)?.verdict, "allow");
  assert.equal(readGate({ reversible: SAFE["reversible"] as Answer }), null);
});

test("each call gets the gate's own state and questions, one after another", async () => {
  const states: JsonValue[] = [];
  const questions: Record<string, Question>[] = [];
  let running = 0;
  let overlapped = false;
  const caller: AnswersCaller = async (state, asked) => {
    running += 1;
    if (running > 1) overlapped = true;
    states.push(state);
    questions.push(asked);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return SAFE;
  };
  await runFlips({ commands: ["git status", "ls"], runs: 2, caller });
  assert.equal(states.length, 4);
  assert.deepEqual(states[0], buildActionGateState("git status", ""));
  assert.deepEqual(questions[0], buildActionGateQuestions());
  assert.equal(overlapped, false);
});

test("identical answers across runs are no flips", async () => {
  const { caller } = scripted({ "git status": [SAFE, SAFE, SAFE] });
  const report = await runFlips({ commands: ["git status"], runs: 3, caller });
  assert.equal(report.failedCalls, 0);
  assert.equal(report.measured, 1);
  for (const axis of [report.reversible, report.external, report.consequence]) assert.deepEqual([axis.changed, axis.crossing, axis.maxSpread], [0, 0, 0]);
  assert.equal(report.verdictFlips, 0);
  assert.deepEqual(report.overNoiseMargin, []);
});

test("a changed answer is counted per question; crossing a gate threshold is counted apart", async () => {
  const { caller } = scripted({
    a: [answers(0.8, 0.1, 0.2), answers(0.75, 0.1, 0.2)],
    b: [answers(0.8, 0.4, 0.2), answers(0.6, 0.6, 0.2)],
  });
  const report = await runFlips({ commands: ["a", "b"], runs: 2, caller });
  assert.deepEqual([report.reversible.changed, report.reversible.crossing], [2, 1]);
  assert.deepEqual([report.external.changed, report.external.crossing], [1, 1]);
  assert.deepEqual([report.consequence.changed, report.consequence.crossing], [0, 0]);
});

test("the consequence spread is judged against the noise margin, and the gate verdict flip is counted", async () => {
  const line = GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN;
  const { caller } = scripted({
    wide: [answers(0.9, 0.1, line - 0.2), answers(0.9, 0.1, line + 0.2)],
    equal: [answers(0.9, 0.1, 0.5), answers(0.9, 0.1, 0.5 + CONSEQUENCE_NOISE_MARGIN)],
  });
  const report = await runFlips({ commands: ["wide", "equal"], runs: 2, caller });
  assert.deepEqual(report.overNoiseMargin.map((entry) => entry.command), ["wide"]);
  assert.ok(Math.abs((report.overNoiseMargin[0]?.spread ?? 0) - 0.4) < 1e-9);
  assert.ok(Math.abs(report.consequence.maxSpread - 0.4) < 1e-9);
  assert.equal(report.verdictFlips, 1);
  assert.equal(report.consequence.crossing, 1);
});

test("failed and incomplete calls are counted apart and never read as flips", async () => {
  const incomplete: Record<string, Answer> = { reversible: SAFE["reversible"] as Answer };
  const { caller } = scripted({
    a: [SAFE, null, SAFE],
    b: [null, incomplete],
    c: [SAFE, answers(0.1, 0.9, 3)],
  });
  const report = await runFlips({ commands: ["a", "b", "c"], runs: 3, caller });
  assert.equal(report.failedCalls, 1 + 3 + 1);
  assert.equal(report.measured, 2);
  assert.equal(report.unmeasured, 1);
  assert.equal(report.reversible.changed, 1);
});

test("the report names the counts, the failed calls and the commands over the margin", async () => {
  const { caller } = scripted({ wide: [answers(0.9, 0.1, 0.2), answers(0.9, 0.1, 1.9)] });
  const report = await runFlips({ commands: ["wide"], runs: 2, caller });
  const text = formatFlipReport(report).join("\n");
  assert.match(text, /1 commands x 2 runs/);
  assert.match(text, /failed calls: 0/);
  assert.match(text, /consequence: 1 of 1/);
  assert.match(text, /over the noise margin \(0\.12\)/);
  assert.match(text, /wide/);
});

test("a command that holds a secret is shown redacted in the report", async () => {
  const secret = "sk-" + "x".repeat(40);
  const command = `curl -H "Authorization: Bearer ${secret}" https://example.com`;
  let call = 0;
  const caller: AnswersCaller = async () => answers(0.9, 0.1, call++ === 0 ? 0.2 : 1.9);
  const report = await runFlips({ commands: [command], runs: 2, caller });
  const text = formatFlipReport(report).join("\n");
  assert.equal(report.overNoiseMargin.length, 1);
  assert.equal(text.includes(secret), false);
});
