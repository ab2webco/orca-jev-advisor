import assert from "node:assert/strict";
import test from "node:test";

import { CONFIDENCE_FLOOR, buildTierQuestions } from "./model_router_decide.ts";
import {
  DEFAULT_WORK_KIND_MODE,
  WORK_KINDS,
  WORK_KIND_MODES,
  interpretWorkKind,
  keywordWorkKind,
  kindStepEffort,
  parseWorkKindMode,
  readWorkTierEffort,
  withWorkKindQuestion,
} from "./work_kind.ts";
import type { KindEffortInput } from "./work_kind.ts";

// ---------------------------------------------------------------------------
// 0.6.16 T2: the work kind at subagent spawn (odd/research/phase-effort.md §6 A).
// ---------------------------------------------------------------------------

test("T2: five kinds, three modes, measure by default", () => {
  assert.deepEqual(WORK_KINDS, ["execute", "read", "review", "implement", "design"]);
  assert.deepEqual(WORK_KIND_MODES, ["off", "measure", "active"]);
  assert.equal(DEFAULT_WORK_KIND_MODE, "measure");
  assert.equal(parseWorkKindMode("active"), "active");
  assert.equal(parseWorkKindMode("on"), "measure");
  assert.equal(parseWorkKindMode(undefined), "measure");
});

test("T2: the kind is one more question in the spawn's own tier call, never a second call", () => {
  const questions = withWorkKindQuestion(buildTierQuestions());
  assert.deepEqual(Object.keys(questions).sort(), ["kind", "tier"]);
  const kind = questions.kind;
  assert.equal(kind?.type, "choice");
  if (kind?.type !== "choice") return;
  assert.deepEqual(Object.keys(kind.criteria), [...WORK_KINDS]);
  assert.match(kind.instructions, /implement/);
  assert.deepEqual(buildTierQuestions().tier, questions.tier, "the tier question is unchanged");
});

test("T2 interpretWorkKind: a known kind with its confidence, else null", () => {
  assert.deepEqual(interpretWorkKind({ kind: { type: "choice", choice: "read", probabilities: { read: 0.8 }, confidence: 0.8 } }), { kind: "read", confidence: 0.8, source: "jev" });
  assert.equal(interpretWorkKind({ kind: { type: "choice", choice: "deploy", probabilities: {}, confidence: 0.9 } }), null);
  assert.equal(interpretWorkKind({}), null);
});

test("T2 keywordWorkKind: the research's description categories, first match wins", () => {
  assert.equal(keywordWorkKind("Watch the CI run"), "execute");
  assert.equal(keywordWorkKind("Run the test suite"), "execute");
  assert.equal(keywordWorkKind("Review the diff"), "review");
  assert.equal(keywordWorkKind("Explore the router code"), "read");
  assert.equal(keywordWorkKind("Implement T3"), "implement");
  assert.equal(keywordWorkKind("Design the cache"), "design");
  assert.equal(keywordWorkKind("Something else"), null);
});

const READ: KindEffortInput = {
  kind: { kind: "read", confidence: 0.9, source: "jev" },
  model: "claude-sonnet-5",
  effort: "xhigh",
  declared: null,
  guard: null,
  text: "Find where the router logs its decisions",
  destinationKind: null,
};

test("T2 kindStepEffort: Sonnet 5 on read or execute work is capped at high, never xhigh", () => {
  assert.deepEqual(kindStepEffort(READ), { effort: "high", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, kind: { kind: "execute", confidence: 0.8, source: "jev" } }), { effort: "high", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-sonnet-5-20260101", effort: "high" }), { effort: "high", hold: null }, "high stays high");
  assert.deepEqual(kindStepEffort({ ...READ, effort: "medium" }), { effort: "medium", hold: null }, "a cap never raises");
});

test("T2 kindStepEffort: Opus 5.5 and Sonnet 5.5 run read or execute work at medium, their Claude Code default", () => {
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-opus-5-5", effort: "high" }), { effort: "medium", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-opus-5-5[1m]", effort: "xhigh" }), { effort: "medium", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-sonnet-5-5", effort: "high" }), { effort: "medium", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-opus-5", effort: "high" }), { effort: "high", hold: "other-model" });
});

test("T2 kindStepEffort: review, implement and design keep their effort", () => {
  for (const kind of ["review", "implement", "design"] as const) {
    assert.deepEqual(kindStepEffort({ ...READ, kind: { kind, confidence: 0.95, source: "jev" } }), { effort: "xhigh", hold: "not-read-work" });
  }
});

test("T2 kindStepEffort: every guard holds the effort as it is", () => {
  assert.deepEqual(kindStepEffort({ ...READ, kind: null }), { effort: "xhigh", hold: "no-kind" });
  assert.deepEqual(kindStepEffort({ ...READ, kind: { kind: "read", confidence: CONFIDENCE_FLOOR - 0.01, source: "jev" } }), { effort: "xhigh", hold: "unsure" });
  assert.deepEqual(kindStepEffort({ ...READ, kind: { kind: "read", confidence: null, source: "keywords" } }), { effort: "xhigh", hold: "unsure" }, "keywords alone never act");
  assert.deepEqual(kindStepEffort({ ...READ, guard: "pointer-prompt" }), { effort: "xhigh", hold: "pointer-prompt" });
  assert.deepEqual(kindStepEffort({ ...READ, text: "Check the production deploy logs" }), { effort: "xhigh", hold: "sensitive" });
  assert.deepEqual(kindStepEffort({ ...READ, destinationKind: "client-site" }), { effort: "xhigh", hold: "client-site" });
  assert.deepEqual(kindStepEffort({ ...READ, effort: "max" }), { effort: "max", hold: "person-effort" });
  assert.deepEqual(kindStepEffort({ ...READ, effort: 16000 }), { effort: 16000, hold: "person-effort" });
  assert.deepEqual(kindStepEffort({ ...READ, declared: "max" }), { effort: "xhigh", hold: "person-effort" });
  assert.deepEqual(kindStepEffort({ ...READ, effort: undefined }), { effort: undefined, hold: "none-sent" });
});

test("T2 kindStepEffort: never below the definition's declared effort (T3)", () => {
  assert.deepEqual(kindStepEffort({ ...READ, declared: "xhigh" }), { effort: "xhigh", hold: null });
  assert.deepEqual(kindStepEffort({ ...READ, model: "claude-opus-5-5", effort: "xhigh", declared: "high" }), { effort: "high", hold: null });
});

test("T1/T2 readWorkTierEffort: the router's own low stays only on read or execute work at the simple tier's default", () => {
  const acting = { kind: "read", confidence: 0.9, source: "jev" } as const;
  assert.equal(readWorkTierEffort("simple", "medium", false, acting), "low");
  assert.equal(readWorkTierEffort("simple", "medium", false, { ...acting, kind: "execute" }), "low");
  assert.equal(readWorkTierEffort("simple", "medium", false, { ...acting, kind: "implement" }), "medium", "work that may edit");
  assert.equal(readWorkTierEffort("simple", "medium", false, { ...acting, confidence: 0.5 }), "medium", "an unsure kind");
  assert.equal(readWorkTierEffort("simple", "medium", false, null), "medium");
  assert.equal(readWorkTierEffort("simple", "high", true, acting), "high", "the person's own setting for simple wins");
  assert.equal(readWorkTierEffort("standard", "medium", false, acting), "medium");
});
