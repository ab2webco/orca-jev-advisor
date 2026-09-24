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

function runMirrorAgainst (home, mode, stdinContent, extraEnv = {}) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  // Deliberately deleted (not merely left unset from the parent shell)
  // before applying `extraEnv`: the "refuses..." test below relies on this
  // being absent so resolveConfigDir has nothing to fall back on, while the
  // sanity test passes it explicitly through `extraEnv`.
  delete env.ORCA_SUPERVISOR_CONFIG_DIR
  Object.assign(env, extraEnv)
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, mode], { env, encoding: 'utf8', input: stdinContent })
  return JSON.parse(stdout)
}

test('refuses catalog-save against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')

  const result = runMirrorAgainst(FAKE_REAL_HOME, 'catalog-save', JSON.stringify({ destinations: [] }))

  // The refusal now fires one layer earlier than it used to: src/core/
  // paths.ts's resolveConfigDir itself refuses to hand back a real path at
  // all under node's test runner unless ORCA_SUPERVISOR_CONFIG_DIR is set
  // (see that module's doc) -- write-secret-mirror.mjs never even reaches
  // guarded_fs.ts's per-write check below, because it never gets a real
  // CONFIG_DIR to write into in the first place. Still reported through
  // the exact same `{ok:false, reason:'exception', detail}` contract as
  // any other failure (see write-secret-mirror.mjs's module-scope try/catch
  // around its path resolution).
  assert.equal(result.ok, false, `expected the paths guard to refuse catalog-save, got: ${JSON.stringify(result)}`)
  assert.equal(result.reason, 'exception')
  assert.match(result.detail, /paths guard/i)
  assert.match(result.detail, /refused to hand back/i)
  assert.equal(existsSync(FAKE_CATALOG_PATH), false, 'the guard must fire before any file is created')
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('still saves normally against an isolated (mkdtemp-style) HOME', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-mirror-sanity-'))
  try {
    const result = runMirrorAgainst(tempHome, 'catalog-save', JSON.stringify({ destinations: [] }), {
      // resolveConfigDir refuses to compute a real path at all under node's
      // test runner unless an explicit override is set (see src/core/
      // paths.ts's module doc) -- a temp HOME alone is no longer enough by
      // itself. This points it at exactly what it would have computed for
      // `tempHome` on darwin with no XDG override.
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, true, `expected a normal catalog-save to succeed, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'catalog.json'), 'utf8'))
    assert.deepEqual(written, { destinations: [] })
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
