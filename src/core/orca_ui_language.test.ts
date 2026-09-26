// odd/tasks/release-0.5.1.md JEVADV-10: parseOrcaUiLanguage reads Orca's
// OWN language setting (`settings.uiLanguage` inside orca-data.json), never
// this plugin's own `<html lang>`-derived guess. Pure: takes the raw file
// contents (or `null` for "the file does not exist"), never touches a
// filesystem itself -- adapters/orca/write-secret-mirror.mjs's
// orca-ui-language-read mode is the only I/O, and its own real-temp-file
// tests live in adapters/orca/write-secret-mirror.orca-ui-language.test.mjs.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOrcaUiLanguage } from "./orca_ui_language.ts";

test("parseOrcaUiLanguage: a concrete 'es' setting is authoritative", () => {
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: "es" } })), "es");
});

test("parseOrcaUiLanguage: a concrete 'en' setting is authoritative", () => {
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: "en" } })), "en");
});

test("parseOrcaUiLanguage: a regional tag normalizes to its base language", () => {
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: "es-CO" } })), "es");
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: "en-GB" } })), "en");
});

test("parseOrcaUiLanguage: 'system' defers -- never forced to 'en'", () => {
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: "system" } })), null);
});

test("parseOrcaUiLanguage: a missing uiLanguage field defers", () => {
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: {} })), null);
  assert.equal(parseOrcaUiLanguage(JSON.stringify({})), null);
});

test("parseOrcaUiLanguage: null (the file does not exist) defers", () => {
  assert.equal(parseOrcaUiLanguage(null), null);
});

test("parseOrcaUiLanguage: malformed JSON defers rather than throwing", () => {
  assert.equal(parseOrcaUiLanguage("{not json"), null);
  assert.equal(parseOrcaUiLanguage(""), null);
});

test("parseOrcaUiLanguage: an unexpected shape (array, or settings not an object) defers", () => {
  assert.equal(parseOrcaUiLanguage("[]"), null);
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: "es" })), null);
  assert.equal(parseOrcaUiLanguage(JSON.stringify({ settings: { uiLanguage: 7 } })), null);
});
