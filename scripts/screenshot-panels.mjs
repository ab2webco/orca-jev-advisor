#!/usr/bin/env node
/**
 * Photographs the plugin's panels outside Orca.
 *
 * A panel is a sandboxed document that talks to its host over postMessage, so
 * rendering one on its own shows an empty shell. This harness plays the host:
 * it answers the panel's action calls from a fixed storage map, which also
 * makes the interesting case reproducible -- `fresh` is a machine where the
 * worker has never run, and that is exactly the state a new install starts in.
 *
 * Two details cost an hour each if rediscovered:
 *
 *   1. The panel reads `result.value.value`. The doubled `value` is real: the
 *      host wraps the action result and the storage read wraps the datum.
 *   2. The panel rate-limits its own calls to stay under the host's cap, so a
 *      screenshot taken at 800ms catches a loading state and looks broken.
 *      SETTLE_MS below is the wait that makes a shot mean something.
 *
 * Overflow is measured, never eyeballed: `scrollWidth > clientWidth` is what
 * catches a table that is 386px wide in a 320px viewport.
 *
 * Usage: node scripts/screenshot-panels.mjs [--scenario fresh|ready|all]
 */
import { chromium } from 'playwright'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseSeedPolicies, parseSeedVersion } from '../src/core/policy_seed.ts'
import { mergePolicySeeds } from '../src/core/policy_seed_import.ts'
import { decidePolicySeedNotice } from '../src/core/policy_seed_notice.ts'
import { parseModelSeedEntries, parseModelSeedVersion } from '../src/core/model_catalog.ts'
import { decideModelSeedNotice, diffModelSeed } from '../src/core/model_seed_notice.ts'
import { summarizeModelMeasurements } from '../src/core/model_measurement.ts'
import { foldGateDecisions } from '../src/core/gate_stats.ts'
import { foldAbResults } from '../src/core/ab_report.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PANELS_DIR = join(ROOT, 'adapters/orca/panels')
const OUT_DIR = join(ROOT, '.screenshots')
const WORK_DIR = join(OUT_DIR, '.rendered')

// The real shipped seed, read once so every fixture below that needs a
// merge/notice count computes it for real -- no invented number anywhere a
// screenshot can show it.
const RAW_SEED = JSON.parse(await readFile(join(ROOT, 'seed/policies.json'), 'utf8'))
const SHIPPED_POLICIES = parseSeedPolicies(RAW_SEED)
const SHIPPED_POLICIES_VERSION = parseSeedVersion(RAW_SEED)

// Same discipline for odd/tasks/model-reclassification.md T7's Models
// section: the real shipped model catalog (seed/models.json), read once.
const RAW_MODEL_SEED = JSON.parse(await readFile(join(ROOT, 'seed/models.json'), 'utf8'))
const SHIPPED_MODELS = parseModelSeedEntries(RAW_MODEL_SEED)
const SHIPPED_MODELS_VERSION = parseModelSeedVersion(RAW_MODEL_SEED)

/** The panel throttles its own host calls; anything shorter photographs a spinner. */
const SETTLE_MS = 6000
const WIDTHS = [1440, 768, 390, 320]
const THEMES = /** @type {const} */ (['light', 'dark'])
const PANELS = ['config.html', 'board.html']

const iso = new Date('2026-09-23T12:00:00.000Z').toISOString()

/**
 * A machine where the worker has never run: every key absent. This is what a
 * marketplace install looks like before any Advisor command or worktree event
 * has forked the worker.
 */
const FRESH = {}

