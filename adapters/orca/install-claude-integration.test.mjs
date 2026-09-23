// Exercises install-claude-integration.mjs as the CLI it actually is (it
// runs `main()` unconditionally at import, so it is only testable as a
// subprocess) against a throwaway HOME -- never the real one. Each test
// gets its own temp directory so runs never interfere with each other or
// with a real machine's ~/.claude.
//
// Focus: the per-event ("PreToolUse", "PostToolUse", "PermissionDenied")
// bookkeeping this change adds. In particular, that uninstall restores
// byte-identical settings.json, and that it removes only the containers
// THIS installer created -- never one that already existed, even an event
// array or `Bash` group that ends up empty once our own entry is gone.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')
const SCRIPT_PATH = join(__dirname, 'install-claude-integration.mjs')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-installer-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function settingsPathFor (home) {
  return join(home, '.claude', 'settings.json')
}

/** Runs the installer against a throwaway HOME, with no ORCA_USER_DATA_PATH
 *  -- so `discoverTargets()` finds no Orca accounts and the only target is
 *  `home`, which is all these tests need to exercise the bookkeeping. */
function run (mode, home) {
  const env = { ...process.env, HOME: home }
  delete env.ORCA_USER_DATA_PATH
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, mode, PLUGIN_ROOT], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

function readSettings (home) {
  return JSON.parse(readFileSync(settingsPathFor(home), 'utf8'))
}

