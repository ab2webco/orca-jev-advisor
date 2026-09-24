// Exercises install-claude-integration.mjs as the CLI it actually is (it
// runs `main()` unconditionally at import, so it is only testable as a
// subprocess) against a throwaway HOME -- never the real one. Each test
// gets its own temp directory so runs never interfere with each other or
// with a real machine's ~/.claude.
//
// Focus: the per-event ("PreToolUse", "PostToolUse", "PostToolUseFailure",
// "PermissionDenied") bookkeeping this change adds. In particular, that
// uninstall restores byte-identical settings.json, and that it removes only
// the containers THIS installer created -- never one that already existed,
// even an event array or `Bash` group that ends up empty once our own entry
// is gone. Also: that an existing install made before PostToolUseFailure
// existed picks up the new hook on the next install, without duplicating or
// disturbing the other three.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')
const SCRIPT_PATH = join(__dirname, 'install-claude-integration.mjs')
const MOD_SOURCE = join(PLUGIN_ROOT, 'adapters', 'claude', 'mod-skills')

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

function modCopyPathFor (home) {
  return join(home, '.claude', 'skills', 'orca-jev-mod-skills')
}

function modCopyMarkerPathFor (home) {
  return join(home, '.claude', 'skills', '.orca-jev-mod-skills.source.json')
}

/** Runs the installer against a throwaway HOME, with no ORCA_USER_DATA_PATH
 *  -- so `discoverTargets()` finds no Orca accounts and the only target is
 *  `home`, which is all these tests need to exercise the bookkeeping.
 *  `pluginRoot` defaults to the real plugin root; a test that needs the
 *  skills-mod copy to fail (P5) passes a directory with no `adapters/claude/
 *  mod-skills` under it instead, which fails `cp()` the same way a real
 *  permission problem would -- no chmod gymnastics needed. */
function run (mode, home, pluginRoot = PLUGIN_ROOT) {
  const env = { ...process.env, HOME: home }
  delete env.ORCA_USER_DATA_PATH
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  // src/core/paths.ts's resolveConfigDirCandidates refuses to compute a
  // real path at all under node's test runner (see its module doc) -- this
  // points it at exactly the directory it would have computed for `home`
  // on darwin with no XDG override, matching the `stateDir` fixture below.
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, mode, pluginRoot], { env, encoding: 'utf8' })
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

test('a fresh install registers all four events, each with its own hook', () => {
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

  const postFailureEntries = ownEntries(settings, 'PostToolUseFailure', OUTCOME_MARKER)
  assert.equal(postFailureEntries.length, 1)
  assert.deepEqual(postFailureEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')])

  // The outcome hook must never be able to delay a command it did not gate:
  // its timeout is short, and strictly shorter than the gate's own.
  assert.ok(postEntries[0].timeout < gateEntries[0].timeout)
  assert.equal(postEntries[0].timeout, deniedEntries[0].timeout)
  assert.equal(postEntries[0].timeout, postFailureEntries[0].timeout)

  const status = run('status', home)
  assert.equal(status.hook.installed, true)
  assert.equal(status.outcomeHook.installed, true)
})

test('re-running install is idempotent: no duplicate entries in any of the four events', () => {
  const home = makeHome()
  run('install', home)
  run('install', home)
  run('install', home)
  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PermissionDenied', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUseFailure', OUTCOME_MARKER).length, 1)
})

test('status reports the outcome hook installed only once PostToolUse, PermissionDenied AND PostToolUseFailure all carry it', () => {
  const home = makeHome()
  run('install', home)
  const settings = readSettings(home)
  // Simulate a user (or another tool) deleting only the PermissionDenied half.
  settings.hooks.PermissionDenied = []
  writeSettings(home, settings)
  const status = run('status', home)
  assert.equal(status.hook.installed, true, 'the gate hook is untouched')
  assert.equal(status.outcomeHook.installed, false, 'the outcome hook is incomplete without all three halves')
})

test('status reports the outcome hook incomplete when only PostToolUseFailure is missing', () => {
  const home = makeHome()
  run('install', home)
  const settings = readSettings(home)
  settings.hooks.PostToolUseFailure = []
  writeSettings(home, settings)
  const status = run('status', home)
  assert.equal(status.hook.installed, true, 'the gate hook is untouched')
  assert.equal(status.outcomeHook.installed, false, 'the outcome hook is incomplete without PostToolUseFailure')
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
  // PostToolUseFailure never existed before either, and was created fresh too.
  assert.equal(ownEntries(afterInstall, 'PostToolUseFailure', OUTCOME_MARKER).length, 1)

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

  // PostToolUseFailure never existed before install either, and must be
  // removed entirely too -- reverting must never leave a hook behind that
  // points at gate-outcome.ts.
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.hooks, 'PostToolUseFailure'), false)

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