// odd/tasks/model-reclassification.md T7's measurement readout fixture: a
// small, hand-written log of ModelDecisionRecord/ModelOutcomeRecord
// objects, fed through the REAL summarizeModelMeasurements
// (src/core/model_measurement.ts) against the real shipped catalog above --
// the same discipline SHIPPED_POLICIES follows for the policy notices: the
// numbers the panel shows are the real function's output, never typed in
// by hand.
const MODEL_MEASUREMENT_RECORDS = [
  // Jev recommended a larger model (opus, rank 2) than the sonnet (rank 3)
  // that was requested, and the subagent actually ran on opus: agreement.
  {
    type: 'model-decision', id: 'tool-1', at: iso, mode: 'measurement', source: 'jev', failOpen: null,
    subagentType: 'general-purpose', promptChars: 240, requestedModel: 'sonnet',
    recommended: { id: 'claude-opus-5-5', agentModel: 'opus', rank: 2 },
    score: 0.82, confidence: 0.74, applied: false, rewriteReason: 'measurement', ladderSize: 3,
    latencyMs: 612, permissionMode: 'default', complexity: { tier: 'advanced', tierIndex: 2, score: 0.7 },
  },
  { type: 'model-outcome', id: 'tool-1', at: iso, status: 'success', resolvedModel: 'opus', inputTokens: 4200, outputTokens: 900, durationMs: 54000 },
  // Jev recommended a smaller model (sonnet, rank 3) than opus (rank 2)
  // that was requested, and the subagent ran on sonnet: agreement too.
  {
    type: 'model-decision', id: 'tool-2', at: iso, mode: 'measurement', source: 'jev', failOpen: null,
    subagentType: 'Explore', promptChars: 90, requestedModel: 'opus',
    recommended: { id: 'claude-sonnet-5', agentModel: 'sonnet', rank: 3 },
    score: 0.31, confidence: 0.81, applied: false, rewriteReason: 'measurement', ladderSize: 3,
    latencyMs: 448, permissionMode: 'default', complexity: { tier: 'trivial', tierIndex: 0, score: 0.1 },
  },
  { type: 'model-outcome', id: 'tool-2', at: iso, status: 'success', resolvedModel: 'sonnet', inputTokens: 1100, outputTokens: 210, durationMs: 9000 },
  // Jev agreed with what was requested (sonnet), no outcome joined yet --
  // this row stays judged but not comparable.
  {
    type: 'model-decision', id: 'tool-3', at: iso, mode: 'measurement', source: 'jev', failOpen: null,
    subagentType: 'general-purpose', promptChars: 512, requestedModel: 'sonnet',
    recommended: { id: 'claude-sonnet-5', agentModel: 'sonnet', rank: 3 },
    score: 0.55, confidence: 0.69, applied: false, rewriteReason: 'measurement', ladderSize: 3,
    latencyMs: 390, permissionMode: 'default', complexity: { tier: 'standard', tierIndex: 1, score: 0.4 },
  },
  // Jev's own call failed open -- an unjudged decision (source: 'none'),
  // the shape a past defect in this repo once discarded (see
  // src/core/model_measurement.ts's own module note on parseModelRecord).
  {
    type: 'model-decision', id: 'tool-4', at: iso, mode: 'measurement', source: 'none', failOpen: 'jev-unreachable',
    subagentType: null, promptChars: 80, requestedModel: null, recommended: null,
    score: null, confidence: null, applied: false, rewriteReason: null, ladderSize: 3,
    latencyMs: 1800, permissionMode: 'default', complexity: null,
  },
  // Jev agreed with what was requested (haiku), but the subagent actually
  // ran on sonnet -- a disagreement between the recommendation and what
  // really ran, not between the recommendation and the request.
  {
    type: 'model-decision', id: 'tool-5', at: iso, mode: 'measurement', source: 'jev', failOpen: null,
    subagentType: 'general-purpose', promptChars: 150, requestedModel: 'haiku',
    recommended: { id: 'claude-haiku-4-5-20251001', agentModel: 'haiku', rank: 4 },
    score: 0.12, confidence: 0.88, applied: false, rewriteReason: 'measurement', ladderSize: 3,
    latencyMs: 210, permissionMode: 'default', complexity: { tier: 'trivial', tierIndex: 0, score: 0.05 },
  },
  { type: 'model-outcome', id: 'tool-5', at: iso, status: 'success', resolvedModel: 'sonnet', inputTokens: 800, outputTokens: 120, durationMs: 12000 },
]
const MODEL_MEASUREMENTS_SUMMARY = summarizeModelMeasurements(MODEL_MEASUREMENT_RECORDS, SHIPPED_MODELS)

/**
 * The board's windows, as read-measurements.mjs published them from the
 * author's real logs on 2026-09-24 (a run of the real aggregator, pasted as
 * literals so the harness stays deterministic and never reads a private log
 * path). The log is under a week old, so the 7-day window and all time hold
 * the same records; `week` reuses `all` rather than repeating it. No record
 * carries a pluginVersion yet -- gate-bash.ts does not stamp one -- so the
 * version window is unavailable, exactly as the real aggregator reports it.
 */
