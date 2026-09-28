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
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

function group (settings, event, matcher) {
  return (settings.hooks?.[event] ?? []).find((g) => g.matcher === matcher)
}

function bashGroup (settings, event) {
  return group(settings, event, 'Bash')
}

function agentGroup (settings, event) {
  return group(settings, event, 'Agent')
}

function ownEntries (settings, event, marker, matcher = 'Bash') {
  return (group(settings, event, matcher)?.hooks ?? []).filter((h) => h.statusMessage === marker)
}

/** `<home>/.config/orca-supervisor/locale` -- the same mirror file the gate
 *  hook itself reads (src/core/i18n.ts's own parseLocaleFile), pointed here
 *  by `run()`'s own ORCA_SUPERVISOR_CONFIG_DIR override. Absent (every test
 *  above this point) resolves to the default, "en". */
function writeLocale (home, locale) {
  const path = join(home, '.config', 'orca-supervisor', 'locale')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, locale)
}

const GATE_MARKER = 'orca-jev-advisor: asking Jev before running this command'
const OUTCOME_MARKER = 'orca-jev-advisor: recording what you decided'
const AGENT_MODEL_MARKER = 'orca-jev-advisor: asking Jev which model this subagent needs'
const AGENT_OUTCOME_MARKER = 'orca-jev-advisor: recording which model the subagent ran on'

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

