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
// The model catalog mirror (models-worker.mjs's mirrorModels) is written by
// this same script, through the same CONFIG_DIR resolution -- the same
// incident class applies to it as to catalog.json/policies.json above.
const FAKE_MODELS_PATH = join(FAKE_REAL_HOME, '.config', 'orca-supervisor', 'models-catalog.json')
// The account quota mirror (JEV-060 slice 1, main.mjs's mirrorAccountQuota)
// is written by this same script, through the same CONFIG_DIR resolution --
// the same incident class applies to it as to the two paths above.
const FAKE_QUOTA_PATH = join(FAKE_REAL_HOME, '.config', 'orca-supervisor', 'quota.json')

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

test('refuses models-save against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')

  const result = runMirrorAgainst(FAKE_REAL_HOME, 'models-save', JSON.stringify({ active: false, ready: false, models: [] }))

  // Same guard, same reason -- see the catalog-save test above for why this
  // fires one layer earlier than a per-write check.
  assert.equal(result.ok, false, `expected the paths guard to refuse models-save, got: ${JSON.stringify(result)}`)
  assert.equal(result.reason, 'exception')
  assert.match(result.detail, /paths guard/i)
  assert.match(result.detail, /refused to hand back/i)
  assert.equal(existsSync(FAKE_MODELS_PATH), false, 'the guard must fire before any file is created')
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('models-save still saves normally against an isolated (mkdtemp-style) HOME', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-models-sanity-'))
  try {
    const payload = { active: true, ready: false, models: [] }
    const result = runMirrorAgainst(tempHome, 'models-save', JSON.stringify(payload), {
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, true, `expected a normal models-save to succeed, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'models-catalog.json'), 'utf8'))
    assert.deepEqual(written, payload)
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('models-save rejects a payload that is not {active: boolean, ready: boolean, models: array}', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-models-shape-'))
  try {
    const result = runMirrorAgainst(tempHome, 'models-save', JSON.stringify({ active: 'yes', ready: false, models: [] }), {
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-shape')
    assert.equal(existsSync(join(tempHome, '.config', 'orca-supervisor', 'models-catalog.json')), false)
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('refuses quota-save against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')

  const result = runMirrorAgainst(FAKE_REAL_HOME, 'quota-save', JSON.stringify({ accounts: [], checkedAt: new Date().toISOString() }))

  // Same guard, same reason -- see the catalog-save test above for why this
  // fires one layer earlier than a per-write check.
  assert.equal(result.ok, false, `expected the paths guard to refuse quota-save, got: ${JSON.stringify(result)}`)
  assert.equal(result.reason, 'exception')
  assert.match(result.detail, /paths guard/i)
  assert.match(result.detail, /refused to hand back/i)
  assert.equal(existsSync(FAKE_QUOTA_PATH), false, 'the guard must fire before any file is created')
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('quota-save still saves normally against an isolated (mkdtemp-style) HOME', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-quota-sanity-'))
  try {
    const payload = { accounts: [{ id: 'a1', status: 'ok', sessionUsedPercent: 2, weeklyUsedPercent: 55, resetsAt: 1790568000000 }], checkedAt: '2026-09-26T00:00:00.000Z' }
    const result = runMirrorAgainst(tempHome, 'quota-save', JSON.stringify(payload), {
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, true, `expected a normal quota-save to succeed, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'quota.json'), 'utf8'))
    assert.deepEqual(written, payload)
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

// 0.6.7 T1: the team repositories setting reaches the gate through this same
// script -- team-owners.json, next to catalog.json/policies.json.
test('refuses team-owners-save against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')
  const result = runMirrorAgainst(FAKE_REAL_HOME, 'team-owners-save', JSON.stringify(['acme-team']))
  assert.equal(result.ok, false, `expected the paths guard to refuse team-owners-save, got: ${JSON.stringify(result)}`)
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('team-owners-save writes the normalized owners, never a raw echo of the payload', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-team-owners-'))
  try {
    const result = runMirrorAgainst(tempHome, 'team-owners-save', JSON.stringify(['Acme-Team', '', 'not valid', '@acme-tools', 'acme-team']), {
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, true, `expected a normal team-owners-save to succeed, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'team-owners.json'), 'utf8'))
    assert.deepEqual(written, ['acme-team', 'acme-tools'])
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('team-owners-save writes an empty list for a payload that is not an array of owners', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-team-owners-bad-'))
  try {
    const result = runMirrorAgainst(tempHome, 'team-owners-save', '{not json', {
      ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor'),
    })
    assert.equal(result.ok, true, `expected team-owners-save to normalize, not fail, got: ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(tempHome, '.config', 'orca-supervisor', 'team-owners.json'), 'utf8'))
    assert.deepEqual(written, [])
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

// 0.6.7 T4: queue mode reaches the gate through this same script.
test('queue-mode-save writes the normalized setting, and anything malformed as "ask now"', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-queue-mode-'))
  try {
    const env = { ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor') }
    const path = join(tempHome, '.config', 'orca-supervisor', 'queue-mode.json')
    assert.equal(runMirrorAgainst(tempHome, 'queue-mode-save', JSON.stringify({ enabled: true, extra: 'x' }), env).ok, true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: true })
    assert.equal(runMirrorAgainst(tempHome, 'queue-mode-save', '{not json', env).ok, true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: false })
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

// 0.6.7 T7: the explicit models setting reaches the hooks through this script.
test('explicit-models-save writes the normalized mode, and anything malformed as judge', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-explicit-models-'))
  try {
    const env = { ORCA_SUPERVISOR_CONFIG_DIR: join(tempHome, '.config', 'orca-supervisor') }
    const path = join(tempHome, '.config', 'orca-supervisor', 'explicit-models.json')
    assert.equal(runMirrorAgainst(tempHome, 'explicit-models-save', JSON.stringify({ mode: 'keep', extra: 1 }), env).ok, true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'keep' })
    assert.equal(runMirrorAgainst(tempHome, 'explicit-models-save', '{not json', env).ok, true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mode: 'judge' })
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