const READY_DAY = {
  key: 'day', available: true, pluginVersion: null, since: '2026-09-24T00:28:46.766Z',
  totalDecisions: 2409,
  // The advise-model release: the risk stage's own borderline verdict no
  // longer asks a person -- it advises the coding model instead. 40 of the
  // 2320 that used to be a plain 'allow' are now this new bucket.
  byVerdict: { allow: 2280, ask: 77, deny: 12, advise: 40 },
  bySource: { 'local-rule': 23, cache: 240, jev: 2101, none: 45 },
  jevLatency: { sampleCount: 2101, medianMs: 577, p95Ms: 1243, maxMs: 1809 },
  interventions: {
    rows: [
      { commandFamily: 'cd', total: 769, ask: 22, deny: 2, notRun: 2 },
      { commandFamily: 'gh cli', total: 123, ask: 11, deny: 0, notRun: 0 },
      { commandFamily: 'git discard', total: 12, ask: 8, deny: 1, notRun: 1 },
      { commandFamily: 'git push', total: 33, ask: 4, deny: 4, notRun: 1 },
      { commandFamily: 'curl | shell', total: 7, ask: 5, deny: 2, notRun: 0 },
      { commandFamily: 'rm -rf', total: 57, ask: 4, deny: 1, notRun: 1 },
      { commandFamily: 'python3', total: 69, ask: 3, deny: 0, notRun: 0 },
      { commandFamily: 'ssh', total: 30, ask: 3, deny: 0, notRun: 0 },
      { commandFamily: 'bash', total: 6, ask: 3, deny: 0, notRun: 2 },
      { commandFamily: 'orca', total: 123, ask: 2, deny: 0, notRun: 0 },
      { commandFamily: 'git', total: 87, ask: 2, deny: 0, notRun: 0 },
      { commandFamily: 'other', total: 38, ask: 2, deny: 0, notRun: 0 },
      { commandFamily: 'git branch', total: 26, ask: 2, deny: 0, notRun: 0 },
      { commandFamily: 'scratchpad', total: 22, ask: 2, deny: 0, notRun: 0 },
      { commandFamily: 'terraform', total: 2, ask: 1, deny: 1, notRun: 1 },
    ],
    rest: { families: 4, total: 70, ask: 3, deny: 1, notRun: 1 },
    quiet: { families: 60, total: 935 },
  },
  approvals: { asked: 89, approved: 71, rejected: 0, notRun: 9, awaiting: 9, ceiling: { highestApproved: 2.65, lowestRejected: null, band: null, suggestedCeiling: null, approvedCount: 37, rejectedCount: 0 } },
}
const READY_ALL = {
  key: 'all', available: true, pluginVersion: null, since: null,
  totalDecisions: 3711,
  byVerdict: { allow: 3323, ask: 316, deny: 12, advise: 60 },
  bySource: { 'local-rule': 126, cache: 278, jev: 3262, none: 45 },
  jevLatency: { sampleCount: 3262, medianMs: 530, p95Ms: 1131, maxMs: 1809 },
  interventions: {
    rows: [
      { commandFamily: 'cd', total: 1207, ask: 56, deny: 2, notRun: 2 },
      { commandFamily: 'rm -rf', total: 137, ask: 55, deny: 1, notRun: 2 },
      { commandFamily: 'gh cli', total: 175, ask: 40, deny: 0, notRun: 0 },
      { commandFamily: 'export', total: 159, ask: 22, deny: 0, notRun: 0 },
      { commandFamily: 'git push', total: 50, ask: 16, deny: 4, notRun: 2 },
      { commandFamily: 'curl | shell', total: 19, ask: 17, deny: 2, notRun: 0 },
      { commandFamily: 'git discard', total: 21, ask: 17, deny: 1, notRun: 1 },
      { commandFamily: 'terraform', total: 18, ask: 17, deny: 1, notRun: 2 },
      { commandFamily: 'kubectl', total: 9, ask: 9, deny: 0, notRun: 0 },
      { commandFamily: 'other', total: 69, ask: 8, deny: 0, notRun: 1 },
      { commandFamily: 'npm', total: 19, ask: 7, deny: 0, notRun: 0 },
      { commandFamily: 'git', total: 136, ask: 6, deny: 0, notRun: 0 },
      { commandFamily: 'python3', total: 84, ask: 5, deny: 0, notRun: 0 },
      { commandFamily: 'db client', total: 5, ask: 5, deny: 0, notRun: 0 },
      { commandFamily: 'ssh', total: 40, ask: 4, deny: 0, notRun: 0 },
    ],
    rest: { families: 18, total: 784, ask: 32, deny: 1, notRun: 5 },
    quiet: { families: 69, total: 779 },
  },
  approvals: { asked: 106, approved: 81, rejected: 1, notRun: 15, awaiting: 9, ceiling: { highestApproved: 2.65, lowestRejected: null, band: null, suggestedCeiling: null, approvedCount: 43, rejectedCount: 0 } },
}
const READY_WINDOWS = {
  version: { ...emptyWindow('version'), available: false },
  day: READY_DAY,
  week: { ...READY_ALL, key: 'week', since: '2026-09-18T00:28:46.766Z' },
  all: READY_ALL,
}

/** One window exactly as read-measurements.mjs publishes it for an empty log. */
function emptyWindow (key) {
  return {
    key, available: key !== 'version', pluginVersion: null, since: null,
    totalDecisions: 0,
    byVerdict: { allow: 0, ask: 0, deny: 0, advise: 0 },
    bySource: { 'local-rule': 0, cache: 0, jev: 0, none: 0 },
    jevLatency: { sampleCount: 0, medianMs: null, p95Ms: null, maxMs: null },
    interventions: { rows: [], rest: null, quiet: { families: 0, total: 0 } },
    approvals: {
      asked: 0, approved: 0, rejected: 0, notRun: 0, awaiting: 0,
      ceiling: { highestApproved: null, lowestRejected: null, band: null, suggestedCeiling: null, approvedCount: 0, rejectedCount: 0 },
    },
  }
}

