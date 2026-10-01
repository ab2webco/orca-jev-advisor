// 0.6.21 T1 (JEVADV-98): old gate decision files are folded into running
// totals and deleted, and no reader's number moves. Every reader runs as the
// CLI it is (read-measurements.mjs, read-activity.mjs) or through its real
// export (countRealJevDecisions), against a throwaway HOME, before and after
// each fold.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { foldGateDecisionLog } from './gate-log-fold.mjs'
import { GATE_DECISION_TOTALS_FILE, GATE_DECISION_TOTALS_LOCK_FILE } from '../../src/core/gate_decision_totals.ts'

// ab_benchmark_cli.ts resolves its default dirs on load, which the paths
// guard refuses under the test runner; every call here passes its own.
const PATHS_OVERRIDE_DIR = mkdtempSync(join(tmpdir(), 'orca-jev-gate-fold-default-'))
process.env.ORCA_SUPERVISOR_CONFIG_DIR = join(PATHS_OVERRIDE_DIR, 'config')
process.env.ORCA_SUPERVISOR_CACHE_DIR = join(PATHS_OVERRIDE_DIR, 'cache')
const { countRealJevDecisions } = await import('../cli/ab_benchmark_cli.ts')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const tempDirs = [PATHS_OVERRIDE_DIR]
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-gate-fold-test-'))
  tempDirs.push(dir)
  mkdirSync(cacheDirFor(dir), { recursive: true })
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function cacheDirFor (home) {
  return join(home, '.cache', 'orca-supervisor')
}

function envFor (home) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  env.ORCA_SUPERVISOR_CACHE_DIR = cacheDirFor(home)
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  return env
}

function runScript (name, home) {
  return JSON.parse(execFileSync(process.execPath, [join(__dirname, name)], { env: envFor(home), encoding: 'utf8' }))
}

/** Every figure a reader derives from the gate log. The day and week windows name their own start from the clock, so only that string is set aside. */
function readAll (home) {
  const measurements = runScript('read-measurements.mjs', home)
  assert.equal(measurements.ok, true, JSON.stringify(measurements))
  for (const key of ['day', 'week']) delete measurements.gate.windows[key].since
  const activity = runScript('read-activity.mjs', home)
  assert.equal(activity.ok, true, JSON.stringify(activity))
  return { gate: measurements.gate, activity, abJev: countRealJevDecisions(cacheDirFor(home)) }
}

function hourName (ms) {
  return `gate-decisions-${new Date(ms).toISOString().slice(0, 13)}.jsonl`
}

let nextId = 0
function row (atMs, overrides = {}) {
  nextId += 1
  return JSON.stringify({
    type: 'gate-decision',
    id: `r-${nextId}`,
    at: new Date(atMs).toISOString(),
    project: 'alpha',
    commandFamily: 'grep',
    source: 'local-rule',
    verdict: 'allow',
    latencyMs: null,
    ...overrides,
  })
}

function writeLines (home, name, lines) {
  writeFileSync(join(cacheDirFor(home), name), lines.map((line) => `${line}\n`).join(''))
}

/** Start of the UTC hour `ms` falls in, plus `minutes`. */
function inHour (ms, minutes) {
  return ms - (ms % HOUR) + minutes * 60 * 1000
}

/**
 * The legacy file (all of it 20 days old: unstamped decisions, a corrupt
 * line, a malformed decision and a row of another type), three hour files
 * old enough to fold, and three live ones; two builds, Jev answering and
 * failing, ties between families.
 */
