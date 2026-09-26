// odd/tasks/release-0.5.1.md JEVADV-10 -- the one piece of this fix that
// needs a real file: write-secret-mirror.mjs's `orca-ui-language-read` mode,
// spawned exactly the way main.mjs spawns it (a clean child, real fs), read
// against real temp files. src/core/orca_ui_language.test.ts already covers
// parseOrcaUiLanguage's own logic against plain strings; this only proves
// the I/O around it -- ENOENT, a real read -- reaches that same function.
//
// Same fixture discipline as write-secret-mirror.write-guard.test.mjs: an
// isolated mkdtemp HOME plus an explicit ORCA_SUPERVISOR_CONFIG_DIR
// override, since resolveConfigDir (src/core/paths.ts) refuses to hand back
// a real path at all under node's test runner otherwise -- even though this
// mode never touches CONFIG_DIR, main()'s own module-scope path resolution
// runs unconditionally before dispatching on mode.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'write-secret-mirror.mjs')

const temps = []
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }) })

function tempDir () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-ui-language-read-'))
  temps.push(dir)
  return dir
}

function runOrcaUiLanguageRead (orcaDataPath, home) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, 'orca-ui-language-read', orcaDataPath], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

test('orca-ui-language-read: a concrete es setting reads back as es', () => {
  const home = tempDir()
  const orcaDataPath = join(home, 'orca-data.json')
  writeFileSync(orcaDataPath, JSON.stringify({ settings: { uiLanguage: 'es' } }))
  const result = runOrcaUiLanguageRead(orcaDataPath, home)
  assert.equal(result.ok, true)
  assert.equal(result.value, 'es')
})

test('orca-ui-language-read: a concrete en setting reads back as en', () => {
  const home = tempDir()
  const orcaDataPath = join(home, 'orca-data.json')
  writeFileSync(orcaDataPath, JSON.stringify({ settings: { uiLanguage: 'en' } }))
  const result = runOrcaUiLanguageRead(orcaDataPath, home)
  assert.equal(result.ok, true)
  assert.equal(result.value, 'en')
})

test('orca-ui-language-read: "system" reads back as null, deferring', () => {
  const home = tempDir()
  const orcaDataPath = join(home, 'orca-data.json')
  writeFileSync(orcaDataPath, JSON.stringify({ settings: { uiLanguage: 'system' } }))
  const result = runOrcaUiLanguageRead(orcaDataPath, home)
  assert.equal(result.ok, true)
  assert.equal(result.value, null)
})

test('orca-ui-language-read: a missing file reads back as null, never as an error', () => {
  const home = tempDir()
  const orcaDataPath = join(home, 'orca-data.json')
  const result = runOrcaUiLanguageRead(orcaDataPath, home)
  assert.equal(result.ok, true, `a missing file must not be reported as a failure: ${JSON.stringify(result)}`)
  assert.equal(result.value, null)
})

test('orca-ui-language-read: malformed JSON reads back as null, never as an error', () => {
  const home = tempDir()
  const orcaDataPath = join(home, 'orca-data.json')
  writeFileSync(orcaDataPath, '{not json')
  const result = runOrcaUiLanguageRead(orcaDataPath, home)
  assert.equal(result.ok, true, `malformed JSON must not be reported as a failure: ${JSON.stringify(result)}`)
  assert.equal(result.value, null)
})
