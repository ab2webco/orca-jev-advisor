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
  // src/core/paths.ts's resolveCacheDir refuses to compute a real path at
  // all under node's test runner (see its module doc) -- this points it at
  // exactly the directory it would have computed for `home` on darwin with
  // no XDG override, matching modSkillsLogPathFor above.
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
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
// odd/tasks/panel-interventions-and-mod-copy.md T2/T3/T4 -- the gate
// aggregate now carries pluginVersion breakdowns, p95 latency, per-family
// interventions, and (derived from the separate approvals log) a per-family
// notRun count.
// ---------------------------------------------------------------------------

function gateLogPathFor (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-decisions.jsonl')
}

function writeGateLog (home, lines) {
  const path = gateLogPathFor(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
}

function gateDecisionRow (id, overrides = {}) {
  return {
    type: 'gate-decision',
    id,
    at: '2026-09-24T00:00:00.000Z',
    project: 'orca-supervisor',
    commandFamily: 'terraform',
    source: 'local-rule',
    verdict: 'ask',
    latencyMs: null,
    ...overrides,
  }
}

test('gate.byCommandFamily carries interventions per family and a familiesWithNoInterventions total, without dropping the zero-intervention families', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('a', { commandFamily: 'grep', verdict: 'allow', source: 'cache' }),
    gateDecisionRow('b', { commandFamily: 'grep', verdict: 'allow', source: 'cache' }),
    gateDecisionRow('c', { commandFamily: 'terraform', verdict: 'ask', source: 'local-rule' }),
    gateDecisionRow('d', { commandFamily: 'terraform', verdict: 'deny', source: 'local-rule' }),
  ])
  const result = run(home)
  const grep = result.gate.byCommandFamily.find((f) => f.commandFamily === 'grep')
  const terraform = result.gate.byCommandFamily.find((f) => f.commandFamily === 'terraform')
  assert.equal(grep.interventions, 0)
  assert.equal(terraform.interventions, 2)
  assert.equal(result.gate.familiesWithNoInterventions, 1)
})

test('gate.byCommandFamily: a row written under the old "git reset/clean" label counts with "git discard", not as a second family', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('a', { commandFamily: 'git reset/clean', verdict: 'deny', source: 'local-rule' }),
    gateDecisionRow('b', { commandFamily: 'git discard', verdict: 'deny', source: 'local-rule' }),
  ])
  const result = run(home)
  const families = result.gate.byCommandFamily.map((f) => f.commandFamily)
  assert.equal(families.includes('git reset/clean'), false)
  const discard = result.gate.byCommandFamily.find((f) => f.commandFamily === 'git discard')
  assert.equal(discard.interventions, 2)
})

test('gate.jevLatency exposes p95Ms alongside medianMs and maxMs', () => {
  const home = makeHome()
  writeGateLog(home, Array.from({ length: 20 }, (_, i) =>
    gateDecisionRow(`jev-${i}`, { source: 'jev', verdict: 'allow', latencyMs: (i + 1) * 10 })))
  const result = run(home)
  assert.equal(result.gate.jevLatency.p95Ms, 190)
  assert.equal(result.gate.jevLatency.maxMs, 200)
})

test('gate.byPluginVersion and gate.noPluginVersionCount reflect real per-record versions -- a record from before this field existed still counts, never dropped', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('a', { pluginVersion: '0.4.0' }),
    gateDecisionRow('b', { pluginVersion: '0.4.0' }),
    gateDecisionRow('c', { pluginVersion: '0.2.6' }),
    // No `pluginVersion` key at all -- a record written before this field existed.
    (() => { const row = gateDecisionRow('d'); return row })(),
  ])
  const result = run(home)
  assert.deepEqual(result.gate.byPluginVersion, [
    { pluginVersion: '0.4.0', total: 2 },
    { pluginVersion: '0.2.6', total: 1 },
  ])
  assert.equal(result.gate.noPluginVersionCount, 1)
  assert.equal(result.gate.totalDecisions, 4, 'the legacy record must still be counted, not dropped as corrupt')
})

