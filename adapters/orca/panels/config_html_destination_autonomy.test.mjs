// Guard against the same defect class config_html_thresholds.test.mjs
// already covers for the GLOBAL threshold fields (actThreshold,
// confirmThreshold, reversibleGate, externalGate on PluginConfig.thresholds
// -- production-honesty-pass P2), applied here to a DIFFERENT set of fields
// that happened to share two of the same names: the per-DESTINATION
// `actThreshold`/`confirmThreshold`/`maxAutoDelicateness` on each catalog
// row's own `autonomy` object (`src/core/store.ts`'s `AutonomyConfig`).
//
// config_html_thresholds.test.mjs's own comment already flagged these as
// deliberately out of scope for that pass ("Same names exist elsewhere on
// purpose (the per-destination catalog rows' own live actThreshold/
// confirmThreshold...)"). Traced in the AB-benchmark pass: `decideDestination`
// (src/core/decisions.ts) takes `{ action, policies, policyAnswers,
// riskAnswers }` and never receives a destination's `AutonomyConfig` at
// all -- every destination is judged against the same module-level
// REVERSIBLE_GATE/EXTERNAL_GATE/CONSEQUENCE_CEILING constants. The three
// fields reached no decision anywhere, so they are removed here too, the
// same way P2 removed the global ones: not defaulted, not wired, gone.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

const DEAD_DESTINATION_AUTONOMY_FIELDS = ['actThreshold', 'confirmThreshold', 'maxAutoDelicateness']

/**
 * Drops block and line comments, so a check for "does this field still
 * exist in the CODE" is not defeated by an explanatory comment that
 * legitimately names the field it removed (this file's own header does
 * exactly that, and so does config.html's pre-existing P2 note on the
 * separate, already-removed GLOBAL threshold fields, which share two of
 * these names). Good enough for this one file: it never puts `//` inside a
 * string literal that matters for this check.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

test('config.html: none of the three dead per-destination autonomy fields appears in the panel CODE (comments may still explain the removal)', () => {
  const code = stripComments(configHtml)
  for (const field of DEAD_DESTINATION_AUTONOMY_FIELDS) {
    assert.equal(code.includes(field), false, `'${field}' must not appear in config.html's code -- it is not seeded, not editable, and not read back`)
  }
})

test("config.html: a new catalog row's autonomy seed is an empty object, never a literal for a field no decision reads", () => {
  const match = configHtml.match(/function addCatalogRow[\s\S]*?\n {6}\}/)
  assert.ok(match, 'addCatalogRow not found -- update this test if it moved or was renamed')
  assert.match(match[0], /autonomy:\s*\{\}/, "the default row's autonomy must be an empty object")
})

test('self-check: stripComments removes a // comment naming the field, but leaves real code alone', () => {
  const commentOnly = "      // actThreshold used to live here\n      var x = 1\n"
  const stripped = stripComments(commentOnly)
  assert.equal(stripped.includes('actThreshold'), false, 'a comment mentioning the field must be stripped')
  assert.match(stripped, /var x = 1/, 'real code on other lines must survive')
})

test('self-check: stripComments removes a /* */ block comment naming the field', () => {
  const blockOnly = '/** actThreshold used to live here */\nvar x = 1\n'
  assert.equal(stripComments(blockOnly).includes('actThreshold'), false)
})

test('self-check: the field-absence check would have caught the historical shape of the defect', () => {
  const bad = "autonomy: { actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2 }"
  const stripped = stripComments(bad)
  for (const field of DEAD_DESTINATION_AUTONOMY_FIELDS) {
    assert.equal(stripped.includes(field), true, `self-check fixture (real code, not a comment) must still contain '${field}'`)
  }
})