function writeSettings (home, settings) {
  mkdirSync(dirname(settingsPathFor(home)), { recursive: true })
  writeFileSync(settingsPathFor(home), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function bashGroup (settings, event) {
  return (settings.hooks?.[event] ?? []).find((g) => g.matcher === 'Bash')
}

function ownEntries (settings, event, marker) {
  return (bashGroup(settings, event)?.hooks ?? []).filter((h) => h.statusMessage === marker)
}

const GATE_MARKER = 'orca-jev-advisor: asking Jev before running this command'
const OUTCOME_MARKER = 'orca-jev-advisor: recording what you decided'

test('a fresh install registers all three events, each with its own hook', () => {
  const home = makeHome()
  const result = run('install', home)
  assert.equal(result.ok, true)
  assert.equal(result.changes.hook, true)
  assert.equal(result.changes.outcomeHook, true)

  const settings = readSettings(home)
  const gateEntries = ownEntries(settings, 'PreToolUse', GATE_MARKER)
  assert.equal(gateEntries.length, 1)
  assert.deepEqual(gateEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-bash.ts')])

  const postEntries = ownEntries(settings, 'PostToolUse', OUTCOME_MARKER)
  assert.equal(postEntries.length, 1)
  assert.deepEqual(postEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')])

  const deniedEntries = ownEntries(settings, 'PermissionDenied', OUTCOME_MARKER)
  assert.equal(deniedEntries.length, 1)
  assert.deepEqual(deniedEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')])

  // The outcome hook must never be able to delay a command it did not gate:
  // its timeout is short, and strictly shorter than the gate's own.
  assert.ok(postEntries[0].timeout < gateEntries[0].timeout)
  assert.equal(postEntries[0].timeout, deniedEntries[0].timeout)

  const status = run('status', home)
  assert.equal(status.hook.installed, true)
  assert.equal(status.outcomeHook.installed, true)
})

test('re-running install is idempotent: no duplicate entries in any of the three events', () => {
  const home = makeHome()
  run('install', home)
  run('install', home)
  run('install', home)
  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PermissionDenied', OUTCOME_MARKER).length, 1)
})

test('status reports the outcome hook installed only once BOTH PostToolUse and PermissionDenied carry it', () => {
  const home = makeHome()
  run('install', home)
  const settings = readSettings(home)
  // Simulate a user (or another tool) deleting only the PermissionDenied half.
  settings.hooks.PermissionDenied = []
  writeSettings(home, settings)
  const status = run('status', home)
  assert.equal(status.hook.installed, true, 'the gate hook is untouched')
  assert.equal(status.outcomeHook.installed, false, 'the outcome hook is incomplete without both halves')
})

test('uninstall after a fresh install restores the exact original state (the file did not exist)', () => {
  const home = makeHome()
  run('install', home)
  run('uninstall', home)
  // Nothing this installer created survives: an absent original settings.json
  // was backed up as "{}\n", and writing back an object with every one of our
  // own containers removed reproduces those exact bytes.
  const raw = readFileSync(settingsPathFor(home), 'utf8')
  assert.equal(raw, '{}\n')
})

test('uninstall removes only the containers THIS install created, leaving pre-existing ones -- even now-empty ones -- exactly as found', () => {
  const home = makeHome()
  // A shape a real user or another Claude Code plugin could plausibly leave
  // behind, deliberately different per event so each of the three
  // "existed before" facts is exercised on its own:
  //   PreToolUse       already has a Bash group, with someone else's hook.
  //   PostToolUse      already has an EMPTY array (no groups at all yet).
  //   PermissionDenied does not exist at all.
  const original = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool', args: [], statusMessage: 'someone else entirely' }] }
      ],
      PostToolUse: []
    },
    env: { SOME_OTHER_VAR: 'kept' }
  }
  writeSettings(home, original)
  const before = readFileSync(settingsPathFor(home), 'utf8')

  run('install', home)
  const afterInstall = readSettings(home)
  // The other tool's PreToolUse hook is still there, alongside ours.
  assert.equal(bashGroup(afterInstall, 'PreToolUse').hooks.length, 2)
  // PostToolUse now has our Bash group with the outcome hook.
  assert.equal(ownEntries(afterInstall, 'PostToolUse', OUTCOME_MARKER).length, 1)
  // PermissionDenied was created fresh.
  assert.equal(ownEntries(afterInstall, 'PermissionDenied', OUTCOME_MARKER).length, 1)

  run('uninstall', home)
  const afterUninstall = readSettings(home)

  // PreToolUse: our entry is gone, the other tool's survives, and the array
  // and its Bash group -- which existed before we ever ran -- are untouched.
  assert.equal(bashGroup(afterUninstall, 'PreToolUse').hooks.length, 1)
  assert.equal(bashGroup(afterUninstall, 'PreToolUse').hooks[0].statusMessage, 'someone else entirely')

  // PostToolUse: our Bash group is gone (WE created it), but the empty array
  // itself pre-existed and must survive, empty, exactly as it was.
  assert.deepEqual(afterUninstall.hooks.PostToolUse, [])

  // PermissionDenied never existed before install: uninstall must remove the
  // key entirely, not leave an empty array behind.
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.hooks, 'PermissionDenied'), false)

  // Unrelated env var: untouched throughout.
  assert.equal(afterUninstall.env.SOME_OTHER_VAR, 'kept')
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.env, 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'), false)

  assert.equal(readFileSync(settingsPathFor(home), 'utf8'), before, 'byte-identical restoration')
})

test('the "captured once" fact is never re-derived from a settings.json an install itself already reshaped', () => {
  const home = makeHome()
  run('install', home)
  // Between installs, something (a person, another tool) deletes our
  // PermissionDenied entry but leaves the array in place -- exactly the
  // shape a naive re-derivation would mistake for "this array pre-existed".
  const settings = readSettings(home)
  settings.hooks.PermissionDenied = []
  writeSettings(home, settings)

  run('install', home) // must NOT re-capture PermissionDenied's array as pre-existing
  run('uninstall', home)

  const afterUninstall = readSettings(home)
  // If the array's "existed before" flag had been wrongly re-derived as
  // true on the second install, uninstall would leave `PermissionDenied: []`
  // behind. The original capture (false, from the very first install) must
  // win, so the key is removed entirely.
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.hooks ?? {}, 'PermissionDenied'), false)
})