test('gate.notRunByCommandFamily: derived from gate-approvals.jsonl, grouped by the family already recorded on each pending record -- no cross-log join by family needed, only the existing toolUseId join to resolve outcome', () => {
  const home = makeHome()
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() // past UNRESOLVED_AFTER_MS (6h)
  const recent = new Date().toISOString()
  writeApprovalsLog(home, [
    { ...pendingRow('a', old), commandFamily: 'terraform' },
    { ...pendingRow('b', recent), commandFamily: 'kubectl' }, // not past the TTL yet -- must not count as notRun
  ])
  const result = run(home)
  const terraform = result.gate.notRunByCommandFamily.find((f) => f.commandFamily === 'terraform')
  const kubectl = result.gate.notRunByCommandFamily.find((f) => f.commandFamily === 'kubectl')
  assert.equal(terraform.notRun, 1)
  assert.equal(kubectl.notRun, 0)
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

test("a source:'none' record survives the guard instead of being dropped as malformed", () => {
  // The 0.4.0 fail-open fix writes these rows; toGateDecisionRecord's source
  // check did not list 'none', so every one of them was discarded here and
  // the board's "passed unjudged" count could only ever render zero.
  const home = makeHome()
  writeGateLog(home, [gateDecisionRow('n1', { source: 'none', verdict: 'allow', latencyMs: null })])
  const result = run(home)
  assert.equal(result.gate.corruptLines, 0, "a 'none' row is valid, not corrupt")
  assert.equal(result.gate.totalDecisions, 1)
  assert.equal(result.gate.bySource.none, 1)
})

// ---------------------------------------------------------------------------
// odd/tasks/panel-interventions-and-mod-copy.md T10 -- the board asks four
// questions of one time window at a time, so the reader publishes every
// window already folded: `gate.windows.{version,day,week,all}`, each with
// its own interventions table and approvals summary, plus `gate.health`,
// which is about right now and so belongs to no window.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000
function hoursAgo (hours) {
  return new Date(Date.now() - hours * HOUR_MS).toISOString()
}

test('gate.windows: day, week and all each count only the decisions inside their own time bound', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('recent', { at: hoursAgo(2) }),
    gateDecisionRow('days', { at: hoursAgo(72) }),
    gateDecisionRow('month', { at: hoursAgo(24 * 30) }),
  ])
  const { windows } = run(home).gate
  assert.equal(windows.day.totalDecisions, 1)
  assert.equal(windows.week.totalDecisions, 2)
  assert.equal(windows.all.totalDecisions, 3)
  assert.equal(windows.all.since, null, 'the all window has no lower bound')
  assert.equal(typeof windows.day.since, 'string')
})

test('gate.windows: a record whose timestamp does not parse still counts in all, never in a time-bounded window', () => {
  const home = makeHome()
  writeGateLog(home, [gateDecisionRow('bad', { at: 'not a date' })])
  const { windows } = run(home).gate
  assert.equal(windows.all.totalDecisions, 1)
  assert.equal(windows.day.totalDecisions, 0)
  assert.equal(windows.week.totalDecisions, 0)
})

