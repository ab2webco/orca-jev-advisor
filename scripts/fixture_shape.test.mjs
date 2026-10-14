// The screenshot harness's fixtures have drifted from the shapes the worker
// really publishes FOUR times, and every one of them was found by a human
// looking at an image, never by a test:
//
//   1. `isConfigured` instead of `configured` -- the key panel rendered
//      "No key configured" while the filename claimed a configured one.
//   2. A heartbeat frozen at module load -- every `ready` screenshot after
//      the first forty seconds photographed the dead-worker banner.
//   3. `gate.total` / `byFamily` / `latencyMs {median,p90}` instead of
//      `gate.totalDecisions` / `byCommandFamily` / `jevLatency` -- every
//      populated gate screenshot photographed the EMPTY state.
//   4. `policies: { rules: [] }` instead of an array -- the panel's
//      `.forEach` threw, its own catch painted a red error across the
//      bottom of the settings panel, and the harness reported "no script
//      errors" in the same breath, because a caught throw never reaches
//      pageerror.
//
// Four is not bad luck. This file compares the fixtures against the real
// producers, so the fifth time fails a test instead of shipping a
// photograph of a panel nobody will ever see.

import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { importOptional } from './optional_import.mjs'

// screenshot-panels.mjs imports `playwright` itself, unguarded, at its own
// top -- so a machine with no playwright (this file's own header: every
// fixture in it exists to catch drift a human would otherwise find by eye)
// throws ERR_MODULE_NOT_FOUND here before a single test even registers,
// instead of skipping. importOptional (JEVADV-35, review-3ca73b9da09b0927
// R2/R3) treats ONLY that exact failure as "not installed": a bare
// `catch {}` here used to also swallow a syntax error or a broken export in
// screenshot-panels.mjs as if playwright were merely absent, silently
// skipping every fixture-shape test on a real defect instead of failing.
const imported = await importOptional('./screenshot-panels.mjs', 'playwright')
let SCENARIOS = null
if (imported !== null) {
  ;({ SCENARIOS } = imported)
  if (SCENARIOS === undefined) {
    // A dynamic import that succeeds but does not export what this file
    // expects does NOT throw on its own -- destructuring an absent named
    // export just yields `undefined`. Left unchecked, a renamed or removed
    // `SCENARIOS` export would look identical to "playwright is not
    // installed" and skip every test below instead of failing loudly.
    throw new Error('screenshot-panels.mjs no longer exports SCENARIOS -- a renamed or removed export must fail this file, not be treated as "playwright is not installed"')
  }
}

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const READY = SCENARIOS?.ready
const SKIP_NO_PLAYWRIGHT = { skip: SCENARIOS ? false : 'playwright is not installed' }

/** Every key path in `fixture`, as dotted strings. Arrays contribute their
 *  first element's keys under `[]`, which is enough to catch a renamed field
 *  and cheap enough to stay readable in a failure message. */
function keyPaths (value, prefix = '') {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : keyPaths(value[0], `${prefix}[]`)
  }
  if (value === null || typeof value !== 'object') return []
  return Object.keys(value).flatMap((key) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return [path, ...keyPaths(value[key], path)]
  })
}

/** Runs the real aggregator against an empty home, so it reports the shape
 *  it publishes rather than this machine's own numbers. */
