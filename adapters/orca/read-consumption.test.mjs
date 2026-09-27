// read-consumption.mjs (JEV-060 slice 1, T4) exercised as the CLI it
// actually is (same reason read-measurements.test.mjs runs
// read-measurements.mjs itself rather than importing it): it resolves its
// own cache/config dirs and reads real global-Claude-config paths under
// `home`, so a direct `import` under `node --test` would need the same
// env overrides anyway, and running it as a real child process is the only
// way to prove the actual permission-relevant paths it touches.
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
const SCRIPT_PATH = join(__dirname, 'read-consumption.mjs')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-read-consumption-test-'))
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

function turnUsageFileName (ms) {
  return `turn-usage-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
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
    ...overrides,
  }
}

function writeTurnUsageFile (home, ms, rows) {
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, turnUsageFileName(ms)), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
}

function decisionFileName (ms) {
  return `model-router-decisions-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
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
    ...overrides,
  }
}

function writeDecisionFile (home, ms, rows) {
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, decisionFileName(ms)), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
}

function writeQuota (home, payload) {
  const dir = configDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'quota.json'), JSON.stringify(payload), 'utf8')
}

function writeClaudeMd (home, content) {
  const dir = join(home, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf8')
}

function writeClaudeJson (home, payload) {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(payload), 'utf8')
}

function run (home) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  // src/core/paths.ts's resolveCacheDir/resolveConfigDir both refuse to
  // compute a real path at all under node's test runner (see that
  // module's own doc) -- point them at exactly the directories they would
  // have computed for `home` on darwin/linux with no XDG override.
  env.ORCA_SUPERVISOR_CACHE_DIR = cacheDirFor(home)
  env.ORCA_SUPERVISOR_CONFIG_DIR = configDirFor(home)
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

test('no data anywhere yet: ok, zeroed usage, empty quota, no threshold-gated recommendations', () => {
  const home = makeHome()
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.usage.last24h.stepCount, 0)
  assert.equal(result.usage.last7d.stepCount, 0)
  assert.deepEqual(result.quota, { accounts: [], checkedAt: null })
  assert.equal('claudeMdSize' in result.recommendations, false)
  assert.equal('longSession' in result.recommendations, false)
  assert.equal('subagentShare' in result.recommendations, false)
  // MCP count always has real data (0 counts) -- never conditionally omitted.
  assert.deepEqual(result.recommendations.mcpServerCount, { count: 0 })
  // No model-router-decisions-*.jsonl file exists at all: modelRouter is
  // null, never a zeroed summary that would look like a router that ran
  // and decided nothing (JEV-060 slice 2, T9).
  assert.equal(result.modelRouter, null)
})

test('modelRouter summarizes decisions from model-router-decisions-*.jsonl once at least one file exists', () => {
  const home = makeHome()
  const now = Date.now()
  writeDecisionFile(home, now, [
    decisionRow({ point: 'start', tier: 'simple', applied: true }),
    decisionRow({ point: 'stage', tier: 'complex', applied: false }),
  ])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.notEqual(result.modelRouter, null)
  assert.equal(result.modelRouter.total, 2)
  assert.equal(result.modelRouter.applied, 1)
  assert.equal(result.modelRouter.measured, 1)
  assert.equal(result.modelRouter.byPoint.start.simple, 1)
  assert.equal(result.modelRouter.byPoint.stage.complex, 1)
})

test('modelRouter is an empty-but-present summary when the decision file exists with zero rows', () => {
  const home = makeHome()
  const now = Date.now()
  writeDecisionFile(home, now, [])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.notEqual(result.modelRouter, null)
  assert.equal(result.modelRouter.total, 0)
  assert.equal(result.modelRouter.savedEstimate, null)
})

