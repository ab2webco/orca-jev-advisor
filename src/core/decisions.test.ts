// Unit tests for interpretDestinationPolicy -- pure input to pure output,
// no filesystem, no network. Run with:
//   node --test src/core/decisions.test.ts
// (this project has no test runner configured yet; node:test is the
// built-in one, and Node 24's native TypeScript support runs this file
// directly, same as src/core/gate_stats.test.ts already does).
//
// Covers the full kind x match table from the policy fix:
//   permite/pregunta/prohibe, each with a match (>= gate) and a non-match
//   (< gate) -- plus the two coverage-side null paths (no policy covers
//   the action at all, and low-confidence coverage) that also return null
//   regardless of kind or match.

import assert from "node:assert/strict";
import test from "node:test";

import { interpretDestinationPolicy } from "./decisions.ts";
import type { Policy } from "./decisions.ts";
import type { Answer, ChoiceAnswer, NoulAnswer } from "./jev.ts";

const ACTION = "hacer algo";

function policies(kind: Policy["kind"]): Policy[] {
  return [{ id: "regla", rule: "una regla de prueba", kind }];
}

function coverageAnswer(choice: string, confidence: number): ChoiceAnswer {
  return { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
}

function matchAnswer(noul: number): NoulAnswer {
  return { type: "noul", noul };
}

function answers(choice: string, confidence: number, match: number): Record<string, Answer> {
  return { cobertura: coverageAnswer(choice, confidence), es_del_tipo: matchAnswer(match) };
}

// --- kind x match table (6 cells) -----------------------------------------

test("permite + match -> actua", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("regla", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "actua");
  assert.equal(decision?.source, "politica");
  assert.equal(decision?.policyId, "regla");
  assert.equal(decision?.isPolicyGap, false);
});

test("permite + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("regla", 0.9, 0.2));
  assert.equal(decision, null);
});

test("pregunta + match -> pregunta", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("pregunta"), answers("regla", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "pregunta");
  assert.equal(decision?.source, "politica");
  assert.equal(decision?.isPolicyGap, false);
});

test("pregunta + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("pregunta"), answers("regla", 0.9, 0.1));
  assert.equal(decision, null);
});

test("prohibe + match -> no_hagas", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibe"), answers("regla", 0.9, 0.95));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "no_hagas");
  assert.equal(decision?.source, "politica");
  assert.equal(decision?.isPolicyGap, false);
});

test("prohibe + no match -> falls through (null), this is the reported bug's exact shape", () => {
  // This is the shape of the live bug: a permissive policy (here standing
  // in for lectura_y_pruebas) with a low match score used to produce
  // no_hagas under the old two-gate logic. With kind-based branching, a
  // non-match on ANY kind -- including prohibe -- must fall through to
  // risk judgment, never resolve to no_hagas on its own.
  const decision = interpretDestinationPolicy(ACTION, policies("prohibe"), answers("regla", 0.9, 0.05));
  assert.equal(decision, null);
});

// --- coverage-side null paths (2 cells) ------------------------------------

test("no policy covers the action (cobertura = sin_politica) -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibe"), answers("sin_politica", 0.95, 0.95));
  assert.equal(decision, null);
});

test("low-confidence coverage -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("regla", 0.5, 0.95));
  assert.equal(decision, null);
});

// --- the exact regression from the diagnosed bug ---------------------------

test("regression: a low match against a PERMISSIVE policy never resolves to no_hagas", () => {
  // Before the fix, interpretDestinationPolicy had no notion of `kind` and
  // treated every low 'cumple' value as a violation -- so
  // 'borrar la carpeta node_modules para reinstalar', matched to
  // lectura_y_pruebas (a permite rule) with a low compliance score, came
  // back no_hagas. After the fix the same shape of answer set (permite +
  // low match) must fall through to risk judgment (null), never no_hagas.
  const decision = interpretDestinationPolicy(
    "borrar la carpeta node_modules para reinstalar",
    [{ id: "lectura_y_pruebas", rule: "se hace sin preguntar", kind: "permite" }],
    answers("lectura_y_pruebas", 0.9, 0.3),
  );
  assert.notEqual(decision?.outcome, "no_hagas");
  assert.equal(decision, null);
});

// --- boundary check on the match gate --------------------------------------

test("match exactly at the gate counts as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("regla", 0.9, 0.7));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "actua");
});

test("match just under the gate does not count as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("regla", 0.9, 0.6999));
  assert.equal(decision, null);
});

test("unknown policy id in cobertura's choice (not in the provided policies list) -> null", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permite"), answers("otra_regla_no_listada", 0.9, 0.9));
  assert.equal(decision, null);
});