async function realMeasurementsSummary () {
  const home = mkdtempSync(join(tmpdir(), 'orca-fixture-shape-'))
  try {
    // One row per log, in the format each writer really emits, so the
    // aggregator's arrays come back non-empty and their element keys can be
    // compared too. An empty home would leave every array at [], which is
    // exactly where the third drift (byFamily vs byCommandFamily) hid.
    const cache = join(home, '.cache', 'orca-supervisor')
    mkdirSync(cache, { recursive: true })
    // Sixteen intervening families an hour ago, so every time window gets
    // its interventions rows AND a rest row, and the fixture's keys under
    // both are compared rather than skipped as an empty array or a null.
    const recentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const gateRows = [{
      type: 'gate-decision', id: 'r1', at: recentAt, project: 'p',
      commandFamily: 'git', source: 'jev', verdict: 'allow', latencyMs: 400,
    }]
    for (let i = 0; i < 16; i += 1) {
      gateRows.push({
        type: 'gate-decision', id: `ask-${i}`, at: recentAt, project: 'p',
        commandFamily: `family-${i}`, source: 'local-rule', verdict: 'ask', latencyMs: null,
      })
    }
    writeFileSync(join(cache, 'gate-decisions.jsonl'), gateRows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    // 0.6.8 T5: one queued item, so gate.waiting's own keys are compared too.
    writeFileSync(join(cache, 'human-queue.jsonl'), `${JSON.stringify({
      type: 'queued', id: 'q1', at: recentAt, key: 'k1', project: 'p', policyId: 'client_always_asks', command: 'gh pr merge 1',
    })}\n`)
    writeFileSync(join(cache, 'ab-benchmark-results.jsonl'), `${JSON.stringify({
      id: 'a1', at: '2026-09-24T10:00:00.000Z', commandFamily: 'cd', destinationKind: null,
      jev: { verdict: 'allow', latencyMs: 200, inputTokens: 10, outputTokens: 2 },
      bigModel: {
        latencyMs: 4000, inputTokens: 1, outputTokens: 3, cacheCreationInputTokens: 5,
        cacheReadInputTokens: 7, modelId: 'claude-opus-5-5[1m]', verdict: 'ask', failureReason: null,
      },
      agree: false,
    })}\n`)
    // The memory module's row (src/core/memory_shadow.ts memoryShadowRecord), so `memory.latest` is compared too.
    writeFileSync(join(cache, `memory-decisions-${recentAt.slice(0, 13)}.jsonl`), `${JSON.stringify({
      at: recentAt, account: 'home', project: 'p', mode: 'shadow', sessionId: 's', backend: 'live', decidedBy: 'tools+health', permission: 'ok', detectedAt: 'start',
      gate: 'skip', gateMs: 300, gateTokens: { input: 900, output: 1, cacheRead: 0, cacheWrite: 0 }, forkSampled: false, fork: null, forkMs: null, forkTokens: null,
      wouldSave: { user: 0, feedback: 0, project: 0, reference: 0 }, wouldUpdate: 0, wouldDelete: 0, toEngram: 0, toAutoMemory: 0, judgeBuilds: 0,
      mainEngramSaves: 0, mainEngramSaveTypes: {}, mainJudges: 0, mainCandidates: 0, mainAutoMemoryWrites: 0, agreement: 'neither',
    })}\n`)
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'adapters', 'orca', 'read-measurements.mjs')],
      { env: { ...process.env, HOME: home, USERPROFILE: home, NODE_TEST_CONTEXT: undefined }, cwd: ROOT }
    )
    return JSON.parse(stdout)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the ready fixture\'s measurementsSummary carries only keys read-measurements.mjs really publishes', SKIP_NO_PLAYWRIGHT, async () => {
  const real = await realMeasurementsSummary()
  assert.equal(real.ok, true, `the aggregator failed: ${JSON.stringify(real)}`)
  const realPaths = new Set(keyPaths(real))
  const missing = keyPaths(READY.measurementsSummary).filter((path) => !realPaths.has(path))
  assert.deepEqual(missing, [], `fixture keys the worker never publishes: ${missing.join(', ')}`)
})

test('the ready fixture stores policies as the array the panel iterates', SKIP_NO_PLAYWRIGHT, () => {
  assert.ok(Array.isArray(READY.policies), 'policies must be an array -- the panel calls .forEach on it')
  for (const row of READY.policies) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.rule, 'string')
    assert.equal(typeof row.kind, 'string')
  }
})

test('the ready fixture stores the catalog and the board in the shapes their panels read', SKIP_NO_PLAYWRIGHT, () => {
  assert.ok(Array.isArray(READY.catalog.destinations), 'catalog.destinations must be an array')
  assert.ok(Array.isArray(READY.board.entries), 'board.entries must be an array')
})

test('the ready fixture uses the secret-status field the worker writes, not the one an earlier draft guessed', SKIP_NO_PLAYWRIGHT, () => {
  assert.equal(typeof READY.secretStatus.configured, 'boolean')
  assert.equal(READY.secretStatus.isConfigured, undefined, 'isConfigured is the old wrong name')
})

test('the heartbeat is resolved per page, never pinned at module load', SKIP_NO_PLAYWRIGHT, () => {
  assert.equal(READY.workerHeartbeat.at, 'now',
    "a literal timestamp goes stale mid-run; hostBridge resolves the sentinel 'now' when the page asks")
})

test('the empty fixture is exactly what read-measurements.mjs publishes for an empty home, apart from the clock-derived window bounds', SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-fixture-empty-'))
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'adapters', 'orca', 'read-measurements.mjs')],
      { env: { ...process.env, HOME: home, USERPROFILE: home, NODE_TEST_CONTEXT: undefined }, cwd: ROOT }
    )
    const real = JSON.parse(stdout)
    // `since` on the day and week windows is now minus 24h / 7d: it moves
    // with the clock, so it is the one field a literal cannot match.
    // W1 (odd/tasks/board-global-window.md): so do `sinceMs` and
    // `coverageSinceMs`, on the gate's windows and on the skills mod's.
    const unbound = (windows) => Object.fromEntries(Object.entries(windows).map(([key, w]) => [key, { ...w, since: null, sinceMs: null, coverageSinceMs: null }]))
    const withoutBounds = (summary) => ({
      ...summary,
      gate: { ...summary.gate, windows: unbound(summary.gate.windows) },
      modSkills: { ...summary.modSkills, windows: unbound(summary.modSkills.windows) },
      modules: Object.fromEntries(Object.entries(summary.modules).map(([name, part]) => [name, { ...part, windows: unbound(part.windows) }])),
    })
    assert.deepEqual(withoutBounds(SCENARIOS.empty.measurementsSummary), withoutBounds(real))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// 0.6.28 T4: the Rules tab's remembered authorizations. The fixture is