test('an hourly model-router-decisions file more than 8 days old is pruned, same retention as turn-usage', () => {
  const home = makeHome()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const oldMs = now - 9 * day
  writeDecisionFile(home, oldMs, [decisionRow({ at: new Date(oldMs).toISOString() })])
  const oldPath = join(cacheDirFor(home), decisionFileName(oldMs))
  assert.ok(existsSync(oldPath))
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(existsSync(oldPath), false, 'the 9-day-old decisions file must be pruned')
})

test('aggregates rows across several hourly files into one summary', () => {
  const home = makeHome()
  const now = Date.now()
  const hour = 60 * 60 * 1000
  writeTurnUsageFile(home, now, [usageRow({ model: 'sonnet' }), usageRow({ model: 'sonnet', agent: 'subagent' })])
  writeTurnUsageFile(home, now - 2 * hour, [usageRow({ model: 'opus' })])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.usage.last24h.stepCount, 3)
  const models = result.usage.last24h.byModel.map((m) => m.model).sort()
  assert.deepEqual(models, ['opus', 'sonnet'])
})

test('a corrupt line in an hourly file is skipped, counted, and never crashes the read', () => {
  const home = makeHome()
  const now = Date.now()
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, turnUsageFileName(now))
  writeFileSync(path, `${JSON.stringify(usageRow())}\nnot json at all\n\n`, 'utf8')
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.usage.last24h.stepCount, 1)
  assert.equal(result.usage.corruptLines, 1)
})

test('an hourly file more than 8 days old is deleted; a newer one is kept', () => {
  const home = makeHome()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const oldMs = now - 9 * day
  const recentMs = now - 1 * day
  writeTurnUsageFile(home, oldMs, [usageRow({ at: new Date(oldMs).toISOString() })])
  writeTurnUsageFile(home, recentMs, [usageRow({ at: new Date(recentMs).toISOString() })])
  const oldPath = join(cacheDirFor(home), turnUsageFileName(oldMs))
  const recentPath = join(cacheDirFor(home), turnUsageFileName(recentMs))
  assert.ok(existsSync(oldPath))
  assert.ok(existsSync(recentPath))
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(existsSync(oldPath), false, 'the 9-day-old file must be pruned')
  assert.equal(existsSync(recentPath), true, 'the 1-day-old file must survive pruning')
})

test('quota.json missing degrades to the honest empty shape, never fails the script', () => {
  const home = makeHome()
  const result = run(home)
  assert.equal(result.ok, true)
  assert.deepEqual(result.quota, { accounts: [], checkedAt: null })
})

test('quota.json present is parsed and returned', () => {
  const home = makeHome()
  writeQuota(home, {
    accounts: [{ id: 'a1', status: 'ok', sessionUsedPercent: 10, weeklyUsedPercent: 81, resetsAt: 123 }],
    checkedAt: '2026-09-26T00:00:00.000Z',
  })
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.quota.accounts.length, 1)
  assert.equal(result.quota.accounts[0].id, 'a1')
  assert.equal(result.quota.accounts[0].weeklyUsedPercent, 81)
})

test('quota.json that is unparseable JSON degrades the same as a missing file', () => {
  const home = makeHome()
  const dir = configDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'quota.json'), 'not valid json{{{', 'utf8')
  const result = run(home)
  assert.equal(result.ok, true)
  assert.deepEqual(result.quota, { accounts: [], checkedAt: null })
})

test('CLAUDE.md and .claude.json both missing: no claudeMdSize recommendation, mcpServerCount reads 0', () => {
  const home = makeHome()
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal('claudeMdSize' in result.recommendations, false)
  assert.deepEqual(result.recommendations.mcpServerCount, { count: 0 })
})

test('a present CLAUDE.md and .claude.json feed real numbers into the recommendations', () => {
  const home = makeHome()
  writeClaudeMd(home, 'x'.repeat(32004)) // just over 8000 tokens at 4 bytes/token
  writeClaudeJson(home, { mcpServers: { a: {}, b: {}, c: {} } })
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.recommendations.claudeMdSize.overThreshold, true)
  assert.equal(result.recommendations.mcpServerCount.count, 3)
})