test('install copies the skills mod into place -- a real directory, mirroring the repo layout so its imports resolve', () => {
  const home = makeHome()
  const result = run('install', home)
  assert.equal(result.ok, true)
  assert.equal(result.changes.modCopy, true)

  const copyPath = modCopyPathFor(home)
  const st = lstatSync(copyPath)
  assert.equal(st.isSymbolicLink(), false, 'the mod must be a real copy, not a symlink -- symlink() is refused under a scoped grant')
  assert.equal(st.isDirectory(), true)

  // The real hooks/index.ts, mirrored at its own repo-relative path -- not
  // flattened to <copy>/hooks/index.ts, which is where the GENERATED root
  // hooks.json lives instead (asserted below). Byte for byte against the
  // real source file.
  const copiedEntry = readFileSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks', 'index.ts'), 'utf8')
  const sourceEntry = readFileSync(join(MOD_SOURCE, 'hooks', 'index.ts'), 'utf8')
  assert.equal(copiedEntry, sourceEntry)
  // A src/core dependency several directories deep also landed at its own
  // repo-relative path, proving the mirror goes beyond the mod-skills
  // folder itself.
  assert.equal(readFileSync(join(copyPath, 'src', 'core', 'jev.ts'), 'utf8'), readFileSync(join(PLUGIN_ROOT, 'src', 'core', 'jev.ts'), 'utf8'))

  // The generated manifest -- what used to be entirely missing, and the
  // reason this mod never actually loaded.
  const manifest = JSON.parse(readFileSync(join(copyPath, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'orca-jev-mod-skills')
  assert.deepEqual(manifest.author, { name: 'Ab2Web' }, 'author must be an object -- the engine rejects a bare string')
  assert.equal(manifest.version, JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version)

  // The generated root hooks.json, pointing at the mirrored entry.
  const rootHooksJson = JSON.parse(readFileSync(join(copyPath, 'hooks', 'hooks.json'), 'utf8'))
  assert.deepEqual(rootHooksJson.modules, ['../adapters/claude/mod-skills/hooks/index.ts'])
})

test('install writes a marker recording which plugin tree the copy came from, and a content digest', () => {
  const home = makeHome()
  run('install', home)
  const marker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  assert.equal(marker.source, MOD_SOURCE)
  assert.equal(typeof marker.digest, 'string')
  assert.ok(marker.digest.length > 0)
})

test('install refreshes a copy whose recorded digest no longer matches the current source -- a changed byte at the same path is not ignored', () => {
  const home = makeHome()
  run('install', home)
  const copyPath = modCopyPathFor(home)
  const before = readFileSync(join(copyPath, '.claude-plugin', 'plugin.json'), 'utf8')

  // Simulate a stale marker the way a dev-loaded plugin (same path forever)
  // would produce: everything else about the copy is left alone, only the
  // marker's own digest is now wrong for it.
  const marker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  writeFileSync(modCopyMarkerPathFor(home), JSON.stringify({ ...marker, digest: 'stale-digest-from-an-older-source-tree' }), 'utf8')

  const result = run('install', home)
  assert.equal(result.changes.modCopy, true, "today's bug: only the source PATH was ever recorded, so a copy at the same path never refreshed")
  const after = readFileSync(join(copyPath, '.claude-plugin', 'plugin.json'), 'utf8')
  assert.equal(after, before, 'the manifest content itself is unchanged -- only the stale marker triggered the rewrite')
  const refreshedMarker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  assert.notEqual(refreshedMarker.digest, 'stale-digest-from-an-older-source-tree')
})

test('install removes a file that no longer belongs to the copy -- a leftover from an older, differently-shaped source tree', () => {
  const home = makeHome()
  run('install', home)
  const copyPath = modCopyPathFor(home)
  const leftover = join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks', 'a-file-the-current-source-no-longer-has.ts')
  writeFileSync(leftover, '// stale', 'utf8')
  // Force a refresh the same way the digest-staleness test above does, so
  // install actually re-walks and re-writes the copy instead of taking the
  // already-current no-op path.
  const marker = JSON.parse(readFileSync(modCopyMarkerPathFor(home), 'utf8'))
  writeFileSync(modCopyMarkerPathFor(home), JSON.stringify({ ...marker, digest: 'force-a-refresh' }), 'utf8')

  run('install', home)
  assert.throws(() => readFileSync(leftover, 'utf8'), 'a file the current closure no longer names must not survive a refresh')
})

test('status reports hasManifest -- and installed:false -- when the copy exists but the manifest is missing', () => {
  const home = makeHome()
  const copyPath = modCopyPathFor(home)
  mkdirSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks'), { recursive: true })
  writeFileSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks', 'index.ts'), 'not a real copy', 'utf8')
  mkdirSync(dirname(modCopyMarkerPathFor(home)), { recursive: true })
  writeFileSync(modCopyMarkerPathFor(home), JSON.stringify({ source: MOD_SOURCE, digest: 'whatever' }), 'utf8')

  const status = run('status', home)
  const target = status.targets.find((t) => t.id === 'home')
  assert.equal(target.modCopy.hasManifest, false)
  assert.equal(target.modCopy.installed, false)
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
  // A pluginRoot with no adapters/claude/mod-skills under it: the manual
  // copy's readdir(source) fails with ENOENT, exactly the shape of a real
  // permission failure -- the hook and env-var install do not depend on the
  // source existing, so they still succeed while only the mod copy fails.
  const brokenRoot = mkdtempSync(join(tmpdir(), 'orca-jev-broken-root-'))
  tempDirs.push(brokenRoot)

  const result = run('install', home, brokenRoot)
  assert.equal(result.ok, true, 'the hook/env install must still succeed even though the mod copy failed')
  assert.equal(result.changes.modCopy, false)
  assert.ok(result.modCopyWarning, 'the top-level result must carry a warning, not drop it')
  assert.ok(result.targets[0].modCopyWarning, 'the per-target result must carry it too')
})

// ---------------------------------------------------------------------------
// JEVADV-43: the manual recursive tree-walk this section used to test
// (fs.cp's own recursive copy is denied outright by the plugin worker's
// permission sandbox) is gone. The copy no longer walks a directory at all
// -- it copies exactly the files hooks/index.ts's own import closure names,
// each to its own repo-relative path (src/core/mod_skills_copy.ts, unit
// tested in its own test file: the closure walker, the digest, and the two
// generated-file builders). A symlink or an unrelated file sitting in
// adapters/claude/mod-skills/ that nothing imports is simply never visited
// -- there is no directory listing step left to skip it FROM -- and the
// executable-bit preservation this section used to test against an
// artificial fixture is exercised for real above, against the real
// hooks/index.ts (every file in the actual closure is 0644, so there is
// nothing more specific to assert here without inventing a fixture the
// production code path would never actually see).
// ---------------------------------------------------------------------------

test('a copy failure\'s underlying error text reaches the per-target record as modCopyDetail, separate from the stable modCopyWarning reason code', () => {
  const home = makeHome()
  const brokenRoot = mkdtempSync(join(tmpdir(), 'orca-jev-broken-root-'))
  tempDirs.push(brokenRoot)

  const result = run('install', home, brokenRoot)
  assert.equal(result.targets[0].modCopyWarning, 'copy-failed', 'the machine-readable reason code must stay exactly as panels already key off it')
  assert.ok(typeof result.targets[0].modCopyDetail === 'string' && result.targets[0].modCopyDetail.length > 0, 'the underlying error text must reach the per-target record, not just the reason code')
  assert.notEqual(result.targets[0].modCopyDetail, result.targets[0].modCopyWarning, 'the detail is the diagnosis, not a repeat of the reason code')
})

test('install\'s top-level result counts how many targets actually got the mod copy and how many failed it', () => {
  const home = makeHome()
  const okResult = run('install', home)
  assert.deepEqual(okResult.modCopyTargets, { landed: 1, failed: 0 }, 'the only discovered target (home) got the mod copy')

  const brokenHome = makeHome()
  const brokenRoot = mkdtempSync(join(tmpdir(), 'orca-jev-broken-root-'))
  tempDirs.push(brokenRoot)
  const failResult = run('install', brokenHome, brokenRoot)
  assert.equal(failResult.ok, true, 'the hook/env install still succeeds even though the mod copy failed')
  assert.deepEqual(failResult.modCopyTargets, { landed: 0, failed: 1 }, 'ok:true must not read as "the mod landed everywhere" when it silently did not land anywhere')
})

// Portability, not luck: every file in the real closure is 0644 today, so a
// copy that ignores modes looks correct. The day one has to be executable,
// writeFile's own 0644 would drop the bit silently, and a hook that cannot
// run is indistinguishable from a hook that was never installed. Exercised
// with a minimal fixture whose own hooks/index.ts is the walk's entry (the
// closure-based copy only ever touches files something actually imports),
// so this stays a faithful test of the real code path rather than an
// artificial directory-walk fixture.
test('the copy carries the executable bit across instead of leaving writeFile\'s default', () => {
  const home = makeHome()
  const pluginRoot = mkdtempSync(join(tmpdir(), 'orca-jev-fixture-root-'))
  tempDirs.push(pluginRoot)
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
  const hooksDir = join(pluginRoot, 'adapters', 'claude', 'mod-skills', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ description: 'fixture', modules: ['./index.ts'] }), 'utf8')
  writeFileSync(join(hooksDir, 'index.ts'), "import { run } from '../bin/run.ts'\nexport function register() { run() }\n", 'utf8')
  const binDir = join(pluginRoot, 'adapters', 'claude', 'mod-skills', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'run.ts'), 'export function run() {}\n', 'utf8')
  chmodSync(join(binDir, 'run.ts'), 0o755)

  const result = run('install', home, pluginRoot)
  assert.equal(result.changes.modCopy, true)

  const copyPath = modCopyPathFor(home)
  assert.equal(statSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'bin', 'run.ts')).mode & 0o777, 0o755, 'the executable bit must survive the copy')
  assert.equal(statSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks', 'index.ts')).mode & 0o777, 0o644, 'an ordinary file keeps an ordinary mode')
})