/** A machine where the worker has run and published everything it mirrors. */
const READY = {
  // 'now' is resolved by hostBridge at the moment the page asks, not here.
  // liveIso() at module load was the second version of this bug: one run
  // renders 32 pages over about two minutes, the panel calls a heartbeat
  // older than WORKER_HEARTBEAT_STALE_MS (40s) dead, and every screenshot
  // after the first forty seconds photographed the "worker has not started"
  // banner while the filename said `ready`.
  workerHeartbeat: { at: 'now' },
  // Mirrors GATE_CONSEQUENCE_CEILING; the panel must render this rather than a
  // literal of its own, which is the drift T7 fixed.
  gateDefaults: { consequenceCeiling: 1.78, checkedAt: iso },
  // Both switches off, which is the state every install starts in and the one
  // worth photographing: the copy has to explain a control that does nothing
  // yet without reading as broken.
  modSkillsStatus: { active: false, activeTools: false, checkedAt: iso },
  // These shapes are the worker's, not invented: publishSecretStatus writes
  // `configured` (NOT `isConfigured`), and the integration status is an `ok`
  // envelope around a `hook` record. A fixture that does not match what the
  // worker writes photographs a panel nobody will ever see -- the first draft
  // of this file said `isConfigured` and rendered "No key configured" while
  // claiming to show a configured one.
  secretStatus: { configured: true, endsWith: '9f2a', checkedAt: iso },
  claudeIntegrationStatus: {
    ok: true,
    hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
    // install-claude-integration.mjs's real aggregate shape for the Agent
    // PreToolUse/PostToolUse/PostToolUseFailure hooks -- same fields as
    // `hook` above.
    agentModelHook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
    // statMirror()'s real shape. `{ ok: true }` alone left `exists` and
    // `path` undefined, and the panel photographed "Key file: doesn't exist
    // yet (undefined)." -- next to a secretStatus that says a key is set.
    secretMirror: { ok: true, exists: true, mode: '600', platform: 'darwin', path: '/Users/you/.config/orca-supervisor/env' },
    checkedAt: iso
  },
  // odd/tasks/model-reclassification.md T7. The real shipped catalog,
  // active mode off (the default), and the real summarizeModelMeasurements
  // output for MODEL_MEASUREMENT_RECORDS above.
  models: SHIPPED_MODELS,
  modelsConfig: { active: false },
  modelMeasurements: { ok: true, summary: MODEL_MEASUREMENTS_SUMMARY, checkedAt: iso },
  localeStatus: { value: 'en', checkedAt: iso },
  config: { ceiling: 1.78 },
  catalog: {
    destinations: [
      { id: 'app', label: 'app', description: 'Product repository', care: 'high' },
      { id: 'tooling', label: 'tooling', description: 'Internal tooling', care: 'normal' }
    ]
  },
  // An ARRAY, because that is what the worker stores and what the panel's
  // `(results[2] || []).forEach(addPolicyRow)` expects. The first version of
  // this line was `{ rules: [] }`, an object with no .forEach, so load()
  // threw, its catch painted "Something went wrong and it could not finish"
  // in red across the bottom of the panel, and every settings screenshot ever
  // taken by this harness carried that error while the harness itself
  // reported "no script errors" -- the throw was caught, so it never reached
  // pageerror. Rows are the real first three of seed/policies.json.
  policies: [
    {
      id: 'read_and_test',
      kind: 'permits',
      rule: 'Reading code, searching, running tests, linters, typecheck and local builds happens without asking, always.',
    },
    { id: 'own_branch', kind: 'permits', rule: 'All work goes on a feature branch. Work happens there without asking.' },
    { id: 'never_write_to_main', kind: 'prohibits', rule: 'Never write directly on main or develop, not even a one-line fix.' },
  ],
  // main.mjs's onAgentStatusChanged shape. One worktree resolved to its
  // project and branch, one not (project and branch null, which is what a
  // missed `orca worktree list` lookup leaves): the second is the row that
  // used to print a raw UUID pair as its only label. The ids are made up.
  board: {
    entries: [
      { worktreeId: 'wt-app', project: 'orca-supervisor', rama: 'feat/board-redesign', paneKey: '1e1fff06-5b2c-4c8e-9d11-7a0e3f2b9c41:a62d09bd-0f3e-4b7a-8c55-2d9e6f1a3b70', state: 'working', receivedAt: 2, updatedAt: 'now' },
      { worktreeId: null, project: null, rama: null, paneKey: 'dc178159-8e2a-4f61-b3c7-5a9d0e4f2c18:4a14c726-3b9f-4d2e-a6c1-8f7e5d3b2a90', state: 'done', receivedAt: 1, updatedAt: 'now' },
    ],
  },
  // The shape is read-measurements.mjs's own output, not a flat invention:
  // `{ ok, gate, modSkills, approvals }`, with the board reading
  // `summary.approvals.*`. The first version of this fixture was flat, so
  // every board screenshot photographed the empty state while claiming to
  // show a populated one -- the same mistake as `isConfigured` vs
  // `configured` earlier in this file's history.
  // The shape here is read-measurements.mjs's own output, field for field:
  // `gate` is foldGateDecisions()'s GateStatsSummary (src/core/gate_stats.ts),
  // `abBenchmark` is foldAbResults()'s summary, and the board reads
  // `summary.gate.totalDecisions`, `summary.gate.byCommandFamily`,
  // `summary.gate.jevLatency`, never a flattened alias.
  //
  // This fixture has now drifted from that shape three times -- `isConfigured`
  // vs `configured`, a frozen heartbeat that photographed the dead-worker
  // path, and a `gate.total`/`byFamily`/`latencyMs{median,p90}` invention that
  // made every "ready" gate screenshot silently photograph the EMPTY state
  // while the filename claimed otherwise. screenshot_fixture.test.mjs now
  // asserts these keys against the real aggregator so a fourth time fails a
  // test instead of a release.
  //
  // The numbers are the author's real logs on 2026-09-24, kept as literals so
  // the harness stays deterministic and never reads a private log path.
  measurementsSummary: {
    ok: true,
    gate: {
      totalDecisions: 3711,
      byVerdict: {allow: 3323, ask: 316, deny: 12, advise: 60},
      bySource: {'local-rule': 126, cache: 278, jev: 3262, none: 45},
      jevLatency: {sampleCount: 3262, medianMs: 530, p95Ms: 1131, maxMs: 1809},
      windows: READY_WINDOWS,
      health: { lastJevAt: '2026-09-25T00:28:45.360Z', consecutiveFailures: 0, lastFailureAt: '2026-09-24T20:25:32.366Z' },
      byCommandFamily: [
        { commandFamily: 'cd', total: 511, byVerdict: { allow: 498, ask: 13, deny: 0 } },
        { commandFamily: 'git', total: 402, byVerdict: { allow: 371, ask: 30, deny: 1 } },
        { commandFamily: 'gh cli', total: 188, byVerdict: { allow: 160, ask: 28, deny: 0 } },
        { commandFamily: 'rm -rf', total: 51, byVerdict: { allow: 9, ask: 40, deny: 2 } },
      ],
      byProject: [
        { project: 'orca-supervisor', total: 1204 },
        { project: 'orca-oss', total: 618 },
        { project: null, total: 91 },
      ],
      corruptLines: 0,
      cacheHitRate: 278 / 3711,
      recent: [
        { at: '2026-09-24T15:02:03.837Z', project: 'orca-supervisor', commandFamily: 'cd', source: 'jev', verdict: 'allow', latencyMs: 784 },
        { at: '2026-09-24T15:01:44.102Z', project: 'orca-supervisor', commandFamily: 'rm -rf', source: 'local-rule', verdict: 'ask', latencyMs: null },
        // The advise-model release's own new verdict: the model was refused
        // this one attempt and handed a reason, nobody was interrupted.
        { at: '2026-09-24T15:01:20.511Z', project: 'orca-supervisor', commandFamily: 'rm -rf', source: 'jev', verdict: 'advise', latencyMs: 640 },
        { at: '2026-09-24T15:00:58.640Z', project: 'orca-oss', commandFamily: 'git', source: 'cache', verdict: 'allow', latencyMs: null },
      ],
    },
    modSkills: {
      totalDecisions: 0,
      totalObservations: 0,
      firstAt: null,
      lastAt: null,
      corruptLines: 0,
      suggestedCount: 0,
      comparableCount: 0,
      matchedCount: 0,
      matchRate: null,
      listingCharsTotal: null,
      listingCharsAvgPerPrompt: null,
      listingCharsSampleCount: 0,
      wideLatencyMeanMs: null,
      fitLatencyMeanMs: null,
      byProject: [],
      // evaluateModSkillsReadiness()'s shape (src/core/mod_skills_readiness.ts).
      // Zero comparable prompts is the honest state of this machine: the mod
      // has never run here, which is exactly why the panel must say how far
      // off the threshold is instead of "not ready yet".
      readiness: {
        ready: false,
        comparableShortfall: 1000,
        matchRateMet: null,
        reason: 'not-enough-samples',
        thresholds: { minComparable: 1000, minMatchRate: 0.7 },
      },
    },
    // Twenty real paired samples: Jev's median against the model's, and the
    // model NAMED -- the user was explicit that "the big model" is not a name.
    abBenchmark: {
      sampleCount: 20,
      jevLatency: { sampleCount: 20, medianMs: 236, minMs: 203, maxMs: 784 },
      bigModelLatency: { sampleCount: 20, medianMs: 4126, minMs: 3155, maxMs: 7848 },
      modelIds: ['claude-opus-5-5[1m]'],
      agreementCount: 11,
      disagreementCount: 9,
      agreementRate: 11 / 20,
      disagreements: [{ jevVerdict: 'allow', bigModelVerdict: 'ask', count: 9 }],
      failureCount: 0,
      jevTokens: { inputTotal: 9258, outputTotal: 1060 },
      bigModelTokens: {
        inputTotal: 40,
        outputTotal: 1027,
        cacheCreationInputTotal: 969363,
        cacheReadInputTotal: 241960,
      },
      corruptLines: 0,
    },
    approvals: {
      asked: 43,
      approved: 27,
      rejected: 1,
      notRun: 15,
      awaiting: 0,
      corruptLines: 0,
      ceiling: {
        highestApproved: null,
        lowestRejected: null,
        band: null,
        suggestedCeiling: null,
        approvedCount: 9,
        rejectedCount: 0,
      },
    },
  },
}

