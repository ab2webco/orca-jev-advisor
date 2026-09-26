// Every Spanish string a person reads must read as Spanish: accents where the
// word takes one, and no ASCII stand-ins such as " -- " between clauses. The
// owner saw "tan cerca del limite que preguntar de nuevo podria cambiar la
// respuesta -- muy cerca para dejarlo pasar en silencio" under a real command
// and could not tell what it meant. Unaccented words are a reliable sign a
// string was written in a hurry, so this guards the catalogs against them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_CATALOG } from "./i18n_advisor.ts";
import { DESTINATION_CATALOG } from "./i18n_destination.ts";
import { GATE_CATALOG } from "./i18n_gate.ts";
import { MOD_SKILLS_CATALOG } from "./i18n_mod_skills.ts";
import { TOOLS_CATALOG } from "./i18n_tools.ts";

const CATALOGS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  ["advisor", ADVISOR_CATALOG.es],
  ["destination", DESTINATION_CATALOG.es],
  ["gate", GATE_CATALOG.es],
  ["mod_skills", MOD_SKILLS_CATALOG.es],
  ["tools", TOOLS_CATALOG.es],
];

// Model-facing strings stay in English on purpose (see GATE_CATALOG's
// localRuleDeny note), so they are not Spanish prose to check.
const MODEL_FACING_KEYS = new Set(["localRuleDeny"]);

// Words that are never correct without their accent in these catalogs.
// Ambiguous pairs (esta/está, mas/más, si/sí, solo/sólo) are left out on
// purpose: both spellings are valid Spanish.
const MUST_BE_ACCENTED = [
  "limite", "podria", "podrian", "maquina", "automatica", "automaticamente", "despues", "ningun",
  "catalogo", "politica", "politicas", "aqui", "alli", "leido", "codigo", "sesion", "tambien",
  "todavia", "ademas", "numero", "ultimo", "ultima", "pagina", "accion", "opcion", "configuracion",
  "revision", "decision", "informacion", "funcion", "razon", "deberia", "tendria", "habria",
  "seria", "estara", "sera", "facil", "rapido", "unico", "unica", "metodo",
];

function wordsOf(text: string): readonly string[] {
  return text.toLowerCase().split(/[^a-záéíóúüñ]+/u).filter((word) => word.length > 0);
}

test("Spanish catalog strings carry their accents", () => {
  const problems: string[] = [];
  for (const [name, entries] of CATALOGS) {
    for (const [key, value] of Object.entries(entries)) {
      if (MODEL_FACING_KEYS.has(key)) continue;
      const missing = wordsOf(value).filter((word) => MUST_BE_ACCENTED.includes(word));
      if (missing.length > 0) problems.push(`${name}.${key}: ${missing.join(", ")}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("Spanish catalog strings do not use ' -- ' between clauses", () => {
  const problems: string[] = [];
  for (const [name, entries] of CATALOGS) {
    for (const [key, value] of Object.entries(entries)) {
      if (MODEL_FACING_KEYS.has(key)) continue;
      if (value.includes(" -- ")) problems.push(`${name}.${key}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("English gate reasons do not use ' -- ' between clauses either", () => {
  const problems = Object.entries(GATE_CATALOG.en)
    .filter(([key, value]) => !MODEL_FACING_KEYS.has(key) && value.includes(" -- "))
    .map(([key]) => key);
  assert.deepEqual(problems, []);
});
