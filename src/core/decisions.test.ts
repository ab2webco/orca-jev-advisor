// Unit tests for interpretDestinationPolicy -- pure input to pure output,
// no filesystem, no network. Run with:
//   node --test src/core/decisions.test.ts
// (this project has no test runner configured yet; node:test is the
// built-in one, and Node 24's native TypeScript support runs this file
// directly, same as src/core/gate_stats.test.ts already does).
//
// Covers the full kind x match table from the policy fix:
//   permits/requires_human/prohibits, each with a match (>= gate) and a non-match
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

test("permits + match -> act", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("regla", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "act");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.policyId, "regla");
  assert.equal(decision?.isPolicyGap, false);
});

test("permits + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("regla", 0.9, 0.2));
  assert.equal(decision, null);
});

test("requires_human + match -> ask", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("requires_human"), answers("regla", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "ask");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.isPolicyGap, false);
});

test("requires_human + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("requires_human"), answers("regla", 0.9, 0.1));
  assert.equal(decision, null);
});

test("prohibits + match -> do_not", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("regla", 0.9, 0.95));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "do_not");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.isPolicyGap, false);
});

test("prohibits + no match -> falls through (null), this is the reported bug's exact shape", () => {
  // This is the shape of the live bug: a permissive policy (here standing
  // in for lectura_y_pruebas) with a low match score used to produce
  // do_not under the old two-gate logic. With kind-based branching, a
  // non-match on ANY kind -- including prohibits -- must fall through to
  // risk judgment, never resolve to do_not on its own.
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("regla", 0.9, 0.05));
  assert.equal(decision, null);
});

// --- coverage-side null paths (2 cells) ------------------------------------

test("no policy covers the action (cobertura = no_policy) -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("no_policy", 0.95, 0.95));
  assert.equal(decision, null);
});

test("low-confidence coverage -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("regla", 0.5, 0.95));
  assert.equal(decision, null);
});

// --- the exact regression from the diagnosed bug ---------------------------

test("regression: a low match against a PERMISSIVE policy never resolves to do_not", () => {
  // Before the fix, interpretDestinationPolicy had no notion of `kind` and
  // treated every low 'cumple' value as a violation -- so
  // 'borrar la carpeta node_modules para reinstalar', matched to
  // lectura_y_pruebas (a permits rule) with a low compliance score, came
  // back do_not. After the fix the same shape of answer set (permits +
  // low match) must fall through to risk judgment (null), never do_not.
  const decision = interpretDestinationPolicy(
    "borrar la carpeta node_modules para reinstalar",
    [{ id: "lectura_y_pruebas", rule: "se hace sin preguntar", kind: "permits" }],
    answers("lectura_y_pruebas", 0.9, 0.3),
  );
  assert.notEqual(decision?.outcome, "do_not");
  assert.equal(decision, null);
});

// --- boundary check on the match gate --------------------------------------

test("match exactly at the gate counts as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("regla", 0.9, 0.7));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "act");
});

test("match just under the gate does not count as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("regla", 0.9, 0.6999));
  assert.equal(decision, null);
});

test("unknown policy id in cobertura's choice (not in the provided policies list) -> null", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("otra_regla_no_listada", 0.9, 0.9));
  assert.equal(decision, null);
});
