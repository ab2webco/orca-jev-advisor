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
