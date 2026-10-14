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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  for (const key of ['day', 'week', 'all']) assert.equal(result.usage.windows[key].stepCount, 0, key)
  // No gate decision carries a build yet: there is no "this version".
  assert.deepEqual(result.usage.windows.version, { available: false, sinceMs: null, coverageSinceMs: null })
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
  assert.equal(result.modelRouter.windows.day.total, 2)
  assert.equal(result.modelRouter.windows.day.applied, 1)
  assert.equal(result.modelRouter.windows.day.measured, 1)
  assert.equal(result.modelRouter.windows.day.byPoint.start.simple, 1)
  assert.equal(result.modelRouter.windows.day.byPoint.stage.complex, 1)
})

test('R3: modelRouter.coldSwitches counts the switches after a cold cache in the same window as the rest of the summary', () => {
  const home = makeHome()
  const now = Date.now()
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000
  writeDecisionFile(home, now, [
    decisionRow({ point: 'stage', applied: false, wouldApplyCold: true }),
    decisionRow({ point: 'stage', applied: true }),
  ])
  writeDecisionFile(home, threeDaysAgo, [decisionRow({ at: new Date(threeDaysAgo).toISOString(), point: 'stage', applied: true, appliedCold: true })])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.modelRouter.windows.day.total, 2)
  assert.equal(result.modelRouter.windows.day.coldSwitches, 1)
  assert.equal(result.modelRouter.windows.week.total, 3)
  assert.equal(result.modelRouter.windows.week.coldSwitches, 2)
})

test('modelRouter is an empty-but-present summary when the decision file exists with zero rows', () => {
  const home = makeHome()
  const now = Date.now()
  writeDecisionFile(home, now, [])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.notEqual(result.modelRouter, null)
  assert.equal(result.modelRouter.windows.day.total, 0)
  assert.equal(result.modelRouter.windows.day.savedEstimate, null)
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
  assert.equal(result.usage.windows.day.stepCount, 3)
  const models = result.usage.windows.day.byModel.map((m) => m.model).sort()
  assert.deepEqual(models, ['opus', 'sonnet'])
})

