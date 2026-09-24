// Exercises gate-bash.ts as the CLI it actually is (it runs `main()`
// unconditionally at import, so it is only testable as a subprocess) against
// a throwaway HOME -- never the real one, and never the developer's real
// Orca install.
//
// Focus: the "no API key" defect. resolveApiKey() returning null used to
// pass every command through in total silence, forever -- a plugin whose
// whole purpose is judging commands, quietly judging nothing, with no way
// for the developer to notice. These tests never set TYPESAFE_API_KEY and
// never leave a fallback env file behind, so every command here takes the
// no-key path without ever reaching Jev over the network.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'gate-bash.ts')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-gate-bash-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// A command that is neither obviously safe (tier 1a) nor a NEVER_SILENTLY
// match (tier 1b), so it always reaches the apiKey check -- the only branch
// these tests exercise.
const MIDDLE_TIER_COMMAND = 'some-unmeasured-tool --flag'

/** Runs the hook against a throwaway HOME with a given hook payload on
 *  stdin, exactly as Claude Code itself invokes it. Never touches the real
 *  HOME, the real Orca install, or the real TYPESAFE_API_KEY. */
function run (home, command, cwd) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  delete env.TYPESAFE_API_KEY
  // Point Orca's userData resolution at a directory that does not exist,
  // so pluginDisabledInOrca() fails its own read and fails open (disabled
  // check = false) instead of touching the real developer's Orca install.
  env.ORCA_USER_DATA_PATH = join(home, 'orca-userdata-does-not-exist')
  const payload = { tool_input: { command }, cwd: cwd ?? home, tool_use_id: 'tool-key-notice' }
  return execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT_PATH], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8'
  })
}

function noKeyWarnedPath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-bash.no-key-warned.json')
}

test('no API key: the first command passes through with a one-time notice', () => {
  const home = makeHome()
  const stdout = run(home, MIDDLE_TIER_COMMAND)
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow', 'a missing key must never block a command')
  assert.equal(typeof payload.systemMessage, 'string', 'the first no-key command must say so')
  assert.match(payload.systemMessage, /jev/i)
  assert.ok(existsSync(noKeyWarnedPath(home)), 'the warned marker must be persisted so the next command stays silent')
})

test('no API key: the second command in the same session stays silent', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND) // first command: warns, writes the marker
  const stdout = run(home, MIDDLE_TIER_COMMAND) // second command: must not repeat
  // passThrough() with no notice writes nothing at all -- same silent
  // no-verdict exit every other fail-open path in this hook already uses.
  assert.equal(stdout, '', 'repeating the notice on every command would be as noisy as never warning at all')
})

test('the warned marker records that a warning was already shown', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND)
  const marker = JSON.parse(readFileSync(noKeyWarnedPath(home), 'utf8'))
  assert.equal(marker.warned, true)
})