/**
 * The gate disarmed: Jev was asked and did not answer, so commands passed
 * unjudged and were recorded as `source: 'none'`. These counts are synthetic
 * -- the author's own log cannot contain `none` rows, since nothing wrote
 * them before this change -- and they exist only so the alarm path is
 * photographed instead of shipped unseen. Nothing here is ever shown to a
 * user as a measurement; it is a fixture, and the rest of the object is the
 * real `ready` data.
 */
const DEGRADED_DAY = {
  ...READY_DAY,
  totalDecisions: READY_DAY.totalDecisions + 12,
  byVerdict: { ...READY_DAY.byVerdict, allow: READY_DAY.byVerdict.allow + 12 },
  bySource: { ...READY_DAY.bySource, none: READY_DAY.bySource.none + 12 },
}
const DEGRADED = {
  ...READY,
  measurementsSummary: {
    ...READY.measurementsSummary,
    gate: {
      ...READY.measurementsSummary.gate,
      totalDecisions: READY_ALL.totalDecisions + 12,
      bySource: { ...READY_ALL.bySource, none: READY_ALL.bySource.none + 12 },
      // Also synthetic: a stamped build, so the per-version window is
      // photographed available and selected by default -- the real log
      // cannot show it until gate-bash.ts stamps pluginVersion.
      windows: {
        ...READY_WINDOWS,
        version: { ...DEGRADED_DAY, key: 'version', pluginVersion: '0.4.0', since: '2026-09-24T12:21:00.000Z' },
        day: DEGRADED_DAY,
      },
      health: { lastJevAt: '2026-09-24T17:20:41.118Z', consecutiveFailures: 12, lastFailureAt: '2026-09-24T17:33:10.004Z' },
      recent: [
        { at: '2026-09-24T17:33:10.004Z', project: 'orca-supervisor', commandFamily: 'other', source: 'none', verdict: 'allow', latencyMs: null },
        ...READY.measurementsSummary.gate.recent,
      ],
    },
  },
}

