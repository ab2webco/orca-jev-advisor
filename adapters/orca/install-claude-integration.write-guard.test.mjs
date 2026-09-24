// Proves the fix for the fourth real-file incident: a `node --test` run
// wiped every gate hook entry out of settings.json in all five real Claude
// config roots on the developer's machine, silently, with zero error
// output. install-claude-integration.test.mjs already overrides HOME for
// every process it spawns, so it could never have caught this -- the wipe
// happened through a path where nothing overrides HOME at all (main.mjs
// resolves it from the real os.homedir() and forwards the real
// process.env, unmodified, to this exact script via sidecarEnv). This file
// exercises that unprotected path directly: it spawns the real installer,
// under `node --test`, against a HOME that looks like a real one and is
// NOT isolated inside the OS temp directory, and proves the write is now
// refused instead of silently succeeding.
//
// The fabricated HOME lives inside this checkout (never a real user's
// actual home, never a random top-level path) specifically so that even a
// broken guard could only ever write inside a directory this test already
// owns and deletes -- see the module doc on src/core/write_guard.ts for the
// full guarantee this relies on.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')
const SCRIPT_PATH = join(__dirname, 'install-claude-integration.mjs')

// Deliberately NOT under os.tmpdir(): that is precisely the condition the
// guard exists to refuse. It IS inside this checkout, so even a broken
// guard can only ever touch a directory this test created and deletes.
const FAKE_REAL_HOME = join(PLUGIN_ROOT, '.orca-jev-write-guard-fixture-home')
const FAKE_SETTINGS_PATH = join(FAKE_REAL_HOME, '.claude', 'settings.json')

function resetFixture () {
  rmSync(FAKE_REAL_HOME, { recursive: true, force: true })
}

before(resetFixture)
after(resetFixture)

function runInstallAgainst (home) {
  const env = { ...process.env, HOME: home }
  delete env.ORCA_USER_DATA_PATH
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, 'install', PLUGIN_ROOT], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

test('refuses to install against a real-looking, non-isolated HOME under the test runner', () => {
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'fixture must not pre-exist')

  const result = runInstallAgainst(FAKE_REAL_HOME)

  assert.equal(result.ok, false, `expected the write guard to refuse the install, got: ${JSON.stringify(result)}`)
  assert.equal(result.reason, 'exception')
  assert.match(result.detail, /write guard/i)
  assert.match(result.detail, /refusing to write/i)

  // The strongest assertion: not merely that the JSON says "no", but that
  // nothing was actually written to the fabricated real-looking home.
  assert.equal(existsSync(FAKE_SETTINGS_PATH), false, 'the guard must fire before any file is created')
  assert.equal(existsSync(FAKE_REAL_HOME), false, 'the guard must fire before even the directory is created')
})

test('still installs normally against an isolated (mkdtemp-style) HOME', () => {
  // Sanity check in the other direction: the guard must not turn into a
  // blanket "no writes under test" -- install-claude-integration.test.mjs's
  // entire suite depends on writes succeeding against a temp HOME.
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-jev-write-guard-sanity-'))
  try {
    const result = runInstallAgainst(tempHome)
    assert.equal(result.ok, true, `expected a normal install to succeed, got: ${JSON.stringify(result)}`)
    const settings = JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf8'))
    assert.ok(settings.hooks, 'a real install must still write hooks under an isolated HOME')
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
