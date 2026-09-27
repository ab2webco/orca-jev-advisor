// Every string a person reads in the panels must read as prose. The owner
// flagged " -- " between clauses as a sign of text nobody proofread (the gate
// reasons had the same problem; see src/core/i18n_catalogs.test.ts). This
// reads each panel's translation tables, the `'key': 'value'` lines, and
// rejects a double hyphen in any value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANELS = ['config.html', 'board.html']
const TRANSLATION_LINE = /^\s+'([A-Za-z0-9_.]+)':\s*'(.*)',?\s*$/

function translationValues (file) {
  const values = []
  for (const line of readFileSync(join(HERE, file), 'utf8').split('\n')) {
    const match = TRANSLATION_LINE.exec(line)
    if (match) values.push({ key: match[1], value: match[2] })
  }
  return values
}

for (const file of PANELS) {
  test(`${file}: translation strings exist, so this check reads something real`, () => {
    assert.ok(translationValues(file).length > 50, `expected the translation tables of ${file} to be found`)
  })

  test(`${file}: no translation string joins clauses with " -- "`, () => {
    const offenders = translationValues(file).filter(({ value }) => value.includes(' -- ')).map(({ key }) => key)
    assert.deepEqual(offenders, [])
  })

}

// ---------------------------------------------------------------------------
// JEV-060 slice 2, T9: key parity for the keys THIS task adds -- a key
// declared in one locale block and forgotten in the other renders as a raw
// i18n key on screen, never a translated sentence. Scoped to the new keys
// only: a full-catalog parity sweep would also fail on pre-existing gaps
// this task did not touch and is not the one to fix. Each key must appear
// exactly twice in the file's flat 'key': 'value' line list -- once in the
// `es` block, once in `en` -- never once (missing from a locale) or three+
// times (accidentally duplicated within a block).
// ---------------------------------------------------------------------------

const NEW_ROUTER_KEYS_BY_FILE = {
  'board.html': [
    'consumption.accountHome',
    'consumption.accountLabel',
    'consumption.modelRouterHeading',
    'consumption.modelRouterEmpty',
    'consumption.modelRouterNoDecisions',
    'consumption.modelRouterPointStart',
    'consumption.modelRouterPointStage',
    'consumption.modelRouterPointSubagent',
    'consumption.modelRouterTierSimple',
    'consumption.modelRouterTierStandard',
    'consumption.modelRouterTierComplex',
    'consumption.modelRouterTierFrontier',
    'consumption.modelRouterAppliedMeasured',
    'consumption.modelRouterSavedEstimate',
    'consumption.modelRouterNoEstimateYet',
  ],
  'config.html': [
    'modelRouter.heading',
    'modelRouter.explanation',
    'modelRouter.targetHome',
    'modelRouter.targetAccount',
    'modelRouter.modeOff',
    'modelRouter.modeMeasure',
    'modelRouter.modeActive',
    'modelRouter.save',
    'modelRouter.saving',
    'modelRouter.saved',
    'modelRouter.empty',
  ],
}

for (const [file, keys] of Object.entries(NEW_ROUTER_KEYS_BY_FILE)) {
  test(`${file}: JEV-060 slice 2 T9's new i18n keys are each declared once in es and once in en`, () => {
    const values = translationValues(file)
    for (const key of keys) {
      const occurrences = values.filter((v) => v.key === key).length
      assert.equal(occurrences, 2, `expected "${key}" to appear exactly twice (once per locale) in ${file}, found ${occurrences}`)
    }
  })
}