test('the copy contains exactly the closure -- an unrelated file in the source tree that nothing imports is never copied', () => {
  const home = makeHome()
  const pluginRoot = mkdtempSync(join(tmpdir(), 'orca-jev-fixture-root-'))
  tempDirs.push(pluginRoot)
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8')
  const modDir = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  mkdirSync(join(modDir, 'hooks'), { recursive: true })
  writeFileSync(join(modDir, 'hooks', 'hooks.json'), JSON.stringify({ description: 'fixture', modules: ['./index.ts'] }), 'utf8')
  writeFileSync(join(modDir, 'hooks', 'index.ts'), "export function register() {}\n", 'utf8')
  // Nothing imports this -- a stray file, a stale draft, a symlink to
  // somewhere unrelated; the point is that the closure walker never visits
  // it, so it must never land in the copy.
  writeFileSync(join(modDir, 'unrelated.txt'), 'nobody imports me', 'utf8')

  run('install', home, pluginRoot)
  const copyPath = modCopyPathFor(home)
  assert.equal(readFileSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'hooks', 'index.ts'), 'utf8'), "export function register() {}\n")
  assert.throws(() => readFileSync(join(copyPath, 'adapters', 'claude', 'mod-skills', 'unrelated.txt'), 'utf8'), 'a file nothing imports must never be copied -- "do not hardcode the file list" cuts both ways')
})

// ---------------------------------------------------------------------------
// Agent-matcher hooks (adapters/claude/agent-model.ts) -- PreToolUse,
// PostToolUse and PostToolUseFailure, matcher 'Agent', never 'Bash'. Same
// idempotency, surgical-uninstall and upgrade guarantees as the Bash-matcher
// hooks above, exercised separately because they live in their OWN matcher
// group, sharing only the per-event array with the Bash group on the same
// event.
// ---------------------------------------------------------------------------

