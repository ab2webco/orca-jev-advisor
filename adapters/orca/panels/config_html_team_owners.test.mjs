// 0.6.8 T1: "Repositories your team owns" -- the owners whose repositories
// never reach a client (see src/core/team_owners.ts). The field lives in the
// Policies tab, next to the requires_human policies it narrows, and is saved
// by the same Save button to the `teamOwners` storage key; the worker
// mirrors it to team-owners.json for the gate.
//
// config.html is sandboxed HTML with no compiler, so -- same approach as
// config_html_catalog_proposals.test.mjs -- this reads the panel's own
// source as text. Behavioral (real-DOM) coverage for the same field lives in
// scripts/panels.spec.mjs.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

/** Extracts a named function's body by brace-matching -- same helper the other config_html_*.test.mjs files use. */
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

/** The markup of one tab-panel, from its opening tag to the next tab-panel. */
function tabPanelMarkup (id) {
  const start = configHtml.indexOf(`id="panel-${id}"`)
  assert.ok(start >= 0, `panel-${id} not found`)
  const next = configHtml.indexOf('class="tab-panel"', start + 1)
  return configHtml.slice(start, next === -1 ? undefined : next)
}

/** One language's catalog block, as text. */
function catalogBlock (locale) {
  const start = configHtml.indexOf(`        ${locale}: {`)
  assert.ok(start >= 0, `catalog ${locale} not found`)
  const end = configHtml.indexOf('\n        }', start)
  return configHtml.slice(start, end)
}

const KEYS = ['teamOwners.heading', 'teamOwners.label', 'teamOwners.placeholder', 'teamOwners.hint', 'save.whichTeamOwners']

test('config.html: the team owners field is a labelled textarea inside the Policies tab', () => {
  const policies = tabPanelMarkup('policies')
  assert.match(policies, /<section id="team-owners-section">/)
  assert.match(policies, /<textarea id="team-owners"[^>]*data-i18n-placeholder="teamOwners\.placeholder"/)
  assert.match(policies, /<label for="team-owners" data-i18n="teamOwners\.label"><\/label>/)
  assert.match(policies, /data-i18n="teamOwners\.hint"/)
})

test('config.html: every team owners string exists in both languages', () => {
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of KEYS) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
})

test('config.html: load() reads teamOwners and fills the field', () => {
  const body = functionBody(configHtml, 'load')
  assert.match(body, /read\('teamOwners', false\)/)
  assert.match(body, /fillTeamOwners\(/)
})

test('config.html: Save writes teamOwners from the field, under its own label', () => {
  assert.match(configHtml, /\{ label: t\('save\.whichTeamOwners'\), promise: write\('teamOwners', readTeamOwners\(\)\) \}/)
})

test('config.html: readTeamOwners sends one trimmed, non-empty line per owner', () => {
  const body = functionBody(configHtml, 'readTeamOwners')
  assert.match(body, /split\(/)
  assert.match(body, /trim\(\)/)
  assert.match(body, /filter\(/)
})
