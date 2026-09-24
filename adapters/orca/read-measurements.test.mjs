// odd/tasks/production-honesty-pass.md P6: the config panel's skills-mod
// line needs "recording N prompts since <date>, most recently <date>" --
// read-measurements.mjs already counted `totalDecisions` from
// mod-skills-measurements.jsonl (board.html's own stat tiles use it) but
// never surfaced when the first and most recent of those decisions
// happened. This exercises read-measurements.mjs as the CLI it actually is
// (it runs `main()` unconditionally at import, same as install-claude-
// integration.mjs), against a throwaway HOME -- never the real one.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'read-measurements.mjs')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-read-measurements-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Same cache-dir shape resolveCacheDir (src/core/paths.ts) falls back to on
 *  both darwin and linux once XDG_CACHE_HOME is unset: `<home>/.cache/
 *  orca-supervisor`. Windows is explicitly out of scope for this task. */
function modSkillsLogPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'mod-skills-measurements.jsonl')
}

function writeModSkillsLog (home, lines) {
  const path = modSkillsLogPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
}

function decisionRow (id, at) {
  return {
    type: 'decision', id, at, mode: 'measurement', prompt: 'irrelevant',
    orcaContext: { worktree: null, proyecto: 'app', rama: null },
    candidateCount: 2, listingChars: 120,
    wide: null, fit: null,
    decision: { name: null, reason: 'no candidate cleared the gate' },
    latencyMs: { wide: null, fit: null }
  }
}

function run (home) {
  const env = { ...process.env, HOME: home }
  delete env.XDG_CACHE_HOME
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

test('modSkills reports firstAt/lastAt as null when there are no recorded prompts at all', () => {
  const home = makeHome()
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.modSkills.totalDecisions, 0)
  assert.equal(result.modSkills.firstAt, null)
  assert.equal(result.modSkills.lastAt, null)
})

test('modSkills reports firstAt/lastAt from the actual recorded decisions, not file order', () => {
  const home = makeHome()
  // Deliberately out of chronological order on disk -- firstAt/lastAt must
  // come from the timestamps themselves, never from line position.
  writeModSkillsLog(home, [
    decisionRow('b', '2026-09-20T10:00:00.000Z'),
    decisionRow('a', '2026-09-18T08:00:00.000Z'),
    decisionRow('c', '2026-09-22T14:30:00.000Z')
  ])
  const result = run(home)
  assert.equal(result.modSkills.totalDecisions, 3)
  assert.equal(result.modSkills.firstAt, '2026-09-18T08:00:00.000Z')
  assert.equal(result.modSkills.lastAt, '2026-09-22T14:30:00.000Z')
})

test('modSkills ignores observation rows and malformed timestamps when computing firstAt/lastAt', () => {
  const home = makeHome()
  writeModSkillsLog(home, [
    decisionRow('a', '2026-09-19T00:00:00.000Z'),
    { type: 'observation', id: 'a', at: '2026-09-19T00:05:00.000Z', skill: 'graft' },
    decisionRow('b', 'not-a-real-timestamp')
  ])
  const result = run(home)
  assert.equal(result.modSkills.totalDecisions, 2, 'both decision rows still count toward totalDecisions')
  assert.equal(result.modSkills.firstAt, '2026-09-19T00:00:00.000Z')
  assert.equal(result.modSkills.lastAt, '2026-09-19T00:00:00.000Z', 'the malformed timestamp must not win as "most recent"')
})

// ---------------------------------------------------------------------------
// mod_skills_sampling.md -- aggregateModSkills exposes a `readiness` field
// built from src/core/mod_skills_readiness.ts's evaluateModSkillsReadiness,
// so a panel can render "not ready yet, N more samples needed" without
// duplicating the threshold logic. These tests only check the wiring (the
// real function's own exhaustive matrix lives in
// src/core/mod_skills_readiness.test.ts) -- reaching the default 1000-
// comparable threshold for real would mean writing a fixture that large,
// which the pure-function test already covers.
// ---------------------------------------------------------------------------