// `{ ok, repos, checkedAt }` as publishGateAuthorizations stores it, its rows
// in exactly the shape the real sidecar answers.
test('ready.gateAuthorizationsStatus has the keys the real gate-authorizations sidecar publishes', SKIP_NO_PLAYWRIGHT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-fixture-shape-auth-'))
  try {
    const now = new Date().toISOString()
    writeFileSync(join(dir, 'gate-authorizations.json'), JSON.stringify({ version: 1, repos: { 'github.com/acme/widgets': { 'pr-merge': { firstAt: now, lastAt: now, uses: 1 } } } }))
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', join(ROOT, 'adapters', 'orca', 'gate-authorizations.mjs'), 'read'],
      { env: { ...process.env, ORCA_SUPERVISOR_CACHE_DIR: dir }, cwd: ROOT }
    )
    const real = JSON.parse(stdout)
    assert.equal(real.ok, true)
    const fixture = READY.gateAuthorizationsStatus
    assert.deepEqual(Object.keys(fixture).sort(), ['checkedAt', 'ok', 'repos'])
    assert.deepEqual(keyPaths(fixture.repos).sort(), keyPaths(real.value.repos).sort())
    assert.ok(fixture.repos.some((row) => row.classes.length >= 2), 'one repository holds two or more classes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 0.6.28 T7: the Rules tab's trusted programs. The fixture is what the real
// worker's publishTrustedPrograms stores, built from the same validated list.
test('ready.trustedProgramsStatus has the keys the real worker publishes, and two programs', SKIP_NO_PLAYWRIGHT, async () => {
  // main.mjs resolves its config and cache dirs at import; under the test
  // runner they must be explicit test directories (src/core/paths.ts).
  const paths = mkdtempSync(join(tmpdir(), 'orca-fixture-shape-trusted-'))
  process.env.ORCA_SUPERVISOR_CONFIG_DIR ??= join(paths, 'config')
  process.env.ORCA_SUPERVISOR_CACHE_DIR ??= join(paths, 'cache')
  const { publishTrustedPrograms, TRUSTED_PROGRAMS_STATUS_KEY } = await import('../adapters/orca/main.mjs')
  const store = { trustedPrograms: ['acme-notify'] }
  const host = { get: async (key) => store[key] ?? null, set: async (key, value) => { store[key] = value }, delete: async (key) => { delete store[key] }, keys: async () => Object.keys(store) }
  await publishTrustedPrograms({ log: () => {} }, host)
  const real = store[TRUSTED_PROGRAMS_STATUS_KEY]
  const fixture = READY.trustedProgramsStatus
  assert.deepEqual(Object.keys(fixture).sort(), Object.keys(real).sort())
  assert.equal(fixture.programs.length, 2)
  rmSync(paths, { recursive: true, force: true })
})

// feature-modules T5: the Modules section reads status().modules, the
// installer's per-module summary. The fixtures are held to what the real
// installer reports (a throwaway HOME, nothing installed, with and without a
// module file), so a renamed field fails here instead of photographing a
// section nobody will ever see.
test('the fixtures\' integration status carries the modules the real installer reports', SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-fixture-shape-modules-'))
  try {
    const configDir = join(home, '.config', 'orca-supervisor')
    const status = async () => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, ORCA_SUPERVISOR_CONFIG_DIR: configDir, NODE_TEST_CONTEXT: undefined }
      delete env.ORCA_USER_DATA_PATH
      delete env.XDG_CONFIG_HOME
      const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'adapters', 'orca', 'install-claude-integration.mjs'), 'status', ROOT], { env, cwd: ROOT })
      return JSON.parse(stdout)
    }
    const defaults = await status()
    assert.equal(defaults.ok, true)
    for (const name of ['ready', 'modules-mixed', 'modules-skipped']) {
      const fixture = SCENARIOS[name].claudeIntegrationStatus.modules
      assert.deepEqual(keyPaths(fixture).sort(), keyPaths(defaults.modules).sort(), name)
    }
    assert.deepEqual(Object.keys(READY.claudeIntegrationStatus.modules), Object.keys(defaults.modules))
    // Hook counts are the installer's own, not typed twice with a chance to drift.
    for (const [id, info] of Object.entries(defaults.modules)) assert.equal(READY.claudeIntegrationStatus.modules[id].hookCount, info.hookCount, id)
    // The gate chosen off with nothing installed: the fixture's off row is exactly that.
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'feature-modules.json'), JSON.stringify({ modules: { gate: 'off' } }))
    const gateOff = await status()
    assert.deepEqual(SCENARIOS['modules-mixed'].claudeIntegrationStatus.modules.gate, gateOff.modules.gate)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// odd/tasks/board-global-window.md W1: the consumption and activity readers
