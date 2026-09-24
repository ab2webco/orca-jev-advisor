// Exercises gate-outcome.ts as the CLI it actually is (it runs `main()`
// unconditionally at import, so it is only testable as a subprocess) against
// a throwaway HOME -- never the real one.
//
// Focus: `outcomeFor(event, toolName)`'s event -> outcome mapping, in
// particular that a Bash command approved by the gate and then failing on
// its own (`PostToolUseFailure`) is still recorded as `approved`. The
// question this log answers is "was interrupting the person worth it", and
// they said yes; whether the command then succeeded or failed is the
// command's own business, not the gate's. A failed command is not a
// rejected one.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'gate-outcome.ts')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-gate-outcome-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function outcomesPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-approvals.jsonl')
}

/** Runs the recorder against a throwaway HOME with a given hook payload on
 *  stdin, exactly as Claude Code itself invokes it. */
function run (home, payload) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  execFileSync(process.execPath, [SCRIPT_PATH], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8'
  })
}

function readOutcomes (home) {
  const path = outcomesPathFor(home)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('PostToolUse on Bash is recorded as approved', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PostToolUse', tool_use_id: 'tool-1', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].toolUseId, 'tool-1')
  assert.equal(outcomes[0].outcome, 'approved')
})

test('PermissionDenied on Bash is recorded as rejected', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PermissionDenied', tool_use_id: 'tool-2', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].toolUseId, 'tool-2')
  assert.equal(outcomes[0].outcome, 'rejected')
})

test('PostToolUseFailure on Bash is recorded as approved -- the person approved the run, the failure is the command\'s own business', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'tool-3', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1, 'an approved command that later fails must still be recorded, not silently dropped')
  assert.equal(outcomes[0].toolUseId, 'tool-3')
  assert.equal(outcomes[0].outcome, 'approved')
})

test('PostToolUseFailure on a non-Bash tool is not recorded -- the gate only ever judged Bash', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'tool-4', tool_name: 'Edit' })
  assert.deepEqual(readOutcomes(home), [])
})

test('an unrecognized event is not recorded', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'Notification', tool_use_id: 'tool-5', tool_name: 'Bash' })
  assert.deepEqual(readOutcomes(home), [])
})