test('a fresh install registers the Agent-matcher hooks on PreToolUse, PostToolUse and PostToolUseFailure', () => {
  const home = makeHome()
  const result = run('install', home)
  assert.equal(result.ok, true)
  assert.equal(result.changes.agentModelHook, true)

  const settings = readSettings(home)
  const preEntries = ownEntries(settings, 'PreToolUse', AGENT_MODEL_MARKER, 'Agent')
  assert.equal(preEntries.length, 1)
  assert.deepEqual(preEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'agent-model.ts')])

  const postEntries = ownEntries(settings, 'PostToolUse', AGENT_OUTCOME_MARKER, 'Agent')
  assert.equal(postEntries.length, 1)
  assert.deepEqual(postEntries[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'agent-model.ts')])

  const postFailureEntries = ownEntries(settings, 'PostToolUseFailure', AGENT_OUTCOME_MARKER, 'Agent')
  assert.equal(postFailureEntries.length, 1)

  // The Bash-matcher hooks on the SAME events are untouched: the two
  // matcher groups coexist side by side in the same per-event array.
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1)
  assert.equal(bashGroup(settings, 'PreToolUse').hooks.length, 1)
  assert.equal(agentGroup(settings, 'PreToolUse').hooks.length, 1)

  const status = run('status', home)
  assert.equal(status.agentModelHook.installed, true)
})

test('re-running install is idempotent for the Agent-matcher hooks too -- no duplicate entries', () => {
  const home = makeHome()
  run('install', home)
  run('install', home)
  run('install', home)
  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', AGENT_MODEL_MARKER, 'Agent').length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', AGENT_OUTCOME_MARKER, 'Agent').length, 1)
  assert.equal(ownEntries(settings, 'PostToolUseFailure', AGENT_OUTCOME_MARKER, 'Agent').length, 1)
})

test('uninstall after a fresh install restores the exact original (empty) settings, Agent hooks included', () => {
  const home = makeHome()
  run('install', home)
  run('uninstall', home)
  const raw = readFileSync(settingsPathFor(home), 'utf8')
  assert.equal(raw, '{}\n')
})

test('uninstall leaves a third party\'s own Agent group and hooks alone -- only our own entry is removed, byte-for-byte', () => {
  const home = makeHome()
  const original = {
    hooks: {
      PreToolUse: [
        { matcher: 'Agent', hooks: [{ type: 'command', command: 'other-tool', args: [], statusMessage: 'someone else entirely, on Agent' }] }
      ]
    }
  }
  writeSettings(home, original)
  const before = readFileSync(settingsPathFor(home), 'utf8')

  run('install', home)
  const afterInstall = readSettings(home)
  assert.equal(agentGroup(afterInstall, 'PreToolUse').hooks.length, 2, 'our entry joins the third party\'s in the same Agent group')

  run('uninstall', home)
  const afterUninstall = readSettings(home)
  assert.equal(agentGroup(afterUninstall, 'PreToolUse').hooks.length, 1, 'only our own entry is removed')
  assert.equal(agentGroup(afterUninstall, 'PreToolUse').hooks[0].statusMessage, 'someone else entirely, on Agent')
  assert.equal(readFileSync(settingsPathFor(home), 'utf8'), before, 'byte-for-byte restoration of the third party\'s group')
})

test('an upgrade from a state file written before Agent bookkeeping existed still installs and cleanly uninstalls the Agent hooks', () => {
  const home = makeHome()
  // The exact shape a real machine has after a pre-Agent-hook install: four
  // Bash-matcher events, no `groupExistedBefore` bookkeeping at all (it did
  // not exist yet), and none of the Agent hooks in settings.json.
  const preExisting = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-bash.ts')], timeout: 6, statusMessage: GATE_MARKER }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')], timeout: 2, statusMessage: OUTCOME_MARKER }] }],
      PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')], timeout: 2, statusMessage: OUTCOME_MARKER }] }],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-outcome.ts')], timeout: 2, statusMessage: OUTCOME_MARKER }] }]
    },
    env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }
  }
  writeSettings(home, preExisting)

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
          PermissionDenied: { arrayExistedBefore: false, bashGroupExistedBefore: false },
          PostToolUseFailure: { arrayExistedBefore: false, bashGroupExistedBefore: false }
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
  assert.equal(ownEntries(settings, 'PreToolUse', AGENT_MODEL_MARKER, 'Agent').length, 1, 'the new Agent hook was added')
  assert.equal(ownEntries(settings, 'PostToolUse', AGENT_OUTCOME_MARKER, 'Agent').length, 1)
  assert.equal(ownEntries(settings, 'PostToolUseFailure', AGENT_OUTCOME_MARKER, 'Agent').length, 1)
  // The pre-existing Bash hooks are untouched, not duplicated.
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1)

  run('install', home) // must not duplicate the Agent hooks on a second run
  const settingsAgain = readSettings(home)
  assert.equal(ownEntries(settingsAgain, 'PreToolUse', AGENT_MODEL_MARKER, 'Agent').length, 1)

  run('uninstall', home)
  const afterUninstall = readSettings(home)
  // This fixture's captured bookkeeping says neither the PreToolUse array
  // nor its Bash group existed before our very first install touched it
  // (the same "arrayExistedBefore: false, bashGroupExistedBefore: false"
  // shape the sibling PostToolUseFailure test above already relies on) --
  // so once both the pre-existing Bash group and our freshly-added Agent
  // group are emptied, the whole PreToolUse key is unwound, not left as an
  // empty array or with either group dangling.
  assert.equal(Object.prototype.hasOwnProperty.call(afterUninstall.hooks ?? {}, 'PreToolUse'), false)
})