test('an existing install made before PostToolUseFailure existed gains it on the next install, without duplicating or disturbing the other three', () => {
  const home = makeHome()
  // The exact shape a real machine has after a v0.2.3 install: three events,
  // no PostToolUseFailure anywhere, plus the env var this installer sets.
  const preExisting = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-bash.ts')], timeout: 6, statusMessage: GATE_MARKER }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')], timeout: 2, statusMessage: OUTCOME_MARKER }] }],
      PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')], timeout: 2, statusMessage: OUTCOME_MARKER }] }]
    },
    env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }
  }
  writeSettings(home, preExisting)

  // The install-state a pre-change install would have written: `events`
  // only has the three keys that existed back then.
  const stateDir = join(home, '.config', 'orca-supervisor')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'claude-settings-install-state.json'), JSON.stringify({
    version: 3,
    targets: {
      home: {
        hooksObjectExistedBefore: false,
        events: {
          PreToolUse: { arrayExistedBefore: false, bashGroupExistedBefore: false },
          PostToolUse: { arrayExistedBefore: false, bashGroupExistedBefore: false },
          PermissionDenied: { arrayExistedBefore: false, bashGroupExistedBefore: false }
        },
        envObjectExistedBefore: false,
        hadEnvVarBefore: false,
        priorEnvValue: null
      }
    },
    installedAt: new Date().toISOString()
  }, null, 2), 'utf8')

  const result = run('install', home)
  assert.equal(result.ok, true)

  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1, 'the pre-existing gate hook is untouched')
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1, 'the pre-existing PostToolUse hook is untouched, not duplicated')
  assert.equal(ownEntries(settings, 'PermissionDenied', OUTCOME_MARKER).length, 1, 'the pre-existing PermissionDenied hook is untouched, not duplicated')
  assert.equal(ownEntries(settings, 'PostToolUseFailure', OUTCOME_MARKER).length, 1, 'the new hook was added')

  // Running install again must not duplicate the newly-added event either.
  run('install', home)
  const settingsAgain = readSettings(home)
  assert.equal(ownEntries(settingsAgain, 'PostToolUseFailure', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settingsAgain, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settingsAgain, 'PostToolUse', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settingsAgain, 'PermissionDenied', OUTCOME_MARKER).length, 1)

  // Reverting must remove the new hook cleanly, exactly like the other three.
  run('uninstall', home)
  const afterUninstall = readSettings(home)
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.hooks ?? {}, 'PostToolUseFailure'), false)
})

// ---------------------------------------------------------------------------
// odd/tasks/production-honesty-pass.md P4/P5 -- the skills mod is copied,
// never symlinked (Node's permission model refuses fs.symlink under a
// scoped grant on every machine this was measured on: ERR_ACCESS_DENIED,
// always, for everyone -- see this file's own module note), and a failed
// copy reaches the caller instead of being silently dropped.
// ---------------------------------------------------------------------------

test('install copies the skills mod into place -- a real directory, never a symlink', () => {
  const home = makeHome()
  const result = run('install', home)
  assert.equal(result.ok, true)
  assert.equal(result.changes.modCopy, true)

  const copyPath = modCopyPathFor(home)
  const st = lstatSync(copyPath)
  assert.equal(st.isSymbolicLink(), false, 'the mod must be a real copy, not a symlink -- symlink() is refused under a scoped grant')
  assert.equal(st.isDirectory(), true)
  // A real file from the source tree made it into the copy, byte for byte.
  const copiedContent = readFileSync(join(copyPath, 'hooks', 'hooks.json'), 'utf8')
  const sourceContent = readFileSync(join(MOD_SOURCE, 'hooks', 'hooks.json'), 'utf8')
  assert.equal(copiedContent, sourceContent)
})

test('install writes a marker recording which plugin tree the copy came from', () => {
  const home = makeHome()
  run('install', home)
  const marker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  assert.equal(marker.source, MOD_SOURCE)
})