function writeFixture (home, now) {
  const old = now - 20 * DAY
  writeLines(home, 'gate-decisions.jsonl', [
    row(inHour(old, 1), { source: 'jev', verdict: 'allow', latencyMs: 300, project: 'beta' }),
    row(inHour(old, 2), { commandFamily: 'terraform', verdict: 'ask' }),
    '{"type":"gate-decision","at":"broken',
    JSON.stringify({ type: 'gate-decision', at: new Date(old).toISOString() }),
    JSON.stringify({ type: 'something-else', at: new Date(old).toISOString() }),
    row(inHour(old, 3), { source: 'none', verdict: 'allow' }),
    row(inHour(old, 4), { at: 'not a time', source: 'cache' }),
  ])
  const h15 = now - 15 * DAY
  writeLines(home, hourName(h15), [
    row(inHour(h15, 5), { source: 'jev', verdict: 'deny', latencyMs: 120, pluginVersion: '0.6.17', commandFamily: 'rm' }),
    row(inHour(h15, 6), { source: 'none', pluginVersion: '0.6.17' }),
    'not json',
  ])
  const h12 = now - 12 * DAY
  writeLines(home, hourName(h12), [
    row(inHour(h12, 7), { source: 'jev', verdict: 'advise', latencyMs: 4000, pluginVersion: '0.6.17', project: null }),
    row(inHour(h12, 8), { source: 'cache', pluginVersion: '0.6.18', commandFamily: 'ls' }),
  ])
  const h9 = now - 9 * DAY
  writeLines(home, hourName(h9), [
    row(inHour(h9, 9), { source: 'jev', verdict: 'ask', latencyMs: 120, pluginVersion: '0.6.18', commandFamily: 'git push' }),
    row(inHour(h9, 10), { source: 'none', pluginVersion: '0.6.18' }),
    row(inHour(h9, 11), { source: 'none', pluginVersion: '0.6.18' }),
  ])
  const h2 = now - 2 * DAY
  writeLines(home, hourName(h2), [
    row(inHour(h2, 1), { source: 'none', pluginVersion: '0.6.18', commandFamily: 'ls' }),
    row(inHour(h2, 2), { source: 'local-rule', verdict: 'deny', pluginVersion: '0.6.18', commandFamily: 'rm' }),
  ])
  const h1 = now - HOUR
  writeLines(home, hourName(h1), [
    row(inHour(h1, 1), { source: 'jev', verdict: 'allow', latencyMs: 250, pluginVersion: '0.6.18', project: 'beta' }),
    '{"half":',
  ])
  writeLines(home, hourName(now), [
    row(inHour(now, 0), { source: 'none', pluginVersion: '0.6.18', commandFamily: 'terraform' }),
  ])
  return { folds: ['gate-decisions.jsonl', hourName(h15), hourName(h12), hourName(h9)], live: [hourName(h2), hourName(h1), hourName(now)] }
}

function gateFiles (home) {
  return readdirSync(cacheDirFor(home)).filter((name) => name.startsWith('gate-decisions') && name.endsWith('.jsonl')).sort()
}

function readTotals (home) {
  return JSON.parse(readFileSync(join(cacheDirFor(home), GATE_DECISION_TOTALS_FILE), 'utf8'))
}

function foldedNames (home) {
  return readTotals(home).files.map((file) => file.name)
}

test('T1: folding every file older than 8 days deletes them and changes no window, count or list', async () => {
  const home = makeHome()
  const now = Date.now()
  const { folds, live } = writeFixture(home, now)
  const before = readAll(home)
  assert.equal(before.gate.totalDecisions, 15, 'the fixture is what this test thinks it is')
  assert.equal(before.gate.corruptLines, 4)
  assert.equal(before.abJev, 5)

  const result = await foldGateDecisionLog(cacheDirFor(home), now)
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.folded, folds)
  assert.deepEqual(result.deleted, folds)
  assert.deepEqual(gateFiles(home), [...live].sort())
  assert.deepEqual(foldedNames(home), folds)

  assert.deepEqual(readAll(home), before)
})

test('T1: a fold interrupted between writing the totals and deleting a file counts nothing twice, and the next run deletes it', async () => {
  const home = makeHome()
  const now = Date.now()
  const { folds, live } = writeFixture(home, now)
  const before = readAll(home)

  const crashed = await foldGateDecisionLog(cacheDirFor(home), now, { remove: async () => { throw new Error('killed') } })
  assert.equal(crashed.status, 'ok')
  assert.deepEqual(crashed.deleted, [])
  assert.deepEqual(gateFiles(home), [...folds, ...live].sort(), 'nothing deleted')
  assert.deepEqual(foldedNames(home), folds, 'the totals already hold them')
  assert.deepEqual(readAll(home), before)

  // Not due for a new fold yet, but what an earlier run folded is still deleted.
  const finished = await foldGateDecisionLog(cacheDirFor(home), now + HOUR)
  assert.deepEqual(finished.folded, [])
  assert.deepEqual(gateFiles(home), [...live].sort())
  assert.deepEqual(readAll(home), before)

  // A run that finds them gone forgets their names.
  await foldGateDecisionLog(cacheDirFor(home), now + 2 * HOUR)
  assert.deepEqual(foldedNames(home), [])
  assert.deepEqual(readAll(home), before)
})