// ---------------------------------------------------------------------------
// 0.5.3: while a Bash/Agent PreToolUse hook runs, Claude Code shows its own
// `statusMessage` -- always English, e.g. "orca-jev-advisor: asking Jev
// before running this command", even on a Spanish locale. The installer now
// writes this in the person's own locale, read the same way the gate hook
// itself reads it (the `locale` mirror file, src/core/i18n.ts's own
// parseLocaleFile). Only the two "asking Jev" hooks (Bash PreToolUse, Agent
// PreToolUse) are localized -- the "recording..." outcome hooks stay
// English, unchanged, on purpose (this release's own scope).
//
// The trap: ownership of a hook entry is decided by `findOwnHookIndex`
// matching its OWN statusMessage -- if only the CURRENT locale's text
// counted, a locale change would make install() blind to the entry it
// already wrote (under the OTHER locale's text) and push a SECOND entry
// instead of updating the first in place, and status/uninstall would
// likewise stop recognising it. Every test below proves that never happens.
// ---------------------------------------------------------------------------

const GATE_MARKER_ES = 'orca-jev-advisor: Jev revisa el comando antes de ejecutarlo'
const AGENT_MODEL_MARKER_ES = 'orca-jev-advisor: Jev elige el modelo para este subagente'

test('es locale: a fresh install writes the Spanish "asking Jev" status messages, on both the Bash and Agent PreToolUse hooks', () => {
  const home = makeHome()
  writeLocale(home, 'es')
  const result = run('install', home)
  assert.equal(result.ok, true)

  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER_ES).length, 1)
  assert.equal(ownEntries(settings, 'PreToolUse', AGENT_MODEL_MARKER_ES, 'Agent').length, 1)
  // The "recording..." outcome hooks are unaffected by locale -- still English.
  assert.equal(ownEntries(settings, 'PostToolUse', OUTCOME_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PostToolUse', AGENT_OUTCOME_MARKER, 'Agent').length, 1)

  const status = run('status', home)
  assert.equal(status.hook.installed, true)
  assert.equal(status.agentModelHook.installed, true)
})

test('en locale (the default, no locale file at all): the status messages are today\'s English text, unchanged', () => {
  const home = makeHome()
  const result = run('install', home)
  assert.equal(result.ok, true)
  const settings = readSettings(home)
  assert.equal(ownEntries(settings, 'PreToolUse', GATE_MARKER).length, 1)
  assert.equal(ownEntries(settings, 'PreToolUse', AGENT_MODEL_MARKER, 'Agent').length, 1)
})

test('installing in English, then switching the locale to Spanish and reinstalling updates the text IN PLACE -- one entry each, not two', () => {
  const home = makeHome()
  run('install', home)
  const afterEnglish = readSettings(home)
  assert.equal(ownEntries(afterEnglish, 'PreToolUse', GATE_MARKER).length, 1)

  writeLocale(home, 'es')
  const result = run('install', home)
  // The text changed, so this IS a real change -- never silently skipped.
  assert.equal(result.changes.hook, true, 'the reinstall must report the statusMessage change, not silently no-op')
  assert.equal(result.changes.agentModelHook, true)

  const afterSpanish = readSettings(home)
  // Exactly one Bash PreToolUse hook of ours, now carrying the Spanish text
  // -- the English-authored entry was REPLACED in place, never left behind
  // as a stale second entry alongside the new one.
  const bashHooks = bashGroup(afterSpanish, 'PreToolUse').hooks
  assert.equal(bashHooks.length, 1, 'exactly one of our own hooks -- the locale change must never duplicate the entry')
  assert.equal(bashHooks[0].statusMessage, GATE_MARKER_ES)
  assert.deepEqual(bashHooks[0].args, [join(PLUGIN_ROOT, 'adapters', 'claude', 'gate-bash.ts')], 'the same hook, same path -- only its own status text changed')

  const agentHooks = agentGroup(afterSpanish, 'PreToolUse').hooks
  assert.equal(agentHooks.length, 1)
  assert.equal(agentHooks[0].statusMessage, AGENT_MODEL_MARKER_ES)

  const status = run('status', home)
  assert.equal(status.hook.installed, true)
  assert.equal(status.agentModelHook.installed, true)
})