function decisionRowWithSkill (id, at, skillName) {
  return { ...decisionRow(id, at), decision: { name: skillName, reason: 'cleared both gates' } }
}

function observationRow (id, at, skill) {
  return { type: 'observation', id, at, skill }
}

test('modSkills.readiness: with no recorded prompts at all, reports not ready with the full default shortfall and the thresholds used', () => {
  const home = makeHome()
  const result = run(home)
  assert.deepEqual(result.modSkills.readiness, {
    ready: false,
    comparableShortfall: 1000,
    matchRateMet: null,
    reason: 'not-enough-samples',
    thresholds: { minComparable: 1000, minMatchRate: 0.7 }
  })
})

test('modSkills.readiness: reflects real comparable/match data, still short of the count threshold', () => {
  const home = makeHome()
  writeModSkillsLog(home, [
    decisionRowWithSkill('a', '2026-09-19T00:00:00.000Z', 'graft'),
    observationRow('a', '2026-09-19T00:05:00.000Z', 'graft'),
    decisionRowWithSkill('b', '2026-09-19T01:00:00.000Z', 'graft'),
    observationRow('b', '2026-09-19T01:05:00.000Z', 'dataviz')
  ])
  const result = run(home)
  assert.equal(result.modSkills.comparableCount, 2)
  assert.equal(result.modSkills.matchedCount, 1)
  assert.equal(result.modSkills.matchRate, 0.5)
  assert.deepEqual(result.modSkills.readiness, {
    ready: false,
    comparableShortfall: 998,
    matchRateMet: null,
    reason: 'not-enough-samples',
    thresholds: { minComparable: 1000, minMatchRate: 0.7 }
  })
})

// ---------------------------------------------------------------------------
// odd/tasks/production-honesty-pass.md P7 -- src/core/approval_record.ts's
// summarizeApprovals renamed `unresolved` to `notRun` (a pending past its
// TTL with no outcome, classified rather than discarded -- see that
// module's own doc comment on ApprovalSummary.notRun for why it is a
// classification, not a fact). aggregateApprovals must carry the new field
// name through, not silently drop it back to `undefined` on the panel.
// ---------------------------------------------------------------------------

function approvalsLogPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-approvals.jsonl')
}

function writeApprovalsLog (home, lines) {
  const path = approvalsLogPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
}

function pendingRow (toolUseId, at) {
  return { type: 'gate-pending', toolUseId, at, project: 'app', destinationId: 'app', commandFamily: 'rm -rf', shape: 'abc', reversible: 0.4, external: 0.1, consequence: 1.9, ceiling: 1.78 }
}

test('approvals.notRun -- a nine-rules-deny pending with no outcome is reported under notRun, not a dropped/undefined field', () => {
  const home = makeHome()
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() // past UNRESOLVED_AFTER_MS (6h)
  writeApprovalsLog(home, [pendingRow('a', old)])
  const result = run(home)
  assert.equal(result.approvals.asked, 1)
  assert.equal(result.approvals.notRun, 1)
  assert.equal('unresolved' in result.approvals, false, 'the old field name must not linger alongside the new one')
})

// ---------------------------------------------------------------------------
// odd/tasks/advisor-board-charts.md T2 -- an `abBenchmark` aggregate,
// folded from ab-benchmark-results.jsonl (adapters/cli/ab_benchmark_cli.ts,
// src/core/ab_benchmark.ts) via src/core/ab_report.ts's foldAbResults, the
// same cache directory the gate/modSkills/approvals logs already come
// from. A missing file must not be an error -- the A/B benchmark may
// simply never have been run yet, same as gate/modSkills/approvals.
// ---------------------------------------------------------------------------

function abBenchmarkLogPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'ab-benchmark-results.jsonl')
}