/**
 * A machine where the worker has run but nothing has been measured yet: the
 * heartbeat is live and every log is empty. Unlike `fresh` (the worker never
 * ran, so there is no summary at all), this is the summary the real
 * aggregator publishes for an empty home -- fixture_shape.test.mjs compares it
 * against that output -- and the board must render it as one explanatory card,
 * never a column of empty sections or an "undefined".
 */
const EMPTY_GATE_SUMMARY = foldGateDecisions([])
const EMPTY = {
  ...READY,
  board: { entries: [] },
  measurementsSummary: {
    ok: true,
    gate: {
      ...EMPTY_GATE_SUMMARY,
      windows: { version: emptyWindow('version'), day: emptyWindow('day'), week: emptyWindow('week'), all: emptyWindow('all') },
      health: { lastJevAt: null, consecutiveFailures: 0, lastFailureAt: null },
      corruptLines: 0,
      cacheHitRate: null,
      recent: [],
      notRunByCommandFamily: [],
    },
    modSkills: READY.measurementsSummary.modSkills,
    approvals: { ...emptyWindow('all').approvals, corruptLines: 0 },
    abBenchmark: { ...foldAbResults([]), corruptLines: 0 },
  },
}

/**
 * The shipped baseline has been corrected since this install imported it.
 * Merge-by-id can never reach those rows -- an edited policy must survive --
 * so the panel shows both versions and the person picks. This scenario exists
 * because that list only appears after a live request/result round-trip, and
 * an interactive surface nobody has photographed is a surface nobody has
 * checked. This install's two rows are real ids from seed/policies.json, with
 * the wording genuinely shipped in an earlier seed; `added`/`skipped`/
 * `differing` are the real `mergePolicySeeds` output for exactly that list
 * against the real shipped seed, never a hand-typed count that can drift from
 * it the way `skipped: 20` once silently did after the seed grew to 23 rows.
 */
const SEEDS_EDITED_ROWS = {
  never_write_to_main: { id: 'never_write_to_main', kind: 'prohibits', rule: 'Never write directly on main.' },
  own_branch: { id: 'own_branch', kind: 'permits', rule: 'Work on a branch.', destinations: ['app'] },
}
// Every shipped row, with those two edited by hand: the result then reports
// what an install that already imported really sees -- nothing new, two rows
// to choose between -- and the list on screen agrees with the counts.
const SEEDS_EXISTING_POLICIES = SHIPPED_POLICIES.map((row) => SEEDS_EDITED_ROWS[row.id] ?? row)
const SEEDS_MERGE = mergePolicySeeds(SEEDS_EXISTING_POLICIES, SHIPPED_POLICIES)

const SEEDS = {
  ...READY,
  policies: SEEDS_EXISTING_POLICIES,
  policySeedImportResult: {
    ok: true,
    added: SEEDS_MERGE.added,
    skipped: SEEDS_MERGE.skipped,
    replaced: 0,
    differing: SEEDS_MERGE.differing,
  },
}

/**
 * An install that seeded (or imported) an earlier release and never opened
 * the panel since: the shipped baseline notice is already `due`, with no
 * click needed to see it. The existing list is the real shipped seed minus
 * the three rows this release added and with the wording it tightened on
 * `unit_commits` reverted -- both real, from seed/policies.json's own
 * history (see odd/tasks/gate-destructive-restore-and-seed-refresh.md's T2
 * notes) -- and `policySeedNoticeStatus` is the real `decidePolicySeedNotice`
 * output for that list, never an invented due/added/differing combination.
 */
const BASELINE_REMOVED_IDS = ['discard_uncommitted_work', 'no_force_push', 'infrastructure_changes']
const BASELINE_OLD_UNIT_COMMITS_RULE =
  "Committing without asking is fine on the feature branch, with its tests and its docs in the same commit. " +
  "Pushing the branch to the remote too, as long as it isn't a shared branch."
const BASELINE_EXISTING_POLICIES = SHIPPED_POLICIES
  .filter((row) => !BASELINE_REMOVED_IDS.includes(row.id))
  .map((row) => (row.id === 'unit_commits' ? { ...row, rule: BASELINE_OLD_UNIT_COMMITS_RULE } : row))
const BASELINE_NOTICE_DECISION = decidePolicySeedNotice({
  shippedVersion: SHIPPED_POLICIES_VERSION,
  offeredVersion: 0,
  existing: BASELINE_EXISTING_POLICIES,
  shipped: SHIPPED_POLICIES,
})
// JEVADV-27 (odd/tasks/release-0.5.1.md): the worker now publishes the real
// differing rows alongside the counts (main.mjs's computePolicySeedNoticeDecision),
// and the panel renders the tick list straight from them while the notice is
// due -- so the fixture must carry `differingItems` too, or this scenario's
// screenshot would show the notice banner over an empty list.
const BASELINE_DIFFERING_ITEMS = mergePolicySeeds(BASELINE_EXISTING_POLICIES, SHIPPED_POLICIES).differing