test('status still reports the hook installed after a locale change with no reinstall yet -- the old-locale text is not orphaned', () => {
  const home = makeHome()
  run('install', home) // writes the ENGLISH text
  writeLocale(home, 'es') // the person changes locale, but never reinstalls
  const status = run('status', home)
  assert.equal(status.hook.installed, true, 'the English-authored entry from before the locale change is still recognised as ours')
  assert.equal(status.agentModelHook.installed, true)
})

test('uninstall removes the hook regardless of which locale wrote its status text, restoring the exact original state', () => {
  const home = makeHome()
  writeLocale(home, 'es')
  run('install', home) // writes the SPANISH text
  writeLocale(home, 'en') // the person switches back, without reinstalling
  run('uninstall', home)
  const raw = readFileSync(settingsPathFor(home), 'utf8')
  assert.equal(raw, '{}\n', 'the Spanish-authored entry must still be found and removed even though the CURRENT locale is now English')
})

// ---------------------------------------------------------------------------
// JEV-060 slice 2, §9 T9: the Orca config panel's own switch, without a
// second source of truth (§7) -- these two CLI modes are its whole worker
// side, exercised the same way as install/uninstall/status above (a real
// subprocess against a throwaway HOME). `runRouter` never passes a
// pluginRoot -- routerModeStatus/routerModeSet touch only settings.json,
// never the plugin tree.
// ---------------------------------------------------------------------------

const ROUTER_SETTINGS_KEY = 'orca-jev-mod-skills@skills-dir'

function runRouter (args, home, userDataDir) {
  const env = { ...process.env, HOME: home }
  if (userDataDir === undefined) delete env.ORCA_USER_DATA_PATH
  else env.ORCA_USER_DATA_PATH = userDataDir
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

/** A throwaway Orca `userData` dir with one fake account directory under
 *  `claude-accounts/<accountId>` -- all discoverTargets() itself needs to
 *  find it (settingsPathFor's own `auth/settings.json` is created lazily by
 *  writeSettingsAtomic on the first router-mode-set, exactly like a real
 *  account Orca has never written a hook into yet). */
function makeUserDataWithAccount (home, accountId) {
  const userDataDir = join(home, 'orca-userdata')
  mkdirSync(join(userDataDir, 'claude-accounts', accountId), { recursive: true })
  return userDataDir
}

test('router-mode-status: with no Orca accounts reachable, reports only "home", default "measure"', () => {
  const home = makeHome()
  const result = runRouter(['router-mode-status'], home)
  assert.equal(result.ok, true)
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0].target, 'home')
  assert.equal(result.targets[0].mode, 'measure')
})

test('router-mode-status: reads back a mode already set in settings.json, home and an account both', () => {
  const home = makeHome()
  const accountId = '11111111-2222-3333-4444-555555555555'
  const userDataDir = makeUserDataWithAccount(home, accountId)
  writeSettings(home, { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: 'active' } } } })
  const result = runRouter(['router-mode-status'], home, userDataDir)
  const byTarget = Object.fromEntries(result.targets.map((t) => [t.target, t.mode]))
  assert.equal(byTarget.home, 'active')
  assert.equal(byTarget[accountId], 'measure', 'an account with no settings.json yet defaults to measure')
})

test('router-mode-set: writes routerMode into home settings.json, creating the file, keeping every other key', () => {
  const home = makeHome()
  writeSettings(home, { env: { SOME_OTHER_VAR: '1' } })
  const result = runRouter(['router-mode-set', 'home', 'active'], home)
  assert.equal(result.ok, true)
  assert.equal(result.target, 'home')
  assert.equal(result.mode, 'active')
  const settings = readSettings(home)
  assert.equal(settings.env.SOME_OTHER_VAR, '1', 'an unrelated existing key must survive the write')
  assert.equal(settings.pluginConfigs[ROUTER_SETTINGS_KEY].options.routerMode, 'active')
})

test('router-mode-set: writes into the ACCOUNT settings.json the target names, never the home one', () => {
  const home = makeHome()
  const accountId = '11111111-2222-3333-4444-555555555555'
  const userDataDir = makeUserDataWithAccount(home, accountId)
  const result = runRouter(['router-mode-set', accountId, 'off'], home, userDataDir)
  assert.equal(result.ok, true)
  const accountSettingsPath = join(userDataDir, 'claude-accounts', accountId, 'auth', 'settings.json')
  const accountSettings = JSON.parse(readFileSync(accountSettingsPath, 'utf8'))
  assert.equal(accountSettings.pluginConfigs[ROUTER_SETTINGS_KEY].options.routerMode, 'off')
  assert.equal(existsSync(settingsPathFor(home)), false, 'the home settings.json must never be touched by an account-targeted set')
})

