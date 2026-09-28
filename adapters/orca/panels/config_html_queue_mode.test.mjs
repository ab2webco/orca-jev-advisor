// 0.6.7 T4: "When a person must approve: ask now | queue and continue" --
// src/core/queue_mode.ts. It sits in the Policies tab, next to the
// requires_human policies it applies to, and is saved by the same Save
// button to the `queueMode` storage key ({ enabled }); the worker mirrors it
// to queue-mode.json for the gate. Source-as-text checks, same approach as
// config_html_team_owners.test.mjs; real-DOM coverage is in
// scripts/panels.spec.mjs.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

function functionBody (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  if (!startMatch) throw new Error(`function ${name} not found -- update this test if it moved or was renamed`)
  let depth = 0
  let i = startMatch.index + startMatch[0].length - 1
  const start = i
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

function tabPanelMarkup (id) {
  const start = configHtml.indexOf(`id="panel-${id}"`)
  assert.ok(start >= 0, `panel-${id} not found`)
  const next = configHtml.indexOf('class="tab-panel"', start + 1)
  return configHtml.slice(start, next === -1 ? undefined : next)
}

function catalogBlock (locale) {
  const start = configHtml.indexOf(`        ${locale}: {`)
  assert.ok(start >= 0, `catalog ${locale} not found`)
  const end = configHtml.indexOf('\n        }', start)
  return configHtml.slice(start, end)
}

const KEYS = ['queueMode.heading', 'queueMode.label', 'queueMode.ask', 'queueMode.queue', 'queueMode.hint', 'save.whichQueueMode']

test('config.html: the queue mode is a labelled select with both choices, inside the Policies tab', () => {
  const policies = tabPanelMarkup('policies')
  assert.match(policies, /<section id="queue-mode-section">/)
  assert.match(policies, /<label for="queue-mode" data-i18n="queueMode\.label"><\/label>/)
  assert.match(policies, /<select id="queue-mode">/)
  assert.match(policies, /<option value="ask" data-i18n="queueMode\.ask"><\/option>/)
  assert.match(policies, /<option value="queue" data-i18n="queueMode\.queue"><\/option>/)
  assert.match(policies, /data-i18n="queueMode\.hint"/)
})

test('config.html: every queue mode string exists in both languages', () => {
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of KEYS) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
})

test('config.html: load() reads queueMode and fills the select', () => {
  const body = functionBody(configHtml, 'load')
  assert.match(body, /read\('queueMode', false\)/)
  assert.match(body, /fillQueueMode\(/)
})

test('config.html: Save writes queueMode from the select, under its own label', () => {
  assert.match(configHtml, /\{ label: t\('save\.whichQueueMode'\), promise: write\('queueMode', readQueueMode\(\)\) \}/)
})

test('config.html: only a stored { enabled: true } shows "queue and continue"', () => {
  const body = functionBody(configHtml, 'fillQueueMode')
  assert.match(body, /enabled === true/)
})
