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
//
// Also: joinability. gate-outcome.ts only appends an outcome when a
// gate-pending record for the same tool_use_id already exists in the log --
// an outcome with no matching pending answers no question the gate ever
// asked (measured on the real log: 2697 outcomes, 15 pendings, 11 joinable).
// Every test below except the two explicitly testing that gate ("no
// matching pending") seeds one first with seedPending.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

/** Writes a minimal gate-pending record for `toolUseId`, exactly as
 *  gate-bash.ts would when it stops a command -- so the recorder under
 *  test has a question to join its outcome against. */
function seedPending (home, toolUseId) {
  const path = outcomesPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({
    type: 'gate-pending',
    toolUseId,
    at: new Date().toISOString(),
    project: null,
    destinationId: null,
    commandFamily: 'test',
    shape: null,
    reversible: null,
    external: null,
    consequence: null,
    ceiling: 1.78
  }) + '\n')
}

/** Runs the recorder against a throwaway HOME with a given hook payload on
 *  stdin, exactly as Claude Code itself invokes it. */
function run (home, payload) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  // src/core/paths.ts's resolveCacheDir refuses to compute a real path at
  // all under node's test runner (see its module doc) -- this points it at
  // exactly the directory it would have computed for `home` on darwin with
  // no XDG override, so gate-outcome.ts's own CACHE_DIR still lands inside
  // this throwaway HOME.
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  execFileSync(process.execPath, [SCRIPT_PATH], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8'
  })
}

/** Only the recorded outcome lines -- the log also carries the gate-pending
 *  lines seedPending writes, which are a different record shape entirely. */
function readOutcomes (home) {
  const path = outcomesPathFor(home)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'gate-outcome')
}

test('PostToolUse on Bash with a matching pending record is recorded as approved', () => {
  const home = makeHome()
  seedPending(home, 'tool-1')
  run(home, { hook_event_name: 'PostToolUse', tool_use_id: 'tool-1', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].toolUseId, 'tool-1')
  assert.equal(outcomes[0].outcome, 'approved')
})

test('PostToolUse on Bash with NO matching pending record writes nothing -- most commands were never a question', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PostToolUse', tool_use_id: 'tool-1b', tool_name: 'Bash' })
  assert.deepEqual(readOutcomes(home), [])
})

test('PermissionDenied on Bash with a matching pending record is recorded as rejected', () => {
  const home = makeHome()
  seedPending(home, 'tool-2')
  run(home, { hook_event_name: 'PermissionDenied', tool_use_id: 'tool-2', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].toolUseId, 'tool-2')
  assert.equal(outcomes[0].outcome, 'rejected')
})

test('PermissionDenied on Bash with NO matching pending record writes nothing', () => {
  const home = makeHome()
  run(home, { hook_event_name: 'PermissionDenied', tool_use_id: 'tool-2b', tool_name: 'Bash' })
  assert.deepEqual(readOutcomes(home), [])
})

test('PostToolUseFailure on Bash with a matching pending record is recorded as approved -- the person approved the run, the failure is the command\'s own business', () => {
  const home = makeHome()
  seedPending(home, 'tool-3')
  run(home, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'tool-3', tool_name: 'Bash' })
  const outcomes = readOutcomes(home)
  assert.equal(outcomes.length, 1, 'an approved command that later fails must still be recorded, not silently dropped')
  assert.equal(outcomes[0].toolUseId, 'tool-3')
  assert.equal(outcomes[0].outcome, 'approved')
})

test('PostToolUseFailure on a non-Bash tool is not recorded even with a matching pending record -- the gate only ever judged Bash', () => {
  const home = makeHome()
  seedPending(home, 'tool-4')
  run(home, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'tool-4', tool_name: 'Edit' })
  assert.deepEqual(readOutcomes(home), [])
})

test('an unrecognized event is not recorded, even with a matching pending record', () => {
  const home = makeHome()
  seedPending(home, 'tool-5')
  run(home, { hook_event_name: 'Notification', tool_use_id: 'tool-5', tool_name: 'Bash' })
  assert.deepEqual(readOutcomes(home), [])
})