test('router-mode-set: an unknown mode is rejected, never guessed at or silently defaulted', () => {
  const home = makeHome()
  const result = runRouter(['router-mode-set', 'home', 'turbo'], home)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-mode')
  assert.equal(existsSync(settingsPathFor(home)), false, 'a rejected mode must never write settings.json')
})

test('router-mode-set: an unknown target is rejected', () => {
  const home = makeHome()
  const result = runRouter(['router-mode-set', 'account:not-a-real-account', 'active'], home)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-target')
})

// Review round 2, finding 6: Claude Code and the person edit settings.json
// too. The router-mode writer must never lose their edit, never rewrite an
// unchanged file, keep its formatting, and never overwrite a non-object.

function runRouterAsync (args, home, extraEnv) {
  const env = { ...process.env, HOME: home, ...extraEnv }
  delete env.ORCA_USER_DATA_PATH
  delete env.XDG_CONFIG_HOME
  delete env.XDG_CACHE_HOME
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { env })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', () => resolve(JSON.parse(stdout)))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('finding 6: an edit made while the router mode is being written survives (re-read, then merge again)', async () => {
  const home = makeHome()
  writeSettings(home, { model: 'opus' })
  const pending = runRouterAsync(['router-mode-set', 'home', 'active'], home, { ORCA_TEST_DELAY_BEFORE_RENAME_MS: '700' })
  await sleep(250)
  writeSettings(home, { model: 'opus', permissions: { allow: ['Bash(ls)'] } })
  const result = await pending
  assert.equal(result.ok, true)
  const settings = readSettings(home)
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] }, 'the concurrent edit must not be lost')
  assert.equal(settings.pluginConfigs[ROUTER_SETTINGS_KEY].options.routerMode, 'active')
})

test('finding 6: a file that keeps changing under the writer is reported as a failure, never clobbered', async () => {
  const home = makeHome()
  writeSettings(home, { model: 'opus' })
  const pending = runRouterAsync(['router-mode-set', 'home', 'active'], home, { ORCA_TEST_DELAY_BEFORE_RENAME_MS: '800' })
  await sleep(300)
  writeSettings(home, { model: 'opus', edit: 1 })
  await sleep(1000)
  writeSettings(home, { model: 'opus', edit: 2 })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'concurrent-change')
  assert.deepEqual(readSettings(home), { model: 'opus', edit: 2 })
})

test('finding 6: the requested mode already set means no write at all, byte for byte', () => {
  const home = makeHome()
  const raw = `{\n    "pluginConfigs": {\n        "${ROUTER_SETTINGS_KEY}": { "options": { "routerMode": "active" } }\n    }\n}\n`
  mkdirSync(dirname(settingsPathFor(home)), { recursive: true })
  writeFileSync(settingsPathFor(home), raw)
  const result = runRouter(['router-mode-set', 'home', 'active'], home)
  assert.equal(result.ok, true)
  assert.equal(result.unchanged, true)
  assert.equal(readFileSync(settingsPathFor(home), 'utf8'), raw)
})

test('finding 6: a settings.json that is not a JSON object is refused and left as it is', () => {
  const home = makeHome()
  mkdirSync(dirname(settingsPathFor(home)), { recursive: true })
  writeFileSync(settingsPathFor(home), '[]\n')
  const result = runRouter(['router-mode-set', 'home', 'active'], home)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-an-object')
  assert.equal(readFileSync(settingsPathFor(home), 'utf8'), '[]\n')
})

// ---------------------------------------------------------------------------
// 0.6.2 E3: the effort each tier asks for, per target, next to the mode.
// ---------------------------------------------------------------------------

const DEFAULT_TIER_EFFORT = { simple: 'low', standard: 'medium', complex: 'high', frontier: 'xhigh' }

