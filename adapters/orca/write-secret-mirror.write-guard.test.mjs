// Proves the fix for the same class of incident that has already corrupted
// catalog.json and policies.json twice: this sidecar resolves its own
// CONFIG_DIR from the real os.homedir() at module load, and main.mjs's
// `mirrorCatalogAndPolicies` spawns it for real with the real process.env
// forwarded unmodified (sidecarEnv). No dedicated test file exercised this
// script directly before this one -- see write_guard.ts's module doc for
// the full incident history this guards against.
//
// Same fixture discipline as install-claude-integration.write-guard.test.mjs:
// the fabricated HOME lives inside this checkout, never a random top-level
// path and never a real user's actual home, so even a broken guard could
// only ever write inside a directory this test owns and deletes.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')
const SCRIPT_PATH = join(__dirname, 'write-secret-mirror.mjs')

const FAKE_REAL_HOME = join(PLUGIN_ROOT, '.orca-jev-write-guard-fixture-mirror-home')
const FAKE_CATALOG_PATH = join(FAKE_REAL_HOME, '.config', 'orca-supervisor', 'catalog.json')

function resetFixture () {
  rmSync(FAKE_REAL_HOME, { recursive: true, force: true })
}

before(resetFixture)
after(resetFixture)

function runMirrorAgainst (home, mode, stdinContent) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, mode], { env, encoding: 'utf8', input: stdinContent })
  return JSON.parse(stdout)
}

test('refuses catalog-save against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')

  const result = runMirrorAgainst(FAKE_REAL_HOME, 'catalog-save', JSON.stringify({ destinations: [] }))

  assert.equal(result.ok, false, `expected the write guard to refuse catalog-save, got: ${JSON.stringify(result)}`)
  assert.equal(result.reason, 'exception')
  assert.match(result.detail, /write guard/i)
  assert.match(result.detail, /refusing to write/i)
  assert.equal(existsSync(FAKE_CATALOG_PATH), false, 'the guard must fire before any file is created')
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('still saves normally against an isolated (mkdtemp-style) HOME', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-mirror-sanity-'))
  try {
    const result = runMirrorAgainst(tempHome, 'catalog-save', JSON.stringify({ destinations: [] }))
    assert.equal(result.ok, true, `expected a normal catalog-save to succeed, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'catalog.json'), 'utf8'))
    assert.deepEqual(written, { destinations: [] })
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