function writeAbBenchmarkLog (home, lines) {
  const path = abBenchmarkLogPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n').join(''), 'utf8')
}

/** Mirrors the exact on-disk row shape one real comparison produces (see
 *  odd/tasks/advisor-board-charts.md's own quoted real sample). */
function abResultRow (id, overrides = {}) {
  return {
    id,
    at: '2026-09-24T15:02:03.837Z',
    commandFamily: 'cd',
    destinationKind: null,
    jev: { verdict: 'allow', latencyMs: 236, inputTokens: 464, outputTokens: 53 },
    bigModel: {
      verdict: 'allow',
      latencyMs: 3839,
      inputTokens: 2,
      outputTokens: 34,
      cacheCreationInputTokens: 47338,
      cacheReadInputTokens: 12098,
      modelId: 'claude-opus-5-5[1m]',
      failureReason: null,
    },
    agree: true,
    ...overrides,
  }
}

test('abBenchmark: a missing log file yields the empty summary, not an error', () => {
  const home = makeHome()
  const result = run(home)
  assert.equal(result.ok, true)
  assert.equal(result.abBenchmark.sampleCount, 0)
  assert.equal(result.abBenchmark.jevLatency.medianMs, null)
  assert.equal(result.abBenchmark.agreementRate, null)
  assert.equal(result.abBenchmark.corruptLines, 0)
})

test('abBenchmark: real rows are folded -- sampleCount, agreement, disagreement and modelIds all reflect the actual rows', () => {
  const home = makeHome()
  writeAbBenchmarkLog(home, [
    abResultRow('a', { agree: true }),
    abResultRow('b', {
      agree: false,
      jev: { verdict: 'allow', latencyMs: 300, inputTokens: 10, outputTokens: 2 },
      bigModel: { ...abResultRow('x').bigModel, verdict: 'ask', modelId: 'claude-opus-5-5[1m]' },
    }),
  ])
  const result = run(home)
  assert.equal(result.abBenchmark.sampleCount, 2)
  assert.equal(result.abBenchmark.agreementCount, 1)
  assert.equal(result.abBenchmark.disagreementCount, 1)
  assert.deepEqual(result.abBenchmark.modelIds, ['claude-opus-5-5[1m]'])
  assert.deepEqual(result.abBenchmark.disagreements, [{ jevVerdict: 'allow', bigModelVerdict: 'ask', count: 1 }])
  assert.equal(result.abBenchmark.corruptLines, 0)
})

test('abBenchmark: a hand-edited or half-written line is dropped and counted, never fed to the fold as unknown data', () => {
  const home = makeHome()
  writeAbBenchmarkLog(home, [
    abResultRow('a', { agree: true }),
    '{not valid json at all',
    abResultRow('b', { jev: { verdict: 'allow', latencyMs: 'not-a-number', inputTokens: 1, outputTokens: 1 } }),
    abResultRow('c', { bigModel: { ...abResultRow('x').bigModel, failureReason: 'not-a-real-reason' } }),
  ])
  const result = run(home)
  assert.equal(result.abBenchmark.sampleCount, 1, 'only the one well-formed row is folded')
  assert.equal(result.abBenchmark.corruptLines, 3)
})

test('abBenchmark: a failed comparison is counted in failureCount and excluded from agreement, still visible rather than silently improving the numbers', () => {
  const home = makeHome()
  writeAbBenchmarkLog(home, [
    abResultRow('a', { agree: true }),
    abResultRow('b', {
      agree: null,
      bigModel: {
        verdict: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        modelId: null,
        failureReason: 'cli_not_found',
      },
    }),
  ])
  const result = run(home)
  assert.equal(result.abBenchmark.sampleCount, 2)
  assert.equal(result.abBenchmark.failureCount, 1)
  assert.equal(result.abBenchmark.agreementCount, 1)
  assert.equal(result.abBenchmark.disagreementCount, 0)
})
