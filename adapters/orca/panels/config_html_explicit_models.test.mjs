// 0.6.8 T7: "Models fixed by an agent definition: judge them | keep them" --
// src/core/explicit_models.ts. It sits in the Models tab, next to the
// router it tells what to do with a subagent's fixed model, and is saved by
// the Save button to the `explicitModels` storage key ({ mode }); the worker
// mirrors it to explicit-models.json for the hooks module. Source-as-text checks, same approach as
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

const KEYS = ['explicitModels.heading', 'explicitModels.label', 'explicitModels.judge', 'explicitModels.keep', 'explicitModels.hint', 'save.whichExplicitModels']

test('config.html: the explicit models choice is a labelled select with both choices, inside the Models tab', () => {
  const models = tabPanelMarkup('models')
  assert.match(models, /<section id="explicit-models-section">/)
  assert.match(models, /<label id="explicit-models-label" data-i18n="explicitModels\.label"><\/label>/)
  assert.match(models, /<div id="explicit-models" class="mode-buttons" role="group" aria-labelledby="explicit-models-label">/)
  assert.match(models, /<button type="button" data-value="judge" data-i18n="explicitModels\.judge"><\/button>/)
  assert.match(models, /<button type="button" data-value="keep" data-i18n="explicitModels\.keep"><\/button>/)
  assert.match(models, /data-i18n="explicitModels\.hint"/)
})

test('config.html: every explicit models string exists in both languages', () => {
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of KEYS) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
})

test('config.html: load() reads explicitModels and fills the select', () => {
  const body = functionBody(configHtml, 'load')
  assert.match(body, /read\('explicitModels', false\)/)
  assert.match(body, /fillExplicitModels\(/)
})

test('config.html: Save writes explicitModels from the select, under its own label', () => {
  assert.match(configHtml, /\{ label: t\('save\.whichExplicitModels'\), promise: write\('explicitModels', readExplicitModels\(\)\) \}/)
})

test('config.html: only a stored { mode: "keep" } shows "keep them"; anything else is "judge them"', () => {
  const body = functionBody(configHtml, 'fillExplicitModels')
  assert.match(body, /mode === 'keep'/)
})