test('re-running install with the same source is a no-op on the copy -- idempotent, no rewrite', () => {
  const home = makeHome()
  run('install', home)
  const before = statSync(join(modCopyPathFor(home), 'hooks', 'hooks.json')).mtimeMs
  const beforeChangeResult = run('install', home)
  assert.equal(beforeChangeResult.changes.modCopy, false, 'nothing changed, so this must not be reported as a change')
  const after = statSync(join(modCopyPathFor(home), 'hooks', 'hooks.json')).mtimeMs
  assert.equal(after, before, 'the file must not have been rewritten')
})

test('install replaces a stale copy left by a different plugin root -- the marker changing is the update signal', () => {
  const home = makeHome()
  // Simulate a previous install from a different (older) plugin root: a
  // copy directory with a marker that does not match this plugin root, and
  // a canary file that must not survive the refresh.
  const copyPath = modCopyPathFor(home)
  mkdirSync(copyPath, { recursive: true })
  writeFileSync(join(copyPath, 'stale-canary.txt'), 'from an old install', 'utf8')
  mkdirSync(dirname(modCopyMarkerPathFor(home)), { recursive: true })
  writeFileSync(modCopyMarkerPathFor(home), JSON.stringify({ source: '/old/plugin/root/adapters/claude/mod-skills' }), 'utf8')

  const result = run('install', home)
  assert.equal(result.changes.modCopy, true, 'a stale copy must be reported as a real change')
  assert.throws(() => statSync(join(copyPath, 'stale-canary.txt')), 'the stale copy must be replaced wholesale, not merged into')
  const marker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  assert.equal(marker.source, MOD_SOURCE)
})

test('install migrates a pre-fix symlink install to a real copy', () => {
  const home = makeHome()
  const copyPath = modCopyPathFor(home)
  mkdirSync(dirname(copyPath), { recursive: true })
  symlinkSync(MOD_SOURCE, copyPath, 'dir')
  assert.equal(lstatSync(copyPath).isSymbolicLink(), true, 'test setup: must start as a symlink')

  run('install', home)
  const st = lstatSync(copyPath)
  assert.equal(st.isSymbolicLink(), false, 'the old symlink must be replaced by a real copy')
  assert.equal(st.isDirectory(), true)
})

test('uninstall removes the copy it owns, and its marker', () => {
  const home = makeHome()
  run('install', home)
  const result = run('uninstall', home)
  assert.equal(result.changes.modCopy, true)
  assert.throws(() => lstatSync(modCopyPathFor(home)))
  assert.throws(() => lstatSync(modCopyMarkerPathFor(home)))
})

test('uninstall does not remove a directory it did not create -- checks the marker first', () => {
  const home = makeHome()
  const copyPath = modCopyPathFor(home)
  mkdirSync(copyPath, { recursive: true })
  writeFileSync(join(copyPath, 'not-ours.txt'), 'a real skill someone else installed', 'utf8')
  // No marker at all, and not a symlink pointing at our source either.

  const result = run('uninstall', home)
  assert.equal(result.changes.modCopy, false)
  assert.equal(readFileSync(join(copyPath, 'not-ours.txt'), 'utf8'), 'a real skill someone else installed', 'a foreign directory must survive untouched')
})

test('uninstall still removes a pre-fix symlink install that has no marker, by its target', () => {
  const home = makeHome()
  const copyPath = modCopyPathFor(home)
  mkdirSync(dirname(copyPath), { recursive: true })
  symlinkSync(MOD_SOURCE, copyPath, 'dir')

  const result = run('uninstall', home)
  assert.equal(result.changes.modCopy, true)
  assert.throws(() => lstatSync(copyPath))
})

test('a copy failure is reported through modCopyWarning, not swallowed -- the rest of the install still succeeds', () => {
  const home = makeHome()
  // A pluginRoot with no adapters/claude/mod-skills under it: cp() fails
  // with ENOENT, exactly the shape of a real permission failure -- the hook
  // and env-var install do not depend on the source existing, so they still
  // succeed while only the mod copy fails.
  const brokenRoot = mkdtempSync(join(tmpdir(), 'orca-jev-broken-root-'))
  tempDirs.push(brokenRoot)

  const result = run('install', home, brokenRoot)
  assert.equal(result.ok, true, 'the hook/env install must still succeed even though the mod copy failed')
  assert.equal(result.changes.modCopy, false)
  assert.ok(result.modCopyWarning, 'the top-level result must carry a warning, not drop it')
  assert.ok(result.targets[0].modCopyWarning, 'the per-target result must carry it too')
})
