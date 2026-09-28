import assert from "node:assert/strict";
import test from "node:test";

import { composeStatusLine, skillStatusPart, toolStatusPart } from "./status_line.ts";

test("composeStatusLine: one jev at the start, parts joined, nothing when there is nothing to say", () => {
  assert.equal(composeStatusLine(["skill: branch-pr (solo mide)", null, "modelo: Opus 5.5"]), "jev · skill: branch-pr (solo mide) · modelo: Opus 5.5");
  assert.equal(composeStatusLine([null, null]), null);
});

test("skill part: applied, measuring only, or active with nothing injected, both locales", () => {
  assert.equal(skillStatusPart("es", "branch-pr", "applied"), "skill: branch-pr (aplicada)");
  assert.equal(skillStatusPart("es", "branch-pr", "measuring"), "skill: branch-pr (solo mide)");
  assert.equal(skillStatusPart("es", null, "measuring"), "sin skill (solo mide)");
  assert.equal(skillStatusPart("es", null, "unchanged"), "sin skill");
  assert.equal(skillStatusPart("en", "branch-pr", "applied"), "skill: branch-pr (applied)");
  assert.equal(skillStatusPart("en", "branch-pr", "measuring"), "skill: branch-pr (measuring only)");
  assert.equal(skillStatusPart("en", null, "measuring"), "no skill (measuring only)");
  assert.equal(skillStatusPart("en", "branch-pr", "unchanged"), "skill: branch-pr");
});

test("tool part: applied, measuring only, or active with nothing suggested, both locales", () => {
  assert.equal(toolStatusPart("es", "Bash", "applied"), "herramienta: Bash (aplicada)");
  assert.equal(toolStatusPart("es", "Bash", "measuring"), "herramienta: Bash (solo mide)");
  assert.equal(toolStatusPart("es", null, "measuring"), "herramientas: sin cambio (solo mide)");
  assert.equal(toolStatusPart("es", null, "unchanged"), "herramientas: sin cambio");
  assert.equal(toolStatusPart("en", "Bash", "applied"), "tool: Bash (applied)");
  assert.equal(toolStatusPart("en", null, "measuring"), "tools: no change (measuring only)");
});

test("the owner's line, rebuilt: short, one jev, every part says what it did", () => {
  const line = composeStatusLine([skillStatusPart("es", "branch-pr", "measuring"), toolStatusPart("es", null, "measuring"), "modelo: Opus 5.5 · se mantiene: sesión ya iniciada"]);
  assert.equal(line, "jev · skill: branch-pr (solo mide) · herramientas: sin cambio (solo mide) · modelo: Opus 5.5 · se mantiene: sesión ya iniciada");
  assert.equal(line?.split("jev").length, 2);
  assert.doesNotMatch(line ?? "", / -- /);
});
