// odd/tasks/tool-selection-off.md, T3 -- write-secret-mirror.mjs's
// `mod-skills-config-save` and `mod-skills-config-read` modes, spawned the
// way main.mjs spawns them (a clean child, real fs), against a real temp
// config dir. The parsing is src/core/mod_skills_config.ts's, covered on its
// own; this proves the I/O around it: the three-way `toolsMode` lands on disk
// and comes back, and a legacy `activeTools` file (what every install wrote
// before this) keeps its choice on read.
//
// Same fixture discipline as the sibling write-secret-mirror tests: an
// isolated mkdtemp HOME and an explicit ORCA_SUPERVISOR_CONFIG_DIR.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'write-secret-mirror.mjs')

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

/** Runs `mode` against a throwaway config dir holding `existing` (when given), with `input` on stdin. */
function runMode (mode, { input, existing } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-mod-skills-config-'))
  temps.push(home)
  const configDir = join(home, '.config', 'orca-supervisor')
  const file = join(configDir, 'mod-skills-config.json')
  if (existing !== undefined) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(file, existing)
  }
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: configDir }
  delete env.XDG_CONFIG_HOME
  const result = JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH, mode], { env, encoding: 'utf8', input }))
  return { result, content: existsSync(file) ? readFileSync(file, 'utf8') : null }
}

test('mod-skills-config-read: a missing file reads as skills measurement and tools off', () => {
  assert.deepEqual(runMode('mod-skills-config-read').result, { ok: true, value: { active: false, toolsMode: 'off' } })
})

test('mod-skills-config-read: a legacy activeTools file keeps its choice (true active, false measure)', () => {
  assert.deepEqual(runMode('mod-skills-config-read', { existing: '{"active":true,"activeTools":true}' }).result, { ok: true, value: { active: true, toolsMode: 'active' } })
  assert.deepEqual(runMode('mod-skills-config-read', { existing: '{"active":false,"activeTools":false}' }).result, { ok: true, value: { active: false, toolsMode: 'measure' } })
})

test('mod-skills-config-save: writes toolsMode, drops the legacy boolean, and reads back the same', () => {
  const { result, content } = runMode('mod-skills-config-save', { input: JSON.stringify({ active: true, toolsMode: 'off' }), existing: '{"active":true,"activeTools":true}' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(JSON.parse(content), { active: true, toolsMode: 'off' })
})

test('mod-skills-config-save: an unknown toolsMode is written as off, never passed through raw', () => {
  const { content } = runMode('mod-skills-config-save', { input: JSON.stringify({ active: false, toolsMode: 'on' }) })
  assert.deepEqual(JSON.parse(content), { active: false, toolsMode: 'off' })
})
