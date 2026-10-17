// C2 (odd/tasks/clef-decides-policies.md): a gate line names the provider
// that judged the command. Jev's catalog is the one gate-bash.ts always used;
// Clef's differs only on the keys that name the judge.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GATE_CATALOG, JUDGED_GATE_KEYS, gateCatalogFor, type GateKey } from "./i18n_gate.ts";

test("Jev's catalog is the gate catalog itself, unchanged", () => {
  assert.equal(gateCatalogFor("jev"), GATE_CATALOG);
});

test("Clef's catalog names Clef on the judged lines, in both locales", () => {
  const clef = gateCatalogFor("clef");
  assert.equal(clef.es.advisedLine, "clef · avisó al modelo antes de `{{segment}}`: {{effect}}");
  assert.equal(clef.en.advisedLine, "clef · advised the model before `{{segment}}`: {{effect}}");
  assert.equal(clef.es.advisedRetryLine, "clef · el modelo lo confirmó y se ejecutó: `{{segment}}`");
  assert.equal(clef.es.authorizedLine, "clef · ya lo confirmaste en este repositorio, se ejecutó: `{{segment}}`");
  assert.equal(clef.es.policyBlockedLine, "clef · bloqueó `{{segment}}`: lo prohíbe la política {{policyId}}");
  assert.equal(clef.en.policyBlockedLine, "clef · blocked `{{segment}}`: forbidden by the policy {{policyId}}");
  assert.equal(clef.es.policyAskLine, "clef · {{policyId}} pide que decidas: `{{segment}}`");
  assert.equal(clef.es.queuedLine, "clef · {{policyId}} lo dejó en espera para ti: `{{segment}}` — el agente sigue con lo demás");
  assert.equal(clef.es["effect.uncertain"], "Clef no está seguro de que sea inofensivo");
  assert.equal(clef.en["effect.uncertain"], "Clef isn't sure it's harmless");
  assert.equal(clef.es["reason.incompleteAnswers"], "Clef no devolvió respuestas completas para 'reversible', 'externa' o 'consecuencia'.");
  assert.equal(clef.en["reason.incompleteAnswers"], "Clef didn't return complete answers for 'reversible', 'external' or 'consequence'.");
});

test("Clef's catalog leaves every other key as it is: local decisions and Jev's own notices never change", () => {
  const clef = gateCatalogFor("clef");
  for (const locale of ["es", "en"] as const) {
    for (const key of Object.keys(GATE_CATALOG[locale]) as GateKey[]) {
      if (JUDGED_GATE_KEYS.includes(key)) {
        assert.doesNotMatch(clef[locale][key], /\bjev\b/i, `${locale}.${key}`);
      } else {
        assert.equal(clef[locale][key], GATE_CATALOG[locale][key], `${locale}.${key}`);
      }
    }
  }
  // A local rule's own block and the secret guard are never a provider's.
  assert.equal(clef.es.blockedLine, GATE_CATALOG.es.blockedLine);
  assert.equal(clef.es.secretPublishLine, GATE_CATALOG.es.secretPublishLine);
  assert.equal(clef.es.jevUnreachable, GATE_CATALOG.es.jevUnreachable);
});
