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
 * Usage: node scripts/screenshot-panels.mjs [--scenario fresh|ready|all] [--locale es-ES]
 */
import { chromium } from 'playwright'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { parseSeedPolicies, parseSeedVersion } from '../src/core/policy_seed.ts'
import { mergePolicySeeds } from '../src/core/policy_seed_import.ts'
import { decidePolicySeedNotice } from '../src/core/policy_seed_notice.ts'
import { parseModelSeedEntries, parseModelSeedVersion } from '../src/core/model_catalog.ts'
import { decideModelSeedNotice, diffModelSeed } from '../src/core/model_seed_notice.ts'
import { summarizeModelMeasurements } from '../src/core/model_measurement.ts'
import { foldGateDecisions } from '../src/core/gate_stats.ts'
import { foldAbResults } from '../src/core/ab_report.ts'
import { EMPTY_AUTHORIZATIONS, authorizationRows, recordAuthorization } from '../src/core/gate_authorizations.ts'
import { parseTrustedPrograms } from '../src/core/trusted_programs.ts'

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
    recommended: { id: 'claude-sonnet-5-5', agentModel: 'sonnet', rank: 3 },
    score: 0.31, confidence: 0.81, applied: false, rewriteReason: 'measurement', ladderSize: 3,
    latencyMs: 448, permissionMode: 'default', complexity: { tier: 'trivial', tierIndex: 0, score: 0.1 },
  },
  { type: 'model-outcome', id: 'tool-2', at: iso, status: 'success', resolvedModel: 'sonnet', inputTokens: 1100, outputTokens: 210, durationMs: 9000 },
  // Jev agreed with what was requested (sonnet), no outcome joined yet --
  // this row stays judged but not comparable.
  {
    type: 'model-decision', id: 'tool-3', at: iso, mode: 'measurement', source: 'jev', failOpen: null,
    subagentType: 'general-purpose', promptChars: 512, requestedModel: 'sonnet',
    recommended: { id: 'claude-sonnet-5-5', agentModel: 'sonnet', rank: 3 },
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
// 0.6.28 T4: the Rules tab's remembered authorizations, built with the real
// store functions and authorizationRows -- the same producer the worker's
// sidecar (adapters/orca/gate-authorizations.mjs) publishes from. One
// repository holds three classes, one holds one. Example repositories.
const READY_AUTHORIZATIONS = recordAuthorization(
  recordAuthorization(EMPTY_AUTHORIZATIONS, 'github.com/example/orca-supervisor', ['push-branch', 'pr-create', 'pr-merge'], '2026-09-21T15:40:00.000Z'),
  'github.com/example/website',
  ['release-create'],
  '2026-09-22T09:05:00.000Z',
)

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
    // 0.6.17 T2: the file tools' guard, same aggregate shape.
    fileGuardHook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
    // install-claude-integration.mjs's status().node: the Node the hooks run on.
    node: { state: 'ok', path: '/opt/homebrew/bin/node', version: 'v26.9.0' },
    // statMirror()'s real shape. `{ ok: true }` alone left `exists` and
    // `path` undefined, and the panel photographed "Key file: doesn't exist
    // yet (undefined)." -- next to a secretStatus that says a key is set.
    secretMirror: { ok: true, exists: true, mode: '600', platform: 'darwin', path: '/home/you/.config/orca-supervisor/env' },
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
  // 0.6.8 T1: the team owners field, filled, so the Policies tab photographs
  // it with real lines rather than only its placeholder. Example owners.
  teamOwners: ['acme-team', 'acme-tools'],
  // 0.6.8 T4: queue mode on, so the Policies tab photographs the choice
  // the board's "Waiting for you" list depends on.
  queueMode: { enabled: true },
  gateAuthorizationsStatus: { ok: true, repos: authorizationRows(READY_AUTHORIZATIONS, Date.parse(iso)), checkedAt: iso },
  // 0.6.28 T7: two trusted programs, through the real validator. Example names.
  trustedProgramsStatus: { programs: parseTrustedPrograms(['acme-notify', 'acme-scope']), checkedAt: iso },
  // main.mjs's onAgentStatusChanged shape. One worktree resolved to its
  // project (the raw Orca projectId, plus the projectName the worker
  // resolves from it -- the same name "By project" shows below) and branch;
  // one on Orca's floating terminal, which belongs to no worktree; and one
  // not resolved at all (project and branch null, which is what a missed
  // `orca worktree list` lookup leaves): the row that used to print a raw
  // UUID pair as its only label. The ids are made up.
  board: {
    entries: [
      { worktreeId: 'wt-app', project: 'github:example/orca-supervisor', projectName: 'orca-supervisor', rama: 'feat/board-redesign', paneKey: '1e1fff06-5b2c-4c8e-9d11-7a0e3f2b9c41:a62d09bd-0f3e-4b7a-8c55-2d9e6f1a3b70', state: 'working', receivedAt: 3, updatedAt: 'now' },
      { worktreeId: 'global-floating-terminal', project: null, projectName: null, rama: null, paneKey: '7b2e4c10-9d3a-4f5e-8c21-6a0f1e2d3c4b:0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f', state: 'working', receivedAt: 2, updatedAt: 'now' },
      { worktreeId: null, project: null, projectName: null, rama: null, paneKey: 'dc178159-8e2a-4f61-b3c7-5a9d0e4f2c18:4a14c726-3b9f-4d2e-a6c1-8f7e5d3b2a90', state: 'done', receivedAt: 1, updatedAt: 'now' },
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
      health: { lastJevAt: '2026-09-25T00:28:45.360Z', consecutiveFailures: 0, lastFailureAt: '2026-09-24T20:25:32.366Z', appendFailures: { count: 0, lastAt: null } },
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
      // 0.6.8 T5: what queue mode set aside for a person (read-measurements'
      // aggregateWaiting). Example projects and commands, no real ones.
      waiting: [
        { id: 'w1', at: '2026-09-24T14:58:12.000Z', project: 'acme-app', policyId: 'client_always_asks', command: 'gh pr merge 42 --squash --delete-branch' },
        { id: 'w2', at: '2026-09-24T14:31:40.000Z', project: 'acme-site', policyId: 'production_is_human', command: 'npm run deploy:production -- --region us-east-1 --confirm --tag release-2026-09-24-hotfix' },
      ],
      waitingTotal: 2,
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
      health: { lastJevAt: '2026-09-24T17:20:41.118Z', consecutiveFailures: 12, lastFailureAt: '2026-09-24T17:33:10.004Z', appendFailures: { count: 3, lastAt: '2026-09-24T17:30:02.511Z' } },
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
      health: { lastJevAt: null, consecutiveFailures: 0, lastFailureAt: null, appendFailures: { count: 0, lastAt: null } },
      corruptLines: 0,
      cacheHitRate: null,
      recent: [],
      notRunByCommandFamily: [],
      waiting: [],
      waitingTotal: 0,
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
// 0.6.14 T4 (JEVADV-85): MODELS_EMPTY is a catalog the worker never seeded
// (no modelsSeeded marker), so the Models tab names the shipped models; this
// one the person emptied after the seed, which keeps the plain text.
const MODELS_EMPTIED = { ...MODELS_EMPTY, modelsSeeded: true }

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
      { id: 'client-site-a-backend', label: 'client-site-a-backend', worktreePath: '/home/dev/Projects/client-site-a-backend' },
      { id: 'client-site-b-be', label: 'client-site-b-be', worktreePath: '/home/dev/Projects/client-site-b-be' },
    ],
    checkedAt: iso,
  },
}

