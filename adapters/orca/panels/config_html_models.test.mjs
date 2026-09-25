// odd/tasks/model-reclassification.md T7: the config panel's Models
// section (ladder editor, active-mode switch, baseline notice, measurement
// readout). Modeled on config_html_mod_skills.test.mjs: config.html is
// sandboxed HTML with no compiler to catch a drifted panel, so this reads
// the panel's own source as text, `node --check`s every extracted
// <script>, and asserts the section, its controls, the i18n keys and the
// storage keys by hand.
//
// This section is deliberately self-contained (its own <section
// id="models-section">, its own <script> block, every new identifier
// prefixed `models`/`MODEL`) because parallel work also edits config.html
// (a learned-allows section, the Team policies notice style, and the
// integration line) -- see the module note in <head> and the coordinator
// brief for why.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isModelEntry } from '../../../src/core/model_catalog.ts'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Syntax: every extracted <script> must be independently valid JS. Two
// scripts are expected once the Models section exists: the original panel
// script and this section's own self-contained one.
// ---------------------------------------------------------------------------

function extractedScripts (html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  return matches.map((m) => m[1])
}

test('config.html: every extracted inline <script> is syntactically valid', () => {
  const scripts = extractedScripts(configHtml)
  assert.ok(scripts.length >= 1, 'no inline <script> found')
  const dir = mkdtempSync(join(tmpdir(), 'config-html-models-script-check-'))
  try {
    scripts.forEach((body, index) => {
      const scriptPath = join(dir, `config-panel-script-${index}.js`)
      writeFileSync(scriptPath, body, 'utf8')
      execFileSync(process.execPath, ['--check', scriptPath])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.html: the Models section owns its own <script> block, separate from the original panel script', () => {
  assert.ok(extractedScripts(configHtml).length >= 2, 'expected a second, self-contained <script> block for the Models section')
})

// ---------------------------------------------------------------------------
// The section and its controls.
// ---------------------------------------------------------------------------

test('config.html: the models-section exists', () => {
  assert.match(configHtml, /<section id="models-section">/)
})

const EXPECTED_IDS = [
  'models-empty-catalog-hint',
  'models-seed-notice',
  'models-seed-notice-text',
  'models-seed-notice-items',
  'models-seed-notice-apply',
  'models-seed-notice-dismiss',
  'models-seed-notice-said',
  'models-ladder-list',
  'models-save-ladder',
  'models-ladder-said',
  'models-add-id',
  'models-add-label',
  'models-add-provider',
  'models-add-agentmodel',
  'models-add-source',
  'models-add-summary',
  'models-add-row',
  'models-add-said',
  'models-active',
  'models-active-hint',
  'models-save-config',
  'models-config-said',
  'models-measurements',
]

test('config.html: every Models control id exists exactly once', () => {
  for (const id of EXPECTED_IDS) {
    const occurrences = configHtml.split(`id="${id}"`).length - 1
    assert.equal(occurrences, 1, `expected exactly one element with id="${id}", found ${occurrences}`)
  }
})

// ---------------------------------------------------------------------------
// Storage keys, verbatim -- the contract given in
// odd/tasks/model-reclassification.md, matching adapters/orca/
// models-worker.mjs's own exported constants.
// ---------------------------------------------------------------------------

const STORAGE_KEYS = [
  'models',
  'modelsConfig',
  'modelsMirrorRequest',
  'modelsSeedNotice',
  'modelsSeedRequest',
  'modelsSeedResult',
  'modelMeasurements',
]

test('config.html: every model storage key from models-worker.mjs is referenced verbatim', () => {
  for (const key of STORAGE_KEYS) {
    assert.ok(configHtml.includes(`'${key}'`), `storage key '${key}' is never referenced`)
  }
})

// ---------------------------------------------------------------------------
// i18n: every models.* / integration.agentModelHook* key used by the panel
// must exist in BOTH catalogs (es, en) -- the same discipline
// config_html_mod_skills.test.mjs and panels.spec.mjs's own
// "every policies.* key in one language catalog exists in the other" test
// apply to their own sections.
// ---------------------------------------------------------------------------

function usedI18nKeys (html, prefix) {
  const keys = new Set()
  const dataI18nRe = /data-i18n(?:-placeholder)?="([^"]+)"/g
  let m
  while ((m = dataI18nRe.exec(html))) {
    if (m[1].indexOf(prefix) === 0) keys.add(m[1])
  }
  const tCallRe = /\bt\(\s*'([^']+)'/g
  while ((m = tCallRe.exec(html))) {
    if (m[1].indexOf(prefix) === 0) keys.add(m[1])
  }
  return [...keys]
}

