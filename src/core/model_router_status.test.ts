import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import { keptWhy, routerPersonStatusText, routerStatusText, routerWarmStatusText } from "./model_router_status.ts";

test("status line, Spanish, active: the spec's own example", () => {
  assert.equal(routerStatusText("es", "active", { label: "Sonnet 5", effort: "medium", tier: "standard" }), "modelo: Sonnet 5 · esfuerzo medio (etapa: implementar)");
});

test("status line, Spanish, measure: prefixed with mediría:", () => {
  assert.equal(routerStatusText("es", "measure", { label: "Sonnet 5", effort: "medium", tier: "standard" }), "mediría: Sonnet 5 · esfuerzo medio (etapa: implementar)");
});

test("status line, English, both modes", () => {
  assert.equal(routerStatusText("en", "active", { label: "Opus 5.5", effort: "high", tier: "complex" }), "model: Opus 5.5 · high effort (stage: analyse)");
  assert.equal(routerStatusText("en", "measure", { label: "Opus 5.5", effort: "xhigh", tier: "frontier" }), "would use: Opus 5.5 · extra high effort (stage: deep reasoning)");
});

test("status line: a model without effort shows none", () => {
  assert.equal(routerStatusText("es", "active", { label: "Haiku 4.5", effort: null, tier: "simple" }), "modelo: Haiku 4.5 (etapa: consultar)");
  assert.equal(routerStatusText("en", "measure", { label: "Haiku 4.5", effort: null, tier: "simple" }), "would use: Haiku 4.5 (stage: ask)");
});

test("the router catalog has the same keys in both locales", () => {
  assert.deepEqual(Object.keys(MODEL_ROUTER_CATALOG.es).sort(), Object.keys(MODEL_ROUTER_CATALOG.en).sort());
});

// ---------------------------------------------------------------------------
// A kept model says why (odd/tasks/router-guard-and-status.md, B): the line
// logged at 20:31:38 read "modelo: Opus 5.5 · esfuerzo muy alto
// (etapa: consultar)", pairing Jev's tier with the model it would NOT pick.
// ---------------------------------------------------------------------------

const KEPT = { label: "Opus 5.5", effort: "xhigh", tier: "simple" } as const;

test("kept, held by a guard: pointer-prompt and low-confidence, both locales, both modes", () => {
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "low-confidence" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: poca confianza (Jev: consultar)");
  assert.equal(routerStatusText("es", "measure", { ...KEPT, kept: "pointer-prompt" }), "mediría: Opus 5.5 · esfuerzo muy alto · se mantendría: el mensaje remite a un documento (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "low-confidence" }), "model: Opus 5.5 · extra high effort · kept: low confidence (Jev: ask)");
  assert.equal(routerStatusText("en", "measure", { ...KEPT, kept: "pointer-prompt" }), "would use: Opus 5.5 · extra high effort · would keep: the prompt points to a document (Jev: ask)");
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "low-confidence" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: poca confianza (Jev: consultar)");
  assert.equal(routerStatusText("es", "measure", { ...KEPT, kept: "low-confidence" }), "mediría: Opus 5.5 · esfuerzo muy alto · se mantendría: poca confianza (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "low-confidence" }), "model: Opus 5.5 · extra high effort · kept: low confidence (Jev: ask)");
  assert.equal(routerStatusText("en", "measure", { ...KEPT, kept: "low-confidence" }), "would use: Opus 5.5 · extra high effort · would keep: low confidence (Jev: ask)");
});

test("kept, break-even and hysteresis, both locales, both modes", () => {
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "break-even" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: cambiar cuesta más de lo que ahorra (Jev: consultar)");
  assert.equal(routerStatusText("es", "measure", { ...KEPT, kept: "break-even" }), "mediría: Opus 5.5 · esfuerzo muy alto · se mantendría: cambiar cuesta más de lo que ahorra (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "break-even" }), "model: Opus 5.5 · extra high effort · kept: switching costs more than it saves (Jev: ask)");
  assert.equal(routerStatusText("en", "measure", { ...KEPT, kept: "break-even" }), "would use: Opus 5.5 · extra high effort · would keep: switching costs more than it saves (Jev: ask)");
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "hysteresis" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: esperando otro turno igual (Jev: consultar)");
  assert.equal(routerStatusText("es", "measure", { ...KEPT, kept: "hysteresis" }), "mediría: Opus 5.5 · esfuerzo muy alto · se mantendría: esperando otro turno igual (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "hysteresis" }), "model: Opus 5.5 · extra high effort · kept: waiting for another such turn (Jev: ask)");
  assert.equal(routerStatusText("en", "measure", { ...KEPT, kept: "hysteresis" }), "would use: Opus 5.5 · extra high effort · would keep: waiting for another such turn (Jev: ask)");
});

test("kept, with no effort: the effort segment is dropped", () => {
  const sonnet = { label: "Sonnet 5", effort: null, tier: "simple" } as const;
  assert.equal(routerStatusText("es", "active", { ...sonnet, kept: "prices-unknown" }), "modelo: Sonnet 5 · se mantiene: precios desconocidos (Jev: consultar)");
  assert.equal(routerStatusText("es", "measure", { ...sonnet, kept: "low-confidence" }), "mediría: Sonnet 5 · se mantendría: poca confianza (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...sonnet, kept: "hysteresis" }), "model: Sonnet 5 · kept: waiting for another such turn (Jev: ask)");
  assert.equal(routerStatusText("en", "measure", { ...sonnet, kept: "pointer-prompt" }), "would use: Sonnet 5 · would keep: the prompt points to a document (Jev: ask)");
});

test("a switch, or no reason to keep, reads exactly as before", () => {
  assert.equal(routerStatusText("es", "active", { label: "Haiku 4.5", effort: null, tier: "simple", kept: null }), "modelo: Haiku 4.5 (etapa: consultar)");
  assert.equal(routerStatusText("en", "measure", { label: "Sonnet 5", effort: "medium", tier: "standard", kept: null }), "would use: Sonnet 5 · medium effort (stage: implement)");
});

const HELD = { changed: false, proposed: "claude-haiku-4-5-20251001", model: "claude-opus-5-5" } as const;

test("keptWhy: a held reason names itself, held-by-guard names its guard", () => {
  for (const reason of ["low-confidence", "hysteresis", "break-even", "prices-unknown"] as const) assert.equal(keptWhy({ ...HELD, reason, guard: null }), reason);
  for (const guard of ["pointer-prompt", "low-confidence"] as const) assert.equal(keptWhy({ ...HELD, reason: "held-by-guard", guard }), guard);
  assert.equal(keptWhy({ ...HELD, reason: "held-by-guard", guard: null }), null, "a hold with no guard to name keeps today's wording");
});

test("keptWhy: switches, same-tier decisions and a Jev failure keep today's wording", () => {
  for (const reason of ["upgrade", "downgrade", "floor-restore", "switch"] as const) assert.equal(keptWhy({ ...HELD, reason, guard: null, changed: true, model: "claude-haiku-4-5-20251001" }), null);
  assert.equal(keptWhy({ ...HELD, reason: "same", guard: null, proposed: "claude-opus-5-5" }), null);
  assert.equal(keptWhy({ ...HELD, reason: "jev-failed", guard: null, proposed: null }), null);
  // Session start holds a same-model effort change under a guard: Jev's tier picks this very model ([1m] or not).
  assert.equal(keptWhy({ ...HELD, reason: "held-by-guard", guard: "pointer-prompt", proposed: "claude-opus-5-5", model: "claude-opus-5-5[1m]" }), null);
});

// 0.6.2 E2: an effort kept on the same model says why, the way a kept model does.
const EFFORT_HELD = { changed: false, proposed: "claude-opus-5-5", model: "claude-opus-5-5", effort: "xhigh", effortTarget: "high" } as const;

test("keptWhy: a same-model effort hold names its reason", () => {
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "effort-hysteresis", guard: null }), "hysteresis");
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "effort-break-even", guard: null }), "break-even");
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "effort-unknown-savings", guard: null }), "unknown-savings");
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "held-by-guard", guard: "pointer-prompt" }), "pointer-prompt");
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "low-confidence", guard: null, effortTarget: "max" }), "low-confidence");
  // Reached, or nothing weighed: plain wording.
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "effort-lower", guard: null, changed: true, effort: "high" }), null);
  assert.equal(keptWhy({ ...EFFORT_HELD, reason: "same", guard: null, effortTarget: null }), null);
});

