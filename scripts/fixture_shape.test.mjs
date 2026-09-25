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

// screenshot-panels.mjs imports `playwright` itself, unguarded, at its own
// top -- so this import is guarded the same way scripts/panels.spec.mjs
// guards its own SCENARIOS import, or a machine with no playwright (this
// file's own header: every fixture in it exists to catch drift a human
// would otherwise find by eye) would throw ERR_MODULE_NOT_FOUND here before
// a single test even registers, instead of skipping.
let SCENARIOS = null
try {
  ({ SCENARIOS } = await import('./screenshot-panels.mjs'))
} catch {
  SCENARIOS = null
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
    writeFileSync(join(cache, 'ab-benchmark-results.jsonl'), `${JSON.stringify({
      id: 'a1', at: '2026-09-24T10:00:00.000Z', commandFamily: 'cd', destinationKind: null,
      jev: { verdict: 'allow', latencyMs: 200, inputTokens: 10, outputTokens: 2 },
      bigModel: {
        latencyMs: 4000, inputTokens: 1, outputTokens: 3, cacheCreationInputTokens: 5,
        cacheReadInputTokens: 7, modelId: 'claude-opus-5-5[1m]', verdict: 'ask', failureReason: null,
      },
      agree: false,
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
    const withoutBounds = (summary) => ({
      ...summary,
      gate: {
        ...summary.gate,
        windows: Object.fromEntries(Object.entries(summary.gate.windows).map(([key, w]) => [key, { ...w, since: null }])),
      },
    })
    assert.deepEqual(withoutBounds(SCENARIOS.empty.measurementsSummary), withoutBounds(real))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
