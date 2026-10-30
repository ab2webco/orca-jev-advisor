// 0.13.3: a storage read the host refused (ok: false) used to come back as
// null, the same as "nothing saved", and Save wrote the empty/default value
// over what was stored (24 policies were lost that way). Source-as-text
// checks, same approach as config_html_provider.test.mjs; the real-DOM
// behaviour is in scripts/panels.spec.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { extractFunction } from './panel_html_copies.mjs'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

function catalogBlock (locale) {
  const start = configHtml.indexOf(`        ${locale}: {`)
  assert.ok(start >= 0, `catalog ${locale} not found`)
  return configHtml.slice(start, configHtml.indexOf('\n        }', start))
}

const SAVED_KEYS = ['config', 'catalog', 'policies', 'teamOwners', 'queueMode', 'explicitModels']

test('readStrict tells a refused read apart from an empty value, and the retry helper waits one throttle window', () => {
  const strict = extractFunction(configHtml, 'readStrict')
  assert.match(strict, /call\('storage\.get', \{ key: key \}, false\)/)
  assert.match(strict, /return \{ ok: false, value: null \}/)
  const retrying = extractFunction(configHtml, 'readStrictRetrying')
  assert.match(retrying, /CUPO\.ventanaMs/)
  assert.match(retrying, /retriesLeft - 1/)
})

test('the first batch reads every saved section strictly, never through read()', () => {
  const load = extractFunction(configHtml, 'load')
  for (const key of SAVED_KEYS) {
    assert.match(load, new RegExp(`readStrict\\('${key}'\\)`), `${key} must be read strictly`)
    assert.doesNotMatch(load, new RegExp(`\\bread\\('${key}'`), `${key} must not go through read()`)
  }
  assert.match(load, /readStrict\(MOD_SKILLS_STATUS_KEY\)/)
  assert.match(load, /readStrict\(DENY_TIER_STATUS_KEY\)/)
  const batch = load.slice(load.indexOf('var firstBatch'), load.indexOf('loadProviderSettings('))
  assert.equal((batch.match(/readStrict\(|read\(|loadSecretStatus\(|loadClaudeIntegrationStatus\(/g) || []).length, 14, 'the first batch must not grow')
})

test('Save writes a section only when it was read, and never empties a stored list by accident', () => {
  const start = configHtml.indexOf("el('save-all').addEventListener")
  const body = configHtml.slice(start, configHtml.indexOf('function load ()', start))
  for (const id of SAVED_KEYS) assert.match(body, new RegExp(`planSectionWrite\\('${id}'`), `${id} must go through planSectionWrite`)
  assert.doesNotMatch(body, /write\('policies'/)
  const plan = extractFunction(configHtml, 'planSectionWrite')
  assert.match(plan, /\.loaded/)
  assert.match(plan, /removed/)
})

test('the other whole-section senders check their section was read first', () => {
  for (const id of ['modSkills', 'denyTier', 'modelsLadder', 'modelsConfig']) {
    assert.match(configHtml, new RegExp(`refuseUnreadSection\\('${id}'`), `${id} must be guarded`)
  }
})

test('the unread-section strings exist in both languages, and Spanish uses tú', () => {
  const keys = ['section.reading', 'section.readFailed', 'save.notLoaded', 'save.emptyRefused', 'section.notSent', 'save.nothingLoaded', 'modules.readFailed', 'modules.install.readFailed']
  for (const locale of ['en', 'es']) {
    const block = catalogBlock(locale)
    for (const key of keys) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
  const es = catalogBlock('es')
  for (const key of keys) {
    const line = es.split('\n').find((l) => l.includes(`'${key}':`)) ?? ''
    assert.doesNotMatch(line, /\b(tenés|podés|revisá|decime|cerrá|abrí|volvé|guardá)\b/i, `${key} uses voseo`)
  }
})

test('a status read that failed is retried and the modules keep saying they are reading', () => {
  const loader = extractFunction(configHtml, 'loadClaudeIntegrationStatus')
  assert.match(loader, /readStrict\(CLAUDE_INTEGRATION_STATUS_KEY\)/)
  assert.match(loader, /retries - 1/)
  assert.match(loader, /integrationReadGeneration/)
})

test('a read result from an older generation is dropped, and a write or a newer read bumps the generation', () => {
  const settle = extractFunction(configHtml, 'settleSection')
  assert.match(settle, /generation !== section\.generation/)
  assert.match(extractFunction(configHtml, 'beginSectionRead'), /\+\+sections\[id\]\.generation/)
  assert.match(extractFunction(configHtml, 'planSectionWrite'), /section\.generation \+= 1/)
})

test('an unloaded section locks its controls, and Save with nothing loaded says so', () => {
  assert.match(extractFunction(configHtml, 'lockSection'), /data-section-locked/)
  assert.match(extractFunction(configHtml, 'markSectionLoaded'), /lockSection\(section\)/)
  // odd/tasks/single-save-bar.md T2: an edit the bar sends on its own (the model catalog, a request, a router field) still counts as something to save.
  assert.match(configHtml, /namedWrites\.length === 0 && !editedElsewhere\) \{ said\(saveSaidEl, t\('save\.nothingLoaded'\), true\); return \}/)
})