/**
 * JEV-060 slice 1, T7 -- `ready` above has no `consumptionSummary` at all, so
 * the base `--quick` run photographs the Consumption card in its EMPTY
 * state, not populated. Same realistic numbers as
 * scripts/panels.spec.mjs's own POPULATED_CONSUMPTION fixture (two models,
 * one quota account near its weekly limit, every recommendation trigger
 * present) so the two dedicated screenshots this task also asks for --
 * board.html at 1440 light and 390 dark -- actually show the card doing its
 * job, not its honest-but-uninteresting empty state.
 */
const CONSUMPTION_READY = {
  ...READY,
  consumptionSummary: {
    ok: true,
    usage: {
      last24h: {
        stepCount: 42,
        byModel: [
          { model: 'claude-sonnet-5-5', stepCount: 30, inputShare: 0.11, cacheReadShare: 0.74, cacheWriteShare: 0.1, outputShare: 0.05 },
          { model: 'claude-opus-5-5', stepCount: 12, inputShare: 0.15, cacheReadShare: 0.57, cacheWriteShare: 0.2, outputShare: 0.08 },
        ],
        avgMainStepContextReread: 162345,
        subagentShare: 0.47,
        // 0.6.8 T6: the same split, as real totals.
        byAgent: { main: { stepCount: 30, tokens: 4120000 }, subagent: { stepCount: 12, tokens: 3650000 } },
      },
      last7d: {
        stepCount: 300,
        byModel: [{ model: 'claude-sonnet-5-5', stepCount: 300, inputShare: 0.12, cacheReadShare: 0.7, cacheWriteShare: 0.12, outputShare: 0.06 }],
        avgMainStepContextReread: 150500,
        subagentShare: 0.3,
        byAgent: { main: { stepCount: 210, tokens: 21000000 }, subagent: { stepCount: 90, tokens: 9000000 } },
      },
    },
    // `email` is what main.mjs's withAccountEmails joins on from `orca
    // account list --json`; the addresses are synthetic.
    quota: {
      accounts: [
        { id: 'acct-primary', status: 'ok', sessionUsedPercent: 12.4, weeklyUsedPercent: 81.2, resetsAt: Date.parse('2026-10-03T23:00:00.000Z'), email: 'someone@example.com' },
        { id: 'cccccccc-0000-4000-8000-000000000003', status: 'ok', sessionUsedPercent: 3, weeklyUsedPercent: 22.5, resetsAt: Date.parse('2026-10-02T06:00:00.000Z'), email: 'a.much.longer.person.name@example.com' },
      ],
      checkedAt: iso,
    },
    recommendations: {
      claudeMdSize: { estimatedTokens: 9000, overThreshold: true },
      mcpServerCount: { count: 5 },
      longSession: { avgMainStepContextReread: 162345, overThreshold: true },
      subagentShare: { subagentSharePercent: 47, overThreshold: true },
    },
    checkedAt: iso,
  },
}