// odd/tasks/model-reclassification.md T7's own baseline-notice fixture:
// one shipped model this install never has (haiku, dropped below) and one
// shared id whose label the install's own copy differs on (opus) -- real
// `diffModelSeed`/`decideModelSeedNotice` output over that list, in the
// exact `{ due, added, differing, shippedVersion, items, checkedAt }` shape
// models-worker.mjs's publishModelsSeedNotice publishes (its own
// `noticeItems` helper is module-private, so the `added`/`changed` item
// rows below are built the same way it builds them, from the real diff).
const MODEL_BASELINE_EXISTING = SHIPPED_MODELS
  .filter((row) => row.id !== 'claude-haiku-4-5-20251001')
  .map((row) => (row.id === 'claude-opus-5-5' ? { ...row, label: 'Claude Opus (previous label)' } : row))
const MODEL_BASELINE_DIFF = diffModelSeed(MODEL_BASELINE_EXISTING, SHIPPED_MODELS)
const MODEL_BASELINE_DECISION = decideModelSeedNotice({
  shippedVersion: SHIPPED_MODELS_VERSION,
  offeredVersion: 0,
  existing: MODEL_BASELINE_EXISTING,
  shipped: SHIPPED_MODELS,
})
const MODEL_BASELINE_ITEMS = [
  ...MODEL_BASELINE_DIFF.added.map((row) => ({ id: row.id, label: row.label, kind: 'added', fields: [] })),
  ...MODEL_BASELINE_DIFF.differing.map((diff) => ({ id: diff.id, label: diff.seed.label, kind: 'changed', fields: diff.fields })),
]

const BASELINE = {
  ...READY,
  policies: BASELINE_EXISTING_POLICIES,
  policySeedNoticeStatus: { ...BASELINE_NOTICE_DECISION, differingItems: BASELINE_DIFFERING_ITEMS, at: iso },
  models: MODEL_BASELINE_EXISTING,
  modelsSeedNotice: { ...MODEL_BASELINE_DECISION, items: MODEL_BASELINE_ITEMS, checkedAt: iso },
}

/**
 * A fresh catalog with the worker having already run once (so every OTHER
 * key is the same as `ready`) but the person having removed every model:
 * odd/tasks/model-reclassification.md's own empty-catalog state, distinct
 * from `fresh` (which has never seen the worker at all) and worth its own
 * screenshot since the Models section's copy differs from every other
 * section's empty state.
 */
const { modelMeasurements: _readyModelMeasurements, ...READY_WITHOUT_MODEL_MEASUREMENTS } = READY
const MODELS_EMPTY = { ...READY_WITHOUT_MODEL_MEASUREMENTS, models: [] }

/**
 * JEVADV-11 (odd/tasks/release-0.5.1.md) -- two real client repositories
 * "Search Orca" found that the catalog does not yet cover, each awaiting a
 * kind choice: catalogProposalsStatus is the exact shape
 * publishCatalogProposalsStatus (main.mjs) publishes, never a hand-typed
 * count. Needs no click: the tick list renders straight from the status,
 * same as `baseline` above.
 */
const CATALOG_PROPOSALS = {
  ...READY,
  catalogProposalsStatus: {
    ok: true,
    proposals: [
      { id: 'cineco-backend', label: 'cineco-backend', worktreePath: '/Users/dev/Projects/cineco-backend' },
      { id: 'myparkplanner-be', label: 'myparkplanner-be', worktreePath: '/Users/dev/Projects/myparkplanner-be' },
    ],
    checkedAt: iso,
  },
}

const SCENARIOS = { fresh: FRESH, empty: EMPTY, ready: READY, degraded: DEGRADED, seeds: SEEDS, baseline: BASELINE, 'models-empty': MODELS_EMPTY, 'catalog-proposals': CATALOG_PROPOSALS }

/** A scenario may need one click before the shot -- see SEEDS. `baseline`
 *  needs none: the notice renders straight from policySeedNoticeStatus. */
const SCENARIO_CLICKS = { seeds: { panel: 'config.html', selector: '#import-policy-seeds' } }

// JEVADV-41 -- config.html now shows one section-group at a time behind
// role="tab" buttons inside #config-tabbar (see that element's own comment
// in the panel). Each tab is its own screen, so this harness photographs
// every one of them rather than only whichever tab happens to be active by
// default ('general').
const CONFIG_TAB_KEYS = ['general', 'destinations', 'policies', 'models', 'modskills', 'rules']

/**
 * Impersonates the host bridge. Installed before the panel's own script runs,
 * because the panel starts calling immediately on load.
 */
function hostBridge(storage) {
  // The panel's request/result keys are a round-trip through the worker: it
  // writes `<thing>Request` with a fresh random id and polls `<thing>Result`
  // until one carries that same id back. A fixture cannot know the id in
  // advance, so the fake host plays the worker's part -- it remembers the id
  // that was just written and stamps it onto the canned result. Without this
  // every interactive surface behind a request stays unphotographable, which
  // is how the policy-difference list would have shipped unseen.
  let lastRequestId = null
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || msg.type !== 'orca-panel-action') return
    let value = null
    if (msg.action === 'storage.set' && msg.params?.key === 'policySeedImportRequest') {
      lastRequestId = msg.params?.value?.id ?? null
    }
    if (msg.action === 'storage.get') value = storage[msg.params?.key] ?? null
    if (msg.action === 'storage.get' && msg.params?.key === 'policySeedImportResult' && value && lastRequestId) {
      value = { ...value, id: lastRequestId }
    }
    if (value && value.at === 'now') value = { ...value, at: new Date().toISOString() }
    // Same sentinel for a live-status row, so its "N min ago" reads as live.
    if (value && Array.isArray(value.entries)) {
      value = { ...value, entries: value.entries.map((e) => (e.updatedAt === 'now' ? { ...e, updatedAt: new Date().toISOString() } : e)) }
    }
    // storage.set and notifications.show simply succeed; nothing here persists.
    window.postMessage(
      { type: 'orca-panel-action-result', requestId: msg.requestId, ok: true, value: { value } },
      '*'
    )
  })
}

