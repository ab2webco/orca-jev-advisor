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
// were read by any decision anywhere. A closer look (prompted by the
// coordinator, who verified it independently) found `getConfig()` has
// exactly two callers -- log.ts (logMaxEntries) and main.mjs's cmdDecide
// (jevBudgetMs) -- so consequenceCeiling was dead the same way: FIVE fields,
// not four. It is still shown, because the number itself is useful (it's
// the ceiling the gate actually applies, and a destination can override it),
// but it is read-only now, sourced from the worker's published gateDefaults
// mirror, never an editable control that changed nothing when saved.
//
// This file covers every surviving shape of "every panel default comes from
// the constant it mirrors, or the field does not exist, or it is honestly
// read-only": the four fully-dead fields are gone; consequenceCeiling has no
// editable input; and no hardcoded literal has crept into either the removed
// fields' history or the read-only display's fallback.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

// All five fields this class of defect has touched. actThreshold,
// confirmThreshold, reversibleGate and externalGate no longer exist at all;
// consequenceCeiling exists but must never be editable again.
const FIVE_FIELDS = ['actThreshold', 'confirmThreshold', 'reversibleGate', 'externalGate', 'consequenceCeiling']

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
 * Whether `source` contains an `<input ...>` element with the given id. The
 * failure mode this class of defect keeps producing is not (only) a wrong
 * number -- it is a control that LOOKS editable and changes nothing. This
 * checks the control itself, independent of whatever value it might show.
 *
 * @param {string} source
 * @param {string} id
 * @returns {boolean}
 */
function hasEditableInput(source, id) {
  return new RegExp(`<input\\b[^>]*\\bid="${id}"`).test(source)
}

test('self-check: the editable-input detector catches a reintroduced <input>, and ignores a read-only one', () => {
  assert.equal(hasEditableInput('<input id="consequenceCeiling" type="number" />', 'consequenceCeiling'), true)
  assert.equal(hasEditableInput('<output id="consequenceCeiling"></output>', 'consequenceCeiling'), false)
})

test('config.html: none of the five threshold fields has an editable <input> -- four are gone, consequenceCeiling is read-only', () => {
  for (const id of FIVE_FIELDS) {
    assert.equal(hasEditableInput(configHtml, id), false, `'${id}' must not be an editable <input> -- a control that looks editable and changes nothing is exactly this defect`)
  }
})

test('config.html: readConfig no longer sends a thresholds object at all -- there is nothing left in it to save', () => {
  const match = configHtml.match(/function readConfig[\s\S]*?\n {6}\}/)
  assert.ok(match, 'readConfig not found -- update this test if it moved or was renamed')
  assert.equal(/\bthresholds\s*:/.test(match[0]), false, 'readConfig must not build a thresholds object -- consequenceCeiling is read-only and the other four are gone')
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

test('self-check: the literal-fallback detector catches the historical shape of the defect (a bare decimal fallback)', () => {
  const bad = `
      function fillThresholds (config, gateDefaults) {
        config = config || {}
        el('consequenceCeiling').value = gateDefaults ? gateDefaults.consequenceCeiling : 1.78
        el('logMaxEntries').value = config.logMaxEntries != null ? config.logMaxEntries : 500
      }
`
  assert.equal(ceilingFallbackIsHardcoded(bad), true, 'the detector must flag a reintroduced literal fallback')
})

test("config.html: consequenceCeiling's displayed value never hardcodes a number -- it defers to the worker's published gateDefaults mirror or stays honestly blank", () => {
  assert.equal(
    ceilingFallbackIsHardcoded(configHtml),
    false,
    "consequenceCeiling's displayed value must come from gateDefaults (main.mjs's GATE_CONSEQUENCE_CEILING mirror), never a literal copied by hand",
  )
  assert.match(
    configHtml,
    /gateConsequenceCeiling/,
    'the display must still read from the gateDefaults mirror, not a local guess',
  )
})
