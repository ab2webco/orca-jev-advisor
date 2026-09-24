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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { commandShape } from '../../src/core/command_shape.ts'

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
 *  HOME, the real Orca install, or the real TYPESAFE_API_KEY. `apiKey`
 *  lets a test reach past the no-key path into the cache; GIT_CEILING_
 *  DIRECTORIES keeps `git` from walking up past the throwaway home even if
 *  the OS temp dir ever ends up nested under a real repository. */
function run (home, command, { cwd, apiKey } = {}) {
  const env = { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  // src/core/paths.ts's resolveConfigDir/resolveCacheDir refuse to compute
  // a real path at all under node's test runner (see its module doc) --
  // this points them at exactly the directories they would have computed
  // for `home` on darwin with no XDG override, so gate-bash.ts's own
  // CACHE_DIR/CONFIG_DIR still land inside this throwaway HOME.
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  if (apiKey === undefined) {
    delete env.TYPESAFE_API_KEY
  } else {
    env.TYPESAFE_API_KEY = apiKey
  }
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

function verdictCachePath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-bash.json')
}

/** Computes the exact cache key gate-bash.ts would compute for `command`
 *  run from `cwd` under `home`, with no catalog mirror present (so
 *  destinationId/treeRoot are null) and `cwd` outside any git repository
 *  (so repoContext resolves to this fixed, branch-less string). */
function expectedCacheKey (command, cwd, home) {
  const repoContext = 'no remote, unknown branch, this is a working branch, clean'
  const shape = commandShape(command, { cwd, home, destinationId: null, treeRoot: undefined, repoContext })
  if (shape === null) throw new Error('test command must have a non-null shape to exercise the cache path')
  return createHash('sha256').update(shape).digest('hex').slice(0, 24)
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

// Cache expiry (a separate defect: cached verdicts never expired, since
// nothing ever read the `at` timestamp back). Both cases below supply a
// TYPESAFE_API_KEY so the command reaches the cache section at all -- a
// missing key skips it entirely -- but a FRESH entry means the run returns
// on the cache hit before ever reaching Jev, so no network call happens
// either way.
test('a fresh cached verdict is honoured without a fresh Jev call', () => {
  const home = makeHome()
  const cwd = home
  const key = expectedCacheKey(MIDDLE_TIER_COMMAND, cwd, home)
  const cachePath = verdictCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [key]: { decision: 'ask', reason: 'stale test reason', at: Date.now() - 1000 },
  }))

  const stdout = run(home, MIDDLE_TIER_COMMAND, { cwd, apiKey: 'test-key-unused-on-cache-hit' })
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(payload.systemMessage, /stale test reason/)
  assert.match(payload.systemMessage, /cached/)
})

test('an expired cached verdict is dropped from disk instead of being reused forever', () => {
  const home = makeHome()
  const cwd = home
  const freshKey = expectedCacheKey(MIDDLE_TIER_COMMAND, cwd, home)
  const cachePath = verdictCachePath(home)
  const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [freshKey]: { decision: 'ask', reason: 'still fresh', at: Date.now() - 1000 },
    'unrelated-expired-key': { decision: 'allow', reason: 'months old', at: Date.now() - thirtyOneDaysMs },
  }))

  run(home, MIDDLE_TIER_COMMAND, { cwd, apiKey: 'test-key-unused-on-cache-hit' })

  const persisted = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.ok(Object.hasOwn(persisted, freshKey), 'a verdict cached seconds ago must survive a read')
  assert.equal(Object.hasOwn(persisted, 'unrelated-expired-key'), false, 'a verdict cached over 30 days ago must be dropped on read, not reused forever')
})

// ---------------------------------------------------------------------------
// Deny tier -- NEVER_SILENTLY used to only ever emit 'ask', even for the
// three rules whose blast radius is beyond the repository AND beyond
// recovery (rm -rf /, DROP/TRUNCATE TABLE, terraform/tofu destroy). These
// all fire in the tier-1b loop, BEFORE the API key check, so none of these
// tests need TYPESAFE_API_KEY or reach Jev.
// ---------------------------------------------------------------------------

/** `<home>/.config/orca-supervisor/deny-tier-config.json` -- the fail-CLOSED
 *  mirror gate-bash.ts reads for the three deny-tier switches (see
 *  src/core/deny_tier_config.ts). */
function denyTierConfigPath (home) {
  return join(home, '.config', 'orca-supervisor', 'deny-tier-config.json')
}

function writeDenyTierConfig (home, value) {
  const path = denyTierConfigPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

test('deny tier: rm -rf / is denied, not just asked, with no config file present', () => {
  const home = makeHome()
  const stdout = run(home, 'rm -rf /')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /terminal/i, 'a deny must say the human can still run it themselves')
})

