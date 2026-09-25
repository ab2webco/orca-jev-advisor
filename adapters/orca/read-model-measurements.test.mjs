// Exercises read-model-measurements.mjs as the CLI it actually is (it runs
// `main()` unconditionally at import, same discipline as
// read-measurements.mjs's own test suite), against a throwaway HOME --
// never the real one. See models-worker.mjs's publishModelMeasurements for
// how this sidecar is spawned in production.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'read-model-measurements.mjs')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-read-model-measurements-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Same cache-dir shape resolveCacheDir (src/core/paths.ts) falls back to on
 *  both darwin and linux once XDG_CACHE_HOME is unset: `<home>/.cache/
 *  orca-supervisor`. Windows is explicitly out of scope for this task. */
function logPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'model-reclassifications.jsonl')
}

function writeLog (home, lines) {
  const path = logPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
}

function run (home, catalog) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  // src/core/paths.ts's resolveCacheDir refuses to compute a real path at
  // all under node's test runner (see that module's doc) -- this points it
  // at exactly the directory it would have computed for `home` on darwin
  // with no XDG override, matching logPathFor above.
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8', input: JSON.stringify(catalog ?? []) })
  return JSON.parse(stdout)
}

const SONNET = {
  id: 'claude-sonnet-5', provider: 'anthropic', label: 'Sonnet 5', rank: 1,
  agentModel: 'sonnet', source: 'https://example.test/doc', available: true,
}
const HAIKU = {
  id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Haiku 4.5', rank: 2,
  agentModel: 'haiku', source: 'https://example.test/doc', available: true,
}

function decisionRow (id, overrides = {}) {
  return {
    type: 'model-decision', id, at: '2026-01-01T00:00:00.000Z', mode: 'measurement',
    source: 'jev', failOpen: null, subagentType: null, promptChars: 10,
    requestedModel: 'haiku',
    recommended: { id: 'claude-sonnet-5', agentModel: 'sonnet', rank: 1 },
    score: 1, confidence: 0.9, applied: false, rewriteReason: 'measurement',
    ladderSize: 2, latencyMs: 100, permissionMode: null, complexity: null,
    ...overrides,
  }
}

test('a missing log file reads as zero decisions, never a crash', () => {
  const home = makeHome()
  const result = run(home, [SONNET, HAIKU])
  assert.equal(result.ok, true)
  assert.equal(result.summary.decisions, 0)
  assert.equal(result.summary.judged, 0)
})

test('summarizes real decisions against the catalog passed over stdin, up/down by rank', () => {
  const home = makeHome()
  writeLog(home, [decisionRow('a')])
  const result = run(home, [SONNET, HAIKU])
  assert.equal(result.ok, true)
  assert.equal(result.summary.decisions, 1)
  assert.equal(result.summary.judged, 1)
  assert.equal(result.summary.compared, 1)
  assert.equal(result.summary.up, 1, 'requested haiku (rank 2), recommended sonnet (rank 1) -- an upgrade')
})

test('a corrupt line is skipped, never thrown on', () => {
  const home = makeHome()
  const path = logPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'not json at all\n', 'utf8')
  const result = run(home, [])
  assert.equal(result.ok, true)
  assert.equal(result.summary.decisions, 0)
})

test('an unparseable stdin catalog reports ok:false with a reason, never a stack trace', () => {
  const home = makeHome()
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8', input: 'not json' })
  const result = JSON.parse(stdout)
  assert.equal(result.ok, false)
  assert.equal(typeof result.reason, 'string')
})
