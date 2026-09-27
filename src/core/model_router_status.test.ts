import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import { routerStatusText } from "./model_router_status.ts";

test("status line, Spanish, active: the spec's own example", () => {
  assert.equal(routerStatusText("es", "active", { label: "Sonnet 5", effort: "medium", tier: "standard" }), "jev · modelo: Sonnet 5 · esfuerzo medio (etapa: implementar)");
});

test("status line, Spanish, measure: prefixed with mediría:", () => {
  assert.equal(routerStatusText("es", "measure", { label: "Sonnet 5", effort: "medium", tier: "standard" }), "jev · mediría: Sonnet 5 · esfuerzo medio (etapa: implementar)");
});

test("status line, English, both modes", () => {
  assert.equal(routerStatusText("en", "active", { label: "Opus 5.5", effort: "high", tier: "complex" }), "jev · model: Opus 5.5 · high effort (stage: analyse)");
  assert.equal(routerStatusText("en", "measure", { label: "Opus 5.5", effort: "xhigh", tier: "frontier" }), "jev · would use: Opus 5.5 · extra high effort (stage: deep reasoning)");
});

test("status line: a model without effort shows none", () => {
  assert.equal(routerStatusText("es", "active", { label: "Haiku 4.5", effort: null, tier: "simple" }), "jev · modelo: Haiku 4.5 (etapa: consultar)");
  assert.equal(routerStatusText("en", "measure", { label: "Haiku 4.5", effort: null, tier: "simple" }), "jev · would use: Haiku 4.5 (stage: ask)");
});

test("the router catalog has the same keys in both locales", () => {
  assert.deepEqual(Object.keys(MODEL_ROUTER_CATALOG.es).sort(), Object.keys(MODEL_ROUTER_CATALOG.en).sort());
});