test('deny tier: DROP TABLE is denied, not just asked', () => {
  const home = makeHome()
  const stdout = run(home, 'psql -c "DROP TABLE users"')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: terraform destroy is denied, not just asked', () => {
  const home = makeHome()
  const stdout = run(home, 'terraform destroy -auto-approve')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// These two used to assert the opposite, back when deny was the exception.
// The numbers overturned that: 3103 approvals against 1 refusal, and 5 of 16
// questions never answered. An `ask` stops the person; a `deny` refuses the
// model and lets it pick another way. What must NOT change is the floor --
// switching a rule off reaches `ask`, never `allow` -- so each of these now
// asserts both halves.
test('terraform apply denies by default, and drops to ask when its switch is off', () => {
  const home = makeHome()
  assert.equal(
    JSON.parse(run(home, 'terraform apply -auto-approve')).hookSpecificOutput.permissionDecision,
    'deny',
  )
  writeDenyTierConfig(home, { denyTerraformApply: false })
  assert.equal(
    JSON.parse(run(home, 'terraform apply -auto-approve')).hookSpecificOutput.permissionDecision,
    'ask',
    'switched off must reach ask, never allow',
  )
})

test('a force push denies by default, and drops to ask when its switch is off', () => {
  const home = makeHome()
  assert.equal(
    JSON.parse(run(home, 'git push --force origin main')).hookSpecificOutput.permissionDecision,
    'deny',
  )
  writeDenyTierConfig(home, { denyForcePush: false })
  assert.equal(
    JSON.parse(run(home, 'git push --force origin main')).hookSpecificOutput.permissionDecision,
    'ask',
    'switched off must reach ask, never allow',
  )
})

test('deny tier: a rule switched off downgrades to ask, never to allow', () => {
  const home = makeHome()
  writeDenyTierConfig(home, { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true })
  const stdout = run(home, 'rm -rf /')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask', 'turning the switch off must downgrade to ask, never disappear into allow')
})

test('deny tier: the other two switches are unaffected by turning one off', () => {
  const home = makeHome()
  writeDenyTierConfig(home, { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true })
  const dropTable = JSON.parse(run(home, 'DROP TABLE users'))
  const destroy = JSON.parse(run(home, 'terraform destroy'))
  assert.equal(dropTable.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(destroy.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: a malformed config file keeps all three rules denying (fail closed)', () => {
  const home = makeHome()
  const path = denyTierConfigPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{not valid json')
  const rmRf = JSON.parse(run(home, 'rm -rf /'))
  const dropTable = JSON.parse(run(home, 'DROP TABLE users'))
  const destroy = JSON.parse(run(home, 'terraform destroy'))
  assert.equal(rmRf.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(dropTable.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(destroy.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: an unreadable config file (a directory instead of a file) keeps all three rules denying (fail closed)', () => {
  const home = makeHome()
  const path = denyTierConfigPath(home)
  // Making the "file" a directory forces readFileSync to throw EISDIR,
  // exercising the failure path distinctly from a JSON.parse failure.
  mkdirSync(path, { recursive: true })
  const rmRf = JSON.parse(run(home, 'rm -rf /'))
  assert.equal(rmRf.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// AB benchmark sampling (appendAbBenchmarkSample) -- only its NEGATIVE case
// is testable here. The real 'jev' verdict path (the only source this
// benchmark samples) needs a live network response from Jev's fixed
// endpoint; this suite's harness has no fetch injection point for a
// subprocess-spawned hook (see the module note above -- every test here
// takes the no-key or deny-tier path specifically to avoid the network),
// so it cannot exercise the append itself. That is covered instead by
// src/core/ab_benchmark.test.ts's unit tests for shouldSample/
// serializeSampleEntry/parseSampleEntries -- the exact functions
// appendAbBenchmarkSample calls.
// ---------------------------------------------------------------------------

function abBenchmarkQueuePath (home) {
  return join(home, '.cache', 'orca-supervisor', 'ab-benchmark-queue.jsonl')
}

test('AB benchmark: no queue file is created on the no-key path -- sampling never runs before a real Jev decision exists', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND)
  assert.equal(existsSync(abBenchmarkQueuePath(home)), false)
})

test('AB benchmark: no queue file is created on a deny-tier local-rule verdict -- only source:"jev" decisions are ever sampled', () => {
  const home = makeHome()
  run(home, 'rm -rf /')
  assert.equal(existsSync(abBenchmarkQueuePath(home)), false)
})