test('gate.windows.*.interventions: at most 15 rows, sorted by interventions, the leftovers folded into rest and the zero-intervention families into quiet', () => {
  const home = makeHome()
  const rows = []
  // 18 intervening families: family-k gets k asks, so family-18 must lead.
  for (let k = 1; k <= 18; k += 1) {
    for (let i = 0; i < k; i += 1) rows.push(gateDecisionRow(`f${k}-${i}`, { commandFamily: `family-${k}`, verdict: 'ask', at: hoursAgo(1) }))
  }
  // A family that runs far more often but never intervenes must not take a row.
  for (let i = 0; i < 200; i += 1) rows.push(gateDecisionRow(`grep-${i}`, { commandFamily: 'grep', verdict: 'allow', source: 'cache', at: hoursAgo(1) }))
  rows.push(gateDecisionRow('ls-1', { commandFamily: 'ls', verdict: 'allow', source: 'cache', at: hoursAgo(1) }))
  rows.push(gateDecisionRow('deny-1', { commandFamily: 'family-1', verdict: 'deny', at: hoursAgo(1) }))
  writeGateLog(home, rows)

  const { interventions } = run(home).gate.windows.all
  assert.equal(interventions.rows.length, 15)
  assert.equal(interventions.rows[0].commandFamily, 'family-18')
  assert.equal(interventions.rows[0].ask, 18)
  assert.equal(interventions.rows.some((r) => r.commandFamily === 'grep'), false)
  for (let i = 1; i < interventions.rows.length; i += 1) {
    const prev = interventions.rows[i - 1]
    const cur = interventions.rows[i]
    assert.ok(prev.ask + prev.deny >= cur.ask + cur.deny, 'rows must be sorted by interventions')
  }
  // family-1 (1 ask + 1 deny = 2), family-2 (2) and family-3 (3) are left over.
  assert.deepEqual(interventions.rest, { families: 3, total: 1 + 1 + 2 + 3, ask: 1 + 2 + 3, deny: 1, notRun: 0 })
  assert.deepEqual(interventions.quiet, { families: 2, total: 201 })
})

test('gate.windows.*.interventions: fewer than 16 intervening families leaves rest null, not a zero row', () => {
  const home = makeHome()
  writeGateLog(home, [gateDecisionRow('a', { commandFamily: 'terraform', verdict: 'ask' })])
  const { interventions } = run(home).gate.windows.all
  assert.equal(interventions.rows.length, 1)
  assert.equal(interventions.rest, null)
  assert.deepEqual(interventions.quiet, { families: 0, total: 0 })
})

test('gate.windows.*.interventions: notRun is joined onto each row from gate-approvals.jsonl, by the family the pending record already carries', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('a', { commandFamily: 'terraform', verdict: 'ask', at: hoursAgo(8) }),
    gateDecisionRow('b', { commandFamily: 'terraform', verdict: 'ask', at: hoursAgo(8) }),
  ])
  writeApprovalsLog(home, [
    { ...pendingRow('p1', hoursAgo(8)), commandFamily: 'terraform' },
    { ...pendingRow('p2', hoursAgo(8)), commandFamily: 'terraform' },
    { type: 'gate-outcome', toolUseId: 'p2', at: hoursAgo(8), outcome: 'approved' },
  ])
  const row = run(home).gate.windows.all.interventions.rows[0]
  assert.deepEqual(row, { commandFamily: 'terraform', total: 2, ask: 2, deny: 0, notRun: 1 })
})

test('gate.windows.*.approvals: each window summarizes only the pending asks inside its own bound', () => {
  const home = makeHome()
  writeApprovalsLog(home, [
    pendingRow('recent', hoursAgo(8)),
    pendingRow('old', hoursAgo(24 * 10)),
    { type: 'gate-outcome', toolUseId: 'old', at: hoursAgo(24 * 10), outcome: 'approved' },
  ])
  const { windows } = run(home).gate
  assert.equal(windows.week.approvals.asked, 1)
  assert.equal(windows.week.approvals.notRun, 1)
  assert.equal(windows.week.approvals.approved, 0)
  assert.equal(windows.all.approvals.asked, 2)
  assert.equal(windows.all.approvals.approved, 1)
  assert.ok('ceiling' in windows.all.approvals, 'the calibration card reads the ceiling evidence per window')
})

test('gate.windows.version: unavailable when no record carries a pluginVersion, never an empty window passed off as real', () => {
  const home = makeHome()
  writeGateLog(home, [gateDecisionRow('a'), gateDecisionRow('b')])
  const { version } = run(home).gate.windows
  assert.equal(version.available, false)
  assert.equal(version.pluginVersion, null)
  assert.equal(version.totalDecisions, 0)
})