async function main() {
  const requested = process.argv.includes('--scenario')
    ? process.argv[process.argv.indexOf('--scenario') + 1]
    : 'all'
  const names = requested === 'all' ? Object.keys(SCENARIOS) : [requested]
  for (const name of names) {
    if (!(name in SCENARIOS)) throw new Error(`unknown scenario: ${name}`)
  }

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })

  // JEVADV-10 (odd/tasks/release-0.5.1.md): the panel used to read its
  // language from `<html lang>`, which Orca's plugin shells hardcode to
  // "en" (never set by this plugin, never varied) -- it now reads
  // `navigator.languages`/`navigator.language` instead (config.html's
  // localeFromOrca), so English screenshots come from the browser
  // CONTEXT's own `locale` below, not from rewriting the markup.
  const rendered = {}
  for (const panel of PANELS) {
    const path = join(WORK_DIR, panel)
    await writeFile(path, await readFile(join(PANELS_DIR, panel), 'utf8'))
    rendered[panel] = path
  }

  const browser = await chromium.launch()
  const overflows = []
  let shots = 0
  try {
    for (const scenario of names) {
      for (const panel of PANELS) {
        for (const theme of THEMES) {
          for (const width of WIDTHS) {
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              colorScheme: theme,
              deviceScaleFactor: 2,
              locale: 'en-US'
            })
            const page = await context.newPage()
            await page.addInitScript(hostBridge, SCENARIOS[scenario])
            const failures = []
            page.on('pageerror', (error) => failures.push(String(error.message)))
            await page.goto(`file://${rendered[panel]}`)
            await page.waitForTimeout(SETTLE_MS)
            const click = SCENARIO_CLICKS[scenario]
            if (click && click.panel === panel) {
              // JEVADV-41: the target may live inside a tab-panel that is
              // not the active one (import-policy-seeds is in Policies,
              // not the default General tab) -- switch to it first, or
              // Playwright's actionability check times out against a
              // button hidden by its own tab-panel's [hidden].
              const tabOfSelector = await page.evaluate((selector) => {
                const target = document.querySelector(selector)
                const panelEl = target && target.closest ? target.closest('.tab-panel') : null
                return panelEl ? panelEl.id.replace(/^panel-/, '') : null
              }, click.selector)
              if (tabOfSelector) {
                await page.click(`#tab-${tabOfSelector}`)
                await page.waitForTimeout(300)
              }
              await page.click(click.selector)
              await page.waitForTimeout(SETTLE_MS)
            }

            // JEVADV-41: config.html now shows one section-group at a time
            // behind #config-tabbar; each tab is its own screen and gets its
            // own screenshot and its own overflow check. board.html has no
            // tabs, so tabKeys is a single `null` entry and behaves exactly
            // as before.
            const tabKeys = panel === 'config.html' ? CONFIG_TAB_KEYS : [null]
            for (const tabKey of tabKeys) {
              if (tabKey) {
                await page.click(`#tab-${tabKey}`)
                await page.waitForTimeout(300)
              }

              const overflow = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth
              }))
              const label = tabKey
                ? `${scenario}/${panel}/${theme}/${width}/${tabKey}`
                : `${scenario}/${panel}/${theme}/${width}`
              if (overflow.scrollWidth > overflow.clientWidth) {
                overflows.push(`${label}: content is ${overflow.scrollWidth}px wide`)
              }

              const name = tabKey
                ? `${scenario}-${panel.replace('.html', '')}-${theme}-${width}-${tabKey}.png`
                : `${scenario}-${panel.replace('.html', '')}-${theme}-${width}.png`
              await page.screenshot({ path: join(OUT_DIR, name), fullPage: true })
              shots += 1
            }
            if (failures.length > 0) {
              overflows.push(`${scenario}/${panel}/${theme}/${width}: script error: ${failures[0]}`)
            }
            await context.close()
          }
        }
      }
    }
  } finally {
    await browser.close()
    await rm(WORK_DIR, { recursive: true, force: true })
  }

  console.log(`${shots} screenshots written to .screenshots/`)
  if (overflows.length > 0) {
    console.error(`\n${overflows.length} problem(s):`)
    for (const line of overflows) console.error(`  ${line}`)
    process.exitCode = 1
    return
  }
  console.log('no horizontal overflow and no script errors at any width')
}

// Exported so scripts/fixture_shape.test.mjs can assert these fixtures
// against the shapes the worker really publishes -- a fixture has now
// drifted from those shapes four times, and each time the harness kept
// reporting success while photographing the wrong panel. main() stays
// behind the direct-invocation check so importing this file renders
// nothing.
export { SCENARIOS }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