/**
 * JEV-060 slice 2, §7/§9 T9 -- the config panel's "Jev model router" section
 * (one row per target, off/measure/active) and the board's Consumption
 * card's own "Model router" subsection, both populated at once: this
 * computer in `measure`, one Orca account in `active`, and a realistic
 * decision summary (real current model ids: Sonnet 5.5/Opus 5.5/Haiku 4.5,
 * same as CONSUMPTION_READY above) with decisions at all three points, an
 * applied switch, and a real dollar estimate -- so both new UI pieces show
 * their populated state, not the honest-but-uninteresting empty one.
 */
const ROUTER_EFFORT_DEFAULTS = { simple: 'medium', standard: 'medium', complex: 'high', frontier: 'xhigh' }
const ROUTER_TIERS_ANTHROPIC = {
  simple: { modelId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', supportsEffort: false },
  standard: { modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', supportsEffort: true },
  complex: { modelId: 'claude-opus-5-5', label: 'Opus 5.5', supportsEffort: true },
  frontier: { modelId: 'claude-opus-5-5', label: 'Opus 5.5', supportsEffort: true },
}
const ROUTER_READY = {
  ...CONSUMPTION_READY,
  modelRouterStatus: {
    // 0.6.2: the per-tier effort and the model each tier resolves to, as
    // install-claude-integration.mjs's router-mode-status publishes them.
    targets: [
      // The context steward's per-target settings (odd/tasks/jev-context-steward.md).
      { target: 'home', mode: 'measure', effort: ROUTER_EFFORT_DEFAULTS, tiers: ROUTER_TIERS_ANTHROPIC, steward: { mode: 'measure', threshold: 120000 }, workKind: 'measure' },
      { target: 'cccccccc-0000-4000-8000-000000000003', mode: 'active', email: 'owner@example.com', effort: { ...ROUTER_EFFORT_DEFAULTS, complex: 'xhigh' }, tiers: ROUTER_TIERS_ANTHROPIC, steward: { mode: 'active', threshold: 150000, softMode: 'active' }, workKind: 'active' },
      { target: 'bbbbbbbb-0000-4000-8000-000000000002', mode: 'measure', effort: ROUTER_EFFORT_DEFAULTS, tiers: ROUTER_TIERS_ANTHROPIC, steward: { mode: 'off', threshold: 120000 }, workKind: 'measure' },
    ],
    checkedAt: iso,
  },
  consumptionSummary: {
    ...CONSUMPTION_READY.consumptionSummary,
    modelRouter: {
      total: 9,
      applied: 5,
      measured: 4,
      byPoint: {
        start: { simple: 3, standard: 0, complex: 0, frontier: 0 },
        stage: { simple: 0, standard: 2, complex: 2, frontier: 1 },
        subagent: { simple: 1, standard: 0, complex: 0, frontier: 0 },
      },
      savedEstimate: 0.0847,
      switchesEstimated: 3,
    },
    // summarizeStewardDecisions' shape plus verifyStewardSaving's; synthetic figures.
    steward: {
      decisions: 7,
      applied: 3,
      wouldCompact: 2,
      freedPerStep: 114000,
      verified: { compactions: 59, verified: 32, steps: 4891, tokensNotReread: 1380000000, mainContextTokens: 3500000000, share: 0.283 },
    },
  },
}

/**
 * odd/tasks/board-leftovers.md L2 -- every other scenario's skills mod has
 * recorded nothing, so the Skills tab had only ever been photographed empty,
 * and the skills rows of "By project" never at all. Here the mod has run in
 * four projects, one per way the mod records where it ran: Orca's
 * remote-derived projectId (`github:owner/name`, twice, one of them the
 * project the gate rows above also count), Orca's `repo:<id>` for a checkout
 * with no remote, and the `cwd` fallback when Orca could not answer.
 *
 * The rows are shaped like the real mod-skills-measurements.jsonl
 * (src/core/skill_measurement.ts's DecisionRecord/ObservationRecord, the
 * same fields the mod writes), and they go through the real read path: the
 * harness writes them to a throwaway cache dir and runs the real
 * read-measurements.mjs over it, so `modSkills` below is the aggregator's
 * own output, byProject naming included. Every value is synthetic: made-up
 * repositories, paths and prompts.
 */
const SKILLS_LOG_PROJECTS = [
  { orcaContext: { worktree: '/home/dev/Projects/orca-supervisor', proyecto: 'github:example/orca-supervisor', rama: 'main' }, decisions: 6 },
  { orcaContext: { worktree: '/home/dev/worktrees/board-redesign', proyecto: 'github:example/orca-supervisor', rama: 'feat/board-redesign' }, decisions: 4 },
  { orcaContext: { worktree: '/home/dev/Projects/notes-app', proyecto: 'github:example/notes-app', rama: 'main' }, decisions: 5 },
  { orcaContext: { worktree: '/home/dev/Projects/scratch-notes', proyecto: 'repo:5f0c9a3e-1b2d-4c8e-9a7f-3e6d2b1c0a94', rama: 'main' }, decisions: 3 },
  { orcaContext: { worktree: '/home/dev/tmp/workdir', proyecto: 'workdir', rama: null }, decisions: 2 },
]
const SKILLS_LOG_SKILLS = ['graft', 'dataviz', 'orca-cli', 'chained-pr']
const SKILLS_READINESS_AT_WRITE = { ready: false, comparableShortfall: 1000, matchRateMet: null, reason: 'not-enough-samples' }

/** The log as the mod writes it: one decision per prompt, in measurement
 *  mode unless it is the project's last one (active mode, which withholds the
 *  listing when it names a skill), plus an observation of the skill the model
 *  really loaded for most named measurement-mode decisions. */
function skillsLogRows () {
  const rows = []
  let n = 0
  for (const project of SKILLS_LOG_PROJECTS) {
    for (let i = 0; i < project.decisions; i += 1) {
      n += 1
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const at = new Date(Date.parse('2026-09-22T09:00:00.000Z') + n * 47 * 60 * 1000).toISOString()
      const active = i === project.decisions - 1
      const skill = n % 3 === 0 ? null : SKILLS_LOG_SKILLS[n % SKILLS_LOG_SKILLS.length]
      const candidateCount = 60 + (n % 20)
      rows.push({
        type: 'decision', id, at, mode: active ? 'active' : 'measurement',
        prompt: `Synthetic prompt ${n} for the screenshot harness`,
        orcaContext: project.orcaContext,
        candidateCount,
        listingChars: candidateCount * 460 + n * 13,
        listingWithheld: active && skill !== null,
        wide: {
          ranked: [
            { name: skill ?? 'ship', probability: 0.41 },
            { name: 'get-linked-context', probability: 0.12 },
            { name: 'orchestration', probability: 0.07 },
          ],
          gate: 0.41,
          needsSkill: true,
        },
        fit: { winner: skill ?? 'ship', fits: { [skill ?? 'ship']: skill === null ? 0.22 : 0.36, 'get-linked-context': 0.11 } },
        decision: skill === null ? { name: null, reason: 'nothing fits, best fits 0.22 < 0.3' } : { name: skill, reason: 'stage 2, fits 0.36' },
        latencyMs: { wide: 400 + (n % 7) * 11, fit: 230 + (n % 5) * 9 },
        readiness: SKILLS_READINESS_AT_WRITE,
      })
      if (!active && skill !== null && n % 4 !== 0) {
        // The model mostly loads the skill Jev named; now and then it loads
        // another one, so the match rate is not 100%.
        const loaded = n % 5 === 0 ? 'orca-cli' : skill
        rows.push({ type: 'observation', id, at: new Date(Date.parse(at) + 90 * 1000).toISOString(), skill: loaded })
      }
    }
  }
  return rows
}

/** Runs the real read-measurements.mjs over `rows`, in a cache dir of its own. */
function realModSkillsSummary (rows) {
  const cache = mkdtempSync(join(tmpdir(), 'orca-skills-ready-'))
  try {
    writeFileSync(join(cache, 'mod-skills-measurements.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    const env = { ...process.env, ORCA_SUPERVISOR_CACHE_DIR: cache }
    delete env.NODE_TEST_CONTEXT
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'adapters/orca/read-measurements.mjs')], { env, encoding: 'utf8' })
    const summary = JSON.parse(stdout)
    if (!summary.ok) throw new Error(`read-measurements.mjs failed for skills-ready: ${JSON.stringify(summary)}`)
    return summary.modSkills
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

const SKILLS_READY = {
  ...READY,
  measurementsSummary: { ...READY.measurementsSummary, modSkills: realModSkillsSummary(skillsLogRows()) },
}

const SCENARIOS = { fresh: FRESH, empty: EMPTY, ready: READY, degraded: DEGRADED, seeds: SEEDS, baseline: BASELINE, 'models-empty': MODELS_EMPTY, 'models-emptied': MODELS_EMPTIED, 'catalog-proposals': CATALOG_PROPOSALS, 'consumption-ready': CONSUMPTION_READY, 'router-ready': ROUTER_READY }
// Added after the literal so the existing scenario list stays untouched.
SCENARIOS['skills-ready'] = SKILLS_READY

/**
 * 0.6.26 T3 -- an older plugin copy (Orca's marketplace one) activated over a
 * newer install and left it alone: main.mjs publishes what it skipped as
 * `newerInstall` next to the rest of the integration status.
 */
SCENARIOS['newer-install'] = {
  ...READY,
  claudeIntegrationStatus: {
    ...READY.claudeIntegrationStatus,
    // The newer install's copy is on disk; seen from this older root its
    // digest is not ours, so it exists but is not "installed".
    modCopy: { installed: false, exists: true, hasManifest: true },
    newerInstall: { version: '0.6.25', root: '/home/you/Projects/orca-jev-advisor-dev', ownVersion: '0.6.10' },
  },
}

/**
 * odd/tasks/board-leftovers.md L6 -- the owner's live panel with 63 agents:
 * one project and branch repeated more than ten times, rows marked working
 * three days after their last signal, and rows from days ago mixed in with
 * this hour's. Entries are shaped like main.mjs's onAgentStatusChanged
 * board entries; every name, id and pane is made up. Ages are real ISO
 * times relative to when the harness loads (not the 'now' sentinel, which
 * only this file's hostBridge resolves; panels.spec.mjs reads the scenario
 * through its own), so a long run only ages every row by the same minutes.
 */
const LIVE_BUSY_LOADED_AT = Date.now()
function liveBusyEntry (n, fields, ageMinutes) {
  const at = new Date(LIVE_BUSY_LOADED_AT - ageMinutes * 60 * 1000).toISOString()
  return {
    worktreeId: `wt-busy-${n}`, project: null, projectName: null, rama: null,
    paneKey: `${String(n).padStart(8, '0')}-5b2c-4c8e-9d11-7a0e3f2b9c41:0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f`,
    state: 'done', receivedAt: LIVE_BUSY_LOADED_AT - ageMinutes * 60 * 1000, updatedAt: at, ...fields,
  }
}
const LIVE_BUSY_PROJECT_A = { project: 'github:example/project-a', projectName: 'project-a', rama: 'main' }
const LIVE_BUSY_ENTRIES = [
  // One project and branch, twelve sessions over the last ten hours.
  ...[2, 14, 35, 60, 95, 130, 180, 240, 300, 380, 470, 590].map((age, i) =>
    liveBusyEntry(i + 1, { ...LIVE_BUSY_PROJECT_A, state: i === 0 ? 'working' : 'done' }, age)),
  liveBusyEntry(20, { project: 'github:example/orca-supervisor', projectName: 'orca-supervisor', rama: 'feat/board-redesign', state: 'working' }, 8),
  liveBusyEntry(21, { project: 'github:example/orca-supervisor', projectName: 'orca-supervisor', rama: 'feat/board-redesign' }, 42),
  // Working and waiting, but silent for hours: no signal.
  liveBusyEntry(22, { project: 'github:example/helpdesk', projectName: 'helpdesk', rama: 'main', state: 'working' }, 190),
  liveBusyEntry(23, { project: 'github:example/notes-app', projectName: 'notes-app', rama: 'fix/sync', state: 'waiting' }, 125),
  // No project at all: each stays its own row.
  liveBusyEntry(30, { worktreeId: 'global-floating-terminal', state: 'working' }, 1),
  liveBusyEntry(31, { worktreeId: 'global-floating-terminal' }, 33),
  liveBusyEntry(32, { worktreeId: null }, 21),
  liveBusyEntry(33, { worktreeId: null }, 65),
  liveBusyEntry(34, { project: 'repo:5c1d0e4f-2c18-4a14-b3c7-5a9d0e4f2c18', rama: 'main' }, 310),
  // Last seen over 24 h ago, behind "show more": one of them still says
  // working, three days on.
  liveBusyEntry(40, { project: 'github:example/client-site-a-orchestrator', projectName: 'client-site-a-orchestrator', rama: 'main', state: 'working' }, 3 * 24 * 60),
  liveBusyEntry(41, { project: 'github:example/website', projectName: 'website', rama: 'main' }, 2 * 24 * 60),
  liveBusyEntry(42, { project: 'github:example/scratch-notes', projectName: 'scratch-notes', rama: 'main' }, 30 * 60),
]
SCENARIOS['live-busy'] = { ...READY, board: { entries: LIVE_BUSY_ENTRIES } }

/**
 * JEVADV-63 -- the Activity tab's per-project cards fixture
 * (activityByProjectSummary, src/core/activity_by_project.ts's own output
 * shape). Seven projects, in the rank order the panel must show them in
 * without re-sorting: one with real router savings, one with a router
 * "extra cost" (a negative estimate, relabelled only at display time --
 * never shown as a negative saving), one with no router decisions at all
 * (router: null, never a fake zero row), one with an unresolved project
 * (project: null), and three more past the top-6 rank to exercise the
 * show-more toggle. Every name and number here is synthetic -- placeholder
 * project names only (0.6.3 privacy rule: this repo is public and carries
 * no real client/project names or usage figures from the owner's machine).
 */
function activityDaysFixture (peakDayIndex, peakJudged, peakSteps) {
  return Array.from({ length: 7 }, (_, i) => ({
    day: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    judgedCommands: i === peakDayIndex ? peakJudged : Math.max(0, Math.round(peakJudged * 0.2)),
    mainSteps: i === peakDayIndex ? peakSteps : Math.max(0, Math.round(peakSteps * 0.3)),
    subagentSteps: i === peakDayIndex ? Math.round(peakSteps * 0.4) : 0,
  }))
}
const ACTIVITY_READY_PROJECTS = [
  {
    project: 'client-site-a', lastActivityAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    days: activityDaysFixture(6, 14, 22),
    gateOutcomes: { allowed: 58, advised: 6, asked: 3, blocked: 1 },
    steps: { main: 90, subagent: 34 },
    tokensByModel: [
      { model: 'claude-sonnet-5-5', input: 42000, output: 8100, cacheRead: 310000, cacheWrite: 15200, estimatedCostUsd: 1.86 },
      { model: 'claude-opus-5-5', input: 3200, output: 900, cacheRead: 40000, cacheWrite: 2100, estimatedCostUsd: 0.71 },
    ],
    totalEstimatedCostUsd: 2.57,
    router: {
      total: 9, applied: 5, measured: 4,
      byPoint: {
        start: { simple: 2, standard: 0, complex: 0, frontier: 0 },
        stage: { simple: 0, standard: 2, complex: 1, frontier: 0 },
        subagent: { simple: 0, standard: 0, complex: 0, frontier: 0 },
      },
      savedEstimate: 0.94, switchesEstimated: 3,
    },
  },
  {
    // A switch happened but was net negative -- the card must relabel this
    // as an extra cost, never a negative "saved" number.
    project: 'service-b', lastActivityAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    days: activityDaysFixture(4, 6, 10),
    gateOutcomes: { allowed: 20, advised: 1, asked: 2, blocked: 0 },
    steps: { main: 40, subagent: 6 },
    tokensByModel: [{ model: 'claude-sonnet-5-5', input: 15000, output: 2600, cacheRead: 90000, cacheWrite: 5100, estimatedCostUsd: 0.52 }],
    totalEstimatedCostUsd: 0.52,
    router: {
      total: 3, applied: 2, measured: 1,
      byPoint: {
        start: { simple: 0, standard: 1, complex: 0, frontier: 0 },
        stage: { simple: 0, standard: 0, complex: 1, frontier: 0 },
        subagent: { simple: 0, standard: 0, complex: 0, frontier: 0 },
      },
      savedEstimate: -0.11, switchesEstimated: 1,
    },
  },
  {
    // No router decisions at all for this project -- router stays null,
    // never a zeroed-out summary.
    project: 'project-c', lastActivityAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    days: activityDaysFixture(1, 3, 5),
    gateOutcomes: { allowed: 9, advised: 0, asked: 0, blocked: 0 },
    steps: { main: 12, subagent: 0 },
    tokensByModel: [{ model: 'claude-haiku-4-5-20251001', input: 5000, output: 900, cacheRead: 12000, cacheWrite: 800, estimatedCostUsd: 0.04 }],
    totalEstimatedCostUsd: 0.04,
    router: null,
  },
  {
    // The gate could not resolve a project for these rows -- honestly
    // unknown, never dropped.
    project: null, lastActivityAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    days: activityDaysFixture(6, 2, 3),
    gateOutcomes: { allowed: 4, advised: 0, asked: 1, blocked: 0 },
    steps: { main: 5, subagent: 0 },
    tokensByModel: [],
    totalEstimatedCostUsd: 0,
    router: null,
  },
  {
    project: 'client-site-d', lastActivityAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    days: activityDaysFixture(0, 1, 2),
    gateOutcomes: { allowed: 3, advised: 0, asked: 0, blocked: 0 },
    steps: { main: 4, subagent: 0 },
    tokensByModel: [{ model: 'claude-sonnet-5-5', input: 2000, output: 400, cacheRead: 6000, cacheWrite: 300, estimatedCostUsd: 0.02 }],
    totalEstimatedCostUsd: 0.02,
    router: null,
  },
  {
    project: 'service-e', lastActivityAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    days: activityDaysFixture(0, 1, 1),
    gateOutcomes: { allowed: 2, advised: 0, asked: 0, blocked: 0 },
    steps: { main: 1, subagent: 0 },
    tokensByModel: [],
    totalEstimatedCostUsd: 0,
    router: null,
  },
  {
    // Past the top 6 -- only reachable through the show-more toggle.
    project: 'client-site-f', lastActivityAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    days: activityDaysFixture(0, 1, 1),
    gateOutcomes: { allowed: 1, advised: 0, asked: 0, blocked: 0 },
    steps: { main: 1, subagent: 0 },
    tokensByModel: [],
    totalEstimatedCostUsd: 0,
    router: null,
  },
]
SCENARIOS['activity-ready'] = {
  ...READY,
  activityByProjectSummary: { ok: true, projects: ACTIVITY_READY_PROJECTS, corruptLines: 0, checkedAt: iso },
}

/** A scenario may need one click before the shot -- see SEEDS. `baseline`
 *  needs none: the notice renders straight from policySeedNoticeStatus. */
const SCENARIO_CLICKS = { seeds: { panel: 'config.html', selector: '#import-policy-seeds' } }

// JEVADV-41 -- config.html now shows one section-group at a time behind
// role="tab" buttons inside #config-tabbar (see that element's own comment
// in the panel). Each tab is its own screen, so this harness photographs
// every one of them rather than only whichever tab happens to be active by
// default ('general').
const CONFIG_TAB_KEYS = ['general', 'destinations', 'policies', 'models', 'modskills', 'rules']
// odd/tasks/board-tabs-and-names.md T2 -- board.html has the same kind of
// tablist now (#board-tabbar), so it is photographed tab by tab too.
const BOARD_TAB_KEYS = ['gate', 'activity', 'consumption', 'skills']

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
  // --quick is what `npm run check` runs: the populated scenario only, each
  // panel once at a desktop width in light and once at a phone width in dark,
  // and one image per panel (each panel's first tab). Every tab of both
  // panels is still opened and checked for overflow and script errors; only
  // the photographs are cut, because nobody reviews hundreds of them per run. The full matrix
  // stays available as `npm run shots:all` for large UI changes.
  const quick = process.argv.includes('--quick')
  const requested = process.argv.includes('--scenario')
    ? process.argv[process.argv.indexOf('--scenario') + 1]
    : (quick ? 'ready' : 'all')
  const names = requested === 'all' ? Object.keys(SCENARIOS) : [requested]
  const combos = quick
    ? [['light', 1440], ['dark', 390]]
    : THEMES.flatMap((theme) => WIDTHS.map((width) => [theme, width]))
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
        for (const [theme, width] of combos) {
          {
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              colorScheme: theme,
              deviceScaleFactor: 2,
              locale: process.argv.includes('--locale') ? process.argv[process.argv.indexOf('--locale') + 1] : 'en-US'
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

            // JEVADV-41: config.html shows one section-group at a time behind
            // #config-tabbar, and board.html behind #board-tabbar
            // (odd/tasks/board-tabs-and-names.md T2); each tab is its own
            // screen and gets its own screenshot and its own overflow check.
            const tabKeys = panel === 'config.html' ? CONFIG_TAB_KEYS : BOARD_TAB_KEYS
            for (const tabKey of tabKeys) {
              await page.click(`#tab-${tabKey}`)
              await page.waitForTimeout(300)
              // 0.6.28 T4: the remembered authorizations are read after the
              // panel's first batch of reads, a host quota window later.
              if (tabKey === 'rules') await page.waitForSelector('#gate-authorizations-section[data-state="ready"]', { timeout: 15000 })
              // 0.6.28 T7: the trusted programs are read right after them.
              if (tabKey === 'rules') await page.waitForSelector('#trusted-programs-section[data-state="ready"]', { timeout: 15000 })

              const overflow = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth
              }))
              const label = `${scenario}/${panel}/${theme}/${width}/${tabKey}`
              if (overflow.scrollWidth > overflow.clientWidth) {
                overflows.push(`${label}: content is ${overflow.scrollWidth}px wide`)
              }

              const name = `${scenario}-${panel.replace('.html', '')}-${theme}-${width}-${tabKey}.png`
              if (!quick || tabKey === tabKeys[0]) {
                await page.screenshot({ path: join(OUT_DIR, name), fullPage: true })
                shots += 1
              }
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