function catalogBlock (html, locale) {
  const re = new RegExp(`${locale}:\\s*\\{([\\s\\S]*?)\\n {8}\\}`)
  const match = html.match(re)
  assert.ok(match, `CATALOG.${locale} block not found`)
  return match[1]
}

test('config.html: every models.* key used by the panel is defined in both catalogs', () => {
  const used = usedI18nKeys(configHtml, 'models.')
  assert.ok(used.length > 10, `expected the Models section to use several i18n keys, found ${used.length}`)
  const es = catalogBlock(configHtml, 'es')
  const en = catalogBlock(configHtml, 'en')
  const missingEs = used.filter((key) => !es.includes(`'${key}':`))
  const missingEn = used.filter((key) => !en.includes(`'${key}':`))
  assert.deepEqual(missingEs, [], `models.* keys missing from the es catalog: ${missingEs.join(', ')}`)
  assert.deepEqual(missingEn, [], `models.* keys missing from the en catalog: ${missingEn.join(', ')}`)
})

test('config.html: every integration.agentModelHook* key used by the panel is defined in both catalogs', () => {
  const used = usedI18nKeys(configHtml, 'integration.agentModelHook')
  assert.ok(used.length >= 1, 'expected at least one integration.agentModelHook* key')
  const es = catalogBlock(configHtml, 'es')
  const en = catalogBlock(configHtml, 'en')
  const missingEs = used.filter((key) => !es.includes(`'${key}':`))
  const missingEn = used.filter((key) => !en.includes(`'${key}':`))
  assert.deepEqual(missingEs, [], `integration.agentModelHook* keys missing from the es catalog: ${missingEs.join(', ')}`)
  assert.deepEqual(missingEn, [], `integration.agentModelHook* keys missing from the en catalog: ${missingEn.join(', ')}`)
})

// ---------------------------------------------------------------------------
// The integration-list change: exactly one added line, guarded on the field
// existing (odd/tasks/model-reclassification.md: "only when the field
// exists").
// ---------------------------------------------------------------------------

test('config.html: renderClaudeIntegrationStatus renders the agentModelHook line only when the field exists', () => {
  const match = configHtml.match(/function renderClaudeIntegrationStatus \([\s\S]*?\n {6}\}/)
  assert.ok(match, 'renderClaudeIntegrationStatus not found -- update this test if it moved')
  assert.match(match[0], /status\.agentModelHook/, 'must read status.agentModelHook')
})

// ---------------------------------------------------------------------------
// Pure helpers extracted and run for real (the modSkillsLine trick from
// config_html_mod_skills.test.mjs), so the ladder reorder/row-building
// logic is checked as behavior, not just as text.
// ---------------------------------------------------------------------------

/** Extracts a named function's FULL source (signature + body) by
 *  brace-matching from its opening `{`. Unlike config_html_mod_skills.test
 *  .mjs's own `functionBody` helper (which returns only the body, for a
 *  test that just greps it), this needs to re-evaluate the function for
 *  real, so it keeps the parameter list. */
