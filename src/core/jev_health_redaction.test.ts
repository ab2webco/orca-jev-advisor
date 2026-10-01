// 0.6.22 T4 (JEVADV-97): redaction impact. Each command is put to Jev twice,
// with the gate's redacted state and with the raw one. Fake secrets are built
// at runtime; no secret-shaped literal lives in the repository.

import assert from "node:assert/strict";
import test from "node:test";

import { CONSEQUENCE_NOISE_MARGIN } from "./decisions.ts";
import type { Answer, JsonValue } from "./jev.ts";
import { formatRedactionReport, runRedaction } from "./jev_health_redaction.ts";
import type { AnswersCaller } from "./jev_health_flips.ts";

const SECRET = "sk-" + "x".repeat(40);
const WITH_SECRET = `deploy --token ${SECRET}`;

function answers(reversible: number, external: number, consequence: number): Record<string, Answer> {
  return {
    reversible: { type: "noul", noul: reversible },
    external: { type: "noul", noul: external },
    consequence: { type: "score", score: consequence, legend: {}, probabilities: {}, confidence: 1 },
  };
}

function command(state: JsonValue): string {
  return String((state as { [key: string]: JsonValue })["proposed_command"]);
}

/** Answers `redacted` for a state without the secret, `raw` for one that holds it. */
function byState(redacted: Record<string, Answer> | null, raw: Record<string, Answer> | null): { caller: AnswersCaller; states: JsonValue[] } {
  const states: JsonValue[] = [];
  const caller: AnswersCaller = async (state) => {
    states.push(state);
    const given = command(state).includes(SECRET) ? raw : redacted;
    if (given === null) throw new Error("call failed");
    return given;
  };
  return { caller, states };
}

test("the raw state holds the secret, the normal one does not", async () => {
  const { caller, states } = byState(answers(0.9, 0.1, 0.2), answers(0.9, 0.1, 0.2));
  await runRedaction({ commands: [WITH_SECRET], caller });
  assert.equal(states.length, 2);
  assert.equal(states.filter((state) => JSON.stringify(state).includes(SECRET)).length, 1);
});

test("a command with nothing to redact has an identical state: not asked, not compared", async () => {
  const { caller, states } = byState(answers(0.9, 0.1, 0.2), answers(0.9, 0.1, 0.2));
  const report = await runRedaction({ commands: ["git status"], caller });
  assert.equal(states.length, 0);
  assert.equal(report.identical, 1);
  assert.equal(report.compared, 0);
});

test("a flipped gate outcome is listed, with both outcomes", async () => {
  const { caller } = byState(answers(0.9, 0.1, 0.2), answers(0.9, 0.1, 1.9));
  const report = await runRedaction({ commands: [WITH_SECRET], caller });
  assert.equal(report.verdictDiffers.length, 1);
  assert.deepEqual([report.verdictDiffers[0]?.redacted.verdict, report.verdictDiffers[0]?.raw.verdict], ["allow", "ask"]);
  assert.equal(report.crossing.length, 1);
});

test("an answer that crosses a threshold without flipping the outcome is listed apart", async () => {
  const { caller } = byState(answers(0.8, 0.1, 0.2), answers(0.5, 0.1, 0.2));
  const report = await runRedaction({ commands: [WITH_SECRET], caller });
  assert.equal(report.verdictDiffers.length, 0);
  assert.equal(report.crossing.length, 1);
  assert.deepEqual(report.crossing[0]?.questions, ["reversible"]);
});

test("axes that differ only by noise are counted, not listed", async () => {
  const { caller } = byState(answers(0.8, 0.1, 0.2), answers(0.78, 0.1, 0.2 + CONSEQUENCE_NOISE_MARGIN / 2));
  const report = await runRedaction({ commands: [WITH_SECRET], caller });
  assert.equal(report.axesDiffer, 1);
  assert.equal(report.crossing.length, 0);
  assert.equal(report.verdictDiffers.length, 0);
});

test("a failed call on either side is counted as failed, never as a difference", async () => {
  const { caller } = byState(answers(0.9, 0.1, 0.2), null);
  const report = await runRedaction({ commands: [WITH_SECRET], caller });
  assert.equal(report.failed, 1);
  assert.equal(report.compared, 0);
  assert.equal(report.verdictDiffers.length, 0);
});

test("the report never prints the secret", async () => {
  const { caller } = byState(answers(0.9, 0.1, 0.2), answers(0.9, 0.1, 1.9));
  const report = await runRedaction({ commands: [WITH_SECRET], caller });
  const text = formatRedactionReport(report).join("\n");
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /allow -> ask/);
});
