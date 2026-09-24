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
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PANELS_DIR = join(ROOT, 'adapters/orca/panels')
const OUT_DIR = join(ROOT, '.screenshots')
const WORK_DIR = join(OUT_DIR, '.rendered')

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
    secretMirror: { ok: true },
    checkedAt: iso
  },
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
  board: { entries: [] },
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
      totalDecisions: 2297,
      byVerdict: { allow: 2013, ask: 279, deny: 5 },
      bySource: { jev: 2029, cache: 149, 'local-rule': 119, none: 0 },
      jevLatency: { sampleCount: 2029, medianMs: 447, maxMs: 1742 },
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
      cacheHitRate: 149 / 2297,
      recent: [
        { at: '2026-09-24T15:02:03.837Z', project: 'orca-supervisor', commandFamily: 'cd', source: 'jev', verdict: 'allow', latencyMs: 784 },
        { at: '2026-09-24T15:01:44.102Z', project: 'orca-supervisor', commandFamily: 'rm -rf', source: 'local-rule', verdict: 'ask', latencyMs: null },
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
const DEGRADED = {
  ...READY,
  measurementsSummary: {
    ...READY.measurementsSummary,
    gate: {
      ...READY.measurementsSummary.gate,
      totalDecisions: 2354,
      bySource: { ...READY.measurementsSummary.gate.bySource, none: 57 },
      recent: [
        { at: '2026-09-24T17:33:10.004Z', project: 'orca-supervisor', commandFamily: 'other', source: 'none', verdict: 'allow', latencyMs: null },
        ...READY.measurementsSummary.gate.recent,
      ],
    },
  },
}

const SCENARIOS = { fresh: FRESH, ready: READY, degraded: DEGRADED }

/**
 * Impersonates the host bridge. Installed before the panel's own script runs,
 * because the panel starts calling immediately on load.
 */
function hostBridge(storage) {
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || msg.type !== 'orca-panel-action') return
    let value = null
    if (msg.action === 'storage.get') value = storage[msg.params?.key] ?? null
    if (value && value.at === 'now') value = { ...value, at: new Date().toISOString() }
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

  // The panel reads its language from `<html lang>`, which the Orca shell sets.
  // Rewriting the tag is simpler and more faithful than patching the DOM after
  // load, which races the panel's own first read.
  const rendered = {}
  for (const panel of PANELS) {
    const html = await readFile(join(PANELS_DIR, panel), 'utf8')
    if (!html.includes('<html>')) throw new Error(`${panel}: no bare <html> tag to localise`)
    const path = join(WORK_DIR, panel)
    await writeFile(path, html.replace('<html>', '<html lang="en">'))
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
              deviceScaleFactor: 2
            })
            const page = await context.newPage()
            await page.addInitScript(hostBridge, SCENARIOS[scenario])
            const failures = []
            page.on('pageerror', (error) => failures.push(String(error.message)))
            await page.goto(`file://${rendered[panel]}`)
            await page.waitForTimeout(SETTLE_MS)

            const overflow = await page.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth
            }))
            if (overflow.scrollWidth > overflow.clientWidth) {
              overflows.push(
                `${scenario}/${panel}/${theme}/${width}: content is ${overflow.scrollWidth}px wide`
              )
            }
            if (failures.length > 0) {
              overflows.push(`${scenario}/${panel}/${theme}/${width}: script error: ${failures[0]}`)
            }

            const name = `${scenario}-${panel.replace('.html', '')}-${theme}-${width}.png`
            await page.screenshot({ path: join(OUT_DIR, name), fullPage: true })
            shots += 1
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

await main()