test('T1: a file is never deleted when its totals could not be written', async () => {
  const home = makeHome()
  const now = Date.now()
  const { folds, live } = writeFixture(home, now)
  const before = readAll(home)
  // Where the new totals are written first: a directory there fails the write.
  mkdirSync(join(cacheDirFor(home), `${GATE_DECISION_TOTALS_FILE}.tmp`))
  await assert.rejects(foldGateDecisionLog(cacheDirFor(home), now))
  assert.equal(existsSync(join(cacheDirFor(home), GATE_DECISION_TOTALS_FILE)), false)
  assert.deepEqual(gateFiles(home), [...folds, ...live].sort())
  assert.deepEqual(readAll(home), before, 'and a reader still reads every file')
  assert.equal(existsSync(join(cacheDirFor(home), GATE_DECISION_TOTALS_LOCK_FILE)), false, 'the lock is released')
})

test('T1: an unreadable totals file stops the fold; it is never replaced by fresh totals', async () => {
  const home = makeHome()
  const now = Date.now()
  writeFixture(home, now)
  writeFileSync(join(cacheDirFor(home), GATE_DECISION_TOTALS_FILE), '{"schema":1,"files":')
  const before = gateFiles(home)
  const result = await foldGateDecisionLog(cacheDirFor(home), now)
  assert.equal(result.status, 'unreadable-totals')
  assert.deepEqual(gateFiles(home), before)
  assert.equal(readFileSync(join(cacheDirFor(home), GATE_DECISION_TOTALS_FILE), 'utf8'), '{"schema":1,"files":')
})

test('T1: the fold looks for new files at most once a day, and folds them when it does', async () => {
  const home = makeHome()
  const now = Date.now()
  const { live } = writeFixture(home, now)
  await foldGateDecisionLog(cacheDirFor(home), now)
  const before = readAll(home)
  const later = now - 10 * DAY
  writeLines(home, hourName(later), [row(inHour(later, 3), { source: 'jev', latencyMs: 90, pluginVersion: '0.6.18' })])
  const withNew = readAll(home)
  assert.equal(withNew.gate.totalDecisions, before.gate.totalDecisions + 1)

  const soon = await foldGateDecisionLog(cacheDirFor(home), now + 23 * HOUR)
  assert.deepEqual(soon.folded, [])
  assert.ok(gateFiles(home).includes(hourName(later)))

  const nextDay = await foldGateDecisionLog(cacheDirFor(home), now + 24 * HOUR)
  assert.deepEqual(nextDay.folded, [hourName(later)])
  assert.deepEqual(gateFiles(home), [...live].sort())
  assert.deepEqual(readAll(home), withNew)
})

test('T1: the legacy file stays whole while it holds a decision from the last 8 days, and so does every file after it', async () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [row(now - 20 * DAY), row(now - 3 * DAY)])
  writeLines(home, hourName(now - 15 * DAY), [row(now - 15 * DAY)])
  const before = readAll(home)
  const result = await foldGateDecisionLog(cacheDirFor(home), now)
  assert.deepEqual(result.folded, [])
  assert.deepEqual(gateFiles(home), ['gate-decisions.jsonl', hourName(now - 15 * DAY)].sort())
  assert.deepEqual(readAll(home), before)
})

test('T1: a fold already running is left alone; a lock left by a dead fold is taken over', async () => {
  const home = makeHome()
  const now = Date.now()
  writeFixture(home, now)
  const lock = join(cacheDirFor(home), GATE_DECISION_TOTALS_LOCK_FILE)
  writeFileSync(lock, '')
  const before = gateFiles(home)
  assert.equal((await foldGateDecisionLog(cacheDirFor(home), now)).status, 'locked')
  assert.deepEqual(gateFiles(home), before)

  const stale = new Date(Date.now() - 20 * 60 * 1000)
  utimesSync(lock, stale, stale)
  assert.equal((await foldGateDecisionLog(cacheDirFor(home), now)).status, 'ok')
  assert.equal(existsSync(lock), false)
})