test('router-mode-status: each target reports its per-tier effort and the model each tier resolves to there', () => {
  const home = makeHome()
  const accountId = '11111111-2222-3333-4444-555555555555'
  const userDataDir = makeUserDataWithAccount(home, accountId)
  writeSettings(home, { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerEffort: { complex: 'xhigh', simple: 'turbo' } } } } })
  const accountSettingsPath = join(userDataDir, 'claude-accounts', accountId, 'auth', 'settings.json')
  mkdirSync(dirname(accountSettingsPath), { recursive: true })
  writeFileSync(accountSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_DEFAULT_OPUS_MODEL: 'big', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mid', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small' } }))
  const result = runRouter(['router-mode-status'], home, userDataDir)
  const byTarget = Object.fromEntries(result.targets.map((t) => [t.target, t]))
  assert.deepEqual(byTarget.home.effort, { ...DEFAULT_TIER_EFFORT, complex: 'xhigh' }, 'an invalid value falls back to the default')
  assert.equal(byTarget.home.tiers.complex.modelId, 'claude-opus-5-5')
  assert.equal(byTarget.home.tiers.complex.label, 'Opus 5.5')
  assert.equal(byTarget.home.tiers.simple.supportsEffort, false, 'Haiku takes no effort')
  assert.deepEqual(byTarget[accountId].effort, DEFAULT_TIER_EFFORT)
  assert.equal(byTarget[accountId].tiers.complex.modelId, 'big', 'a gateway account resolves to its own ids')
})

test('router-effort-set: writes only what differs from the defaults, keeping the mode and every other key', () => {
  const home = makeHome()
  writeSettings(home, { env: { SOME_OTHER_VAR: '1' }, pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: 'active' } } } })
  const result = runRouter(['router-effort-set', 'home', JSON.stringify({ ...DEFAULT_TIER_EFFORT, complex: 'xhigh' })], home)
  assert.equal(result.ok, true)
  assert.equal(result.target, 'home')
  const settings = readSettings(home)
  assert.equal(settings.env.SOME_OTHER_VAR, '1')
  assert.deepEqual(settings.pluginConfigs[ROUTER_SETTINGS_KEY].options, { routerMode: 'active', routerEffort: { complex: 'xhigh' } })
  const again = runRouter(['router-effort-set', 'home', JSON.stringify({ complex: 'xhigh' })], home)
  assert.equal(again.unchanged, true, 'the same effort is no write')
})

test('router-effort-set: an unknown effort, tier or shape is rejected and never written', () => {
  const home = makeHome()
  for (const arg of [JSON.stringify({ complex: 'turbo' }), JSON.stringify({ galaxy: 'high' }), JSON.stringify(['high']), 'not json']) {
    const result = runRouter(['router-effort-set', 'home', arg], home)
    assert.equal(result.ok, false, arg)
    assert.equal(result.reason, 'unknown-effort', arg)
  }
  assert.equal(existsSync(settingsPathFor(home)), false)
  const noTarget = runRouter(['router-effort-set', 'account:nope', JSON.stringify({ complex: 'high' })], home)
  assert.equal(noTarget.reason, 'unknown-target')
})

test('router-mode-status: each target reports its context steward mode and threshold, measure at 120k by default', () => {
  const home = makeHome()
  writeSettings(home, { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { stewardMode: 'active', stewardThreshold: 150000 } } } })
  const result = runRouter(['router-mode-status'], home)
  assert.deepEqual(result.targets[0].steward, { mode: 'active', threshold: 150000 })
  const fresh = runRouter(['router-mode-status'], makeHome())
  assert.deepEqual(fresh.targets[0].steward, { mode: 'measure', threshold: 120000 })
})

test('steward-set: writes the steward mode and threshold next to the router mode, keeping every other key', () => {
  const home = makeHome()
  writeSettings(home, { env: { SOME_OTHER_VAR: '1' }, pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: 'active' } } } })
  const result = runRouter(['steward-set', 'home', JSON.stringify({ mode: 'active', threshold: 100000 })], home)
  assert.equal(result.ok, true)
  assert.equal(result.target, 'home')
  const settings = readSettings(home)
  assert.equal(settings.env.SOME_OTHER_VAR, '1')
  assert.deepEqual(settings.pluginConfigs[ROUTER_SETTINGS_KEY].options, { routerMode: 'active', stewardMode: 'active', stewardThreshold: 100000 })
  const again = runRouter(['steward-set', 'home', JSON.stringify({ mode: 'active', threshold: 100000 })], home)
  assert.equal(again.unchanged, true, 'the same settings are no write')
})

test('steward-set: an unknown mode, a threshold out of range or a bad shape is rejected and never written', () => {
  const home = makeHome()
  for (const arg of [JSON.stringify({ mode: 'loud', threshold: 120000 }), JSON.stringify({ mode: 'active', threshold: 5 }), JSON.stringify({ mode: 'active' }), 'not json']) {
    const result = runRouter(['steward-set', 'home', arg], home)
    assert.equal(result.ok, false, arg)
    assert.equal(result.reason, 'unknown-steward', arg)
  }
  assert.equal(existsSync(settingsPathFor(home)), false)
  const noTarget = runRouter(['steward-set', 'account:nope', JSON.stringify({ mode: 'off', threshold: 120000 })], home)
  assert.equal(noTarget.reason, 'unknown-target')
})
