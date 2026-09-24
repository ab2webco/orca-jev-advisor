// Guard against a defect class that has now shipped three times: a panel
// literal silently drifting from the real constant it is supposed to
// mirror.
//
//   1. consequenceCeiling hardcoded as 1.5 -- the value measured wrong.
//   2. The same field re-measured to 1.78 in decisions.ts
//      (GATE_CONSEQUENCE_CEILING) without the panel's own copy catching up.
//   3. externalGate's panel fallback left at 0.35 while decisions.ts's
//      GATE_EXTERNAL_GATE had moved to 0.5.
//
// config.html is sandboxed HTML and cannot import from src/core (see
// main.mjs's own module note on GATE_DEFAULTS_KEY), so there is no compiler
// to catch a copy going stale -- the only honest guard is to read the
// panel's own source and check by hand.
//
// odd/tasks/production-honesty-pass.md's P2 removed actThreshold,
// confirmThreshold, reversibleGate and externalGate entirely: none of them
// were read by any decision anywhere, so incident 3 above is closed by the
// field no longer existing rather than by fixing its fallback. This test
// covers both surviving shapes of "every panel default comes from the
// constant it mirrors, or the field does not exist": the four dead fields
// are gone, and consequenceCeiling's fallback still defers to the worker's
// published mirror instead of hardcoding a number.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

test('config.html: actThreshold, confirmThreshold, reversibleGate and externalGate no longer exist as panel fields', () => {
  // Same names exist elsewhere on purpose (the per-destination catalog rows'
  // own live actThreshold/confirmThreshold, built per row without a global
  // DOM id -- see fieldInput/addCatalogRow) -- this checks the removed
  // GLOBAL threshold fields specifically: no input element with that id,
  // and no el(id) DOM lookup, which is exactly how fillThresholds/readConfig
  // used to reach them. A comment explaining the removal (this file's own
  // header, config.html's own module note) is fine and expected.
  for (const id of ['actThreshold', 'confirmThreshold', 'reversibleGate', 'externalGate']) {
    assert.equal(configHtml.includes(`id="${id}"`), false, `'${id}' input element must not exist in the panel`)
    assert.equal(configHtml.includes(`el('${id}')`), false, `'${id}' must not be read/written via el() anymore`)
  }
})

/**
 * Extracts fillThresholds' body from the panel source and reports whether it
 * hardcodes a bare decimal fallback for consequenceCeiling -- the exact
 * shape of incidents 1 and 2 above (`... : 1.5`, then `... : 1.78`).
 *
 * @param {string} source
 * @returns {boolean}
 */
function ceilingFallbackIsHardcoded(source) {
  const match = source.match(/function fillThresholds[\s\S]*?\n {6}\}/)
  if (!match) throw new Error('fillThresholds not found -- update this test if it moved or was renamed')
  const body = match[0]
  const ceilingLine = body.match(/el\('consequenceCeiling'\)\.value[\s\S]*?(?:\n {6,8}\S[\s\S]*?)?(?=\n {6,8}el\(|\n {6}\})/)
  if (!ceilingLine) throw new Error("the consequenceCeiling assignment was not found in fillThresholds -- update this test if it moved")
  return /:\s*1\.\d+/.test(ceilingLine[0])
}

test('self-check: the detector catches the historical shape of the defect (a bare decimal fallback)', () => {
  const bad = `
      function fillThresholds (config, gateDefaults) {
        config = config || {}
        var thresholds = config.thresholds || {}
        el('consequenceCeiling').value = thresholds.consequenceCeiling != null ? thresholds.consequenceCeiling : 1.78
        el('logMaxEntries').value = config.logMaxEntries != null ? config.logMaxEntries : 500
      }
`
  assert.equal(ceilingFallbackIsHardcoded(bad), true, 'the detector must flag a reintroduced literal fallback')
})

test("config.html: consequenceCeiling's fallback never hardcodes a number -- it defers to the worker's published gateDefaults mirror or stays honestly blank", () => {
  assert.equal(
    ceilingFallbackIsHardcoded(configHtml),
    false,
    "consequenceCeiling's fallback must come from gateDefaults (main.mjs's GATE_CONSEQUENCE_CEILING mirror), never a literal copied by hand",
  )
  assert.match(
    configHtml,
    /gateConsequenceCeiling/,
    'the fallback chain must still read from the gateDefaults mirror, not a local guess',
  )
})
