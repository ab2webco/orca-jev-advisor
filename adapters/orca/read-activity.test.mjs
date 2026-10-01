// read-activity.mjs (JEVADV-63, A3) exercised as the CLI it actually is,
// same reason read-consumption.test.mjs runs read-consumption.mjs itself
// rather than importing it: it resolves its own cache dir, so running it as
// a real child process is the only way to prove the paths it touches.
//
// Every test runs against a throwaway, mkdtemp'd HOME plus explicit
// ORCA_SUPERVISOR_CACHE_DIR/ORCA_SUPERVISOR_CONFIG_DIR overrides -- never
// the real ~/.cache/orca-supervisor, ~/.config/orca-supervisor or
// ~/.claude*.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'read-activity.mjs')
const PLUGIN_ROOT = join(__dirname, '..', '..')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-read-activity-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function cacheDirFor (home) {
  return join(home, '.cache', 'orca-supervisor')
}
function configDirFor (home) {
  return join(home, '.config', 'orca-supervisor')
}

function hourKey (ms) {
  return new Date(ms).toISOString().slice(0, 13)
}

function writeLines (home, name, lines) {
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''), 'utf8')
}

function gateRow (overrides = {}) {
  return {
    type: 'gate-decision',
    id: `g-${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    project: 'alpha',
    commandFamily: 'git',
    source: 'jev',
    verdict: 'allow',
    latencyMs: 120,
    ...overrides,
  }
}

function usageRow (overrides = {}) {
  return {
    at: new Date().toISOString(),
    agent: 'main',
    model: 'claude-sonnet-5',
    effort: null,
    input: 100,
    output: 50,
    cacheRead: 1000,
    cacheWrite: 200,
    stopReason: 'end_turn',
    account: 'home',
    project: 'alpha',
    ...overrides,
  }
}

function decisionRow (overrides = {}) {
  return {
    at: new Date().toISOString(),
    account: 'home',
    point: 'start',
    tier: 'simple',
    confidence: 1,
    current: 'claude-opus-5-5',
    proposed: 'claude-haiku-4-5',
    applied: true,
    reason: 'switch',
    guard: null,
    contextTokens: 1000,
    switchCost: 0.002,
    stepSaving: 0.001,
    expectedSteps: 5,
    quotaBand: 'normal',
    origin: 'composer',
    effort: null,
    project: 'alpha',
    ...overrides,
  }
}

function envFor (home) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  // src/core/paths.ts refuses to compute a real path under node's test
  // runner -- point it at exactly the dirs it would compute for `home`.
  env.ORCA_SUPERVISOR_CACHE_DIR = cacheDirFor(home)
  env.ORCA_SUPERVISOR_CONFIG_DIR = configDirFor(home)
  return env
}

function run (home) {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT_PATH], { env: envFor(home), encoding: 'utf8' }))
}

test('no data anywhere yet: ok, an empty project list, zero corrupt lines', () => {
  const home = makeHome()
  const result = run(home)
  assert.deepEqual(result, { ok: true, projects: [], corruptLines: 0 })
})

test('gate log plus hourly turn-usage and router files fold into one per-project summary, end to end', () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [
    gateRow({ verdict: 'allow' }),
    gateRow({ verdict: 'deny' }),
    gateRow({ verdict: 'advise' }),
    gateRow({ verdict: 'ask', project: 'beta' }),
    // Not a gate-decision row at all: ignored, never counted as corrupt.
    { type: 'something-else', at: new Date().toISOString() },
  ])
  writeLines(home, `turn-usage-${hourKey(now)}.jsonl`, [
    usageRow(),
    usageRow({ agent: 'subagent', model: 'claude-haiku-4-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
  ])
  writeLines(home, `model-router-decisions-${hourKey(now)}.jsonl`, [decisionRow()])

  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.corruptLines, 0)
  assert.deepEqual(result.projects.map((p) => p.project).sort(), ['alpha', 'beta'])

  const alpha = result.projects.find((p) => p.project === 'alpha')
  assert.deepEqual(alpha.gateOutcomes, { allowed: 1, advised: 1, asked: 0, blocked: 1 })
  assert.deepEqual(alpha.steps, { main: 1, subagent: 1 })
  assert.equal(alpha.days.length, 7)
  const today = alpha.days[6]
  assert.equal(today.judgedCommands, 3)
  assert.equal(today.mainSteps, 1)
  assert.equal(today.subagentSteps, 1)
  const sonnet = alpha.tokensByModel.find((m) => m.model === 'claude-sonnet-5')
  assert.deepEqual(
    { input: sonnet.input, output: sonnet.output, cacheRead: sonnet.cacheRead, cacheWrite: sonnet.cacheWrite },
    { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 },
  )
  assert.equal(typeof alpha.totalEstimatedCostUsd, 'number')
  assert.equal(alpha.router.total, 1)
  assert.equal(alpha.router.applied, 1)

  const beta = result.projects.find((p) => p.project === 'beta')
  assert.deepEqual(beta.gateOutcomes, { allowed: 0, advised: 0, asked: 1, blocked: 0 })
  assert.equal(beta.router, null)
})

test('old records without a project field fold under the null project, never dropped', () => {
  const home = makeHome()
  const now = Date.now()
  const { project: _drop, ...legacyUsage } = usageRow()
  const { project: _dropDecision, ...legacyDecision } = decisionRow()
  writeLines(home, `turn-usage-${hourKey(now)}.jsonl`, [legacyUsage])
  writeLines(home, `model-router-decisions-${hourKey(now)}.jsonl`, [legacyDecision])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.projects.length, 1)
  assert.equal(result.projects[0].project, null)
  assert.deepEqual(result.projects[0].steps, { main: 1, subagent: 0 })
  assert.equal(result.projects[0].router.total, 1)
})

test('corrupt and malformed lines are skipped, counted, and never crash the read', () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [
    '{not json',
    gateRow({ verdict: 'nonsense' }),
    gateRow(),
  ])
  writeLines(home, `turn-usage-${hourKey(now)}.jsonl`, [
    'also not json',
    usageRow({ agent: 'robot' }),
    usageRow(),
  ])
  writeLines(home, `model-router-decisions-${hourKey(now)}.jsonl`, [
    '[1,2,3]',
    decisionRow({ at: 42 }),
    decisionRow(),
  ])
  const result = run(home)
  assert.equal(result.ok, true)
  // gate: 1 unparseable + 1 malformed verdict; usage: 1 unparseable + 1
  // malformed agent; decisions: 1 non-object + 1 non-string `at`.
  assert.equal(result.corruptLines, 6)
  const alpha = result.projects.find((p) => p.project === 'alpha')
  assert.deepEqual(alpha.gateOutcomes, { allowed: 1, advised: 0, asked: 0, blocked: 0 })
  assert.deepEqual(alpha.steps, { main: 1, subagent: 0 })
  assert.equal(alpha.router.total, 1)
})

test('never prunes: an hourly file far outside the window is left on disk (pruning is read-consumption.mjs\'s job)', () => {
  const home = makeHome()
  const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000
  const oldName = `turn-usage-${hourKey(oldMs)}.jsonl`
  writeLines(home, oldName, [usageRow({ at: new Date(oldMs).toISOString() })])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.deepEqual(result.projects, [])
  assert.ok(existsSync(join(cacheDirFor(home), oldName)))
})

// The same permission shape main.mjs's activitySidecarArgv grants (read on
// the plugin root and the cache dir, no write anywhere): proves the sidecar
// needs nothing more than that, since a missing grant in production would
// only surface as a silently failed read.
test('runs under the permission sandbox with read-only grants on the plugin root and cache dir', () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [gateRow()])
  writeLines(home, `turn-usage-${hourKey(now)}.jsonl`, [usageRow()])
  const argv = ['--permission', `--allow-fs-read=${PLUGIN_ROOT}`, `--allow-fs-read=${cacheDirFor(home)}`, SCRIPT_PATH]
  const result = JSON.parse(execFileSync(process.execPath, argv, { env: envFor(home), encoding: 'utf8' }))
  assert.equal(result.ok, true)
  assert.equal(result.projects[0].project, 'alpha')
  assert.deepEqual(result.projects[0].gateOutcomes, { allowed: 1, advised: 0, asked: 0, blocked: 0 })
})

// 0.6.17 T4 (JEVADV-92): the gate's log is one file per UTC hour now; the
// single file written before 0.6.17 is read next to them, so no history
// disappears on upgrade.
test('T4: gate decisions are read from the legacy file and from every hourly file', () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [gateRow({ verdict: 'allow', at: new Date(now - 3 * 60 * 60 * 1000).toISOString() })])
  writeLines(home, `gate-decisions-${hourKey(now - 60 * 60 * 1000)}.jsonl`, [gateRow({ verdict: 'deny', source: 'local-rule', at: new Date(now - 60 * 60 * 1000).toISOString() })])
  writeLines(home, `gate-decisions-${hourKey(now)}.jsonl`, [gateRow({ verdict: 'allow' }), 'not json'])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.deepEqual(result.projects[0].gateOutcomes, { allowed: 2, advised: 0, asked: 0, blocked: 1 })
  assert.equal(result.corruptLines, 1)
})