test('T1: with every file folded, the A/B count still reads the Jev decisions instead of "no log"', async () => {
  const home = makeHome()
  const now = Date.now()
  const old = now - 12 * DAY
  writeLines(home, hourName(old), [row(old, { source: 'jev', latencyMs: 10 }), row(old, { source: 'cache' })])
  assert.equal(countRealJevDecisions(cacheDirFor(home)), 1)
  await foldGateDecisionLog(cacheDirFor(home), now)
  assert.deepEqual(gateFiles(home), [])
  assert.equal(countRealJevDecisions(cacheDirFor(home)), 1)
  const empty = makeHome()
  await foldGateDecisionLog(cacheDirFor(empty), now)
  assert.equal(countRealJevDecisions(cacheDirFor(empty)), null, 'nothing ever logged is still no log')
})

test('T1: the fold works inside the permission sandbox the consumption sidecar runs in', () => {
  const home = makeHome()
  const now = Date.now()
  const { live } = writeFixture(home, now)
  const cache = cacheDirFor(home)
  const code = `import { foldGateDecisionLog } from ${JSON.stringify(join(__dirname, 'gate-log-fold.mjs'))}; process.stdout.write(JSON.stringify(await foldGateDecisionLog(${JSON.stringify(cache)}, ${now})))`
  const stdout = execFileSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${cache}`, `--allow-fs-write=${cache}`, '--input-type=module', '-e', code], { env: envFor(home), encoding: 'utf8' })
  assert.equal(JSON.parse(stdout).status, 'ok')
  assert.deepEqual(gateFiles(home), [...live].sort())
})

test('T1: the legacy file and the first hour files overlap in time (two builds wrote both during the upgrade); folded together, the Jev failure streak stays exact', async () => {
  const home = makeHome()
  const now = Date.now()
  const start = inHour(now - 20 * DAY, 0)
  const minute = 60 * 1000
  // Old build: Jev answered at :10, then failed at :50. New build, same hour: failed at :20, answered at :30.
  writeLines(home, 'gate-decisions.jsonl', [
    row(start + 10 * minute, { source: 'jev', latencyMs: 100, pluginVersion: '0.6.16' }),
    row(start + 50 * minute, { source: 'none', pluginVersion: '0.6.16' }),
  ])
  writeLines(home, hourName(start), [
    row(start + 20 * minute, { source: 'none', pluginVersion: '0.6.17' }),
    row(start + 30 * minute, { source: 'jev', latencyMs: 200, pluginVersion: '0.6.17' }),
  ])
  const before = readAll(home)
  assert.equal(before.gate.health.consecutiveFailures, 1)
  const result = await foldGateDecisionLog(cacheDirFor(home), now)
  assert.deepEqual(result.folded, ['gate-decisions.jsonl', hourName(start)])
  assert.deepEqual(readAll(home), before)
})

test('T1: a file recreated under a folded name is read as new, never skipped as folded', async () => {
  const home = makeHome()
  const now = Date.now()
  writeLines(home, 'gate-decisions.jsonl', [row(now - 20 * DAY, { source: 'jev', latencyMs: 10 })])
  // Folded, but stopped before the delete: the name stays in the totals.
  await foldGateDecisionLog(cacheDirFor(home), now, { remove: async () => { throw new Error('killed') } })
  const folded = readAll(home)
  assert.equal(folded.gate.totalDecisions, 1)
  // An older copy of the plugin deletes and writes the legacy file again.
  rmSync(join(cacheDirFor(home), 'gate-decisions.jsonl'))
  writeLines(home, 'gate-decisions.jsonl', [row(now - HOUR, { source: 'jev', latencyMs: 20 }), row(now - HOUR, { source: 'cache' })])
  const recreated = readAll(home)
  assert.equal(recreated.gate.totalDecisions, 3)
  assert.equal(recreated.abJev, 2)
})