// now publish one summary per board window. Their fixtures are held to the
// keys the real readers publish, so a renamed or dropped field fails here.
async function realSidecar (script, writeRows) {
  const home = mkdtempSync(join(tmpdir(), 'orca-fixture-shape-windows-'))
  try {
    const cache = join(home, '.cache', 'orca-supervisor')
    const config = join(home, '.config', 'orca-supervisor')
    mkdirSync(cache, { recursive: true })
    writeRows(cache)
    const env = { ...process.env, HOME: home, USERPROFILE: home, ORCA_SUPERVISOR_CACHE_DIR: cache, ORCA_SUPERVISOR_CONFIG_DIR: config, NODE_TEST_CONTEXT: undefined }
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'adapters', 'orca', script)], { env, cwd: ROOT })
    return JSON.parse(stdout)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function seedWindowedLogs (cache) {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const hour = at.slice(0, 13)
  const line = (row) => `${JSON.stringify(row)}\n`
  writeFileSync(join(cache, 'gate-decisions.jsonl'), line({ type: 'gate-decision', id: 'g1', at, project: 'p', commandFamily: 'git', source: 'jev', verdict: 'ask', latencyMs: 400, pluginVersion: '0.11.0' }))
  writeFileSync(join(cache, `turn-usage-${hour}.jsonl`), line({ at, agent: 'main', model: 'claude-sonnet-5-5', effort: null, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, stopReason: 'end_turn', account: 'home', project: 'p' }))
  writeFileSync(join(cache, `model-router-decisions-${hour}.jsonl`), line({ at, account: 'home', project: 'p', point: 'stage', tier: 'simple', applied: true, proposed: 'claude-sonnet-5-5', switchCost: 0.01, stepSaving: 0.02 }))
  writeFileSync(join(cache, `context-steward-decisions-${hour}.jsonl`),
    line({ at, account: 'home', project: 'p', mode: 'active', contextBefore: 150000, decision: 'boundary', confidence: 0.9, compact: true, applied: true, contextAfter: 30000 }) +
    // A measured pre-cold fire, so preCold's own keys are compared too.
    line({ at, account: 'home', project: 'p', sessionId: 's', trigger: 'pre-cold', decision: 'pre-cold', mode: 'measure', contextBefore: 150000, confidence: 0.9, compact: true, applied: false, contextAfter: null, wouldFire: 'pre-cold' }))
  writeFileSync(join(cache, `typing-${hour}.jsonl`), line({ type: 'typing', at, sessionId: 's', origin: 'composer', kind: 'composer', gapMs: 900, edits: 3 }))
}

test('the windowed consumption fixtures carry only keys read-consumption.mjs really publishes', SKIP_NO_PLAYWRIGHT, async () => {
  const real = await realSidecar('read-consumption.mjs', seedWindowedLogs)
  assert.equal(real.ok, true, JSON.stringify(real))
  const realPaths = new Set(keyPaths(real))
  for (const name of ['consumption-ready', 'router-ready', 'skills-ready']) {
    const fixture = SCENARIOS[name].consumptionSummary
    // The windowed parts only: quota and recommendations come from this machine's config, and checkedAt from the worker.
    const windowed = /^(usage|modelRouter|steward|typing)\./
    const missing = keyPaths(fixture).filter((path) => windowed.test(path) && !realPaths.has(path))
    assert.deepEqual(missing, [], `${name}: fixture keys the worker never publishes: ${missing.join(', ')}`)
  }
})

test('the windowed activity fixture carries only keys read-activity.mjs really publishes', SKIP_NO_PLAYWRIGHT, async () => {
  const real = await realSidecar('read-activity.mjs', seedWindowedLogs)
  assert.equal(real.ok, true, JSON.stringify(real))
  const realPaths = new Set(keyPaths(real))
  const missing = keyPaths(SCENARIOS['activity-ready'].activityByProjectSummary).filter((path) => path !== 'checkedAt' && !realPaths.has(path))
  assert.deepEqual(missing, [], `fixture keys the worker never publishes: ${missing.join(', ')}`)
})
