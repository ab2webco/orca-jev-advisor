// 0.6.17 T2 (JEVADV-90): the file tools' guard, run as the CLI Claude Code
// starts (a subprocess, a hook payload on stdin) against a throwaway HOME --
// never the real one. It refuses an Edit/Write/MultiEdit/NotebookEdit of the
// gate's own decision inputs and says nothing for every other file.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'gate-files.mjs')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-gate-files-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** `orcaUserData: null` leaves Orca's user data where Orca puts it for this HOME. */
function run (home, payload, { locale, orcaUserData = join(home, 'orca-userdata') } = {}) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  delete env.ORCA_USER_DATA_PATH
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  if (orcaUserData !== null) env.ORCA_USER_DATA_PATH = orcaUserData
  if (locale !== undefined) {
    mkdirSync(env.ORCA_SUPERVISOR_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.ORCA_SUPERVISOR_CONFIG_DIR, 'locale'), locale)
  }
  return execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT_PATH], { env, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: home, ...payload }), encoding: 'utf8' })
}

const denied = (stdout) => {
  assert.notEqual(stdout.trim(), '', 'a refusal writes a verdict')
  return JSON.parse(stdout)
}

test('each file tool is refused on the gate\'s own files, with the reason for the model and a line for the person', () => {
  const home = makeHome()
  const policies = join(home, '.config', 'orca-supervisor', 'policies.json')
  for (const [tool_name, tool_input] of [
    ['Edit', { file_path: policies, old_string: 'never', new_string: 'always' }],
    ['Write', { file_path: join(home, '.config', 'orca-supervisor', 'deny-tier-config.json'), content: '{}' }],
    ['MultiEdit', { file_path: join(home, '.config', 'orca-supervisor', 'team-owners.json'), edits: [] }],
    ['NotebookEdit', { notebook_path: join(home, '.cache', 'orca-supervisor', 'gate-bash.json'), new_source: '' }]
  ]) {
    const payload = denied(run(home, { tool_name, tool_input }))
    assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny', tool_name)
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^REFUSED: edits the gate's own rules \(~\/\.(config|cache)\/orca-supervisor\/[\w.-]+\); change them in the Advisor panel\. You cannot make this edit\./, tool_name)
    assert.match(payload.systemMessage, /^jev · blocked `~\/\.(config|cache)\/orca-supervisor\/[\w.-]+`: edits the gate's own rules/, tool_name)
  }
})

test('a relative path and a symlink are the file they name', () => {
  const home = makeHome()
  const configDir = join(home, '.config', 'orca-supervisor')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'policies.json'), '[]')
  symlinkSync(join(configDir, 'policies.json'), join(home, 'link.json'))
  assert.equal(denied(run(home, { tool_name: 'Write', tool_input: { file_path: '.config/orca-supervisor/catalog.json', content: '{}' } })).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(denied(run(home, { tool_name: 'Edit', tool_input: { file_path: join(home, 'link.json'), old_string: 'a', new_string: 'b' } })).hookSpecificOutput.permissionDecision, 'deny')
})

test('the person line follows the locale; the model text stays English', () => {
  const home = makeHome()
  const payload = denied(run(home, { tool_name: 'Write', tool_input: { file_path: join(home, '.config', 'orca-supervisor', 'policies.json'), content: '[]' } }, { locale: 'es' }))
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^REFUSED: edits the gate's own rules/)
  assert.match(payload.systemMessage, /^jev · bloqueó `~\/\.config\/orca-supervisor\/policies\.json`: edita las reglas del propio gate/)
})

test('every other file, a test HOME\'s config and an unreadable payload pass in silence', () => {
  const home = makeHome()
  for (const payload of [
    { tool_name: 'Edit', tool_input: { file_path: join(home, 'Projects', 'app', 'src', 'index.ts'), old_string: 'a', new_string: 'b' } },
    { tool_name: 'Write', tool_input: { file_path: join(home, '.config', 'orca-supervisor', 'locale'), content: 'es' } },
    { tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'other-home', '.config', 'orca-supervisor', 'policies.json'), content: '[]' } },
    { tool_name: 'Read', tool_input: { file_path: join(home, '.config', 'orca-supervisor', 'policies.json') } },
    { tool_name: 'Write', tool_input: {} },
    { tool_name: 'Write' }
  ]) {
    assert.equal(run(home, payload), '', JSON.stringify(payload))
  }
})

test('with the plugin switched off in Orca, nothing is refused', () => {
  const home = makeHome()
  const userData = join(home, 'orca-userdata')
  mkdirSync(join(userData, 'profiles', 'p1'), { recursive: true })
  writeFileSync(join(userData, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'p1' }))
  writeFileSync(join(userData, 'profiles', 'p1', 'orca-data.json'), JSON.stringify({ settings: { disabledPlugins: ['ab2web.orca-jev-advisor'] } }))
  assert.equal(run(home, { tool_name: 'Write', tool_input: { file_path: join(home, '.config', 'orca-supervisor', 'policies.json'), content: '[]' } }), '')
})

// 0.6.18 T3 (JEVADV-94): the plugin's Orca storage, at Orca's own location for
// this HOME (no override variable names it, as on a real machine), so the
// plain-JavaScript pass in gate-files.mjs must not let it through unread.
test('an Edit or Write of the plugin\'s Orca storage is refused; another plugin\'s is not', { skip: process.platform === 'win32' }, () => {
  const home = makeHome()
  const userData = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'orca') : join(home, '.config', 'orca-ide')
  const store = join(userData, 'plugins-data', 'ab2web.orca-jev-advisor')
  const conventional = (payload) => run(home, payload, { orcaUserData: null })
  for (const [tool_name, tool_input] of [
    ['Write', { file_path: join(store, 'storage.json'), content: '{}' }],
    ['Edit', { file_path: join(store, 'storage.json'), old_string: 'never', new_string: 'always' }],
    ['Write', { file_path: join(store, 'secrets.json.enc'), content: '' }]
  ]) {
    const payload = denied(conventional({ tool_name, tool_input }))
    assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny', tool_name)
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^REFUSED: edits the gate's own rules \(~\/.*plugins-data\/ab2web\.orca-jev-advisor\/(storage\.json|secrets\.json\.enc)\)/, tool_name)
  }
  assert.equal(conventional({ tool_name: 'Write', tool_input: { file_path: join(userData, 'plugins-data', 'ab2web.wa-inbox', 'storage.json'), content: '{}' } }), '')
})