test('turn-usage rows tolerate a missing or malformed project field -- an old record is never dropped for lacking it (JEVADV-63)', () => {
  const home = makeHome()
  const now = Date.now()
  writeTurnUsageFile(home, now, [
    usageRow({ model: 'sonnet' }), // no `project` at all -- an old record
    usageRow({ model: 'sonnet', project: 'orca-supervisor' }),
    usageRow({ model: 'sonnet', project: 12345 }), // a hand-edited, wrong-typed value
  ])
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.usage.windows.day.stepCount, 3, 'none of the three rows should be dropped as corrupt')
  assert.equal(result.usage.corruptLines, 0)
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
  assert.equal(result.usage.windows.day.stepCount, 1)
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

// odd/tasks/board-global-window.md W1: one summary per board window, each
// saying how far back its data can honestly speak.
test('W1: usage is summarized for every board window, and "all" says it only speaks for what the 8-day logs keep', () => {
  const home = makeHome()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  writeTurnUsageFile(home, now, [usageRow()])
  writeTurnUsageFile(home, now - 3 * day, [usageRow({ at: new Date(now - 3 * day).toISOString() })])
  writeTurnUsageFile(home, now - 7.5 * day, [usageRow({ at: new Date(now - 7.5 * day).toISOString() })])
  const result = run(home)
  const { day: d, week, all } = result.usage.windows
  assert.deepEqual([d.stepCount, week.stepCount, all.stepCount], [1, 2, 3])
  assert.ok(Math.abs(d.sinceMs - (now - day)) < 60_000)
  assert.equal(d.coverageSinceMs, d.sinceMs, '24 h is inside what the logs keep')
  assert.equal(all.sinceMs, null)
  assert.ok(Math.abs(all.coverageSinceMs - (now - 8 * day)) < 60_000, 'all: only what the logs keep')
  assert.equal(all.available, true)
})

test('W1: "this version" starts at the first gate decision of the running build, the same instant on every tab', () => {
  const home = makeHome()
  const now = Date.now()
  const hour = 60 * 60 * 1000
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  const gate = (at, pluginVersion) => JSON.stringify({ type: 'gate-decision', id: `g${at}`, at: new Date(at).toISOString(), project: 'p', commandFamily: 'git', source: 'jev', verdict: 'allow', latencyMs: 1, pluginVersion })
  writeFileSync(join(dir, 'gate-decisions.jsonl'), [gate(now - 5 * hour, '0.10.0'), gate(now - 2 * hour, '0.11.0'), gate(now - hour, '0.11.0')].join('\n') + '\n')
  writeTurnUsageFile(home, now, [usageRow()])
  writeTurnUsageFile(home, now - 3 * hour, [usageRow({ at: new Date(now - 3 * hour).toISOString() })])
  const version = run(home).usage.windows.version
  assert.equal(version.available, true)
  assert.equal(version.pluginVersion, '0.11.0')
  assert.equal(version.sinceMs, now - 2 * hour)
  assert.equal(version.stepCount, 1)
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

// ---------------------------------------------------------------------------
// The context steward's hourly logs (odd/tasks/jev-context-steward.md)
// ---------------------------------------------------------------------------

function stewardFileName (ms) {
  return `context-steward-decisions-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
}

function writeStewardFile (home, ms, rows) {
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, stewardFileName(ms)), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
}

function stewardRow (overrides = {}) {
  return { at: new Date().toISOString(), account: 'acct-a', project: 'project-c', mode: 'active', contextBefore: 150000, decision: 'boundary', confidence: 0.9, compact: true, applied: true, contextAfter: 30000, ...overrides }
}

test('steward is null until a context-steward-decisions file exists', () => {
  const result = run(makeHome())
  assert.equal(result.ok, true)
  assert.equal(result.steward, null)
})

test('steward summarizes each window: compactions applied, measure-mode ones, context freed per later step', () => {
  const home = makeHome()
  const now = Date.now()
  writeStewardFile(home, now, [stewardRow(), stewardRow({ mode: 'measure', applied: false, contextAfter: null }), stewardRow({ decision: 'mid-task', compact: false, applied: false, contextAfter: null })])
  const { available, sinceMs, coverageSinceMs, ...dayWindow } = run(home).steward.windows.day
  assert.equal(available, true)
  assert.ok(sinceMs !== null && coverageSinceMs === sinceMs)
  assert.deepEqual(dayWindow, { decisions: 3, applied: 1, wouldCompact: 1, freedPerStep: 120000, verified: { compactions: 1, verified: 0, steps: 0, tokensNotReread: 0, mainContextTokens: 0, share: null }, preCold: null })
})

// Track S: the pre-cold tier's 7 days, its returns joined from the same turn usage.
test('steward.preCold counts a measured pre-cold fire and the session coming back within 24 h', () => {
  const home = makeHome()
  const now = Date.now()
  const at = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString()
  writeStewardFile(home, now, [stewardRow({ at: at(30), sessionId: 's1', trigger: 'pre-cold', decision: 'pre-cold', mode: 'measure', applied: false, contextAfter: null, wouldFire: 'pre-cold' })])
  writeTurnUsageFile(home, now, [usageRow({ at: at(29), sessionId: 's1', input: 0, cacheRead: 0, cacheWrite: 150000 })])
  const result = run(home)
  const week = result.steward.windows.week
  assert.equal(week.decisions, 0, 'not a turn-end decision')
  assert.equal(week.preCold.wouldFire, 1)
  assert.equal(week.preCold.returned, 1)
  assert.equal(week.preCold.coldRewriteOnReturn, 150000)
  assert.equal(result.steward.windows.day.preCold, null, 'the fire was 30 h ago: not in the 24 h window')
})

// 0.6.27 T2: the saving measured on real usage, over the 7-day usage window.
test('steward.verified measures the saving on the main agent\'s real turn usage in the window asked for', () => {
  const home = makeHome()
  const now = Date.now()
  const at = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString()
  // Two days ago: outside the 24h summary, inside the 7-day verified window.
  writeStewardFile(home, now, [stewardRow({ at: at(48), sessionId: 's1' })])
  writeTurnUsageFile(home, now, [
    usageRow({ at: at(49), sessionId: 's1', input: 0, cacheRead: 280000, cacheWrite: 20000 }),
    usageRow({ at: at(47), sessionId: 's1', input: 0, cacheRead: 90000, cacheWrite: 10000 }),
    usageRow({ at: at(46), sessionId: 's1', input: 0, cacheRead: 100000, cacheWrite: 10000 }),
    usageRow({ at: at(47.5), agent: 'subagent', sessionId: 's1', input: 0, cacheRead: 5000, cacheWrite: 0 }),
  ])
  const result = run(home)
  assert.equal(result.steward.windows.day.applied, 0, 'two days ago: outside 24 h')
  assert.equal(result.steward.windows.day.verified, null)
  assert.equal(result.steward.windows.week.applied, 1)
  assert.deepEqual(result.steward.windows.week.verified, { compactions: 1, verified: 1, steps: 2, tokensNotReread: 400000, mainContextTokens: 510000, share: 400000 / 910000 })
})

test('a steward log more than 8 days old is pruned, same retention as the others', () => {
  const home = makeHome()
  const oldMs = Date.now() - 9 * 24 * 60 * 60 * 1000
  writeStewardFile(home, oldMs, [stewardRow({ at: new Date(oldMs).toISOString() })])
  const oldPath = join(cacheDirFor(home), stewardFileName(oldMs))
  assert.equal(run(home).ok, true)
  assert.equal(existsSync(oldPath), false)
})

// 0.6.21 T1 (JEVADV-98): this sidecar, the one with write access to the cache
// dir, also folds gate decision files older than 8 days into the running
// totals and deletes them -- after its own summary, and never at its cost.
function gateFileName (ms) {
  return `gate-decisions-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
}

function gateRow (atMs, source) {
  return `${JSON.stringify({ type: 'gate-decision', id: `g-${atMs}-${source}`, at: new Date(atMs).toISOString(), project: 'alpha', commandFamily: 'grep', source, verdict: 'allow', latencyMs: source === 'jev' ? 100 : null })}\n`
}

test('T1: a gate decision file more than 8 days old is folded into the totals and deleted; a newer one is kept', () => {
  const home = makeHome()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  mkdirSync(cacheDirFor(home), { recursive: true })
  const oldPath = join(cacheDirFor(home), gateFileName(now - 9 * day))
  const recentPath = join(cacheDirFor(home), gateFileName(now - day))
  writeFileSync(oldPath, gateRow(now - 9 * day, 'jev') + gateRow(now - 9 * day, 'cache'))
  writeFileSync(recentPath, gateRow(now - day, 'jev'))
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(existsSync(oldPath), false, 'the 9-day-old gate file is folded and deleted')
  assert.equal(existsSync(recentPath), true)
  const totals = JSON.parse(readFileSync(join(cacheDirFor(home), 'gate-decisions-totals.json'), 'utf8'))
  assert.equal(totals.all.totalDecisions, 2)
  assert.equal(totals.jevRecordsForAb, 1)
})

test('T1: a fold that fails leaves the consumption summary and every gate file as they were', () => {
  const home = makeHome()
  const now = Date.now()
  mkdirSync(cacheDirFor(home), { recursive: true })
  const oldPath = join(cacheDirFor(home), gateFileName(now - 9 * 24 * 60 * 60 * 1000))
  writeFileSync(oldPath, gateRow(now - 9 * 24 * 60 * 60 * 1000, 'jev'))
  mkdirSync(join(cacheDirFor(home), 'gate-decisions-totals.json.tmp'))
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(existsSync(oldPath), true)
})

// K0c (odd/tasks/typing-lead-time.md): the mod's typing-*.jsonl rows, summed
// over the last 7 days for the Skills card's "Typing before send" line.
function typingFileName (ms) {
  return `typing-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
}

function typingRow (overrides = {}) {
  return { type: 'typing', at: new Date().toISOString(), sessionId: 's1', origin: 'composer', kind: 'composer', gapMs: 1200, edits: 40, ...overrides }
}

function writeTypingFile (home, ms, rows) {
  const dir = cacheDirFor(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, typingFileName(ms)), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
}

test('K0c typing is null until a typing file exists, never a zero', () => {
  const result = run(makeHome())
  assert.equal(result.ok, true)
  assert.equal(result.typing, null)
})

test('K0c typing summarizes each window: p50 and p90 of the gap over typed prompts, injected ones counted apart', () => {
  const home = makeHome()
  const now = Date.now()
  const at = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString()
  writeTypingFile(home, now, [
    typingRow({ at: at(1), gapMs: 400 }),
    typingRow({ at: at(30), gapMs: 2000 }),
    typingRow({ at: at(100), gapMs: 900 }),
    typingRow({ at: at(2), origin: 'task-notification', kind: 'injected', gapMs: null, edits: 0 }),
    typingRow({ at: at(8 * 24), gapMs: 99000 }),
  ])
  const strip = ({ available, sinceMs, coverageSinceMs, ...figures }) => figures
  const typing = run(home).typing
  assert.deepEqual(strip(typing.windows.week), { typed: 3, injected: 1, p50Ms: 900, p90Ms: 2000 })
  assert.deepEqual(strip(typing.windows.day), { typed: 1, injected: 1, p50Ms: 400, p90Ms: 400 })
})

test('K0c a typing log more than 8 days old is pruned, same retention as the others', () => {
  const home = makeHome()
  const oldMs = Date.now() - 9 * 24 * 60 * 60 * 1000
  writeTypingFile(home, oldMs, [typingRow({ at: new Date(oldMs).toISOString() })])
  const oldPath = join(cacheDirFor(home), typingFileName(oldMs))
  const result = run(home)
  assert.equal(result.ok, true)
  assert.deepEqual([result.typing.windows.all.typed, result.typing.windows.all.injected], [0, 0], 'only rows past what is kept: nothing counted, never a made-up figure')
  assert.equal(result.typing.windows.all.p50Ms, null)
  assert.equal(existsSync(oldPath), false)
})
