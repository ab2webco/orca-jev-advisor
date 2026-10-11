// feature-modules T4 -- write-secret-mirror.mjs's `feature-modules-read`
// mode, spawned the way main.mjs spawns its read-only modes (a clean child,
// real fs), against a real temp config dir. It is the worker's one read of
// `<configDir>/feature-modules.json` at activation (the worker's own sandbox
// cannot read the config dir); the parsing is src/core/feature_modules.ts's,
// covered on its own, so this only proves the I/O around it. T5 adds
// `feature-modules-save`, the one writer of that file (the panel asks, the
// worker spawns this mode): atomic, and a corrupt request is refused.
//
// Same fixture discipline as the sibling write-secret-mirror tests: an
// isolated mkdtemp HOME and an explicit ORCA_SUPERVISOR_CONFIG_DIR.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'write-secret-mirror.mjs')

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

function readModules (content) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-feature-modules-read-'))
  temps.push(home)
  const configDir = join(home, '.config', 'orca-supervisor')
  if (content !== undefined) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'feature-modules.json'), content)
  }
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: configDir }
  delete env.XDG_CONFIG_HOME
  return JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH, 'feature-modules-read'], { env, encoding: 'utf8' }))
}

// Every module that existed before 0.8.0 defaults to active; verify-done, new, to shadow.
const DEFAULTS = { gate: 'active', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active', 'verify-done': 'shadow' }

test('feature-modules-read: a missing file reads as the defaults', () => {
  assert.deepEqual(readModules(undefined), { ok: true, value: DEFAULTS })
})

test('feature-modules-read: the states in the file come back', () => {
  const result = readModules(JSON.stringify({ modules: { gate: 'off', 'model-router': 'shadow', board: 'off' } }))
  assert.deepEqual(result, { ok: true, value: { ...DEFAULTS, gate: 'off', 'model-router': 'shadow', board: 'off' } })
})

test('feature-modules-read: a corrupt file reads as the defaults', () => {
  assert.deepEqual(readModules('{ not json'), { ok: true, value: DEFAULTS })
})

// ---------------------------------------------------------------------------
// feature-modules-save (T5)
// ---------------------------------------------------------------------------

/** Runs `mode` against a throwaway config dir holding `existing` (when given), with `input` on stdin. */
function runMode (mode, { input, existing } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-feature-modules-save-'))
  temps.push(home)
  const configDir = join(home, '.config', 'orca-supervisor')
  const file = join(configDir, 'feature-modules.json')
  if (existing !== undefined) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(file, existing)
  }
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: configDir }
  delete env.XDG_CONFIG_HOME
  const result = JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH, mode], { env, encoding: 'utf8', input }))
  return { result, file, configDir, content: existsSync(file) ? readFileSync(file, 'utf8') : null }
}

const CHOSEN = { gate: 'off', 'model-router': 'shadow', steward: 'active', 'skill-selection': 'shadow', board: 'off', 'verify-done': 'off' }

test('feature-modules-save: writes the chosen states, pretty-printed, and answers with them', () => {
  const { result, content, configDir } = runMode('feature-modules-save', { input: JSON.stringify({ modules: CHOSEN }) })
  assert.deepEqual(result, { ok: true, value: CHOSEN })
  assert.deepEqual(JSON.parse(content), { modules: CHOSEN })
  assert.match(content, /\n {2}"modules"/, 'pretty-printed like the other mirrors')
  assert.deepEqual(readdirSync(configDir), ['feature-modules.json'], 'the temp file of the atomic write is gone')
})

test('feature-modules-save: replaces a previous file whole, and feature-modules-read then agrees', () => {
  const { content } = runMode('feature-modules-save', {
    existing: JSON.stringify({ modules: { gate: 'off' } }),
    input: JSON.stringify({ modules: { ...DEFAULTS, steward: 'off' } })
  })
  assert.deepEqual(JSON.parse(content), { modules: { ...DEFAULTS, steward: 'off' } })
  assert.deepEqual(readModules(content), { ok: true, value: { ...DEFAULTS, steward: 'off' } })
})

for (const [name, input] of [
  ['input that is not JSON', '{ not json'],
  ['an empty request', ''],
  ['a map missing a module', JSON.stringify({ modules: { gate: 'off' } })],
  ['a state the module does not offer', JSON.stringify({ modules: { ...DEFAULTS, gate: 'shadow' } })],
  ['active for a module that only measures', JSON.stringify({ modules: { ...DEFAULTS, 'verify-done': 'active' } })],
  ['an unknown module', JSON.stringify({ modules: { ...DEFAULTS, unknown: 'off' } })],
  ['modules of the wrong type', JSON.stringify({ modules: 'off' })]
]) {
  test(`feature-modules-save: refuses ${name} and leaves the file as it was`, () => {
    const before = JSON.stringify({ modules: { ...DEFAULTS, board: 'off' } })
    const { result, content, configDir } = runMode('feature-modules-save', { existing: before, input })
    assert.equal(result.ok, false)
    assert.match(result.reason, /^invalid-(json|shape)$/)
    assert.equal(typeof result.detail, 'string')
    assert.equal(content, before)
    assert.deepEqual(readdirSync(configDir), ['feature-modules.json'], 'no half-written temp file')
  })
}

test('feature-modules-save: a refused request creates no file where there was none', () => {
  const { result, content } = runMode('feature-modules-save', { input: '{ not json' })
  assert.equal(result.ok, false)
  assert.equal(content, null)
})

// ---------------------------------------------------------------------------
// 0.8.0 V4: the real panel and the real writer agree. The panel keeps its own
// module list (config.html MODULE_ROWS) and sends the whole map on every
// switch; the sidecar refuses a map missing a module. A fake worker in
// scripts/panels.spec.mjs cannot see that gap, so the map the panel builds,
// for every state its cards offer, goes through this real sidecar here.
// ---------------------------------------------------------------------------

/** config.html's MODULE_ROWS, read from its source: each card's id and the states it offers. */
function panelModuleRows () {
  const html = readFileSync(join(__dirname, 'panels', 'config.html'), 'utf8')
  return [...html.matchAll(/\{ id: '([\w-]+)', states: \[([^\]]*)\], cost:/g)].map((match) => ({ id: match[1], states: [...match[2].matchAll(/'([\w-]+)'/g)].map((state) => state[1]) }))
}

test('the panel offers a card for every registered module, with exactly the states the registry allows', async () => {
  const { FEATURE_MODULES } = await import('../../src/core/feature_modules.ts')
  assert.deepEqual(panelModuleRows(), FEATURE_MODULES.map((module) => ({ id: module.id, states: [...module.states] })))
})

test('feature-modules-save: the map the panel sends, for every state its cards offer, is accepted by the real sidecar', () => {
  const rows = panelModuleRows()
  // What the panel holds when nothing was chosen yet: each card at the state the status reports, the defaults.
  const shown = Object.fromEntries(rows.map((row) => [row.id, DEFAULTS[row.id]]))
  for (const row of rows) {
    for (const state of row.states) {
      const next = { ...shown, [row.id]: state }
      const { result } = runMode('feature-modules-save', { input: JSON.stringify({ modules: next }) })
      assert.deepEqual(result, { ok: true, value: next }, `${row.id} ${state}`)
    }
  }
})