test('gate.windows.version: the build of the most recent stamped record, counting only its records, bounded from its first one', () => {
  const home = makeHome()
  const firstNewAt = hoursAgo(20)
  writeGateLog(home, [
    gateDecisionRow('old-build', { at: hoursAgo(50), pluginVersion: '0.3.1', verdict: 'ask' }),
    gateDecisionRow('first-new', { at: firstNewAt, pluginVersion: '0.4.0', verdict: 'deny' }),
    gateDecisionRow('legacy', { at: hoursAgo(10) }),
    gateDecisionRow('last-new', { at: hoursAgo(1), pluginVersion: '0.4.0', verdict: 'allow' }),
  ])
  writeApprovalsLog(home, [
    pendingRow('before', hoursAgo(30)),
    pendingRow('after', hoursAgo(15)),
  ])
  const { version } = run(home).gate.windows
  assert.equal(version.available, true)
  assert.equal(version.pluginVersion, '0.4.0')
  assert.equal(version.totalDecisions, 2)
  assert.deepEqual(version.byVerdict, { allow: 1, ask: 0, deny: 1 })
  assert.equal(version.since, firstNewAt)
  // Pending asks carry no build, so they are bounded by the first decision the build wrote.
  assert.equal(version.approvals.asked, 1)
})

test('gate.health: the last successful Jev call and the unanswered calls since it, ignoring local-rule and cache decisions in between', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('j1', { source: 'jev', verdict: 'allow', latencyMs: 400, at: '2026-09-24T10:00:00.000Z' }),
    gateDecisionRow('j2', { source: 'jev', verdict: 'allow', latencyMs: 410, at: '2026-09-24T11:00:00.000Z' }),
    gateDecisionRow('n1', { source: 'none', verdict: 'allow', at: '2026-09-24T11:05:00.000Z' }),
    gateDecisionRow('c1', { source: 'cache', verdict: 'allow', at: '2026-09-24T11:06:00.000Z' }),
    gateDecisionRow('n2', { source: 'none', verdict: 'allow', at: '2026-09-24T11:07:00.000Z' }),
  ])
  const { health } = run(home).gate
  assert.deepEqual(health, {
    lastJevAt: '2026-09-24T11:00:00.000Z',
    consecutiveFailures: 2,
    lastFailureAt: '2026-09-24T11:07:00.000Z',
  })
})

test('gate.health: by timestamp, not file order -- a Jev answer written out of order still ends the failure streak', () => {
  const home = makeHome()
  writeGateLog(home, [
    gateDecisionRow('n1', { source: 'none', verdict: 'allow', at: '2026-09-24T11:05:00.000Z' }),
    gateDecisionRow('j1', { source: 'jev', verdict: 'allow', latencyMs: 400, at: '2026-09-24T11:10:00.000Z' }),
    gateDecisionRow('n0', { source: 'none', verdict: 'allow', at: '2026-09-24T11:00:00.000Z' }),
  ])
  const { health } = run(home).gate
  assert.equal(health.lastJevAt, '2026-09-24T11:10:00.000Z')
  assert.equal(health.consecutiveFailures, 0)
  assert.equal(health.lastFailureAt, '2026-09-24T11:05:00.000Z')
})

test('gate.windows and gate.health on an empty log: every window present and zeroed, nothing undefined for the board to print', () => {
  const home = makeHome()
  const { gate } = run(home)
  for (const key of ['version', 'day', 'week', 'all']) {
    const w = gate.windows[key]
    assert.equal(w.totalDecisions, 0, key)
    assert.deepEqual(w.interventions, { rows: [], rest: null, quiet: { families: 0, total: 0 } }, key)
    assert.equal(w.approvals.asked, 0, key)
    assert.equal(w.jevLatency.medianMs, null, key)
  }
  assert.deepEqual(gate.health, { lastJevAt: null, consecutiveFailures: 0, lastFailureAt: null })
})