test("status line: unknown savings reads in both locales", () => {
  assert.equal(routerStatusText("es", "active", { label: "Opus 5.5", effort: "xhigh", tier: "complex", kept: "unknown-savings" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: ahorro aún sin medir (Jev: analizar)");
  assert.equal(routerStatusText("en", "active", { label: "Opus 5.5", effort: "xhigh", tier: "complex", kept: "unknown-savings" }), "model: Opus 5.5 · extra high effort · kept: saving not measured yet (Jev: analyse)");
});

test("0.6.2 E6: a model held by a pointer prompt says so, both locales", () => {
  assert.equal(keptWhy({ ...HELD, reason: "held-by-guard", guard: "pointer-prompt" }), "pointer-prompt");
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "pointer-prompt" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: el mensaje remite a un documento (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "pointer-prompt" }), "model: Opus 5.5 · extra high effort · kept: the prompt points to a document (Jev: ask)");
});

test("0.6.2 E8: the router part carries no jev prefix of its own (the line has one)", () => {
  assert.equal(routerStatusText("es", "active", { label: "Sonnet 5", effort: "medium", tier: "standard" }).startsWith("jev"), false);
});

test("0.6.2 E8: a warm session's kept model says why, both locales, both modes", () => {
  assert.equal(routerWarmStatusText("es", "active", "Opus 5.5"), "modelo: Opus 5.5 · se mantiene: sesión ya iniciada");
  assert.equal(routerWarmStatusText("es", "measure", "Opus 5.5"), "mediría: Opus 5.5 · se mantendría: sesión ya iniciada");
  assert.equal(routerWarmStatusText("en", "active", "Opus 5.5"), "model: Opus 5.5 · kept: session already started");
  assert.equal(routerWarmStatusText("en", "measure", "Opus 5.5"), "would use: Opus 5.5 · would keep: session already started");
});

test("nit 10: the person's own switch reads as their choice, both locales, both modes", () => {
  assert.equal(routerPersonStatusText("es", "active", "Sonnet 5"), "modelo: Sonnet 5 · se mantiene: lo elegiste tú");
  assert.equal(routerPersonStatusText("es", "measure", "Sonnet 5"), "mediría: Sonnet 5 · se mantendría: lo elegiste tú");
  assert.equal(routerPersonStatusText("en", "active", "Sonnet 5"), "model: Sonnet 5 · kept: your choice");
  assert.equal(routerPersonStatusText("en", "measure", "Sonnet 5"), "would use: Sonnet 5 · would keep: your choice");
});

test("kept by the context-window floor: named in both locales", () => {
  assert.equal(routerStatusText("es", "active", { ...KEPT, kept: "context-window" }), "modelo: Opus 5.5 · esfuerzo muy alto · se mantiene: el contexto no cabe en un modelo menor (Jev: consultar)");
  assert.equal(routerStatusText("en", "active", { ...KEPT, kept: "context-window" }), "model: Opus 5.5 · extra high effort · kept: the context does not fit a smaller model (Jev: ask)");
});