function extractFunction (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  assert.ok(startMatch, `function ${name} not found -- update this test if it moved or was renamed`)
  const start = startMatch.index
  let depth = 0
  let i = start + startMatch[0].length - 1
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

function loadModelsReorder () {
  const src = extractFunction(configHtml, 'modelsReorder')
  const factory = new Function(`${src}; return modelsReorder`)
  return factory()
}

function row (id, rank) {
  return { id: id, provider: 'anthropic', label: id, rank: rank, agentModel: id, source: '', available: true }
}

test('modelsReorder: swaps two ranked rows and keeps ranks 1..n', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', 1), row('b', 2), row('c', 3)]
  const result = modelsReorder(display, 1, 'up')
  assert.deepEqual(result.map((r) => r.id), ['b', 'a', 'c'])
  assert.deepEqual(result.map((r) => r.rank), [1, 2, 3])
})

test('modelsReorder: moving the top ranked row up is a no-op', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', 1), row('b', 2)]
  const result = modelsReorder(display, 0, 'up')
  assert.deepEqual(result.map((r) => r.id), ['a', 'b'])
})

test('modelsReorder: moving the last ranked row down is a no-op -- "mark unranked" is the only way out', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', 1), row('b', 2), row('c', null)]
  const result = modelsReorder(display, 1, 'down')
  assert.deepEqual(result.map((r) => r.id), ['a', 'b', 'c'])
  assert.deepEqual(result.map((r) => r.rank), [1, 2, null])
})

test('modelsReorder: moving the first unranked row up promotes it, demoting the previously-last-ranked row', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', 1), row('b', 2), row('c', null), row('d', null)]
  const result = modelsReorder(display, 2, 'up')
  assert.deepEqual(result.map((r) => r.id), ['a', 'c', 'b', 'd'])
  assert.deepEqual(result.map((r) => r.rank), [1, 2, null, null])
})

test('modelsReorder: moving the only unranked row up when nothing is ranked gives it rank 1', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', null), row('b', null)]
  const result = modelsReorder(display, 0, 'up')
  assert.deepEqual(result.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(result.map((r) => r.rank), [1, null])
})

test('modelsReorder: reordering two unranked rows never assigns a rank', () => {
  const modelsReorder = loadModelsReorder()
  const display = [row('a', 1), row('b', null), row('c', null)]
  const result = modelsReorder(display, 2, 'up')
  assert.deepEqual(result.map((r) => r.id), ['a', 'c', 'b'])
  assert.deepEqual(result.map((r) => r.rank), [1, null, null])
})

function loadModelsBuildRow () {
  const src = extractFunction(configHtml, 'modelsBuildRow')
  const factory = new Function(`${src}; return modelsBuildRow`)
  return factory()
}

test('modelsBuildRow: produces a row that satisfies isModelEntry exactly, so the worker never silently drops it', () => {
  const modelsBuildRow = loadModelsBuildRow()
  const full = modelsBuildRow({
    id: 'x', label: 'X', provider: 'anthropic', agentModel: 'sonnet',
    source: 'https://example.test', summary: 'a summary', rank: null, available: false,
  })
  assert.ok(isModelEntry(full), `row is not a valid ModelEntry: ${JSON.stringify(full)}`)

  const minimal = modelsBuildRow({
    id: 'y', label: 'Y', provider: 'anthropic', agentModel: 'haiku',
    source: '', summary: '', rank: null, available: false,
  })
  assert.ok(isModelEntry(minimal), `row with blank optional fields is not a valid ModelEntry: ${JSON.stringify(minimal)}`)
  assert.equal('summary' in minimal, false, 'a blank summary must be omitted, never sent as an empty string or undefined')
})

function loadModelsSplitLadder () {
  const src = extractFunction(configHtml, 'modelsSplitLadder')
  const factory = new Function(`${src}; return modelsSplitLadder`)
  return factory()
}

test('modelsSplitLadder: ranked entries first (by rank ascending), then unranked in stored order -- same rule as orderedLadder', () => {
  const modelsSplitLadder = loadModelsSplitLadder()
  const entries = [row('unranked-1', null), row('c', 3), row('a', 1), row('unranked-2', null), row('b', 2)]
  const display = modelsSplitLadder(entries)
  assert.deepEqual(display.map((r) => r.id), ['a', 'b', 'c', 'unranked-1', 'unranked-2'])
})
