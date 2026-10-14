// End-to-end checks of the config panel, driven as a person drives it.
//
// A panel is a sandboxed document that talks to its host over postMessage, so
// loading one on its own renders an empty shell and proves nothing. This spec
// plays the host, the way scripts/screenshot-panels.mjs does, but asserts on
// what the page ends up SAYING rather than photographing it -- the screenshot
// run measures overflow and script errors, and would happily photograph a
// panel that renders the wrong words.
//
// Two details cost an hour each if rediscovered:
//   1. The panel reads `result.value.value`. The doubled `value` is real: the
//      host wraps the action result and the storage read wraps the datum.
//   2. The panel rate-limits its own host calls, so anything asserted before
//      it settles catches a spinner.
//
// Playwright is a devDependency and the README is explicit that Orca installs
// nothing when it clones this plugin, so a machine without it skips rather
// than fails. `npm run test:panels` is the command that runs this.
//
// It runs it in four shards. Almost every test here opens a panel and waits
// SETTLE_MS for it, so ~200 of them back to back in one process took ~25
// minutes, almost all of it waiting. scripts/panels.shard-N.spec.mjs each set
// PANELS_SPEC_SHARD to "N/4" and import this file, which then registers only
// the tests whose position in it, modulo 4, is N-1; node --test runs the four
// files as parallel processes, so every test still runs exactly once, with its
// own assertions, in one combined report. Run on its own
// (`node --test scripts/panels.spec.mjs`), with the variable unset, the file
// registers every test, as it always did.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test as nodeTest } from 'node:test'

/** "N/COUNT" (1-based) to { index, count }, or null when the variable is unset.
 *  Anything else throws: a typo here must not quietly run a quarter of the suite. */
function parseShard (value) {
  if (value === undefined || value === '') return null
  const match = /^(\d+)\/(\d+)$/.exec(value)
  const shard = match ? Number(match[1]) : 0
  const count = match ? Number(match[2]) : 0
  if (shard < 1 || shard > count) throw new Error(`PANELS_SPEC_SHARD must look like "2/4", got ${JSON.stringify(value)}`)
  return { index: shard - 1, count }
}

const SHARD = parseShard(process.env.PANELS_SPEC_SHARD)
let testsSeen = 0

/** node:test's own `test`, registered only when the test's position falls in this shard. */
function test (...args) {
  const position = testsSeen++
  if (SHARD === null || position % SHARD.count === SHARD.index) nodeTest(...args)
}

// main.mjs pulls in src/core/secrets.ts, which resolves the config dir at
// MODULE scope -- and src/core/paths.ts now refuses to hand back the real
// ~/.config/orca-supervisor under the test runner. So the override has to be
// set before that module graph loads, and a static `import` is hoisted above
// every statement in this file. Hence the dynamic import below, the same
// shape main.test.mjs and the A/B CLI test use. Third occurrence of the same
// hoisting trap; the comment is here so the fourth is quick to diagnose.
const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), 'orca-panels-spec-'))
process.env.ORCA_SUPERVISOR_CONFIG_DIR = join(ISOLATED_ROOT, 'config')
process.env.ORCA_SUPERVISOR_CACHE_DIR = join(ISOLATED_ROOT, 'cache')

const { parseSeedPolicies, parseSeedVersion } = await import('../src/core/policy_seed.ts')
const { mergePolicySeeds } = await import('../src/core/policy_seed_import.ts')
const { decidePolicySeedNotice } = await import('../src/core/policy_seed_notice.ts')
const { seedPoliciesIfEmpty } = await import('../adapters/orca/main.mjs')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_PANEL = join(ROOT, 'adapters/orca/panels/config.html')
const BOARD_PANEL = join(ROOT, 'adapters/orca/panels/board.html')

/** The panel throttles its own host calls; anything shorter observes a spinner. */
const SETTLE_MS = 6000

let chromium = null
try {
  ({ chromium } = await import('playwright'))
} catch {
  chromium = null
}

// One Chromium per process, launched on first use; each test gets its own
// context (its own storage, viewport, locale and colour scheme) and closes it.
// Launching a browser per test cost a second or more each, ~200 times over.
// The openers below hand the context back as `browser`, so every test's
// `finally { await browser.close() }` closes its own context and nothing else.
let browserLaunch = null
async function sharedBrowser () {
  if (browserLaunch !== null) {
    const running = await browserLaunch
    if (running.isConnected()) return running
  }
  browserLaunch = chromium.launch()
  return browserLaunch
}
after(async () => {
  if (browserLaunch !== null) await (await browserLaunch).close()
})

// SCENARIOS.ready is screenshot-panels.mjs's own fixture, derived from the
// same worker shapes this file already checks (see its own module doc and
// scripts/fixture_shape.test.mjs) -- reused here rather than a second,
// hand-typed board fixture that could drift from it unnoticed. That module
// imports `playwright` itself, unguarded, at its own top -- so this import
// is guarded the same way chromium's is above, or a machine with no
// playwright (this file's own header: "a machine without it skips rather
// than fails") would throw ERR_MODULE_NOT_FOUND here before a single test
// even registers, instead of skipping.
let SCENARIOS = null
try {
  ({ SCENARIOS } = await import('./screenshot-panels.mjs'))
} catch {
  SCENARIOS = null
}

// odd/tasks/board-global-window.md W1: the readers publish one summary per
// board window. `windowed(figures, byKey)` builds that shape through the
// readers' own perBoardWindow, the same figures in every window unless
// `byKey` names a window's own.
const { perBoardWindow } = await import('../adapters/orca/log-files.mjs')
const { boardWindows, HOURLY_LOG_KEPT_MS } = await import('../src/core/board_windows.ts')
function windowed (figures, byKey = {}) {
  const now = Date.now()
  return { windows: perBoardWindow(boardWindows(now, null), now, now - HOURLY_LOG_KEPT_MS, (window) => (byKey[window.key] ?? figures)) }
}

const RAW_SEED = JSON.parse(await readFile(join(ROOT, 'seed/policies.json'), 'utf8'))
const SHIPPED = parseSeedPolicies(RAW_SEED)
const SHIPPED_VERSION = parseSeedVersion(RAW_SEED)

// The three rows this release added, and the wording it tightened on an id
// it already had -- both real, from seed/policies.json's own history (see
// odd/tasks/gate-destructive-restore-and-seed-refresh.md's T2 notes), never
// invented for this fixture. Used below to drive the baseline notice off a
// realistic "install that seeded an earlier release" list, so its counts
// come from the real `mergePolicySeeds`/`decidePolicySeedNotice`, not a
// guess.
const BASELINE_UPDATE_REMOVED_IDS = ['discard_uncommitted_work', 'no_force_push', 'infrastructure_changes']
const BASELINE_UPDATE_OLD_UNIT_COMMITS_RULE =
  "Committing without asking is fine on the feature branch, with its tests and its docs in the same commit. " +
  "Pushing the branch to the remote too, as long as it isn't a shared branch."

function existingBeforeBaselineUpdate () {
  return SHIPPED.filter((row) => !BASELINE_UPDATE_REMOVED_IDS.includes(row.id)).map((row) =>
    row.id === 'unit_commits' ? { ...row, rule: BASELINE_UPDATE_OLD_UNIT_COMMITS_RULE } : row)
}

const BASELINE_UPDATE_DECISION = decidePolicySeedNotice({
  shippedVersion: SHIPPED_VERSION,
  offeredVersion: 0,
  existing: existingBeforeBaselineUpdate(),
  shipped: SHIPPED
})
// JEVADV-27 -- the real differing rows for the same scenario, the same shape
// main.mjs's computePolicySeedNoticeDecision now publishes as
// policySeedNoticeStatus.differingItems (never a hand-typed count).
const BASELINE_UPDATE_DIFFERING_ITEMS = mergePolicySeeds(existingBeforeBaselineUpdate(), SHIPPED).differing

/**
 * The storage a fresh install ends up with, produced by running the REAL
 * seeding the worker runs at activation -- not by hand-injecting the rows.
 *
 * That distinction is the whole point. An earlier version of this file put
 * `{ policies: SHIPPED }` straight into the fake storage, which made the test
 * pass even with seeding entirely disabled: it proved the panel can render
 * policies, never that anything puts them there.
 */
async function storageAfterRealSeeding () {
  const store = {}
  const host = {
    async get (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    async set (key, value) { store[key] = value }
  }
  await seedPoliciesIfEmpty({ log: () => {} }, host)
  return store
}

const temps = []
after(async () => { for (const dir of temps) await rm(dir, { recursive: true, force: true }) })

/** Copies the panel out to a temp path -- Playwright needs a real file for
 *  `file://`. The locale itself is no longer an `<html lang>` mutation:
 *  JEVADV-10 (odd/tasks/release-0.5.1.md) found Orca's plugin shells
 *  hardcode `<html lang="en">` on every panel, so the panel now detects its
 *  locale from `navigator.languages`/`navigator.language` instead (see
 *  config.html's localeFromOrca) -- openPanel/openBoardPanel below drive
 *  that through the browser CONTEXT's own `locale` option instead. */
async function renderPanel () {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-panel-'))
  temps.push(dir)
  const html = await readFile(CONFIG_PANEL, 'utf8')
  const path = join(dir, 'config.html')
  await writeFile(path, html)
  return path
}

/** 'es'/'en' (the only two this suite ever asks for) to a real BCP47 tag
 *  Playwright's context `locale` option accepts -- anything else (an
 *  already-full tag like 'es-CO', for a test that wants a specific region)
 *  passes through unchanged. */
function playwrightLocaleFor (locale) {
  if (locale.indexOf('-') !== -1) return locale
  return locale === 'es' ? 'es-ES' : 'en-US'
}

/**
 * Impersonates the host bridge. `answer` may replace the value for any key,
 * which is how a request the panel has just written gets a result back.
 */
function hostBridge (storage) {
  window.__written = {}
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || msg.type !== 'orca-panel-action') return
    let value = null
    if (msg.action === 'storage.get') {
      const key = msg.params?.key
      // A request/result round trip is answered with the paired result,
      // keyed by the id the panel itself minted -- the same handshake the
      // worker performs. `storage.__policySeedImportResult`/
      // `storage.__policySeedDismissResult` let a test override ok/added/
      // etc; a plain "it worked" is the default so a test that only cares
      // about the request being sent does not have to supply one.
      if (key === 'catalogRefreshResult' && window.__written.catalogRefreshRequest) {
        value = { ...storage.__refreshResult, id: window.__written.catalogRefreshRequest.id }
      } else if (key === 'catalogProposalAcceptResult' && window.__written.catalogProposalAcceptRequest) {
        value = { ok: true, added: 0, ...storage.__proposalAcceptResult, id: window.__written.catalogProposalAcceptRequest.id }
      } else if (key === 'policySeedImportResult' && window.__written.policySeedImportRequest) {
        value = {
          ok: true, added: 0, skipped: 0, replaced: 0, differing: [],
          ...storage.__policySeedImportResult,
          id: window.__written.policySeedImportRequest.id
        }
      } else if (key === 'policySeedDismissResult' && window.__written.policySeedDismissRequest) {
        value = { ok: true, ...storage.__policySeedDismissResult, id: window.__written.policySeedDismissRequest.id }
      } else if (key === 'modelRouterConfigResult' && window.__written.modelRouterConfigRequest) {
        // JEV-060 slice 2, T9: same request/result handshake as the other
        // channels above -- `storage.__modelRouterConfigResult` lets a test
        // override ok/reason/detail; a plain "it worked" is the default.
        value = { ok: true, ...storage.__modelRouterConfigResult, id: window.__written.modelRouterConfigRequest.id }
      } else if (key === 'modelRouterStatus' && window.__written.modelRouterStatusRefreshRequest) {
        // 0.6.2 E7: the worker answers a refresh request by republishing the
        // status with the request's id. `storage.__routerRefreshSequence`
        // gives the nth refresh its own status (a mode changed from a
        // terminal in between); by default the stored status comes back.
        // `__routerRefreshDelayMs` holds the answer back (the worker is slow);
        // `__routerRefreshWithoutId` answers like the periodic publish does,
        // with a newer checkedAt but no refreshId.
        const sequence = storage.__routerRefreshSequence
        const fresh = Array.isArray(sequence) ? sequence[Math.min(window.__routerRefreshCount, sequence.length) - 1] : storage.modelRouterStatus
        if (storage.__routerRefreshDelayMs && Date.now() - window.__routerRefreshAt < storage.__routerRefreshDelayMs) value = storage.modelRouterStatus
        else if (storage.__routerRefreshWithoutId) value = { ...fresh, checkedAt: new Date(Date.now() + 1000).toISOString() }
        else value = { ...fresh, refreshId: window.__written.modelRouterStatusRefreshRequest.id, checkedAt: new Date().toISOString() }
      } else if (key === 'trustedProgramResult' && window.__written.trustedProgramRequest) {
        // 0.6.28 T7: the worker validates the name; `storage.__trustedProgramResult`
        // overrides ok/reason, and `storage.__trustedProgramsAfter` is the list it publishes.
        value = { ok: true, reason: null, name: String(window.__written.trustedProgramRequest.name).trim().toLowerCase(), ...storage.__trustedProgramResult, id: window.__written.trustedProgramRequest.id }
      } else if (key === 'trustedProgramsStatus' && window.__written.trustedProgramRequest && storage.__trustedProgramsAfter) {
        value = { programs: storage.__trustedProgramsAfter, checkedAt: new Date().toISOString() }
      } else if (key === 'featureModulesSaveResult' && window.__written.featureModulesSaveRequest) {
        // feature-modules T5: the worker answers the module switch with the id the panel minted;
        // `storage.__featureModulesResult` overrides ok/skipped/reason (a skipped install, a refusal).
        value = { ok: true, saved: true, skipped: false, reason: null, detail: null, modules: null, ...storage.__featureModulesResult, id: window.__written.featureModulesSaveRequest.id }
      } else if (key === 'modelsSeedResult' && window.__written.modelsSeedRequest) {
        // odd/tasks/model-reclassification.md T7: models-worker.mjs answers
        // one request/result channel for both apply and dismiss (unlike the
        // two separate policy channels above), so this needs only one branch.
        value = {
          ok: true, replaced: 0, added: 0, reason: null, detail: null,
          ...storage.__modelsSeedResult, id: window.__written.modelsSeedRequest.id
        }
      } else {
        value = storage[key] ?? null
      }
    }
    if (msg.action === 'storage.set') window.__written[msg.params?.key] = msg.params?.value
    if (msg.action === 'storage.set' && msg.params?.key === 'modelRouterStatusRefreshRequest') {
      window.__routerRefreshCount = (window.__routerRefreshCount ?? 0) + 1
      window.__routerRefreshAt = Date.now()
    }
    window.postMessage(
      { type: 'orca-panel-action-result', requestId: msg.requestId, ok: true, value: { value } },
      '*'
    )
  })
}

/** Copies board.html out -- same discipline as renderPanel above; no more a
 *  language tag than that one is. */
async function renderBoardPanel () {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-board-panel-'))
  temps.push(dir)
  const html = await readFile(BOARD_PANEL, 'utf8')
  const path = join(dir, 'board.html')
  await writeFile(path, html)
  return path
}

/** Same host-simulation shape as openPanel, against board.html instead of
 *  config.html -- hostBridge needs no board-specific branch: board.html's
 *  reads fall through to the plain `storage[key] ?? null` branch already
 *  there, and its one write, the active tab through storage.set, lands in
 *  `window.__written` like any other. */
// `options.viewport` narrows the page (the 320px overflow check below), and
// `options.throwingStorage` replaces `window.localStorage` with a getter that
// throws, the same simulation openPanelWithThrowingStorage uses for
// config.html, applied before the board's own script runs.
async function openBoardPanel (storage, locale = 'en', colorScheme = 'light', options = {}) {
  const context = await (await sharedBrowser()).newContext({ viewport: options.viewport ?? { width: 1440, height: 1200 }, colorScheme, locale: playwrightLocaleFor(locale) })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message)))
  await page.addInitScript(hostBridge, storage)
  if (options.throwingStorage) {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get () { throw new Error('storage disabled for this test') }
      })
    })
  }
  await page.goto(`file://${await renderBoardPanel()}`)
  await page.waitForTimeout(SETTLE_MS)
  return { browser: context, page, errors }
}

// `viewport` defaults to what every existing test in this file already
// assumed before JEVADV-41 -- the tab-height test below is the first one
// that needs a narrower one (320px, the layout every .row/.row.two/.row.four
// rule collapses to a single column at, and so the tallest one).
async function openPanel (storage, locale = 'en', colorScheme = 'light', viewport = { width: 1440, height: 1200 }) {
  const context = await (await sharedBrowser()).newContext({ viewport, colorScheme, locale: playwrightLocaleFor(locale) })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message)))
  await page.addInitScript(hostBridge, storage)
  await page.goto(`file://${await renderPanel()}`)
  await page.waitForTimeout(SETTLE_MS)
  return { browser: context, page, errors }
}

/** Same host simulation as openPanel, but with `window.localStorage`
 *  replaced by a getter that throws -- JEVADV-41's tab memory must not be
 *  able to break the panel on a machine where storage access itself throws
 *  (private browsing, a disabled/full quota, or -- in production -- Orca's
 *  own sandboxed opaque-origin iframe, where it always does; see the
 *  panel's own <head> comment). The override has to be an initScript, run
 *  before config.html's own script executes, not something set after
 *  goto -- by then the panel's first paint has already happened. */
async function openPanelWithThrowingStorage (storage) {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1440, height: 1200 }, locale: 'en-US' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message)))
  await page.addInitScript(hostBridge, storage)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get () { throw new Error('storage disabled for this test') }
    })
  })
  await page.goto(`file://${await renderPanel()}`)
  await page.waitForTimeout(SETTLE_MS)
  return { browser: context, page, errors }
}

test('the seeded policies are the ones a person actually sees in the panel', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // The defect this covers: seed/policies.json shipped for the life of the
  // plugin and nothing read it, so this section rendered empty on every
  // install. Asserting the rows are IN STORAGE would not have caught it --
  // they were never in storage. This asserts the person sees them.
  const seeded = await storageAfterRealSeeding()
  assert.ok(Array.isArray(seeded.policies) && seeded.policies.length > 0,
    'activation planted nothing, so there is nothing for the panel to show')
  const { browser, page, errors } = await openPanel(seeded)
  try {
    const shown = await page.evaluate(() => document.getElementById('policies-list').innerText)
    assert.ok(SHIPPED.length > 0, 'the shipped seed is empty, so this proves nothing')
    for (const row of SHIPPED) {
      assert.ok(shown.includes(row.id), `the panel never shows policy '${row.id}'`)
    }
    assert.deepEqual(errors, [], 'the panel threw while rendering the policies')
  } finally {
    await browser.close()
  }
})

test('a policy stored with a legacy Spanish kind keeps its kind on screen and on save', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // Found live on 2026-09-26: rows stored before the kind rename carry
  // permite/prohibe/pregunta. The gate already maps them (migratePolicyKind),
  // but the panel showed them as "-- Choose --" and a plain "Save" wrote
  // them back WITHOUT a kind, which silently took every one of them out of
  // judgment -- client_always_asks and production among them.
  const legacy = [
    { id: 'legacy_permits', rule: 'Reading code happens without asking.', kind: 'permite' },
    { id: 'legacy_prohibits', rule: 'Never write directly on main.', kind: 'prohibe' },
    { id: 'legacy_asks', rule: 'Anything that touches a client gets confirmed.', kind: 'pregunta' },
  ]
  const { browser, page, errors } = await openPanel({ policies: legacy })
  try {
    const shownKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#policies-list .entry select')).slice(0, 3).map((select) => select.value))
    assert.deepEqual(shownKinds, ['permits', 'prohibits', 'requires_human'])
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    const written = await page.evaluate(() => window.__written.policies)
    assert.deepEqual(written.map((row) => row.kind), ['permits', 'prohibits', 'requires_human'],
      'saving must never drop a legacy kind the gate still honours')
    assert.deepEqual(errors, [], 'the panel threw while rendering or saving the policies')
  } finally {
    await browser.close()
  }
})

test('a panel with no policies shows none, which is what a pre-seed install looked like', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ policies: [] })
  try {
    const shown = await page.evaluate(() => document.getElementById('policies-list').innerText.trim())
    for (const row of SHIPPED) {
      assert.ok(!shown.includes(row.id), `an empty install somehow shows policy '${row.id}'`)
    }
  } finally {
    await browser.close()
  }
})

test('a refresh that could not reach the CLI says so, instead of reporting nothing to add', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // The whole point of the `derivation-failed` reason. Before it, a CLI call
  // that failed produced `ok: true, added: 0`, which the panel rendered as
  // the same cheerful "nothing new" a healthy machine gets -- so a broken
  // refresh was indistinguishable from a refresh with nothing to do.
  const { browser, page } = await openPanel({
    catalog: { destinations: [] },
    __refreshResult: { at: new Date().toISOString(), ok: false, proposed: null, reason: 'derivation-failed', detail: 'spawn orca ENOENT' }
  })
  try {
    // JEVADV-41: refresh-catalog now lives inside the Destinations tab,
    // hidden by default (General is).
    await page.click('#tab-destinations')
    await page.click('#refresh-catalog')
    await page.waitForFunction(() => {
      const said = document.getElementById('catalog-refresh-said')
      return said && /could not be read/i.test(said.innerText)
    }, undefined, { timeout: 25000 })

    const said = await page.evaluate(() => document.getElementById('catalog-refresh-said').innerText)
    assert.match(said, /could not be read/i)
    assert.doesNotMatch(said, /nothing new|no new/i, 'a failed refresh still reads as a successful one')
  } finally {
    await browser.close()
  }
})

test('a refresh that genuinely adds nothing keeps saying exactly that', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // The other side of the same fork: the honest "nothing new" must survive.
  const { browser, page } = await openPanel({
    catalog: { destinations: [] },
    __refreshResult: { at: new Date().toISOString(), ok: true, proposed: 0, reason: null, detail: null }
  })
  try {
    await page.click('#tab-destinations')
    await page.click('#refresh-catalog')
    await page.waitForFunction(() => {
      const said = document.getElementById('catalog-refresh-said')
      return said && said.innerText.trim().length > 0 && !/refreshing/i.test(said.innerText)
    }, undefined, { timeout: 25000 })

    const said = await page.evaluate(() => document.getElementById('catalog-refresh-said').innerText)
    assert.doesNotMatch(said, /could not be read/i, 'a healthy refresh was reported as a failure')
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// JEVADV-11 (odd/tasks/release-0.5.1.md) -- "Search Orca" used to silently
// ADD a newly-seen worktree with `kind: "project"` hardcoded. It now only
// computes a proposal list; the person ticks which repositories to adopt
// and picks a kind for each, never a guessed one.
// ---------------------------------------------------------------------------

const CATALOG_PROPOSAL_FIXTURE = {
  ok: true,
  proposals: [
    { id: 'client-site-a-backend', label: 'client-site-a-backend', worktreePath: '/home/dev/Projects/client-site-a-backend' },
    { id: 'client-site-b-be', label: 'client-site-b-be', worktreePath: '/home/dev/Projects/client-site-b-be' }
  ],
  checkedAt: new Date().toISOString()
}

test('a proposed repository renders on a plain reload, with no kind pre-selected', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({
    catalog: { destinations: [] },
    catalogProposalsStatus: CATALOG_PROPOSAL_FIXTURE
  })
  try {
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#catalog-proposals input[data-catalog-proposal-id]')).map((box) => box.getAttribute('data-catalog-proposal-id')))
    assert.deepEqual(rows.sort(), ['client-site-a-backend', 'client-site-b-be'])
    const kindValues = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#catalog-proposals select[data-catalog-proposal-kind]')).map((select) => select.value))
    assert.ok(kindValues.every((v) => v === ''), `every proposal's kind must start unchosen, got: ${JSON.stringify(kindValues)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('clicking "Add ticked" with a ticked row but no kind chosen refuses, and sends no request', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    catalog: { destinations: [] },
    catalogProposalsStatus: CATALOG_PROPOSAL_FIXTURE
  })
  try {
    await page.click('#tab-destinations')
    await page.click('#catalog-proposals input[data-catalog-proposal-id="client-site-a-backend"]')
    await page.click('#add-catalog-proposals')
    await page.waitForFunction(() => {
      const said = document.querySelector('#catalog-proposals .said')
      return said && said.innerText.trim().length > 0
    }, undefined, { timeout: 25000 })
    const written = await page.evaluate(() => window.__written.catalogProposalAcceptRequest)
    assert.equal(written, undefined, 'a row with no kind chosen must never reach a request')
  } finally {
    await browser.close()
  }
})

test('ticking a proposal, picking a kind, and clicking "Add ticked" sends exactly that id/kind pair', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    catalog: { destinations: [] },
    catalogProposalsStatus: CATALOG_PROPOSAL_FIXTURE,
    __proposalAcceptResult: { added: 1 }
  })
  try {
    await page.click('#tab-destinations')
    await page.click('#catalog-proposals input[data-catalog-proposal-id="client-site-a-backend"]')
    await page.selectOption('#catalog-proposals select[data-catalog-proposal-kind="client-site-a-backend"]', 'client-site')
    await page.click('#add-catalog-proposals')
    await page.waitForFunction(() => !!window.__written.catalogProposalAcceptRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.catalogProposalAcceptRequest)
    assert.deepEqual(request.accepted, [{ id: 'client-site-a-backend', kind: 'client-site' }])
  } finally {
    await browser.close()
  }
})

test('the catalog-proposals list stays empty on a reload when the status carries none', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ catalog: { destinations: [] } })
  try {
    const rows = await page.evaluate(() => document.querySelectorAll('#catalog-proposals input[data-catalog-proposal-id]').length)
    assert.equal(rows, 0)
  } finally {
    await browser.close()
  }
})

test('every catalog.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('catalog.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('catalog.') === 0)
    assert.deepEqual(esKeys.filter((key) => enKeys.indexOf(key) === -1), [])
    assert.deepEqual(enKeys.filter((key) => esKeys.indexOf(key) === -1), [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// T2b -- the "shipped baseline changed" notice in Team Policies. See
// odd/tasks/gate-destructive-restore-and-seed-refresh.md and
// src/core/policy_seed_notice.ts. BASELINE_UPDATE_DECISION above is the real
// decidePolicySeedNotice output for a realistic "seeded an earlier release"
// install, never invented numbers.
// ---------------------------------------------------------------------------

test('the baseline notice shows the worker\'s real counts when the status says it is due', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  assert.ok(BASELINE_UPDATE_DECISION.due, 'the fixture scenario is not actually due, so this proves nothing')
  const { browser, page, errors } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, at: new Date().toISOString() }
  })
  try {
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('policy-seed-notice')).display !== 'none')
    assert.ok(visible, 'the notice did not render even though the status says it is due')
    const text = await page.evaluate(() => document.getElementById('policy-seed-notice-text').innerText)
    assert.ok(text.includes(String(BASELINE_UPDATE_DECISION.added)), `notice text "${text}" is missing the real added count`)
    assert.ok(text.includes(String(BASELINE_UPDATE_DECISION.differing)), `notice text "${text}" is missing the real differing count`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// JEVADV-27 -- odd/tasks/release-0.5.1.md. Before this fix, `#policy-diffs`
// only ever got rendered as the side effect of a live import request/result
// round trip (clicking "Review" or "Adopt ticked"); a plain panel reload
// showed the notice banner's counts but never the tick list itself, even
// though storage held the real rows all along in
// policySeedImportResult.differing. This asserts the list renders straight
// from the worker's stored status on load, with no click required.
test('the differing-policy rows render on a plain reload, straight from the stored status -- no click required', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  assert.ok(BASELINE_UPDATE_DIFFERING_ITEMS.length > 0, 'the fixture scenario has nothing differing, so this proves nothing')
  const { browser, page, errors } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, differingItems: BASELINE_UPDATE_DIFFERING_ITEMS, at: new Date().toISOString() }
  })
  try {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#policy-diffs input[data-policy-diff-id]')).map((box) => box.getAttribute('data-policy-diff-id')))
    assert.deepEqual(ids.sort(), BASELINE_UPDATE_DIFFERING_ITEMS.map((d) => d.id).sort(),
      'the differing rows were not rendered from the stored status on a plain load')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the differing-policy list stays empty on load when the notice is not due, even with differingItems present (a resolved/legacy install)', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { due: false, added: 0, differing: BASELINE_UPDATE_DIFFERING_ITEMS.length, shippedVersion: SHIPPED_VERSION, differingItems: BASELINE_UPDATE_DIFFERING_ITEMS, at: new Date().toISOString() }
  })
  try {
    const rows = await page.evaluate(() => document.querySelectorAll('#policy-diffs input[data-policy-diff-id]').length)
    assert.equal(rows, 0, 'a not-due status still rendered a stale differing list')
  } finally {
    await browser.close()
  }
})

test('the differing-policy list sits directly under the baseline notice, before the policies list itself', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, differingItems: BASELINE_UPDATE_DIFFERING_ITEMS, at: new Date().toISOString() }
  })
  try {
    const order = await page.evaluate(() => {
      const ids = ['policy-seed-notice', 'policy-diffs', 'policies-list']
      const positions = ids.map((id) => {
        let node = document.getElementById(id)
        let index = 0
        while ((node = node.previousElementSibling) != null) index += 1
        return index
      })
      return positions
    })
    assert.ok(order[0] < order[1] && order[1] < order[2], `expected notice < diffs < policies-list, got ${JSON.stringify(order)}`)
  } finally {
    await browser.close()
  }
})

test('the baseline notice stays hidden when there is no status at all', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ policies: [] })
  try {
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('policy-seed-notice')).display !== 'none')
    assert.equal(visible, false)
  } finally {
    await browser.close()
  }
})

test('the baseline notice stays hidden when the status says it is not due', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    policies: [],
    policySeedNoticeStatus: { due: false, added: 5, differing: 2, shippedVersion: SHIPPED_VERSION, at: new Date().toISOString() }
  })
  try {
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('policy-seed-notice')).display !== 'none')
    assert.equal(visible, false, 'a not-due status still rendered the notice')
  } finally {
    await browser.close()
  }
})

test('the baseline notice stays hidden when due but the counts are both zero', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // The worker should never publish this combination (decidePolicySeedNotice
  // requires added+differing > 0 for due), but the panel double-checks
  // rather than trusting `due` alone, so it can never show an empty notice.
  const { browser, page } = await openPanel({
    policies: [],
    policySeedNoticeStatus: { due: true, added: 0, differing: 0, shippedVersion: SHIPPED_VERSION, at: new Date().toISOString() }
  })
  try {
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('policy-seed-notice')).display !== 'none')
    assert.equal(visible, false)
  } finally {
    await browser.close()
  }
})

test('clicking the notice\'s review button sends a policy-seed-import request with no accepted ids', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, at: new Date().toISOString() }
  })
  try {
    // JEVADV-41: the policy-seed notice lives inside the Policies tab.
    await page.click('#tab-policies')
    await page.click('#policy-seed-notice-review')
    await page.waitForFunction(() => !!window.__written.policySeedImportRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.policySeedImportRequest)
    assert.equal(typeof request.id, 'string')
    assert.equal(request.acceptedIds, undefined, 'the notice button pre-accepted ids it should have left for the person to choose')
  } finally {
    await browser.close()
  }
})

test('clicking the notice\'s dismiss button sends a policy-seed-dismiss request', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    policies: existingBeforeBaselineUpdate(),
    policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, at: new Date().toISOString() }
  })
  try {
    await page.click('#tab-policies')
    await page.click('#policy-seed-notice-dismiss')
    await page.waitForFunction(() => !!window.__written.policySeedDismissRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.policySeedDismissRequest)
    assert.equal(typeof request.id, 'string')
    assert.equal(typeof request.at, 'string')
  } finally {
    await browser.close()
  }
})

test('every policies.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // t() falls back to the English catalog on a missing key (JEVADV-10,
  // aligned with src/core/i18n.ts's DEFAULT_LOCALE = "en"), which hides a
  // one-sided addition from an English-locale reader but leaves a
  // Spanish-locale reader looking at the literal key string -- this catches
  // either gap in either direction, for every `policies.*` key, not only
  // the new ones.
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('policies.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('policies.') === 0)
    const missingInEn = esKeys.filter((key) => enKeys.indexOf(key) === -1)
    const missingInEs = enKeys.filter((key) => esKeys.indexOf(key) === -1)
    assert.deepEqual(missingInEn, [], `es-only policies.* keys missing from en: ${missingInEn.join(', ')}`)
    assert.deepEqual(missingInEs, [], `en-only policies.* keys missing from es: ${missingInEs.join(', ')}`)
  } finally {
    await browser.close()
  }
})

// 0.6.8 T1: "Repositories your team owns" -- the owners typed one per line
// in the Policies tab, saved to `teamOwners` by the same Save button.
test('the team owners field shows the stored owners one per line, and Save writes each line back', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ teamOwners: ['acme-team', 'acme-tools'] })
  try {
    await page.click('#tab-policies')
    assert.equal(await page.inputValue('#team-owners'), 'acme-team\nacme-tools')
    await page.fill('#team-owners', '  acme-team \n\n@acme-tools\nacme-labs  ')
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    const written = await page.evaluate(() => window.__written.teamOwners)
    // The panel only splits and trims; the worker's parseTeamOwners
    // normalizes (drops the @, validates) before anything reaches the gate.
    assert.deepEqual(written, ['acme-team', '@acme-tools', 'acme-labs'])
    assert.deepEqual(errors, [], 'the panel threw while rendering or saving the team owners')
  } finally {
    await browser.close()
  }
})

test('an install that never set team owners shows an empty field and saves an empty list', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({})
  try {
    await page.click('#tab-policies')
    assert.equal(await page.inputValue('#team-owners'), '')
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    assert.deepEqual(await page.evaluate(() => window.__written.teamOwners), [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// A button group is the panel's replacement for a native select: the pressed button is the value.
async function pressedValues (page, groupSelector) {
  return page.evaluate((sel) => Array.from(document.querySelector(sel).querySelectorAll('button')).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.value), groupSelector)
}

// 0.6.8 T4: "When a person must approve: ask now | queue and continue",
// saved to `queueMode` ({ enabled }) by the same Save button.
test('the queue mode select shows the stored choice and Save writes it back', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ queueMode: { enabled: true } })
  try {
    await page.click('#tab-policies')
    assert.deepEqual(await pressedValues(page, '#queue-mode'), ['queue'])
    assert.ok((await page.textContent('#queue-mode-section')).length > 40, 'the section renders its heading, choices and hint')
    await page.click('#queue-mode button[data-value="ask"]')
    assert.deepEqual(await pressedValues(page, '#queue-mode'), ['ask'])
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    assert.deepEqual(await page.evaluate(() => window.__written.queueMode), { enabled: false })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an install that never set the queue mode shows "ask now" and saves it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({})
  try {
    await page.click('#tab-policies')
    assert.deepEqual(await pressedValues(page, '#queue-mode'), ['ask'])
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    assert.deepEqual(await page.evaluate(() => window.__written.queueMode), { enabled: false })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// 0.6.8 T7: "Models fixed by an agent: judge them | keep them", in the
// Models tab, saved to `explicitModels` ({ mode }) by the Save button.
test('the explicit models select shows the stored choice and Save writes it back', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ explicitModels: { mode: 'keep' } })
  try {
    await page.click('#tab-models')
    assert.deepEqual(await pressedValues(page, '#explicit-models'), ['keep'])
    assert.ok((await page.textContent('#explicit-models-section')).length > 40, 'the section renders its heading, choices and hint')
    await page.click('#explicit-models button[data-value="judge"]')
    assert.deepEqual(await pressedValues(page, '#explicit-models'), ['judge'])
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    assert.deepEqual(await page.evaluate(() => window.__written.explicitModels), { mode: 'judge' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an install that never set it shows "judge them" and saves it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({})
  try {
    await page.click('#tab-models')
    assert.deepEqual(await pressedValues(page, '#explicit-models'), ['judge'])
    await page.click('#save-all')
    await page.waitForTimeout(SETTLE_MS)
    assert.deepEqual(await page.evaluate(() => window.__written.explicitModels), { mode: 'judge' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('every teamOwners.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('teamOwners.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('teamOwners.') === 0)
    assert.ok(enKeys.length > 0, 'no teamOwners.* keys at all')
    assert.deepEqual(esKeys.filter((key) => enKeys.indexOf(key) === -1), [])
    assert.deepEqual(enKeys.filter((key) => esKeys.indexOf(key) === -1), [])
  } finally {
    await browser.close()
  }
})

for (const colorScheme of ['light', 'dark']) {
  test(`the baseline notice reads as information, not as an error (${colorScheme})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    // "The shipped baseline changed" is news, not a failure: nothing broke and
    // nothing is lost by ignoring it. Painting it in the destructive red the
    // panel keeps for a failed save or an unset policy kind cries wolf, and
    // teaches the reader to skim past the red that does matter.
    const { browser, page, errors } = await openPanel({
      policies: existingBeforeBaselineUpdate(),
      policySeedNoticeStatus: { ...BASELINE_UPDATE_DECISION, at: new Date().toISOString() }
    }, 'en', colorScheme)
    try {
      const colors = await page.evaluate(() => {
        const probe = document.createElement('p')
        probe.className = 'hint warn'
        document.body.appendChild(probe)
        const destructive = getComputedStyle(probe).color
        probe.remove()
        return { notice: getComputedStyle(document.getElementById('policy-seed-notice-text')).color, destructive }
      })
      assert.notEqual(colors.notice, colors.destructive, `the baseline notice renders in the error colour ${colors.destructive}`)
      const text = await page.evaluate(() => document.getElementById('policy-seed-notice-text').innerText)
      assert.equal(text, `The shipped baseline changed: ${BASELINE_UPDATE_DECISION.added} new, ${BASELINE_UPDATE_DECISION.differing} different from yours.`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

// What write-secret-mirror.mjs's statMirror() actually returns, one per
// branch it has -- plus the bare `{ ok: true }` the screenshot fixture used to
// send, which is how "Key file: doesn't exist yet (undefined)." got
// photographed: `exists` and `path` both absent, so the panel took the
// "missing" branch and interpolated a path nobody had supplied.
const KEY_FILE_PATH = '/home/someone/.config/orca-supervisor/env'
const SECRET_MIRROR_SHAPES = {
  present: { ok: true, exists: true, mode: '600', platform: 'darwin', path: KEY_FILE_PATH },
  presentWindows: { ok: true, exists: true, mode: '666', platform: 'win32', path: KEY_FILE_PATH },
  missing: { ok: true, exists: false, mode: null, platform: 'darwin', path: KEY_FILE_PATH },
  missingNoPath: { ok: true, exists: false },
  sparse: { ok: true },
  failed: { ok: false, reason: 'exception', detail: 'boom' }
}

async function integrationLines (secretMirror, locale) {
  const { browser, page, errors } = await openPanel({
    claudeIntegrationStatus: {
      ok: true,
      hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2, orcaPanesCovered: true },
      env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
      secretMirror,
      checkedAt: new Date().toISOString()
    }
  }, locale)
  try {
    const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
    return { lines, errors }
  } finally {
    await browser.close()
  }
}

for (const locale of ['en', 'es']) {
  for (const [shape, secretMirror] of Object.entries(SECRET_MIRROR_SHAPES)) {
    test(`no Claude Code integration line ever says "undefined" (${locale}, key file ${shape})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
      const { lines, errors } = await integrationLines(secretMirror, locale)
      assert.ok(lines.length >= 4, `expected the integration list to render, got ${JSON.stringify(lines)}`)
      const bad = lines.filter((line) => /undefined|null|\{\{/.test(line))
      assert.deepEqual(bad, [], `integration lines leaked a missing value: ${JSON.stringify(bad)}`)
      if (secretMirror.path) {
        assert.ok(lines.some((line) => line.includes(secretMirror.path)), `the key file's real path is not shown: ${JSON.stringify(lines)}`)
      }
      assert.deepEqual(errors, [])
    })
  }
}

// ---------------------------------------------------------------------------
// odd/tasks/model-reclassification.md T7 -- the Models section: the ladder
// editor, the empty-catalog state, the baseline notice and the measurement
// readout. Same style as the Team policies checks above: this asserts what
// the page SAYS, not just that storage holds the right rows.
// ---------------------------------------------------------------------------

function modelRow (overrides) {
  return {
    id: 'm-x', provider: 'anthropic', label: 'Model X', rank: null,
    agentModel: 'sonnet', source: '', available: false, ...overrides
  }
}

test('the Models ladder renders ranked entries before unranked ones, in rank order', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [
    modelRow({ id: 'b', label: 'B', rank: 2, available: true }),
    modelRow({ id: 'u', label: 'U', rank: null }),
    modelRow({ id: 'a', label: 'A', rank: 1, available: true, source: 'https://example.test/a' }),
  ]
  const { browser, page, errors } = await openPanel({ models, modelsConfig: { active: false } })
  try {
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    assert.deepEqual(names, ['A (a)', 'B (b)', 'U (u)'])
    const linkHref = await page.evaluate(() => {
      const link = document.querySelector('#models-ladder-list a[href]')
      return link ? { href: link.getAttribute('href'), target: link.target, rel: link.rel } : null
    })
    assert.deepEqual(linkHref, { href: 'https://example.test/a', target: '_blank', rel: 'noopener' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an empty model catalog says so in words and still offers the add form', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ models: [] })
  try {
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('models-empty-catalog-hint')).display !== 'none')
    assert.ok(visible, 'the empty-catalog hint did not render for an empty catalog')
    const hasAddForm = await page.evaluate(() => !!document.getElementById('models-add-row'))
    assert.ok(hasAddForm, 'the add-model form must stay available even with an empty catalog')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// 0.6.14 T4 (JEVADV-85): an empty catalog that was never seeded is not one
// the person emptied. It says the plugin's own models load when its worker
// starts, and what the plugin log says if they did not; one the person
// emptied (the seed marker is set) keeps the plain "add a model" text.
test('a never-seeded empty catalog names the shipped models and what the log should say', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const shipped = JSON.parse(await readFile(join(ROOT, 'seed/models.json'), 'utf8')).models.map((row) => row.label)
  const { browser, page, errors } = await openPanel({ models: [] })
  try {
    const text = await page.evaluate(() => document.getElementById('models-empty-catalog-hint').textContent)
    for (const label of shipped) assert.ok(text.includes(label), `the hint must name ${label}: ${text}`)
    assert.ok(text.includes('model catalog seed planted') && text.includes('initial model seeding failed'), `the hint must say what the log shows: ${text}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an empty catalog the person emptied keeps the plain text', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ models: [], modelsSeeded: true })
  try {
    const hint = await page.evaluate(() => {
      const node = document.getElementById('models-empty-catalog-hint')
      return { text: node.textContent, visible: getComputedStyle(node).display !== 'none' }
    })
    assert.ok(hint.visible)
    assert.ok(!hint.text.includes('seed') && !hint.text.includes('Claude Opus'), `the emptied catalog must not blame the seed: ${hint.text}`)
    assert.ok(/form below|formulario de abajo/.test(hint.text), hint.text)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('adding a model with a duplicate id is refused, and a valid one lands unranked and unavailable', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [modelRow({ id: 'existing', label: 'Existing', rank: 1, available: true })]
  const { browser, page } = await openPanel({ models })
  try {
    // JEVADV-41: the models editor lives inside the Models tab.
    await page.click('#tab-models')
    await page.fill('#models-add-id', 'existing')
    await page.fill('#models-add-label', 'Existing again')
    await page.fill('#models-add-provider', 'anthropic')
    await page.fill('#models-add-agentmodel', 'sonnet')
    await page.click('#models-add-row')
    const dupSaid = await page.evaluate(() => document.getElementById('models-add-said').innerText)
    assert.match(dupSaid, /already exists|Ya existe/i)

    await page.fill('#models-add-id', 'new-model')
    await page.fill('#models-add-label', 'New Model')
    await page.fill('#models-add-provider', 'anthropic')
    await page.fill('#models-add-agentmodel', 'haiku')
    await page.click('#models-add-row')
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    assert.ok(names.includes('New Model (new-model)'), `new model not rendered: ${JSON.stringify(names)}`)
    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    assert.ok(badges.some((b) => /unranked|sin clasificar/i.test(b)), 'a newly added model must render as unranked')
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// "Rank this" is the only way an unranked entry enters the ranked
// ladder, appended at the bottom without demoting anyone; every rank-
// changing action renumbers 1..n with no gaps. See
// config_html_models.test.mjs for the pure-function coverage of
// modelsReorder/modelsRankThis/modelsMarkUnranked/modelsRemove/
// modelsRenumber -- these check the same behavior through the real buttons.
// ---------------------------------------------------------------------------

test('the "Rank this" action grows the ladder without demoting anyone, and renumbers 1..n', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [
    modelRow({ id: 'a', label: 'A', rank: 1, available: true }),
    modelRow({ id: 'b', label: 'B', rank: 2, available: true }),
    modelRow({ id: 'u', label: 'U', rank: null }),
  ]
  const { browser, page, errors } = await openPanel({ models })
  try {
    await page.click('#tab-models')
    const entries = page.locator('#models-ladder-list .entry')
    await entries.nth(2).getByRole('button', { name: /rank this|clasificar/i }).click()
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    assert.deepEqual(names, ['A (a)', 'B (b)', 'U (u)'], '"Rank this" must not reorder the display')
    assert.ok(badges[0].includes('1') && badges[1].includes('2') && badges[2].includes('3'),
      `ranks after "Rank this" are not 1..3: ${JSON.stringify(badges)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('adding a model then ranking it grows the ladder from N to N+1 with ranks 1..N+1', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [modelRow({ id: 'a', label: 'A', rank: 1, available: true })]
  const { browser, page } = await openPanel({ models })
  try {
    await page.click('#tab-models')
    await page.fill('#models-add-id', 'new-model')
    await page.fill('#models-add-label', 'New Model')
    await page.fill('#models-add-provider', 'anthropic')
    await page.fill('#models-add-agentmodel', 'haiku')
    await page.click('#models-add-row')
    const entries = page.locator('#models-ladder-list .entry')
    await entries.nth(1).getByRole('button', { name: /rank this|clasificar/i }).click()
    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    assert.equal(badges.length, 2)
    assert.ok(badges[0].includes('1') && badges[1].includes('2'), `ranks not 1..2: ${JSON.stringify(badges)}`)
  } finally {
    await browser.close()
  }
})

test('an unranked entry has no move up/down of its own -- only "Rank this" gets it into the ladder', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [
    modelRow({ id: 'a', label: 'A', rank: 1, available: true }),
    modelRow({ id: 'u', label: 'U', rank: null }),
  ]
  const { browser, page } = await openPanel({ models })
  try {
    await page.click('#tab-models')
    const unrankedEntry = page.locator('#models-ladder-list .entry').nth(1)
    const upDisabled = await unrankedEntry.getByRole('button', { name: /move up|subir/i }).isDisabled()
    const downDisabled = await unrankedEntry.getByRole('button', { name: /move down|bajar/i }).isDisabled()
    assert.ok(upDisabled, 'an unranked row\'s move-up button must be disabled')
    assert.ok(downDisabled, 'an unranked row\'s move-down button must be disabled')
  } finally {
    await browser.close()
  }
})

test('move down swaps two ranked rows, and mark-unranked/remove renumber the rest with no gaps', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [
    modelRow({ id: 'a', label: 'A', rank: 1, available: true }),
    modelRow({ id: 'b', label: 'B', rank: 2, available: true }),
    modelRow({ id: 'c', label: 'C', rank: 3, available: true }),
  ]
  const { browser, page } = await openPanel({ models })
  try {
    await page.click('#tab-models')
    const entries = () => page.locator('#models-ladder-list .entry')
    await entries().nth(0).getByRole('button', { name: /move down|bajar/i }).click()
    let names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    assert.deepEqual(names, ['B (b)', 'A (a)', 'C (c)'])

    await entries().nth(0).getByRole('button', { name: /mark unranked|marcar sin clasificar/i }).click()
    let badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    assert.deepEqual(names, ['A (a)', 'C (c)', 'B (b)'], 'marking unranked must not renumber the entries around it out of order')
    assert.ok(badges[0].includes('1') && badges[1].includes('2'), `remaining ranks not renumbered: ${JSON.stringify(badges)}`)

    await entries().nth(0).getByRole('button', { name: /^remove$|^quitar$/i }).click()
    badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .entry-name')).map((el) => el.textContent))
    assert.deepEqual(names, ['C (c)', 'B (b)'])
    assert.ok(badges[0].includes('1'), `remaining rank not renumbered after remove: ${JSON.stringify(badges)}`)
  } finally {
    await browser.close()
  }
})

test('the model baseline notice stays hidden with no status, and shows the real counts when due', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const hidden = await openPanel({ models: [] })
  try {
    const visible = await hidden.page.evaluate(() => getComputedStyle(document.getElementById('models-seed-notice')).display !== 'none')
    assert.equal(visible, false)
  } finally {
    await hidden.browser.close()
  }

  const status = {
    due: true, added: 1, differing: 1, shippedVersion: 2,
    items: [
      { id: 'new-id', label: 'New Model', kind: 'added', fields: [] },
      { id: 'changed-id', label: 'Changed Model', kind: 'changed', fields: ['label', 'rank'] },
    ],
    checkedAt: new Date().toISOString(),
  }
  const shown = await openPanel({ models: [], modelsSeedNotice: status })
  try {
    const visible = await shown.page.evaluate(() => getComputedStyle(document.getElementById('models-seed-notice')).display !== 'none')
    assert.ok(visible, 'a due status with real counts must render the notice')
    const text = await shown.page.evaluate(() => document.getElementById('models-seed-notice-text').innerText)
    assert.ok(text.includes('1'), `notice text is missing the real counts: ${text}`)
    assert.ok(text.includes('2'), `notice text is missing the shipped version: ${text}`)
    const itemLabels = await shown.page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-seed-notice-items .checkbox-label')).map((el) => el.textContent))
    assert.ok(itemLabels.some((l) => l.includes('new-id')))
    assert.ok(itemLabels.some((l) => l.includes('changed-id') && l.includes('label')))
    assert.deepEqual(shown.errors, [])
  } finally {
    await shown.browser.close()
  }
})

test('clicking the model notice\'s apply button sends only the ticked ids, none preselected', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models: [], modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    const preTicked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-seed-notice-items input[type=checkbox]')).map((b) => b.checked))
    assert.deepEqual(preTicked, [false], 'the notice preselected an item nobody ticked')

    await page.click('#models-seed-notice-apply')
    const noneSaid = await page.evaluate(() => document.getElementById('models-seed-notice-said').innerText)
    assert.match(noneSaid, /nothing was ticked|no marcaste ninguno/i)

    await page.check('#models-seed-notice-items input[type=checkbox]')
    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(() => !!window.__written.modelsSeedRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelsSeedRequest)
    assert.equal(request.action, 'apply')
    assert.deepEqual(request.acceptedIds, ['new-id'])
  } finally {
    await browser.close()
  }
})

test('clicking the model notice\'s dismiss button sends a dismiss request with no accepted ids', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models: [], modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    await page.click('#models-seed-notice-dismiss')
    await page.waitForFunction(() => !!window.__written.modelsSeedRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelsSeedRequest)
    assert.equal(request.action, 'dismiss')
    assert.deepEqual(request.acceptedIds, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// Apply/Dismiss stay disabled from the click until the matching
// result (or the timeout) arrives, so a second click can never replace an
// in-flight request. The bridge answers `modelsSeedResult` synchronously
// inside the same tick `modelsSeedRequest` is written, so a plain click+
// assert would pass by luck; these hold the request with a property
// override on `window.__written` until the assertion has run, then release
// it so the panel's own poll picks it up.
// ---------------------------------------------------------------------------

async function holdSeedRequest (page) {
  await page.evaluate(() => {
    window.__heldSeedRequest = undefined
    Object.defineProperty(window.__written, 'modelsSeedRequest', {
      configurable: true,
      set (v) { window.__heldSeedRequest = v },
      get () { return undefined }
    })
  })
}

async function releaseSeedRequest (page) {
  await page.evaluate(() => {
    delete window.__written.modelsSeedRequest
    window.__written.modelsSeedRequest = window.__heldSeedRequest
  })
}

test('Apply and Dismiss are both disabled while an apply request is in flight, then re-enabled', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models: [], modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    await holdSeedRequest(page)
    await page.check('#models-seed-notice-items input[type=checkbox]')
    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(() => window.__heldSeedRequest !== undefined, undefined, { timeout: 25000 })

    const disabledInFlight = await page.evaluate(() => ({
      apply: document.getElementById('models-seed-notice-apply').disabled,
      dismiss: document.getElementById('models-seed-notice-dismiss').disabled
    }))
    assert.deepEqual(disabledInFlight, { apply: true, dismiss: true },
      'both buttons must be disabled while the apply request is in flight')

    await releaseSeedRequest(page)
    await page.waitForFunction(() => {
      const applyBtn = document.getElementById('models-seed-notice-apply')
      const dismissBtn = document.getElementById('models-seed-notice-dismiss')
      return !applyBtn.disabled && !dismissBtn.disabled
    }, undefined, { timeout: 25000 })
  } finally {
    await browser.close()
  }
})

test('Apply and Dismiss are both disabled while a dismiss request is in flight, then re-enabled', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models: [], modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    await holdSeedRequest(page)
    await page.click('#models-seed-notice-dismiss')
    await page.waitForFunction(() => window.__heldSeedRequest !== undefined, undefined, { timeout: 25000 })

    const disabledInFlight = await page.evaluate(() => ({
      apply: document.getElementById('models-seed-notice-apply').disabled,
      dismiss: document.getElementById('models-seed-notice-dismiss').disabled
    }))
    assert.deepEqual(disabledInFlight, { apply: true, dismiss: true },
      'both buttons must be disabled while the dismiss request is in flight')

    await releaseSeedRequest(page)
    await page.waitForFunction(() => {
      const applyBtn = document.getElementById('models-seed-notice-apply')
      const dismissBtn = document.getElementById('models-seed-notice-dismiss')
      return !applyBtn.disabled && !dismissBtn.disabled
    }, undefined, { timeout: 25000 })
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// A dirty (unsaved) ladder blocks Apply instead of letting a
// successful apply silently overwrite it with a fresh storage read.
// ---------------------------------------------------------------------------

test('a dirty ladder blocks Apply and shows the inline message, without sending a request -- Save unblocks it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [modelRow({ id: 'a', label: 'A', rank: null })]
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models, modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    await page.locator('#models-ladder-list .entry').nth(0)
      .getByRole('button', { name: /rank this|clasificar/i }).click()

    await page.check('#models-seed-notice-items input[type=checkbox]')
    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('models-seed-notice-dirty')).display !== 'none',
      undefined, { timeout: 5000 }
    )
    const writtenWhileDirty = await page.evaluate(() => window.__written.modelsSeedRequest)
    assert.equal(writtenWhileDirty, undefined, 'a dirty ladder must not send an apply request')

    await page.click('#models-save-ladder')
    await page.waitForFunction(
      () => /saved|guardado/i.test(document.getElementById('models-ladder-said').innerText),
      undefined, { timeout: 25000 }
    )

    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(() => !!window.__written.modelsSeedRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelsSeedRequest)
    assert.equal(request.action, 'apply')
  } finally {
    await browser.close()
  }
})

// Found by the owner in Orca, not by any of the 448 screenshots the check
// used to write: a model row's Move up / Move down / Mark unranked buttons sat
// flush against each other, because `.entry-actions` had no gap. This measures
// the real rendered boxes, at a desktop and the narrowest width, so the same
// regression fails the suite instead of waiting for someone to look.
for (const width of [1440, 320]) {
  test(`a model row's action buttons keep visible space between them, and stay inside the row, at ${width}px`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const models = [
      modelRow({ id: 'a', label: 'A', rank: 1, available: true }),
      modelRow({ id: 'b', label: 'B', rank: 2, available: true }),
    ]
    const { browser, page } = await openPanel({ models }, 'es', 'dark', { width, height: 1200 })
    try {
      await page.click('#tab-models')
      const layout = await page.evaluate(() => {
        const entry = document.querySelector('#models-ladder-list .entry')
        const actions = entry.querySelector('.entry-actions')
        const boxes = Array.from(actions.children).map((el) => el.getBoundingClientRect())
        const row = entry.getBoundingClientRect()
        return {
          boxes: boxes.map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })),
          rowLeft: row.left,
          rowRight: row.right,
        }
      })
      assert.ok(layout.boxes.length >= 3, `expected at least three actions in a ranked row, got ${layout.boxes.length}`)
      for (let i = 1; i < layout.boxes.length; i++) {
        const previous = layout.boxes[i - 1]
        const current = layout.boxes[i]
        // Same line when the two boxes overlap vertically: a text link is
        // shorter than a button and, centred, starts a few pixels lower.
        const sameLine = current.top < previous.bottom && previous.top < current.bottom
        if (sameLine) {
          assert.ok(current.left - previous.right >= 6, `actions ${i - 1} and ${i} are ${current.left - previous.right}px apart; they must not touch`)
        } else {
          assert.ok(current.top >= previous.bottom, `a wrapped action must sit below the previous one, not over it`)
        }
      }
      for (const box of layout.boxes) {
        assert.ok(box.left >= layout.rowLeft && box.right <= layout.rowRight + 0.5, `an action spills outside its row at ${width}px`)
      }
    } finally {
      await browser.close()
    }
  })
}

test('"Discard my edits" reloads the ladder from storage, clears the dirty flag, and unblocks Apply', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [modelRow({ id: 'a', label: 'A', rank: null })]
  const status = {
    due: true, added: 1, differing: 0, shippedVersion: 2,
    items: [{ id: 'new-id', label: 'New Model', kind: 'added', fields: [] }],
    checkedAt: new Date().toISOString(),
  }
  const { browser, page } = await openPanel({ models, modelsSeedNotice: status })
  try {
    await page.click('#tab-models')
    await page.locator('#models-ladder-list .entry').nth(0)
      .getByRole('button', { name: /rank this|clasificar/i }).click()

    await page.check('#models-seed-notice-items input[type=checkbox]')
    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('models-seed-notice-dirty')).display !== 'none',
      undefined, { timeout: 5000 }
    )

    await page.click('#models-seed-notice-discard')
    // The dirty block hides synchronously on click, but the actual reload
    // is an async storage read -- wait for that to finish (the "discarded"
    // confirmation only appears after modelsRenderLadder runs) instead of
    // racing the badge check against it.
    await page.waitForFunction(
      () => /discarded|descartado/i.test(document.getElementById('models-ladder-said').innerText),
      undefined, { timeout: 25000 }
    )
    const dirtyVisible = await page.evaluate(() =>
      getComputedStyle(document.getElementById('models-seed-notice-dirty')).display !== 'none')
    assert.equal(dirtyVisible, false, 'the dirty block must stay hidden once edits are discarded')
    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#models-ladder-list .models-badge')).map((el) => el.textContent))
    assert.ok(badges.every((b) => /unranked|sin clasificar/i.test(b)),
      `discard must reload the ladder from storage, undoing the "Rank this" edit: ${JSON.stringify(badges)}`)

    await page.click('#models-seed-notice-apply')
    await page.waitForFunction(() => !!window.__written.modelsSeedRequest, undefined, { timeout: 25000 })
  } finally {
    await browser.close()
  }
})

test('the measurement readout shows an honest empty state with no calls measured, never a zeros table', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ models: [] })
  try {
    const text = await page.evaluate(() => document.getElementById('models-measurements').innerText)
    assert.match(text, /no subagent call has been measured|no se ha medido ninguna/i)
    assert.doesNotMatch(text, /undefined|NaN|\{\{/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a real measurement summary renders its real counts, with a dash (not 0%) for a null agreement rate', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const summary = {
    decisions: 5, judged: 4, unjudged: 1, compared: 0, up: 0, down: 0, agree: 0,
    agreementRate: null, applied: 0, outcomes: 0, comparable: 0, matches: 0, matchRate: null,
    readiness: { ready: false, comparableShortfall: 1000, matchRateMet: null, reason: 'not-enough-samples' },
  }
  const { browser, page, errors } = await openPanel({ models: [], modelMeasurements: { ok: true, summary, checkedAt: new Date().toISOString() } })
  try {
    const text = await page.evaluate(() => document.getElementById('models-measurements').innerText)
    assert.ok(text.includes('5'), `decisions count missing: ${text}`)
    assert.ok(text.includes('4'), `judged count missing: ${text}`)
    assert.ok(/not enough comparable|no hay suficientes|todavía sin casos/i.test(text), `null agreement rate was not rendered as unknown: ${text}`)
    assert.doesNotMatch(text, /\bNaN\b|\{\{/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a failed measurement readout (ok:false) is reported as unavailable, never as "no calls measured yet"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ models: [], modelMeasurements: { ok: false, reason: 'exception', detail: 'boom', checkedAt: new Date().toISOString() } })
  try {
    const text = await page.evaluate(() => document.getElementById('models-measurements').innerText)
    assert.doesNotMatch(text, /no subagent call has been measured|no se ha medido ninguna/i, 'a failed readout must not read as an honest empty state')
  } finally {
    await browser.close()
  }
})

test('every models.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('models.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('models.') === 0)
    const missingInEn = esKeys.filter((key) => enKeys.indexOf(key) === -1)
    const missingInEs = enKeys.filter((key) => esKeys.indexOf(key) === -1)
    assert.deepEqual(missingInEn, [], `es-only models.* keys missing from en: ${missingInEn.join(', ')}`)
    assert.deepEqual(missingInEs, [], `en-only models.* keys missing from es: ${missingInEs.join(', ')}`)
  } finally {
    await browser.close()
  }
})

test('the Agent model hooks line renders only when the field exists, and never as "undefined"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const withField = await openPanel({
    claudeIntegrationStatus: {
      ok: true,
      hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
      agentModelHook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
      env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
      secretMirror: { ok: true, exists: false },
      checkedAt: new Date().toISOString(),
    },
  })
  try {
    const lines = await withField.page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
    assert.ok(lines.some((line) => /agent model hooks/i.test(line)), `no Agent model hooks line rendered: ${JSON.stringify(lines)}`)
    assert.ok(!lines.some((line) => /undefined|\{\{/.test(line)), `an integration line leaked a missing value: ${JSON.stringify(lines)}`)
    assert.deepEqual(withField.errors, [])
  } finally {
    await withField.browser.close()
  }

  const withoutField = await openPanel({
    claudeIntegrationStatus: {
      ok: true,
      hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
      env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
      secretMirror: { ok: true, exists: false },
      checkedAt: new Date().toISOString(),
    },
  })
  try {
    const lines = await withoutField.page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
    assert.ok(!lines.some((line) => /agent model hooks/i.test(line)), `an Agent model hooks line rendered with no status field: ${JSON.stringify(lines)}`)
    assert.deepEqual(withoutField.errors, [])
  } finally {
    await withoutField.browser.close()
  }
})

// 0.6.17 T2 -- the file tools' guard: its own line, in both languages, only
// when the worker reports the field.
for (const [locale, installedText, missingText] of [['en', /Edit guard \(the gate's own rules\): installed in 2 of 2 places/, /Edit guard \(the gate's own rules\): not installed/], ['es', /Guarda de ediciones \(reglas del propio gate\): puesta en 2 de 2 sitios/, /Guarda de ediciones \(reglas del propio gate\): no puesta/]]) {
  test(`the file tools' guard line says where it is installed (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    for (const [fileGuardHook, expected] of [[{ installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 }, installedText], [{ installed: false, installedCount: 1, totalCount: 2, orcaPaneCount: 2 }, missingText], [undefined, null]]) {
      const { browser, page, errors } = await openPanel({
        claudeIntegrationStatus: {
          ok: true,
          hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
          ...(fileGuardHook === undefined ? {} : { fileGuardHook }),
          env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
          secretMirror: { ok: true, exists: false },
          checkedAt: new Date().toISOString()
        }
      }, locale)
      try {
        const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
        if (expected === null) assert.ok(!lines.some((line) => /Edit guard|Guarda de ediciones/.test(line)), `a guard line rendered with no status field: ${JSON.stringify(lines)}`)
        else assert.ok(lines.some((line) => expected.test(line)), `no matching guard line: ${JSON.stringify(lines)}`)
        assert.ok(!lines.some((line) => /undefined|\{\{/.test(line)), `an integration line leaked a missing value: ${JSON.stringify(lines)}`)
        assert.deepEqual(errors, [])
      } finally {
        await browser.close()
      }
    }
  })
}

// 0.6.26 T3 -- an older plugin copy that left a newer install alone says so,
// with both versions and the root, in both languages; nothing when the worker
// reports no skip.
for (const [locale, expected] of [['en', /A newer install is already in place \(version 0\.6\.25, from \/work\/advisor-dev\); this plugin copy is 0\.6\.10/], ['es', /Ya hay una instalación más nueva \(versión 0\.6\.25, en \/work\/advisor-dev\); esta copia del plugin es la 0\.6\.10/]]) {
  test(`the newer-install line names the installed version and root (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    for (const [newerInstall, shouldShow] of [[{ version: '0.6.25', root: '/work/advisor-dev', ownVersion: '0.6.10' }, true], [null, false]]) {
      const { browser, page, errors } = await openPanel({
        claudeIntegrationStatus: {
          ok: true,
          hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
          env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
          secretMirror: { ok: true, exists: false },
          newerInstall,
          checkedAt: new Date().toISOString()
        }
      }, locale)
      try {
        const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
        if (shouldShow) assert.ok(lines.some((line) => expected.test(line)), `no newer-install line: ${JSON.stringify(lines)}`)
        else assert.ok(!lines.some((line) => /newer install|instalación más nueva/i.test(line)), `a newer-install line rendered with no skip: ${JSON.stringify(lines)}`)
        assert.ok(!lines.some((line) => /undefined|\{\{/.test(line)), `an integration line leaked a missing value: ${JSON.stringify(lines)}`)
        assert.deepEqual(errors, [])
      } finally {
        await browser.close()
      }
    }
  })
}

// 0.6.11 T2a -- the Node the installed hooks run on: a clear line when it is
// too old or missing, a plain confirmation when it is fine, nothing when an
// older worker never reported it.
const NODE_STATUS_SHAPES = {
  ok: { state: 'ok', path: '/opt/homebrew/bin/node', version: 'v26.9.0' },
  'too-old': { state: 'too-old', path: '/usr/local/bin/node', version: 'v20.11.0' },
  missing: { state: 'missing', path: null, version: null }
}

for (const locale of ['en', 'es']) {
  for (const [shape, node] of Object.entries(NODE_STATUS_SHAPES)) {
    test(`the Node line says what the hooks run on (${locale}, ${shape})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
      const { browser, page, errors } = await openPanel({
        claudeIntegrationStatus: {
          ok: true,
          hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
          env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
          node,
          secretMirror: { ok: true, exists: false },
          checkedAt: new Date().toISOString()
        }
      }, locale)
      try {
        const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
        const nodeLine = lines.find((line) => /Node/.test(line))
        assert.ok(nodeLine, `no Node line rendered: ${JSON.stringify(lines)}`)
        assert.ok(!/undefined|null|\{\{/.test(nodeLine), `the Node line leaked a missing value: ${nodeLine}`)
        if (node.version) assert.ok(nodeLine.includes(node.version) && nodeLine.includes(node.path), nodeLine)
        if (shape === 'too-old' && locale === 'en') assert.equal(nodeLine, 'Node 24 or newer is required; found v20.11.0 at /usr/local/bin/node.')
        if (shape !== 'ok') assert.match(nodeLine, locale === 'en' ? /24 or newer/ : /24 o superior/)
        assert.deepEqual(errors, [])
      } finally {
        await browser.close()
      }
    })
  }
}

test('no Node line renders when the status has no node field', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({
    claudeIntegrationStatus: {
      ok: true,
      hook: { installed: true, installedCount: 2, totalCount: 2, orcaPaneCount: 2 },
      env: { installed: true, name: 'ORCA_SUPERVISOR_GATE' },
      secretMirror: { ok: true, exists: false },
      checkedAt: new Date().toISOString()
    }
  })
  try {
    const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#claude-integration-status li')).map((li) => li.innerText))
    assert.ok(!lines.some((line) => /Node/.test(line)), JSON.stringify(lines))
  } finally {
    await browser.close()
  }
})

test('every integration.node* key exists in both catalogs, and the es values are accented', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('integration.node') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('integration.node') === 0)
    assert.ok(esKeys.length >= 3, 'the es catalog has no integration.node* keys')
    assert.deepEqual(esKeys.filter((key) => enKeys.indexOf(key) === -1), [])
    assert.deepEqual(enKeys.filter((key) => esKeys.indexOf(key) === -1), [])
    assert.match(catalog.es['integration.nodeTooOld'], /[áéíóú]/u, 'Spanish copy keeps its accents')
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// JEVADV-41 (part A) -- config.html shows one section-group at a time behind
// an in-panel role="tablist" (#config-tabbar), so a long settings document
// with many open .entry rows never reports a height past Orca's own
// PANEL_CONTENT_HEIGHT_MAX_PX clamp (8000, orca-oss plugin-panel-bridge.ts)
// -- past it, the panel's iframe grows its own inner scrollbar on top of
// Orca's Settings page scroll, which is two scrollbars.
// ---------------------------------------------------------------------------

/** One row from SCENARIOS.ready, repeated with a suffixed id -- the exact
 *  field set that fixture already uses, never a new one invented for this
 *  test. */
function repeatRow (row, suffix) {
  return { ...row, id: `${row.id}-${suffix}` }
}

/** 40 policies / 30 destinations, shaped exactly like SCENARIOS.ready's own
 *  three policies / two destinations -- large enough that, on the old
 *  one-long-page layout with every .entry open at once, this document
 *  cleared Orca's height clamp by a wide margin (see the recorded RED
 *  measurement in this task's own report). */
function largeReadyStorage () {
  const basePolicies = SCENARIOS.ready.policies
  const baseDestinations = SCENARIOS.ready.catalog.destinations
  const policies = []
  for (let i = 0; i < 40; i++) policies.push(repeatRow(basePolicies[i % basePolicies.length], i))
  const destinations = []
  for (let i = 0; i < 30; i++) destinations.push(repeatRow(baseDestinations[i % baseDestinations.length], i))
  return { ...SCENARIOS.ready, policies, catalog: { destinations } }
}

test(
  "a large realistic config stays under Orca's own panel height clamp on every tab, at the tallest (320px) layout",
  { skip: chromium && SCENARIOS ? false : 'playwright is not installed, or screenshot-panels.mjs could not be imported' },
  async () => {
    const HEIGHT_CLAMP = 8000
    const { browser, page, errors } = await openPanel(largeReadyStorage(), 'en', 'light', { width: 320, height: 900 })
    try {
      const tabKeys = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#config-tabbar [role="tab"]')).map((b) => b.id.replace(/^tab-/, '')))

      // No tabs at all is the pre-fix shape this test must fail against:
      // everything lives on the one visible page already, so "every tab"
      // collapses to the whole document.
      const groups = tabKeys.length > 0 ? tabKeys : [null]
      const measured = []
      for (const key of groups) {
        if (key) {
          await page.click(`#tab-${key}`)
          await page.waitForTimeout(200)
        }
        // "trying to open every entry in each list" -- a real click on
        // every visible <summary>, in order, the same way a person would.
        // On the fixed panel this leaves at most one entry open per list
        // (JEVADV-41's other invariant, closeSiblingEntries); on the base
        // panel nothing closes anything, so all 70 stay open at once.
        const summaryCount = await page.locator('details.entry > summary:visible').count()
        for (let i = 0; i < summaryCount; i++) {
          await page.locator('details.entry > summary:visible').nth(i).click()
        }
        const height = await page.evaluate(() => document.documentElement.scrollHeight)
        measured.push({ tab: key, height })
      }

      for (const { tab, height } of measured) {
        assert.ok(height < HEIGHT_CLAMP,
          `tab ${tab === null ? '(none -- #config-tabbar is missing)' : tab} reports ${height}px, ` +
          `at or past Orca's own ${HEIGHT_CLAMP}px clamp -- every measured tab: ${JSON.stringify(measured)}`)
      }
      assert.deepEqual(errors, [], 'the panel threw while rendering a large config')
    } finally {
      await browser.close()
    }
  }
)

test('clicking a tab shows only its own sections, and the save button stays visible on every tab', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({})
  try {
    const keys = ['general', 'destinations', 'policies', 'models', 'modskills', 'rules']
    for (const key of keys) {
      await page.click(`#tab-${key}`)
      await page.waitForTimeout(150)
      const state = await page.evaluate((activeKey) => {
        const keys = ['general', 'destinations', 'policies', 'models', 'modskills', 'rules']
        return {
          selected: keys.filter((k) => document.getElementById(`tab-${k}`).getAttribute('aria-selected') === 'true'),
          visiblePanels: keys.filter((k) => !document.getElementById(`panel-${k}`).hidden),
          saveVisible: document.getElementById('save-all').offsetParent !== null
        }
      }, key)
      assert.deepEqual(state.selected, [key], `exactly tab-${key} should be aria-selected=true`)
      assert.deepEqual(state.visiblePanels, [key], `exactly panel-${key} should be visible, saw ${JSON.stringify(state.visiblePanels)}`)
      assert.equal(state.saveVisible, true, `the save button must stay visible while tab ${key} is active`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('arrow keys move focus and selection between tabs, wrapping at both ends', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({})
  try {
    await page.click('#tab-general')
    await page.focus('#tab-general')

    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-destinations')
    assert.equal(await page.evaluate(() => document.getElementById('tab-destinations').getAttribute('aria-selected')), 'true')
    assert.equal(await page.evaluate(() => document.getElementById('panel-destinations').hidden), false)

    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-general')

    // Wrapping: ArrowLeft off the first tab lands on the last one, and
    // ArrowRight off the last tab lands back on the first.
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-rules')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-general')

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a validation error on a field inside a hidden tab switches back to that tab and focuses the field', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ config: { logMaxEntries: 500 } })
  try {
    // logMaxEntries' own min="1" is the one real, already-declared HTML5
    // constraint in this whole panel (see firstInvalidTabField's own
    // comment) -- 0 fails it without any new business rule invented here.
    await page.fill('#logMaxEntries', '0')
    await page.click('#tab-destinations')
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.getElementById('panel-general').hidden), true,
      'the field is not actually hidden yet, so this assertion proves nothing')

    await page.click('#save-all')
    await page.waitForTimeout(300)

    assert.equal(await page.evaluate(() => document.getElementById('tab-general').getAttribute('aria-selected')), 'true',
      'save-all must switch back to the tab holding the invalid field')
    assert.equal(await page.evaluate(() => document.getElementById('panel-general').hidden), false)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'logMaxEntries',
      'the invalid field itself must end up focused, not just its tab')
    assert.equal(await page.evaluate(() => window.__written.config), undefined,
      'a blocked save must never reach the host writes')

    const said = await page.evaluate(() => document.getElementById('save-said').innerText)
    assert.match(said, /invalid value/i)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('within one list, opening an entry closes every other open entry in that same list', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const policies = [
    { id: 'p1', rule: 'Rule one', kind: 'permits' },
    { id: 'p2', rule: 'Rule two', kind: 'permits' },
    { id: 'p3', rule: 'Rule three', kind: 'permits' },
  ]
  const { browser, page, errors } = await openPanel({
    policies,
    catalog: { destinations: [{ id: 'app', label: 'app', kind: 'project', worktreePath: '/app' }] }
  })
  try {
    await page.click('#tab-policies')
    await page.waitForTimeout(150)

    const openStates = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('#policies-list > details.entry')).map((d) => d.open))

    await page.locator('#policies-list details.entry > summary').nth(0).click()
    assert.deepEqual(await openStates(), [true, false, false])

    await page.locator('#policies-list details.entry > summary').nth(1).click()
    assert.deepEqual(await openStates(), [false, true, false])

    // A newly added entry opens and becomes the one open entry.
    await page.click('#tab-destinations')
    await page.waitForTimeout(100)
    await page.click('#tab-policies')
    await page.waitForTimeout(100)
    await page.click('#add-policy-row')
    const statesAfterAdd = await openStates()
    assert.deepEqual(statesAfterAdd.slice(0, 3), [false, false, false], 'adding a row must close every existing open row in the same list')
    assert.equal(statesAfterAdd[3], true, 'the newly added row must itself be open')

    // Opening a policy entry must never touch the catalog list -- a
    // separate list, its own invariant.
    await page.click('#tab-destinations')
    await page.waitForTimeout(100)
    const catalogOpenBefore = await page.evaluate(() => document.querySelector('#catalog-list details.entry').open)
    assert.equal(catalogOpenBefore, false, 'the catalog entry must not have been opened by policy-list activity')

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a machine where localStorage itself throws (Orca\'s sandboxed opaque-origin iframe) still renders the default tab', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanelWithThrowingStorage({})
  try {
    assert.equal(await page.evaluate(() => document.getElementById('tab-general').getAttribute('aria-selected')), 'true')
    assert.equal(await page.evaluate(() => document.getElementById('panel-general').hidden), false)
    // Switching still has to work for this view even though nothing about
    // it can be remembered.
    await page.click('#tab-models')
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.getElementById('panel-models').hidden), false)
    assert.deepEqual(errors, [], 'a throwing localStorage must never surface as an uncaught panel error')
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// board.html -- the calibration card ("How is calibration going?").
// odd/tasks/release-prep-0.5.0.md T6: approved/rejected/notRun's legend never
// summed to `asked` while any pending prompt was still inside the wait
// window -- src/core/approval_record.ts's summarizeApprovals had no bucket
// for it. This asserts the rendered legend, not just the underlying summary,
// because the summary already had the right total; only the DOM was short a
// row.
// ---------------------------------------------------------------------------

// 0.6.8 T5: "Waiting for you" -- what queue mode set aside for a person,
// in the Gate tab, with how to release an item.
test('the Gate tab lists what is waiting for a person: policy, project, command and when, with how to release it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    assert.equal(await page.isVisible('#card-waiting'), true)
    const rows = await page.$$eval('#waiting-body li', (items) => items.map((li) => li.textContent))
    assert.equal(rows.length, 2)
    assert.match(rows[0], /client_always_asks/)
    assert.match(rows[0], /acme-app/)
    assert.match(rows[0], /gh pr merge 42/)
    assert.match(rows[0], /ago|min|h\b|d\b/)
    const heading = await page.textContent('#card-waiting h2')
    assert.match(heading, /2/)
    assert.match(await page.textContent('#waiting-release'), /run it again/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the waiting card stays hidden when nothing is queued', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.empty)
  try {
    assert.equal(await page.isVisible('#card-waiting'), false)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a long waiting command wraps inside a 320px board instead of widening it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready, 'en', 'light', { viewport: { width: 320, height: 900 } })
  try {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.equal(overflow, 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('every waiting.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openBoardPanel(SCENARIOS.ready, 'es')
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('waiting.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('waiting.') === 0)
    assert.ok(enKeys.length > 0, 'no waiting.* keys at all')
    assert.deepEqual(esKeys.filter((key) => enKeys.indexOf(key) === -1), [])
    assert.deepEqual(enKeys.filter((key) => esKeys.indexOf(key) === -1), [])
  } finally {
    await browser.close()
  }
})

test('the calibration card\'s legend rows sum to asked, with no bucket left uncounted', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    const legendValues = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#approvals-body .legend .lv')).map((li) => li.textContent))
    assert.ok(legendValues.length > 0, 'the calibration card rendered no legend rows at all')
    const sum = legendValues.reduce((total, text) => total + Number(String(text).replace(/,/g, '')), 0)
    // 'day' is defaultWindowKey's pick for SCENARIOS.ready (24 h, which has
    // decisions in it, per board.html) -- read from the fixture itself,
    // never typed here, so this cannot drift from whichever window the
    // panel actually renders.
    const activeApprovals = SCENARIOS.ready.measurementsSummary.gate.windows.day.approvals
    assert.equal(sum, activeApprovals.asked, `legend rows ${JSON.stringify(legendValues)} do not sum to asked (${activeApprovals.asked})`)
    assert.deepEqual(errors, [], 'the board threw while rendering the calibration card')
  } finally {
    await browser.close()
  }
})

test('the calibration card renders a real label for every legend row, never a raw i18n key', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#approvals-body .legend .ll')).map((li) => li.textContent))
    assert.ok(labels.length > 0, 'the calibration card rendered no legend rows at all')
    for (const label of labels) {
      assert.ok(!/^approvals\./.test(String(label)), `a legend row rendered its raw i18n key: ${label}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// config.html -- the "Jev model router" section (JEV-060 slice 2, §7/§9,
// T9). One row per target from MODEL_ROUTER_STATUS_KEY, each with its own
// off/measure/active `<select>` and its own save button/request.
// ---------------------------------------------------------------------------

const MODEL_ROUTER_STATUS_TWO_TARGETS = {
  targets: [
    { target: 'home', mode: 'measure' },
    { target: '11112222-3333-4444-5555-666677778888', mode: 'active' }
  ],
  checkedAt: new Date().toISOString()
}

test('the model router section renders one row per target, with its current mode selected', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_TWO_TARGETS })
  try {
    await page.click('#tab-models')
    const rows = await page.evaluate(() => {
      const modes = ['off', 'measure', 'active']
      return Array.from(document.querySelectorAll('#model-router-rows .mode-buttons')).map((group) => ({
        target: group.getAttribute('data-model-router-target'),
        value: modes[Array.from(group.querySelectorAll('button')).findIndex((b) => b.className === 'active')]
      }))
    })
    assert.deepEqual(rows, [
      { target: 'home', value: 'measure' },
      { target: '11112222-3333-4444-5555-666677778888', value: 'active' }
    ])
    const text = await page.evaluate(() => document.getElementById('model-router-rows').innerText)
    assert.match(text, /This computer/, 'the "home" target label did not render')
    assert.match(text, /Account 11112222/, 'the account\'s short label did not render')
    assert.doesNotMatch(text, /11112222-3333-4444-5555-666677778888/, 'the full uuid must not be the visible text')
  } finally {
    await browser.close()
  }
})

test('with no targets at all, the section shows its own empty sentence rather than nothing', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: { targets: [], checkedAt: new Date().toISOString() } })
  try {
    await page.click('#tab-models')
    const visible = await page.evaluate(() => getComputedStyle(document.getElementById('model-router-empty')).display !== 'none')
    assert.equal(visible, true)
  } finally {
    await browser.close()
  }
})

test('changing a row\'s mode and clicking its save button sends a modelRouterConfigRequest with that target and mode', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_TWO_TARGETS })
  try {
    await page.click('#tab-models')
    // Click the third button (active mode) for the home target
    await page.evaluate(() => {
      const group = document.querySelector('#model-router-rows .mode-buttons[data-model-router-target="home"]')
      group.querySelectorAll('button')[2].click() // click 'active' button
    })
    await page.click('#model-router-rows .checkbox-row:has(.mode-buttons[data-model-router-target="home"]) .model-router-save')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.equal(typeof request.id, 'string')
    assert.equal(request.target, 'home')
    assert.equal(request.mode, 'active')
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// board.html -- the Consumption card (JEV-060 slice 1, T5/T6). Reads the
// worker's `consumptionSummary` (adapters/orca/read-consumption.mjs's own
// published shape, mirrored via main.mjs's publishConsumptionSummary) and
// renders per-model cache shares, the main-step context re-read average, the
// main-vs-subagent split, quota bars per account, and the plain-language
// recommendations whose trigger key is present. Three honest states, never
// two, same convention as config.html's own modelsRenderMeasurements for
// modelMeasurements: no summary yet (or a genuine ok:true empty payload)
// reads as "no data yet"; `ok:false` reads as a distinct failure sentence;
// only real numbers ever render as a populated card.
// ---------------------------------------------------------------------------

/** A realistic populated consumptionSummary, shaped exactly like
 *  read-consumption.mjs's own stdout (src/core/consumption.ts's
 *  TurnUsageAggregation/ParsedQuota/trigger interfaces) -- never hand-typed
 *  loosely. Two models, one quota account near its weekly limit, and every
 *  one of the four recommendation triggers present with overThreshold: true
 *  so the populated test can assert on every warning line at once. */
/** The person's stored catalog (storage key `models`): the Board names models from it. */
const BOARD_MODELS = [
  { id: 'claude-opus-5-5', provider: 'anthropic', label: 'Claude Opus 5.5', rank: 2, agentModel: 'opus', source: '', available: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', rank: 3, agentModel: 'sonnet', source: '', available: true }
]

const POPULATED_USAGE_DAY = {
  stepCount: 42,
  byModel: [
    { model: 'claude-sonnet-5', stepCount: 30, tokens: 5600000, inputShare: 0.11, cacheReadShare: 0.74, cacheWriteShare: 0.1, outputShare: 0.05 },
    { model: 'claude-opus-5-5', stepCount: 12, tokens: 2170000, inputShare: 0.15, cacheReadShare: 0.57, cacheWriteShare: 0.2, outputShare: 0.08 }
  ],
  avgMainStepContextReread: 162345,
  subagentShare: 0.47,
  // 0.6.8 T6: the same split, as real totals.
  byAgent: { main: { stepCount: 30, tokens: 4120000 }, subagent: { stepCount: 12, tokens: 3650000 } }
}
const POPULATED_USAGE_WEEK = {
  stepCount: 300,
  byModel: [{ model: 'claude-sonnet-5', stepCount: 300, tokens: 30000000, inputShare: 0.12, cacheReadShare: 0.7, cacheWriteShare: 0.12, outputShare: 0.06 }],
  avgMainStepContextReread: 150500,
  subagentShare: 0.3,
  byAgent: { main: { stepCount: 210, tokens: 21000000 }, subagent: { stepCount: 90, tokens: 9000000 } }
}

const POPULATED_CONSUMPTION = {
  ok: true,
  usage: { ...windowed(POPULATED_USAGE_WEEK, { day: POPULATED_USAGE_DAY }), corruptLines: 0 },
  quota: {
    accounts: [
      { id: 'acct-primary', status: 'ok', sessionUsedPercent: 12.4, weeklyUsedPercent: 81.2, resetsAt: Date.parse('2026-10-03T23:00:00.000Z') }
    ],
    checkedAt: new Date().toISOString()
  },
  recommendations: {
    claudeMdSize: { estimatedTokens: 9000, overThreshold: true },
    mcpServerCount: { count: 5 },
    longSession: { avgMainStepContextReread: 162345, overThreshold: true },
    subagentShare: { subagentSharePercent: 47, overThreshold: true }
  },
  checkedAt: new Date().toISOString()
}

test('steward: the Consumption tab shows compactions applied and the context no longer re-read, labelled as an estimate', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000 }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Context steward/)
    assert.match(text, /At the end of a turn: compacted 2/)
    assert.match(text, /on average, about 140,000 tokens/)
    assert.match(text, /estimate/i)
    assert.match(text, /would have compacted 1/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('steward: a verified saving replaces the estimated per-step line with the saving measured on real usage', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const verified = { compactions: 59, verified: 32, steps: 4891, tokensNotReread: 1380000000, mainContextTokens: 3500000000, share: 0.283 }
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000, verified }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /At the end of a turn: compacted 2/)
    assert.match(text, /Verified saving: 1,380,000,000 tokens the main agent did not re-read, 28% of its context\. Measured on real usage in 32 of 59 compactions\./)
    assert.doesNotMatch(text, /on average, about 140,000 tokens/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('steward: a verified result with nothing verified keeps the estimated per-step line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const verified = { compactions: 3, verified: 0, steps: 0, tokensNotReread: 0, mainContextTokens: 0, share: null }
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000, verified }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /on average, about 140,000 tokens/)
    assert.doesNotMatch(text, /Verified saving/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('steward: with no steward log yet the Consumption tab says so in one line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openBoardPanel({ consumptionSummary: { ...POPULATED_CONSUMPTION, steward: null } })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /No context steward decisions yet/)
  } finally {
    await browser.close()
  }
})

/** The worker's own honest "nobody has recorded anything yet" shape -- see
 *  read-consumption.mjs's module doc: `ok: true` with a zero step count and
 *  no quota accounts, `recommendations` holding only `mcpServerCount` (0 is
 *  real data, never omitted). Must render distinctly from both the populated
 *  card above and the `ok:false` failure below. */
const EMPTY_CONSUMPTION = {
  ok: true,
  usage: { ...windowed({ stepCount: 0, byModel: [], avgMainStepContextReread: null, subagentShare: null, byAgent: { main: { stepCount: 0, tokens: null }, subagent: { stepCount: 0, tokens: null } } }), corruptLines: 0 },
  quota: { accounts: [], checkedAt: null },
  recommendations: { mcpServerCount: { count: 0 } },
  checkedAt: new Date().toISOString()
}

// 0.6.8 T6: subagent tokens counted apart from the main conversation.
test('the Consumption tab counts the main conversation and the subagents apart, in tokens and steps', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: POPULATED_CONSUMPTION })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Main conversation: 4,120,000 tokens in 30 steps/)
    assert.match(text, /Subagents: 3,650,000 tokens in 12 steps \(47%\)/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a side that reported no token figure says so instead of printing a zero', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const usage = { ...windowed({ ...POPULATED_USAGE_DAY, byAgent: { main: { stepCount: 30, tokens: 4120000 }, subagent: { stepCount: 0, tokens: null } } }), corruptLines: 0 }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: { ...POPULATED_CONSUMPTION, usage } })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Subagents: no token figure reported yet \(0 steps\)/)
    assert.doesNotMatch(text, /Subagents: 0 tokens/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a populated consumptionSummary renders real per-model shares, quota bars, and every present overThreshold recommendation', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: POPULATED_CONSUMPTION, models: BOARD_MODELS })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Sonnet 5/, 'the first model\'s friendly name did not render')
    assert.match(text, /74(\.0)?%/, 'the first model\'s cache-read share (74%) did not render')
    assert.match(text, /Opus 5\.5/, 'the second model\'s friendly name did not render')
    assert.match(text, /57(\.0)?%/, 'the second model\'s cache-read share (57%) did not render')
    assert.match(text, /12\.4%/, 'the account session usedPercent (12.4%) did not render')
    assert.match(text, /81\.2%/, 'the account weekly usedPercent (81.2%) did not render')
    assert.match(text, /47(\.0)?%/, 'the subagent share (47%) did not render')
    assert.match(text, /9,000|9000/, 'the CLAUDE.md estimated token count (9000) did not render')
    assert.match(text, /\b5\b/, 'the MCP server count (5) did not render')
    assert.match(text, /5 MCP server\(s\) in the global ~\/\.claude\.json/, 'review finding 9: the MCP count must say it is the global file, not the account in use')
    assert.match(text, /\/clear/, 'the long-session recommendation copy did not render')
    // JEV-060 slice 2, T9: the raw id is no longer the visible text -- a
    // short "Account <first 8 chars>" label is, so a person reads a name
    // rather than a uuid. The raw id must still be recoverable from the
    // element's title attribute, the same "friendly text, raw id on hover"
    // discipline the model rows already use (modelTitles below).
    assert.match(text, /Account acct-pri/, 'the account\'s short label did not render')
    assert.doesNotMatch(text, /acct-primary/, 'the raw account id must not be the visible text any more')
    const quotaTitle = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#consumption-body .kpi-sub b')).find((el) => el.title === 'acct-primary')
      return b ? b.title : null
    })
    assert.equal(quotaTitle, 'acct-primary', 'the raw account id must still be recoverable from a title attribute')
    // JEV-060 slice 1 round 4: the owner's own review -- Sonnet's three
    // rendered shares (74 + 10 + 5) summed to 89, not 100, because the
    // uncached-input share had no row at all. Each model's own set of
    // rendered bar percentages must now sum to 100 +/- 1.
    const modelBarSums = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#consumption-body .hrows')).map((hrows) => {
        return Array.from(hrows.querySelectorAll('.hv')).reduce((total, el) => {
          const n = parseFloat(el.textContent)
          return total + (Number.isFinite(n) ? n : 0)
        }, 0)
      })
    })
    for (const sum of modelBarSums.slice(0, 2)) {
      assert.ok(Math.abs(sum - 100) <= 1, `a model's rendered bar percentages should sum to ~100, got ${sum}`)
    }
    // The friendly name is what a person reads; the raw model id must still
    // be recoverable (e.g. on hover) from the element's title attribute.
    const modelTitles = await page.evaluate(() => Array.from(document.querySelectorAll('#consumption-body .kpi-sub b')).map((el) => el.title))
    assert.ok(modelTitles.includes('claude-sonnet-5'), `raw id claude-sonnet-5 missing from any model's title attribute, got: ${JSON.stringify(modelTitles)}`)
    assert.ok(modelTitles.includes('claude-opus-5-5'), `raw id claude-opus-5-5 missing from any model's title attribute, got: ${JSON.stringify(modelTitles)}`)
    assert.deepEqual(errors, [], 'the board threw while rendering a populated consumption card')
  } finally {
    await browser.close()
  }
})

// 0.11.1: the owner saw "error" on a quota row with no reason; Orca's own
// reason (`orca account list --json` quota.error) is shown under it.
test('a quota account in error shows Orca\'s reason', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: {
      ...POPULATED_CONSUMPTION,
      quota: {
        accounts: [{ id: 'dddddddd-0000-4000-8000-000000000004', email: 'someone@example.com', status: 'error', sessionUsedPercent: null, weeklyUsedPercent: null, resetsAt: null, error: 'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.' }],
        checkedAt: new Date().toISOString()
      }
    }
  })
  try {
    const body = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(body, /Orca could not read this quota: Claude usage refresh is waiting for the live Claude terminal to rotate its credentials\./)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// odd/tasks/board-tabs-and-names.md T1: the owner read "Cuenta aaaaaaaa"
// on every quota row. The worker now joins each account's email from
// `orca account list --json` (main.mjs's publishConsumptionSummary); the
// short id label stays only as the fallback for an account with none.
test('a quota account is named by its email, with the raw id kept in the title', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: {
      ...POPULATED_CONSUMPTION,
      quota: {
        accounts: [
          { ...POPULATED_CONSUMPTION.quota.accounts[0], email: 'someone@example.com' },
          { id: 'cccccccc-0000-4000-8000-000000000003', status: 'ok', sessionUsedPercent: 3, weeklyUsedPercent: 20, resetsAt: null }
        ],
        checkedAt: new Date().toISOString()
      }
    }
  })
  try {
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#consumption-body .kpi-sub b')).map((b) => ({ text: b.textContent, title: b.title })))
    const named = labels.find((label) => label.title === 'acct-primary')
    assert.ok(named, `no quota heading carries the raw id in its title: ${JSON.stringify(labels)}`)
    assert.match(named.text, /^someone@example\.com\b/, 'the email must be the visible name')
    assert.doesNotMatch(named.text, /Account acct-pri/, 'the short id must not be shown when an email is known')
    const unnamed = labels.find((label) => label.title === 'cccccccc-0000-4000-8000-000000000003')
    assert.ok(unnamed, 'the second account lost its title')
    assert.match(unnamed.text, /^Account cccccccc\b/, 'an account with no email keeps the short id label, never a blank')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// odd/tasks/board-tabs-and-names.md T1: "Live status" printed the raw
// projectId (`github:owner/name`, `repo:<uuid>`) while "By project" printed
// a short name. The worker now resolves `projectName` (main.mjs's
// boardProjectName); the board shows it and keeps every raw id in `title`.
// `global-floating-terminal` is Orca's own FLOATING_TERMINAL_WORKTREE_ID
// (orca-oss src/shared/floating-workspace-selector.ts), which Orca's own
// Activity page labels "Floating terminal".
const NAMED_BOARD = {
  entries: [
    { worktreeId: 'wt-app', project: 'github:example/orca-jev-advisor', projectName: 'orca-jev-advisor', rama: 'feat/board-tabs', paneKey: 'pane-a', state: 'working', receivedAt: 4, updatedAt: new Date().toISOString() },
    { worktreeId: 'global-floating-terminal', project: null, projectName: null, rama: null, paneKey: 'pane-f', state: 'working', receivedAt: 3, updatedAt: new Date().toISOString() },
    { worktreeId: 'wt-gone', project: 'repo:5c1d0e4f-2c18-4a14-b3c7-5a9d0e4f2c18', projectName: null, rama: 'main', paneKey: 'pane-r', state: 'done', receivedAt: 2, updatedAt: new Date().toISOString() },
    { worktreeId: null, project: null, rama: null, paneKey: 'pane-n', state: 'done', receivedAt: 1, updatedAt: new Date().toISOString() }
  ]
}

async function liveRows (page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#cards .live-row')).map((row) => ({
    name: row.querySelector('.name').textContent, title: row.title, text: row.textContent
  })))
}

test('live rows show the name the worker resolved, keep the raw ids in the title, and never invent a name', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ board: NAMED_BOARD })
  try {
    const rows = await liveRows(page)
    const byPane = Object.fromEntries(rows.map((row) => [row.title.split(' · ').pop(), row]))
    assert.equal(byPane['pane-a'].name, 'orca-jev-advisor')
    assert.match(byPane['pane-a'].title, /github:example\/orca-jev-advisor/, 'the raw projectId must stay recoverable from the title')
    assert.equal(byPane['pane-f'].name, 'Floating terminal')
    assert.equal(byPane['pane-r'].name, '(unknown project)', 'a project the worker could not name reads as unknown, never as its raw id')
    assert.match(byPane['pane-r'].title, /repo:5c1d0e4f/)
    assert.equal(byPane['pane-n'].name, '(unknown worktree)')
    for (const row of rows) {
      assert.doesNotMatch(row.text, /github:|repo:/, `a raw projectId is visible text again: ${row.text}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the floating terminal is named in Spanish too', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ board: NAMED_BOARD }, 'es')
  try {
    const names = (await liveRows(page)).map((row) => row.name)
    assert.ok(names.includes('Terminal flotante'), `expected "Terminal flotante" among ${JSON.stringify(names)}`)
    assert.ok(names.includes('(proyecto desconocido)'), `expected "(proyecto desconocido)" among ${JSON.stringify(names)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the consumptionSummary empty state ("no data yet") never reads as a populated-but-zero card, and is never blank',{ skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: EMPTY_CONSUMPTION })
  try {
    const text = await page.evaluate(() => document.getElementById('card-consumption').innerText.trim())
    assert.notEqual(text, '', 'the empty state must never render as a blank card')
    assert.match(text, /no consumption data yet/i, 'the empty state did not render its honest "no data yet" sentence')
    assert.doesNotMatch(text, /0%|claude-sonnet|acct-/i, 'the empty state must not look like a populated-but-zero card')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an {ok:false} consumptionSummary renders as a failure, never as "no data yet"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: { ok: false, reason: 'exception', detail: 'boom', checkedAt: new Date().toISOString() }
  })
  try {
    const text = await page.evaluate(() => document.getElementById('card-consumption').innerText.trim())
    assert.notEqual(text, '', 'a failure must never render as a blank card')
    assert.doesNotMatch(text, /no consumption data yet/i, 'an ok:false summary must not read as the honest empty state')
    assert.match(text, /could not be calculated/i, 'the ok:false state did not render its own distinct failure sentence')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('every consumption.* key in one language catalog exists in the other, and the es values are accented with no \' -- \'', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openBoardPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('consumption.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('consumption.') === 0)
    assert.ok(esKeys.length > 0, 'no consumption.* keys found in the es catalog')
    const missingInEn = esKeys.filter((key) => enKeys.indexOf(key) === -1)
    const missingInEs = enKeys.filter((key) => esKeys.indexOf(key) === -1)
    assert.deepEqual(missingInEn, [], `es-only consumption.* keys missing from en: ${missingInEn.join(', ')}`)
    assert.deepEqual(missingInEs, [], `en-only consumption.* keys missing from es: ${missingInEs.join(', ')}`)

    // Same technique as src/core/i18n_catalogs.test.ts, scoped to just the
    // new keys -- that file never reads board.html's own inline CATALOG (see
    // odd/tasks/jev-060-consumption.md's board-copy-test correction).
    const mustBeAccented = [
      'limite', 'podria', 'podrian', 'maquina', 'automatica', 'automaticamente', 'despues', 'ningun',
      'catalogo', 'politica', 'politicas', 'aqui', 'alli', 'leido', 'codigo', 'sesion', 'tambien',
      'todavia', 'ademas', 'numero', 'ultimo', 'ultima', 'pagina', 'accion', 'opcion', 'configuracion',
      'revision', 'decision', 'informacion', 'funcion', 'razon', 'deberia', 'tendria', 'habria',
      'seria', 'estara', 'sera', 'facil', 'rapido', 'unico', 'unica', 'metodo'
    ]
    const problems = []
    for (const key of esKeys) {
      const value = catalog.es[key]
      if (value.includes(' -- ')) problems.push(`${key}: uses ' -- '`)
      const words = value.toLowerCase().split(/[^a-záéíóúüñ]+/u).filter((w) => w.length > 0)
      const missingAccents = words.filter((w) => mustBeAccented.includes(w))
      if (missingAccents.length > 0) problems.push(`${key}: missing accents on ${missingAccents.join(', ')}`)
    }
    assert.deepEqual(problems, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// board.html -- tabs (odd/tasks/board-tabs-and-names.md T2). The owner: "The
// Advisor panel needs tabs, it got too long." Every section the board has is
// listed here by id, so a section added later without a tab, or placed under
// two, fails the grouping test instead of quietly disappearing. The window
// chips drive every tab (odd/tasks/board-global-window.md W2), so they sit
// above the tabs, under none of them.
// ---------------------------------------------------------------------------

const BOARD_TABS = ['gate', 'activity', 'consumption', 'skills']
const BOARD_TAB_SECTIONS = {
  gate: ['card-calibration', 'card-empty', 'card-interventions', 'card-recent', 'card-speed', 'card-status', 'card-toll', 'card-unmeasured', 'card-waiting'],
  activity: ['card-live', 'card-projects'],
  consumption: ['card-consumption'],
  // W3: the last tab is the modules' -- the skills mod, memory, the CI
  // watcher and verify-done -- under its old id, so a remembered tab holds.
  skills: ['card-ciwatch', 'card-memory', 'card-skills', 'card-verifydone']
}

async function boardTabState (page) {
  return page.evaluate((keys) => ({
    selected: keys.filter((k) => document.getElementById(`tab-${k}`)?.getAttribute('aria-selected') === 'true'),
    visible: keys.filter((k) => document.getElementById(`panel-${k}`) && !document.getElementById(`panel-${k}`).hidden),
    focused: document.activeElement ? document.activeElement.id : null
  }), BOARD_TABS)
}

test('the board groups every section under exactly one tab', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    const layout = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#board-tabbar [role=tab]')).map((tab) => ({
        id: tab.id, controls: tab.getAttribute('aria-controls')
      }))
      const panels = Array.from(document.querySelectorAll('[role=tabpanel]')).map((panel) => ({
        id: panel.id, labelledBy: panel.getAttribute('aria-labelledby')
      }))
      const sections = Array.from(document.querySelectorAll('section[id^="card-"]')).map((node) => {
        const owners = []
        for (let up = node.parentElement; up; up = up.parentElement) if (up.getAttribute('role') === 'tabpanel') owners.push(up.id)
        return { id: node.id, owners }
      })
      return { tabs, panels, sections, tablist: document.getElementById('board-tabbar')?.getAttribute('role') ?? null }
    })
    assert.equal(layout.tablist, 'tablist')
    assert.deepEqual(layout.tabs, BOARD_TABS.map((k) => ({ id: `tab-${k}`, controls: `panel-${k}` })))
    assert.deepEqual(layout.panels, BOARD_TABS.map((k) => ({ id: `panel-${k}`, labelledBy: `tab-${k}` })))
    const misplaced = layout.sections.filter((section) => section.owners.length !== 1)
    assert.deepEqual(misplaced, [], 'every section must sit under exactly one tab panel')
    const grouping = {}
    for (const section of layout.sections) {
      const key = section.owners[0].replace(/^panel-/, '')
      grouping[key] = [...(grouping[key] ?? []), section.id].sort()
    }
    assert.deepEqual(grouping, BOARD_TAB_SECTIONS)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-global-window.md W2 -- one window for the whole board. The
// owner: the 24 h / 7 days chips "should be outside for everyone". Every card
// heading names the window it shows, or says it does not follow the chip.
// ---------------------------------------------------------------------------

const BOARD_WINDOW_STORAGE_KEY = 'jevAdvisor.boardPanel.window'
/** Cards with no figure of their own to place in time. */
const BOARD_UNTIMED_CARDS = ['card-empty', 'card-unmeasured']

/** Every visible card on every tab: its id and its heading's window label. */
async function boardWindowLabels (page) {
  const labels = {}
  for (const key of BOARD_TABS) {
    await page.click(`#tab-${key}`)
    Object.assign(labels, await page.evaluate((untimed) => {
      const found = {}
      for (const card of document.querySelectorAll('.tab-panel:not([hidden]) section[id^="card-"]')) {
        if (card.offsetParent === null || untimed.includes(card.id)) continue
        found[card.id] = card.querySelector('h2 .win')?.textContent.trim() ?? ''
      }
      return found
    }, BOARD_UNTIMED_CARDS))
  }
  return labels
}

test('W2: the window chips sit above the tabs, under no tab panel, and stay on screen on every tab', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'])
  try {
    const place = await page.evaluate(() => {
      const chips = document.getElementById('windows')
      let owner = null
      for (let up = chips.parentElement; up; up = up.parentElement) if (up.getAttribute('role') === 'tabpanel') owner = up.id
      const tabbar = document.getElementById('board-tabbar')
      return { owner, beforeTabs: Boolean(chips.compareDocumentPosition(tabbar) & Node.DOCUMENT_POSITION_FOLLOWING) }
    })
    assert.deepEqual(place, { owner: null, beforeTabs: true })
    for (const key of BOARD_TABS) {
      await page.click(`#tab-${key}`)
      assert.equal(await page.isVisible('#windows'), true, `the chips are hidden on the ${key} tab`)
      assert.equal(await page.getAttribute('#windows button[data-window="day"]', 'aria-pressed'), 'true', `24 h is not the window on the ${key} tab`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W2: the chips show even when the gate has measured nothing yet', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ ...SCENARIOS.empty, consumptionSummary: SCENARIOS['consumption-ready'].consumptionSummary })
  try {
    await page.click('#tab-consumption')
    assert.equal(await page.isVisible('#windows'), true)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W2: every card heading names the window it shows, or says it does not follow the chip', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'])
  try {
    const labels = await boardWindowLabels(page)
    for (const id of ['card-status', 'card-toll', 'card-interventions', 'card-calibration', 'card-projects', 'card-consumption', 'card-skills', 'card-memory', 'card-ciwatch', 'card-verifydone']) {
      assert.equal(labels[id], '24 h', `${id} does not name its window: ${JSON.stringify(labels)}`)
    }
    for (const id of ['card-recent', 'card-speed', 'card-live', 'card-waiting']) {
      assert.match(labels[id] ?? '', /not the window/, `${id} does not say it ignores the chip: ${JSON.stringify(labels)}`)
    }
    const unlabelled = Object.entries(labels).filter(([, text]) => text === '')
    assert.deepEqual(unlabelled, [], 'a card heading names no window')
    await page.click('#tab-consumption')
    const consumption = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(consumption, /Account quota · right now, not the window/)
    assert.match(consumption, /Recommendations · last 24 h, not the window/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W2: switching the chip changes every card, or its label says why not', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'])
  try {
    const before = await boardWindowLabels(page)
    await page.click('#tab-consumption')
    const usageBefore = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    await page.click('#windows button[data-window="week"]')
    const after = await boardWindowLabels(page)
    for (const [id, label] of Object.entries(before)) {
      if (/not the window/.test(label)) assert.equal(after[id], label, `${id} ignores the chip and must keep its label`)
      else assert.equal(after[id], '7 days', `${id} did not follow the chip: ${JSON.stringify(after)}`)
    }
    await page.click('#tab-consumption')
    const usageAfter = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.notEqual(usageAfter, usageBefore)
    assert.match(usageAfter, /Main conversation: 21,000,000 tokens in 210 steps/, 'the usage figures are the 7-day ones')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W2: a window longer than a log keeps says so in the card heading', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'])
  try {
    await page.click('#windows button[data-window="all"]')
    const labels = await boardWindowLabels(page)
    assert.match(labels['card-projects'], /^All time: only the last 8 days, all that is kept$/)
    assert.match(labels['card-consumption'], /^All time: only the last 8 days, all that is kept$/)
    assert.equal(labels['card-toll'], 'All time', 'the gate keeps every decision in its totals')
    assert.equal(labels['card-skills'], 'All time', 'the skills log is never pruned')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W2: the chosen window is remembered through the host storage bridge, and opening the board stores nothing', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const first = await openBoardPanel(SCENARIOS['board-full'])
  try {
    assert.equal(await first.page.evaluate((key) => window.__written[key], BOARD_WINDOW_STORAGE_KEY), undefined)
    await first.page.click('#windows button[data-window="week"]')
    await first.page.waitForFunction((key) => window.__written[key] !== undefined, BOARD_WINDOW_STORAGE_KEY, { timeout: 3000 })
    assert.equal(await first.page.evaluate((key) => window.__written[key], BOARD_WINDOW_STORAGE_KEY), 'week')
    assert.deepEqual(first.errors, [])
  } finally {
    await first.browser.close()
  }
  const again = await openBoardPanel({ ...SCENARIOS['board-full'], [BOARD_WINDOW_STORAGE_KEY]: 'week' })
  try {
    assert.equal(await again.page.getAttribute('#windows button[data-window="week"]', 'aria-pressed'), 'true')
    await again.page.click('#tab-activity')
    assert.equal(await again.page.evaluate(() => document.querySelector('#card-projects h2 .win').textContent.trim()), '7 days')
    assert.deepEqual(again.errors, [])
  } finally {
    await again.browser.close()
  }
})

test('W2: a stored window that is not a window, or a localStorage that throws, still opens on 24 h', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ ...SCENARIOS['board-full'], [BOARD_WINDOW_STORAGE_KEY]: 'fortnight' }, 'en', 'light', { throwingStorage: true })
  try {
    assert.equal(await page.getAttribute('#windows button[data-window="day"]', 'aria-pressed'), 'true')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-global-window.md W3 -- the owner turned memory (Active,
// Engram), the CI watcher and verify-done on, and the board never showed
// them. The Modules tab does, each with its state and its window's figures,
// straight from measurementsSummary.modules.
// ---------------------------------------------------------------------------

async function moduleCardText (page, id) {
  await page.click('#tab-skills')
  return page.evaluate((id) => document.getElementById(id).innerText, id)
}

test('W3: the Modules tab shows memory, the CI watcher and verify-done with their state and the window\'s own figures', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['board-full']
  const modules = scenario.measurementsSummary.modules
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    assert.equal(await page.textContent('#tab-skills'), 'Modules')
    const memory = await moduleCardText(page, 'card-memory')
    const day = modules.memory.windows.day
    assert.equal(await page.evaluate(() => document.querySelector('#card-memory h2').textContent), 'Memory24 h', 'heading and its window')
    assert.match(memory, /Active/)
    assert.match(memory, /Saves to: Engram, running · right now/)
    for (const [label, value] of [['Turns weighed', day.decisions], ['Saved to Engram', day.engramSaved], ['Memory files written', day.written], ['Saved by your main thread', day.mainEngramSaves], ['Conflicts waiting to be judged', day.judgePending]]) {
      assert.ok(memory.includes(`${value.toLocaleString('en')}\n${label}`) || memory.includes(`${label}\n${value.toLocaleString('en')}`), `memory: ${label} ${value} in ${JSON.stringify(memory)}`)
    }
    assert.match(memory, new RegExp(`Agrees with your main thread on ${Math.round(day.agreementRate * 100)}% of turns`))

    const ci = await moduleCardText(page, 'card-ciwatch')
    const ciDay = modules.ciWatch.windows.day
    assert.equal(await page.evaluate(() => document.querySelector('#card-ciwatch h2').textContent), 'CI watcher24 h')
    assert.match(ci, /Active/)
    for (const [label, value] of [['Watches', ciDay.watches], ['gh calls', ciDay.ghCalls], ['Agent polls replaced', ciDay.pollsReplaced]]) {
      assert.ok(ci.includes(`${value}\n${label}`) || ci.includes(`${label}\n${value}`), `ci: ${label} ${value} in ${JSON.stringify(ci)}`)
    }

    const verify = await moduleCardText(page, 'card-verifydone')
    const vDay = modules.verifyDone.windows.day
    assert.equal(await page.evaluate(() => document.querySelector('#card-verifydone h2').textContent), 'Verify done24 h')
    assert.match(verify, /Shadow/)
    for (const [label, value] of [['Turns checked', vDay.decisions], ['Said done', vDay.claims], ['Would have been stopped', vDay.wouldBlock]]) {
      assert.ok(verify.includes(`${value}\n${label}`) || verify.includes(`${label}\n${value}`), `verify: ${label} ${value} in ${JSON.stringify(verify)}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W3: the module cards follow the chip', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['board-full']
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    await page.click('#windows button[data-window="week"]')
    const memory = await moduleCardText(page, 'card-memory')
    assert.equal(await page.evaluate(() => document.querySelector('#card-memory h2 .win').textContent), '7 days')
    assert.ok(memory.includes(String(scenario.measurementsSummary.modules.memory.windows.week.decisions)), memory)
    const verify = await moduleCardText(page, 'card-verifydone')
    assert.ok(verify.includes(String(scenario.measurementsSummary.modules.verifyDone.windows.week.decisions)), verify)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W3: a module that is off says so; one with nothing in the window says that, never a column of zeros', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = { ...SCENARIOS['modules-mixed'], measurementsSummary: SCENARIOS.empty.measurementsSummary }
  const { browser, page, errors } = await openBoardPanel(scenario, 'es')
  try {
    const verify = await moduleCardText(page, 'card-verifydone')
    assert.match(verify, /Apagado/)
    const ci = await moduleCardText(page, 'card-ciwatch')
    assert.match(ci, /Sin actividad en esta ventana/)
    assert.doesNotMatch(ci, /Llamadas a gh/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W3: a summary from a worker that does not publish modules yet says so in each card', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { modules: _modules, ...older } = SCENARIOS.ready.measurementsSummary
  const { browser, page, errors } = await openBoardPanel({ ...SCENARIOS.ready, measurementsSummary: older })
  try {
    for (const id of ['card-memory', 'card-ciwatch', 'card-verifydone']) {
      assert.match(await moduleCardText(page, id), /No figures yet/, id)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-global-window.md W4 -- cards that read wrong on the owner's
// real board (audit #3, #4, #5, #6, #7, #8, #10, #11).
// ---------------------------------------------------------------------------

test('W4 #3: the router line says the other decisions were measured only, not that they failed', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed(POPULATED_MODEL_ROUTER) } }, 'es')
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Aplicadas 3 · solo medidas 2/)
    assert.doesNotMatch(text, /no aplicadas/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #4: token usage says how much, per model and in total, and folds models with a sliver of the steps into one line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const day = {
    ...POPULATED_USAGE_DAY,
    stepCount: 200,
    byModel: [
      { model: 'claude-sonnet-5', stepCount: 150, tokens: 6000000, inputShare: 0.11, cacheReadShare: 0.74, cacheWriteShare: 0.1, outputShare: 0.05 },
      { model: 'claude-opus-5-5', stepCount: 48, tokens: 1700000, inputShare: 0.15, cacheReadShare: 0.57, cacheWriteShare: 0.2, outputShare: 0.08 },
      { model: 'claude-haiku-4-5-20251001', stepCount: 1, tokens: 900, inputShare: 1, cacheReadShare: 0, cacheWriteShare: 0, outputShare: 0 },
      { model: 'some-gateway-model', stepCount: 1, tokens: 400, inputShare: 1, cacheReadShare: 0, cacheWriteShare: 0, outputShare: 0 }
    ],
    byAgent: { main: { stepCount: 120, tokens: 4120000 }, subagent: { stepCount: 80, tokens: 3581300 } }
  }
  const consumptionSummary = { ...POPULATED_CONSUMPTION, usage: { ...windowed(day), corruptLines: 0 } }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary, models: BOARD_MODELS })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /In total: 7,701,300 tokens in 200 steps\./)
    assert.match(text, /Sonnet 5 · 150 step\(s\) · 6,000,000 tokens/)
    assert.match(text, /Other models with under 2% of the steps \(2\): 2 step\(s\) · 1,300 tokens/)
    assert.doesNotMatch(text, /some-gateway-model/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #5 #6: calibration and Jev latency say they speak for the window; the A/B medians say they cover every comparison', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready, 'es')
  try {
    const status = await page.evaluate(() => document.getElementById('status-body').innerText)
    assert.match(status, /Jev en esta ventana: p50 [\d.,]+ ms · p95 [\d.,]+ ms/)
    const calibration = await page.evaluate(() => document.getElementById('approvals-body').innerText)
    assert.doesNotMatch(calibration, /hasta ahora/)
    assert.match(calibration, /en esta ventana/)
    const speed = await page.evaluate(() => document.getElementById('speed-body').innerText)
    assert.match(speed, /Medianas sobre las 20 comparaciones emparejadas que hay, de cualquier fecha\./)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #7: the steward\'s two moments read side by side, each with what it did and what it would have done', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const preCold = { fired: 0, wouldFire: 9, skipped: 5, returned: 8, returnedEarly: 0, notReturned: 1, pending: 0, coldRewriteOnReturn: 1708572, realizedSaving: null, waste: null, engineIdleCompactions: 0 }
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 181, applied: 9, wouldCompact: 0, freedPerStep: 305381, preCold }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /At the end of a turn: compacted 9 · would have compacted 0 \(measuring only\)/)
    assert.match(text, /Before the cache goes cold: compacted 0 · would have compacted 9 \(measuring only\)/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #8: the header counts the sessions seen in the last 24 h, not every entry ever stored', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['live-busy'])
  try {
    const header = await page.textContent('#status')
    await page.click('#tab-activity')
    const shown = await page.evaluate(() => document.querySelectorAll('#cards .live-row').length)
    assert.equal(header, `${shown} active in 24 h`)
    assert.ok(shown < SCENARIOS['live-busy'].board.entries.length)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #10: recommendations never take the alarm red; checks that ask for nothing fold into one quiet line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const recommendations = {
    claudeMdSize: { estimatedTokens: 9000, overThreshold: true },
    mcpServerCount: { count: 5 },
    longSession: { avgMainStepContextReread: 62345, overThreshold: false },
    subagentShare: { subagentSharePercent: 12, overThreshold: false }
  }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: { ...POPULATED_CONSUMPTION, recommendations } })
  try {
    const found = await page.evaluate(() => {
      const body = document.getElementById('consumption-body')
      return { red: body.querySelectorAll('.stale').length, text: body.innerText }
    })
    assert.equal(found.red, 0, 'advice is not an alarm')
    assert.match(found.text, /Consider trimming it to save tokens on every call\./)
    assert.match(found.text, /Checked, nothing to do: context per main step 62,345 tokens · subagents 12% of usage · 5 MCP server\(s\) in the global ~\/\.claude\.json/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W4 #11: the skills match rate is never a bare percentage on a handful of samples', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['skills-ready']
  const day = scenario.measurementsSummary.modSkills.windows.day
  const min = scenario.measurementsSummary.modSkills.readiness.thresholds.minComparable
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    const text = await skillsCardText(page)
    assert.match(text, new RegExp(`Measurement-mode match rate: ${day.matchedCount} of ${day.comparableCount} comparable prompts; ${min.toLocaleString('en')} are needed before it means anything`))
    assert.doesNotMatch(text, /match rate: \d+(\.\d+)?%/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-global-window.md W5 -- es-ES and narrow screens (audit #12,
// #13): numbers and money in the board's own locale, words instead of raw
// verdicts and states, and bar labels that are never cut at phone widths.
// ---------------------------------------------------------------------------

test('W5 #12: in Spanish, numbers group by thousands (four digits too), decimals use a comma, and dollar amounts are written the Spanish way', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'], 'es')
  try {
    const toll = await page.evaluate(() => document.getElementById('toll-body').innerText)
    assert.match(toll, /2\.409/, 'a four-digit count is grouped')
    await page.click('#tab-consumption')
    const consumption = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(consumption, /4\.120\.000 tokens/)
    assert.match(consumption, /12,4 %|12,4%/)
    assert.doesNotMatch(consumption, /\d\.\d%/, 'no decimal point in a Spanish percentage')
    await page.click('#tab-activity')
    const activity = await page.evaluate(() => document.getElementById('card-projects').innerText)
    assert.match(activity, /2,57\s?US\$/)
    assert.doesNotMatch(activity, /\$\d/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W5 #12: verdicts and live states are words in the board\'s language, never the raw value', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ ...SCENARIOS['board-full'], board: SCENARIOS['live-busy'].board }, 'es')
  try {
    const recent = await page.evaluate(() => document.getElementById('stats-recent').innerText)
    assert.match(recent, /permitido/)
    assert.doesNotMatch(recent, /\ballow\b|\bask\b|\bdeny\b/)
    await page.click('#tab-activity')
    const live = await page.evaluate(() => document.getElementById('cards').innerText)
    assert.doesNotMatch(live, /\bworking\b|\bwaiting\b|\bdone\b|\bblocked\b/)
    assert.match(live, /trabajando|esperando|terminado|bloqueado/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const locale of ['es', 'en']) {
  test(`W5 #13: at 390px no bar label is cut, on any tab (${locale})`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openBoardPanel(SCENARIOS['board-full'], locale, 'dark', { viewport: { width: 390, height: 900 } })
    try {
      const cut = []
      for (const key of BOARD_TABS) {
        await page.click(`#tab-${key}`)
        cut.push(...await page.evaluate(() => Array.from(document.querySelectorAll('.tab-panel:not([hidden]) .hrow .hl'))
          .filter((node) => node.offsetParent !== null && node.scrollWidth > node.clientWidth + 1)
          .map((node) => node.textContent)))
      }
      assert.deepEqual(cut, [])
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

// ---------------------------------------------------------------------------
// odd/tasks/board-global-window.md W6 -- Actividad's live rows and the
// interventions footnote (audit #14, #15).
// ---------------------------------------------------------------------------

test('W6 #14: at 390px every live row reads the same way: name, state and time on one line, branch and sessions under it, pills that show', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['live-busy'], 'es', 'dark', { viewport: { width: 390, height: 900 } })
  try {
    await page.click('#tab-activity')
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#cards .live-row')).map((row) => {
      const top = (selector) => { const node = row.querySelector(selector); return node ? Math.round(node.getBoundingClientRect().top) : null }
      const state = row.querySelector('.tag.state')
      return {
        name: top('.name'), state: top('.tag.state'), when: top('.when'), branch: top('.branch'),
        stateBorder: getComputedStyle(state).borderTopColor,
        cardBorder: getComputedStyle(document.getElementById('card-live')).borderTopColor
      }
    }))
    assert.ok(rows.length > 3)
    for (const row of rows) {
      assert.ok(Math.abs(row.state - row.name) <= 4 && Math.abs(row.when - row.name) <= 4, `name, state and time share the first line: ${JSON.stringify(row)}`)
      if (row.branch !== null) assert.ok(row.branch > row.name + 4, `the branch sits under the name: ${JSON.stringify(row)}`)
      assert.notEqual(row.stateBorder, row.cardBorder, 'a state pill is drawn in a stronger line than the card hairline')
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('W6 #15: the interventions line counts only what the table shows; advice to the model is its own sentence', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready, 'es')
  try {
    const text = await page.evaluate(() => document.getElementById('interventions-body').innerText)
    const day = SCENARIOS.ready.measurementsSummary.gate.windows.day
    assert.doesNotMatch(text.split('\n')[0], /avisadas/)
    assert.match(text, new RegExp(`${day.byVerdict.advise} veces se avisó al modelo sin detener a nadie`))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// odd/tasks/board-global-window.md W7: what the real-data screenshots showed.
test('W7: a share that is not zero never prints 0%, a router share with no switch prints no line, and the A/B verdicts are words', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const day = { ...POPULATED_USAGE_DAY, byModel: [{ model: 'claude-sonnet-5', stepCount: 42, tokens: 100000, inputShare: 0.0002, cacheReadShare: 0.9, cacheWriteShare: 0.0948, outputShare: 0.005 }], stepCount: 42 }
  const quiet = activityProject({ project: 'measured-only', judged: 1, gateOutcomes: { allowed: 1, advised: 0, asked: 0, blocked: 0 }, router: { applied: 0, savedEstimate: null } })
  const { browser, page, errors } = await openBoardPanel({ ...SCENARIOS.ready, ...activitySummary([quiet]), consumptionSummary: { ...POPULATED_CONSUMPTION, usage: { ...windowed(day), corruptLines: 0 } } }, 'es')
  try {
    const speed = await page.evaluate(() => document.getElementById('speed-body').innerText)
    assert.match(speed, /Jev «permitido» \/ modelo «preguntó»/)
    await page.click('#tab-consumption')
    const consumption = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(consumption, /<0,1%/)
    assert.doesNotMatch(consumption, /\n0%/)
    await page.click('#tab-activity')
    const activity = await page.evaluate(() => document.getElementById('card-projects').innerText)
    assert.doesNotMatch(activity, /0 cambio/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the board opens on Gate, and clicking a tab shows only its own panel', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    assert.deepEqual((await boardTabState(page)).visible, ['gate'])
    for (const key of BOARD_TABS) {
      await page.click(`#tab-${key}`)
      const state = await boardTabState(page)
      assert.deepEqual(state.selected, [key], `exactly tab-${key} should be aria-selected=true`)
      assert.deepEqual(state.visible, [key], `exactly panel-${key} should be visible`)
      const tabIndexes = await page.evaluate(() => Array.from(document.querySelectorAll('#board-tabbar [role=tab]')).map((t) => t.tabIndex))
      assert.deepEqual(tabIndexes, BOARD_TABS.map((k) => (k === key ? 0 : -1)), 'only the selected tab is in the tab order')
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('arrow keys move focus and selection between board tabs, wrapping at both ends, and Home/End jump', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    await page.click('#tab-gate')
    await page.focus('#tab-gate')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await boardTabState(page), { selected: ['activity'], visible: ['activity'], focused: 'tab-activity' })
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    assert.deepEqual(await boardTabState(page), { selected: ['skills'], visible: ['skills'], focused: 'tab-skills' })
    await page.keyboard.press('ArrowRight')
    assert.equal((await boardTabState(page)).focused, 'tab-gate')
    await page.keyboard.press('End')
    assert.equal((await boardTabState(page)).focused, 'tab-skills')
    await page.keyboard.press('Home')
    assert.deepEqual(await boardTabState(page), { selected: ['gate'], visible: ['gate'], focused: 'tab-gate' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the board reopens on the tab this viewer chose last time', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    await page.click('#tab-consumption')
    await page.reload()
    await page.waitForTimeout(500)
    assert.deepEqual((await boardTabState(page)).visible, ['consumption'])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a board whose localStorage throws (Orca\'s opaque-origin iframe) still opens on Gate and still switches tabs', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready, 'en', 'light', { throwingStorage: true })
  try {
    assert.deepEqual((await boardTabState(page)).visible, ['gate'])
    await page.click('#tab-activity')
    assert.deepEqual((await boardTabState(page)).visible, ['activity'])
    assert.deepEqual(errors, [], 'a throwing localStorage must never surface as an uncaught panel error')
  } finally {
    await browser.close()
  }
})

test('the board\'s tab labels exist in both languages', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({}, 'es')
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('tabs.') === 0).sort()
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('tabs.') === 0).sort()
    assert.deepEqual(esKeys, ['tabs.activity', 'tabs.consumption', 'tabs.gate', 'tabs.groupLabel', 'tabs.skills'])
    assert.equal(catalog.es['tabs.skills'], 'Módulos', 'W3: the last tab holds every module')
    assert.deepEqual(enKeys, esKeys)
    const labels = await page.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll('#board-tabbar [role=tab]')).map((t) => t.textContent),
      group: document.getElementById('board-tabbar').getAttribute('aria-label')
    }))
    assert.deepEqual(labels.tabs, ['gate', 'activity', 'consumption', 'skills'].map((k) => catalog.es[`tabs.${k}`]))
    assert.equal(labels.group, catalog.es['tabs.groupLabel'])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const scenario of ['fresh', 'empty', 'ready']) {
  test(`no board tab is ever blank (${scenario})`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openBoardPanel(SCENARIOS[scenario])
    try {
      const blank = []
      for (const key of BOARD_TABS) {
        await page.click(`#tab-${key}`)
        const text = await page.evaluate((k) => document.getElementById(`panel-${k}`).innerText.trim(), key)
        if (text === '') blank.push(key)
      }
      assert.deepEqual(blank, [], 'a tab with nothing in it tells a person nothing, not even why')
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

// T3 finding: at 320px the bar wrapped onto a second row only while
// Consumption was selected (its heavier weight made the row too wide), so the
// content below jumped when switching tabs.
for (const width of [320, 390]) {
  test(`the board tab bar stays on one row at ${width}px, whichever tab is selected`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openBoardPanel(SCENARIOS['router-ready'], 'en', 'light', { viewport: { width, height: 900 } })
    try {
      const wrapped = []
      for (const key of BOARD_TABS) {
        await page.click(`#tab-${key}`)
        const tops = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#board-tabbar [role=tab]')).map((t) => `${t.id}:${t.offsetTop}`))
        if (new Set(tops.map((entry) => entry.split(':')[1])).size !== 1) wrapped.push(`${key} selected: ${tops.join(' ')}`)
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
        if (size.scroll > size.client) wrapped.push(`${key} selected: page is ${size.scroll}px in ${size.client}px`)
      }
      assert.deepEqual(wrapped, [])
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('no board tab scrolls sideways at 320px',{ skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS['router-ready'], 'es', 'light', { viewport: { width: 320, height: 900 } })
  try {
    const wide = []
    for (const key of BOARD_TABS) {
      await page.click(`#tab-${key}`)
      const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
      if (size.scroll > size.client) wide.push(`${key}: ${size.scroll}px in ${size.client}px`)
    }
    assert.deepEqual(wide, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// board.html -- the Consumption card's "Model router" subsection (JEV-060
// slice 2, §8, T9). `modelRouter` is summarizeRouterDecisions' own summary
// (read-consumption.mjs), attached to consumptionSummary, or absent/null
// when no model-router-decisions-*.jsonl file exists at all.
// ---------------------------------------------------------------------------

const POPULATED_MODEL_ROUTER = {
  total: 5,
  applied: 3,
  measured: 2,
  byPoint: {
    start: { simple: 2, standard: 0, complex: 0, frontier: 0 },
    stage: { simple: 0, standard: 1, complex: 1, frontier: 0 },
    subagent: { simple: 1, standard: 0, complex: 0, frontier: 0 }
  },
  savedEstimate: 0.0421,
  switchesEstimated: 2
}

const NO_ESTIMATE_MODEL_ROUTER = {
  total: 2,
  applied: 0,
  measured: 2,
  byPoint: {
    start: { simple: 1, standard: 0, complex: 0, frontier: 0 },
    stage: { simple: 0, standard: 0, complex: 1, frontier: 0 },
    subagent: { simple: 0, standard: 0, complex: 0, frontier: 0 }
  },
  savedEstimate: null,
  switchesEstimated: 0
}

test('a populated modelRouter renders decisions by point/tier, applied vs measured, and the dollar estimate', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed(POPULATED_MODEL_ROUTER) }
  })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Model router/, 'the Model router heading did not render')
    assert.match(text, /Session start/, 'the "start" point label did not render')
    assert.match(text, /Stage change/, 'the "stage" point label did not render')
    assert.match(text, /Subagent/, 'the "subagent" point label did not render')
    assert.match(text, /Ask/, 'the simple-tier label did not render')
    assert.match(text, /Implement/, 'the standard-tier label did not render')
    assert.match(text, /Analyse/, 'the complex-tier label did not render')
    assert.match(text, /Applied 3 · measured only 2/, 'the applied/not-applied counts did not render')
    assert.match(text, /Estimated saving at list prices: \$0\.04/, 'the estimated saving did not render')
    assert.doesNotMatch(text, /estimate[ds]?\b[^\n]*\bestimate/i, 'the saving line says "estimate" twice')
    assert.match(text, /Covers downgrades at a stage change only/, 'the estimate does not say what it covers')
    assert.deepEqual(errors, [], 'the board threw while rendering a populated model router section')
  } finally {
    await browser.close()
  }
})

test('R3: the router card says how many switches came after a cold cache in its window, and says nothing without the count', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const withCount = await openBoardPanel({
    consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed({ ...POPULATED_MODEL_ROUTER, coldSwitches: 3 }) }
  })
  try {
    const text = await withCount.page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Switches after a cold cache: 3/)
    assert.deepEqual(withCount.errors, [])
  } finally {
    await withCount.browser.close()
  }
  const older = await openBoardPanel({
    consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed(POPULATED_MODEL_ROUTER) }
  })
  try {
    const text = await older.page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.doesNotMatch(text, /cold cache/, 'a summary from before the count shows no line, never a zero')
    assert.deepEqual(older.errors, [])
  } finally {
    await older.browser.close()
  }
})

test('an absent modelRouter renders one honest "no decisions yet" line, never a zeroed summary', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: POPULATED_CONSUMPTION })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /No router decisions yet/i)
    assert.doesNotMatch(text, /Applied \d/, 'an absent modelRouter must never render applied/measured counts')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('a modelRouter with no applied switch yet renders "no applied switch to estimate" instead of a dollar amount', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed(NO_ESTIMATE_MODEL_ROUTER) }
  })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /No downgrade at a stage change to estimate yet/i)
    assert.doesNotMatch(text, /\$\d/, 'no dollar amount should render when savedEstimate is null')
    assert.match(text, /Applied 0 · measured only 2/, 'the applied/not-applied counts did not render')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('review finding 8: a negative estimate is shown as an extra cost, never as a negative saving', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    consumptionSummary: { ...POPULATED_CONSUMPTION, modelRouter: windowed({ ...POPULATED_MODEL_ROUTER, savedEstimate: -0.0912 }) }
  })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Estimated extra cost at list prices: \$0\.09/)
    assert.doesNotMatch(text, /\$-|-\$/, 'a negative dollar amount must never render')
    assert.doesNotMatch(text, /Estimated saving/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// Generic guard for the class of bug the owner found by eye in the Models tab:
// two controls side by side with no space between them. It walks every tab of
// the settings panel and the board, at a desktop and a phone width, and checks
// each pair of neighbouring controls that share a parent and a line.
const CONTROL_SELECTOR = 'button, a[href], select, input:not([type=hidden]), [role=tab]'

async function touchingControls (page) {
  return page.evaluate((selector) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && el.offsetParent !== null
    }
    const describe = (el) => (el.id ? `#${el.id}` : '') || (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)
    const problems = []
    const parents = new Set(Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => el.parentElement))
    for (const parent of parents) {
      const controls = Array.from(parent.children).filter((el) => el.matches(selector) && visible(el))
      for (let i = 1; i < controls.length; i++) {
        const a = controls[i - 1].getBoundingClientRect()
        const b = controls[i].getBoundingClientRect()
        const sameLine = b.top < a.bottom && a.top < b.bottom
        if (sameLine && b.left - a.right < 4) problems.push(`${describe(controls[i - 1])} | ${describe(controls[i])}: ${Math.round(b.left - a.right)}px`)
      }
    }
    return problems
  }, CONTROL_SELECTOR)
}

for (const width of [1440, 390]) {
  test(`no two neighbouring controls touch on any settings tab at ${width}px`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const { browser, page } = await openPanel(SCENARIOS.ready, 'es', 'dark', { width, height: 1200 })
    try {
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('[role=tab]')).map((t) => t.id))
      assert.ok(tabs.length >= 5, `expected the settings tabs, found ${tabs.length}`)
      const problems = []
      for (const tab of tabs) {
        await page.click(`#${tab}`)
        for (const p of await touchingControls(page)) problems.push(`${tab}: ${p}`)
      }
      assert.deepEqual(problems, [])
    } finally {
      await browser.close()
    }
  })
}

test('no two neighbouring controls touch on any board tab', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openBoardPanel(SCENARIOS.ready, 'es', 'dark')
  try {
    await page.waitForTimeout(1500)
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('#board-tabbar [role=tab]')).map((t) => t.id))
    assert.equal(tabs.length, BOARD_TABS.length, `expected the board tabs, found ${JSON.stringify(tabs)}`)
    const problems = []
    for (const tab of tabs) {
      await page.click(`#${tab}`)
      for (const p of await touchingControls(page)) problems.push(`${tab}: ${p}`)
    }
    assert.deepEqual(problems, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// 0.6.2 E4: the Models tab -- the effort each tier asks for, per account;
// one source line for the catalog; an intro that says what the ladder, the
// router switch and the table each do; the classic hook's switch labelled
// as the legacy one.
// ---------------------------------------------------------------------------

const TIERS_ANTHROPIC = {
  simple: { modelId: 'claude-haiku-5-5', label: 'Haiku 5.5', supportsEffort: true },
  standard: { modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', supportsEffort: true },
  complex: { modelId: 'claude-opus-5-5', label: 'Opus 5.5', supportsEffort: true },
  frontier: { modelId: 'claude-opus-5-5', label: 'Opus 5.5', supportsEffort: true }
}
const EFFORT_DEFAULTS = { simple: 'medium', standard: 'medium', complex: 'high', frontier: 'xhigh' }
const MODEL_ROUTER_STATUS_EFFORT = {
  targets: [
    { target: 'home', mode: 'measure', effort: EFFORT_DEFAULTS, tiers: TIERS_ANTHROPIC, steward: { mode: 'measure', threshold: 120000 } },
    { target: '11112222-3333-4444-5555-666677778888', mode: 'active', effort: { ...EFFORT_DEFAULTS, complex: 'xhigh' }, tiers: TIERS_ANTHROPIC, steward: { mode: 'active', threshold: 150000 } }
  ],
  checkedAt: new Date().toISOString()
}
const ANTHROPIC_MODELS_DOCS = 'https://platform.claude.com/docs/en/about-claude/models/overview'

test('0.6.2: each account shows tier → the model it resolves to → its effort', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT })
  try {
    await page.click('#tab-models')
    const table = await page.evaluate(() => Array.from(document.querySelectorAll('[data-model-router-effort-table="11112222-3333-4444-5555-666677778888"] tbody tr')).map((tr) => {
      const pressed = tr.querySelector('.mode-buttons button[aria-pressed="true"]')
      return { cells: Array.from(tr.cells).slice(0, 2).map((cell) => cell.innerText.trim()), effort: pressed ? pressed.dataset.value : null }
    }))
    assert.deepEqual(table, [
      { cells: ['Ask', 'Haiku 5.5'], effort: 'medium' },
      { cells: ['Implement', 'Sonnet 5.5'], effort: 'medium' },
      { cells: ['Analyse', 'Opus 5.5'], effort: 'xhigh' },
      { cells: ['Deep reasoning', 'Opus 5.5'], effort: 'xhigh' }
    ])
    const group = 'div[data-model-router-effort="home:complex"]'
    const values = await page.evaluate((sel) => Array.from(document.querySelector(sel).querySelectorAll('button')).map((b) => b.dataset.value), group)
    assert.deepEqual(values, ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(await page.getAttribute(group, 'role'), 'group')
    assert.ok((await page.getAttribute(group, 'aria-label')).length > 0, 'the group has an accessible name')
    await page.click(group + ' button[data-value="max"]')
    assert.deepEqual(await pressedValues(page, group), ['max'])
    assert.equal(await page.locator('select[data-model-router-effort]').count(), 0, 'no native select is left')
  } finally {
    await browser.close()
  }
})

test('0.6.29: an account that kept Haiku 4.5 on the simple tier shows its model with no effort control, since that model takes none', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const legacyTiers = { ...TIERS_ANTHROPIC, simple: { modelId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', supportsEffort: false } }
  const status = { targets: [{ target: 'home', mode: 'measure', effort: EFFORT_DEFAULTS, tiers: legacyTiers, steward: { mode: 'measure', threshold: 120000 } }], checkedAt: new Date().toISOString() }
  const { browser, page } = await openPanel({ modelRouterStatus: status })
  try {
    await page.click('#tab-models')
    const ask = await page.evaluate(() => {
      const tr = document.querySelector('[data-model-router-effort-table="home"] tbody tr')
      return { cells: Array.from(tr.cells).slice(0, 2).map((cell) => cell.innerText.trim()), buttons: tr.querySelectorAll('.mode-buttons button').length }
    })
    assert.deepEqual(ask.cells, ['Ask', 'Haiku 4.5'])
    assert.equal(ask.buttons, 0, 'no effort buttons for a model that takes none')
  } finally {
    await browser.close()
  }
})

test('0.6.2: saving an account\'s effort table sends that target\'s whole per-tier effort', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT })
  try {
    await page.click('#tab-models')
    await page.click('div[data-model-router-effort="home:complex"] button[data-value="xhigh"]')
    await page.click('button[data-model-router-effort-save="home"]')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.equal(request.target, 'home')
    assert.equal(request.mode, undefined)
    assert.deepEqual(request.effort, { ...EFFORT_DEFAULTS, complex: 'xhigh' })
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// The context steward (odd/tasks/jev-context-steward.md): per account, its
// mode and threshold, next to the router.
// ---------------------------------------------------------------------------

test('steward: each account shows the context steward mode and threshold next to the router', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT })
  try {
    await page.click('#tab-models')
    const rows = await page.evaluate(() => {
      const modes = ['off', 'measure', 'active']
      return Array.from(document.querySelectorAll('[data-steward-target]')).map((row) => ({
        target: row.getAttribute('data-steward-target'),
        mode: modes[Array.from(row.querySelector('.mode-buttons').querySelectorAll('button')).findIndex((b) => b.className === 'active')],
        threshold: row.querySelector('input[type=number]').value,
        text: row.innerText
      }))
    })
    assert.deepEqual(rows.map((r) => [r.target, r.mode, r.threshold]), [['home', 'measure', '120'], ['11112222-3333-4444-5555-666677778888', 'active', '150']])
    assert.match(rows[0].text, /Context steward/)
    const hint = await page.evaluate(() => document.querySelector('#model-router-section').innerText)
    assert.match(hint, /compact/i)
    assert.match(hint, /\/clear/)
  } finally {
    await browser.close()
  }
})

test('steward: saving sends that target\'s mode and threshold in tokens', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT })
  try {
    await page.click('#tab-models')
    // Click the third button (active mode) for steward
    await page.evaluate(() => document.querySelector('[data-steward-target="home"] .mode-buttons').querySelectorAll('button')[2].click())
    await page.fill('[data-steward-target="home"] input[type=number]', '100')
    await page.click('[data-steward-target="home"] .model-router-steward-save')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.equal(request.target, 'home')
    assert.equal(request.mode, undefined)
    assert.equal(request.effort, undefined)
    // 0.6.15 T4: the 400k soft tier's switch goes with them, measure unless changed.
    assert.deepEqual(request.steward, { mode: 'active', threshold: 100000, softMode: 'measure', coldMode: 'measure' })
  } finally {
    await browser.close()
  }
})

// 0.6.15 T4 (JEVADV-87): the 400k soft tier has its own switch, measure by
// default, in the same steward row; the hint names both limits.
test('steward: the 400k soft tier shows its own switch, measure by default, and saving sends it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = { ...MODEL_ROUTER_STATUS_EFFORT, targets: MODEL_ROUTER_STATUS_EFFORT.targets.map((target, at) => (at === 1 ? { ...target, steward: { ...target.steward, softMode: 'active' } } : target)) }
  const { browser, page } = await openPanel({ modelRouterStatus: status })
  try {
    await page.click('#tab-models')
    const soft = await page.evaluate(() => Array.from(document.querySelectorAll('[data-steward-target]')).map((row) => {
      const group = row.querySelector('[data-steward-soft]')
      const pressed = group === null ? null : Array.from(group.querySelectorAll('button')).find((b) => b.className === 'active')
      return { text: group === null ? '' : group.innerText, pressed: pressed === undefined || pressed === null ? null : pressed.getAttribute('data-value') }
    }))
    assert.deepEqual(soft.map((s) => s.pressed), ['measure', 'active'])
    assert.match(soft[0].text, /400k/)
    const hint = await page.evaluate(() => document.querySelector('#model-router-section').innerText)
    assert.match(hint, /600/)
    assert.match(hint, /400/)
    await page.evaluate(() => document.querySelector('[data-steward-target="home"] [data-steward-soft] button[data-value="active"]').click())
    await page.click('[data-steward-target="home"] .model-router-steward-save')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.deepEqual(request.steward, { mode: 'measure', threshold: 120000, softMode: 'active', coldMode: 'measure' })
  } finally {
    await browser.close()
  }
})

test('steward: a threshold out of range is refused in place and nothing is sent', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT })
  try {
    await page.click('#tab-models')
    await page.fill('[data-steward-target="home"] input[type=number]', '5')
    await page.click('[data-steward-target="home"] .model-router-steward-save')
    await page.waitForTimeout(500)
    const written = await page.evaluate(() => window.__written.modelRouterConfigRequest ?? null)
    assert.equal(written, null)
    const said = await page.evaluate(() => document.querySelector('[data-steward-target="home"] .said').innerText)
    assert.match(said, /10/)
  } finally {
    await browser.close()
  }
})

// 0.6.16 T2: the work kind at subagent spawn has its own switch per account,
// next to the router mode, measure by default.
test('0.6.16 T2: each account shows its work-kind switch, and saving sends only it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = { ...MODEL_ROUTER_STATUS_EFFORT, targets: MODEL_ROUTER_STATUS_EFFORT.targets.map((target, at) => ({ ...target, workKind: at === 1 ? 'active' : 'measure' })) }
  const { browser, page } = await openPanel({ modelRouterStatus: status })
  try {
    await page.click('#tab-models')
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-work-kind-target]')).map((row) => {
      const pressed = Array.from(row.querySelectorAll('.mode-buttons button')).find((b) => b.getAttribute('aria-pressed') === 'true')
      return { target: row.getAttribute('data-work-kind-target'), pressed: pressed ? pressed.getAttribute('data-value') : null, text: row.innerText }
    }))
    assert.deepEqual(rows.map((r) => [r.target, r.pressed]), [['home', 'measure'], ['11112222-3333-4444-5555-666677778888', 'active']])
    assert.match(rows[0].text, /work kind/i)
    const hint = await page.evaluate(() => document.querySelector('#model-router-section').innerText)
    assert.match(hint, /Sonnet 5/)
    await page.click('[data-work-kind-target="home"] button[data-value="active"]')
    await page.click('[data-work-kind-target="home"] .model-router-work-kind-save')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.deepEqual([request.target, request.workKind, request.mode, request.effort, request.steward], ['home', 'active', undefined, undefined, undefined])
  } finally {
    await browser.close()
  }
})

test('0.6.16 T2: the work-kind switch reads in Spanish', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = { ...MODEL_ROUTER_STATUS_EFFORT, targets: MODEL_ROUTER_STATUS_EFFORT.targets.map((target) => ({ ...target, workKind: 'measure' })) }
  const { browser, page } = await openPanel({ modelRouterStatus: status }, 'es')
  try {
    await page.click('#tab-models')
    const text = await page.evaluate(() => document.querySelector('[data-work-kind-target="home"]').innerText)
    assert.match(text, /tipo de trabajo/i)
    assert.match(text, /Medir/)
    assert.equal(await page.locator('[data-work-kind-target]').count(), 2)
  } finally {
    await browser.close()
  }
})

test('0.6.2: the catalog names its source once, not on every card', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready)
  try {
    await page.click('#tab-models')
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('#models-section a')).map((a) => ({ text: a.innerText.trim(), href: a.href, top: a.closest('#models-source-line') !== null })))
    assert.deepEqual(links, [{ text: 'Model data from Anthropic\'s models documentation', href: ANTHROPIC_MODELS_DOCS, top: true }])
  } finally {
    await browser.close()
  }
})

test('0.6.2: the Models intro says what the ladder, the switch and the table do, in both languages', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  for (const [locale, words] of [['en', [/ladder/, /available to the router/, /off, measure or active/, /effort each tier/i, /table/]], ['es', [/escalera/, /disponibles para el enrutador/, /apagado, medir o activo/, /esfuerzo/, /tabla/]]]) {
    const { browser, page } = await openPanel(SCENARIOS.ready, locale)
    try {
      await page.click('#tab-models')
      const intro = await page.evaluate(() => document.querySelector('#models-section .hint').innerText)
      for (const word of words) assert.match(intro, word, `${locale}: ${intro}`)
      assert.doesNotMatch(intro, / -- /)
      if (locale === 'es') assert.match(intro, /[áéíóú]/, 'Spanish copy keeps its accents')
    } finally {
      await browser.close()
    }
  }
})

test('0.6.2: the classic hook\'s checkbox is labelled as the legacy switch, not a second router switch', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready)
  try {
    await page.click('#tab-models')
    const text = await page.evaluate(() => document.getElementById('models-section').innerText)
    assert.doesNotMatch(text, /Let Jev rewrite the model \(active mode\)/)
    assert.match(text, /Legacy switch/)
    assert.match(text, /router is active/)
  } finally {
    await browser.close()
  }
})

for (const width of [1440, 390]) {
  test(`0.6.2: no two neighbouring controls touch on the Models tab with the effort tables at ${width}px`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const { browser, page } = await openPanel({ ...SCENARIOS.ready, modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT }, 'es', 'dark', { width, height: 1200 })
    try {
      await page.click('#tab-models')
      assert.deepEqual(await touchingControls(page), [])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `the page is ${overflow}px wider than the viewport`)
    } finally {
      await browser.close()
    }
  })
}

// ---------------------------------------------------------------------------
// 0.6.2 E7: the router rows name an account by its email, and never save
// over a mode that changed elsewhere since the rows were drawn.
// ---------------------------------------------------------------------------

const ROUTER_ACCOUNTS = {
  targets: [
    { target: 'home', mode: 'measure' },
    { target: 'bbbbbbbb-0000-4000-8000-000000000002', mode: 'measure', email: 'owner@example.com' },
    { target: 'cccccccc-0000-4000-8000-000000000003', mode: 'measure' }
  ],
  checkedAt: '2026-09-27T10:00:00.000Z'
}
const ROUTER_ACCOUNTS_ACTIVE = { ...ROUTER_ACCOUNTS, targets: ROUTER_ACCOUNTS.targets.map((target) => ({ ...target, mode: 'active' })) }

test('0.6.2 E7: an account row shows its email; one with no known email shows its short id; home stays "This computer"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: ROUTER_ACCOUNTS })
  try {
    await page.click('#tab-models')
    const labels = await page.evaluate(() => Array.from(document.querySelectorAll('#model-router-rows .router-target')).map((el) => ({ text: el.innerText.trim(), title: el.parentElement.getAttribute('title') })))
    assert.deepEqual(labels, [
      { text: 'This computer', title: 'home' },
      { text: 'owner@example.com', title: 'bbbbbbbb-0000-4000-8000-000000000002' },
      { text: 'Account cccccccc', title: 'cccccccc-0000-4000-8000-000000000003' }
    ])
  } finally {
    await browser.close()
  }
})

test('0.6.2 E7: opening the panel asks the worker for a fresh read and shows the real mode', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: ROUTER_ACCOUNTS, __routerRefreshSequence: [ROUTER_ACCOUNTS_ACTIVE] })
  try {
    await page.click('#tab-models')
    await page.waitForFunction(() => {
      const modes = Array.from(document.querySelectorAll('#model-router-rows .mode-buttons')).map((g) => Array.from(g.querySelectorAll('button')).findIndex((b) => b.className === 'active'))
      return modes[0] === 2 // 'active' is index 2
    }, undefined, { timeout: 10000 })
    const modes = await page.evaluate(() => {
      const modeNames = ['off', 'measure', 'active']
      return Array.from(document.querySelectorAll('#model-router-rows .mode-buttons')).map((g) => modeNames[Array.from(g.querySelectorAll('button')).findIndex((b) => b.className === 'active')])
    })
    assert.deepEqual(modes, ['active', 'active', 'active'])
  } finally {
    await browser.close()
  }
})

test('0.6.2 E7: a save over a mode that changed elsewhere writes nothing and shows the real mode', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: ROUTER_ACCOUNTS, __routerRefreshSequence: [ROUTER_ACCOUNTS, ROUTER_ACCOUNTS_ACTIVE] })
  try {
    await page.click('#tab-models')
    await page.waitForFunction(() => window.__routerRefreshCount === 1, undefined, { timeout: 10000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')[0].click())
    await page.click('#model-router-rows .checkbox-row:has(.mode-buttons[data-model-router-target="home"]) .model-router-save')
    await page.waitForFunction(() => {
      const modes = Array.from(document.querySelectorAll('#model-router-rows .mode-buttons')).map((g) => Array.from(g.querySelectorAll('button')).findIndex((b) => b.className === 'active'))
      return modes[0] === 2 // 'active' is index 2
    }, undefined, { timeout: 10000 })
    const written = await page.evaluate(() => window.__written.modelRouterConfigRequest ?? null)
    assert.equal(written, null, 'nothing may be written over a mode the row never showed')
    const text = await page.evaluate(() => document.getElementById('model-router-rows').innerText)
    assert.match(text, /changed outside this panel/)
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// 0.6.2 pre-release review: finding 5 and nit 6 on the router rows.
// ---------------------------------------------------------------------------

test('finding 5: a second save on the same row is not refused as "changed outside this panel"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const measure = ROUTER_ACCOUNTS
  const active = { ...ROUTER_ACCOUNTS, targets: ROUTER_ACCOUNTS.targets.map((t) => (t.target === 'home' ? { ...t, mode: 'active' } : t)) }
  const { browser, page } = await openPanel({ modelRouterStatus: measure, __routerRefreshSequence: [measure, measure, active, active, active] })
  try {
    await page.click('#tab-models')
    await page.waitForFunction(() => window.__routerRefreshCount === 1, undefined, { timeout: 10000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')[2].click())
    await page.click('#model-router-rows .checkbox-row:has(.mode-buttons[data-model-router-target="home"]) .model-router-save')
    await page.waitForFunction(() => window.__written.modelRouterConfigRequest?.mode === 'active', undefined, { timeout: 15000 })
    await page.waitForTimeout(2500)
    await page.evaluate(() => document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')[1].click())
    await page.click('#model-router-rows .checkbox-row:has(.mode-buttons[data-model-router-target="home"]) .model-router-save')
    await page.waitForFunction(() => window.__written.modelRouterConfigRequest?.mode === 'measure', undefined, { timeout: 15000 })
    const text = await page.evaluate(() => document.getElementById('model-router-rows').innerText)
    assert.doesNotMatch(text, /changed outside this panel/)
  } finally {
    await browser.close()
  }
})

test('nit 6: the on-open refresh never discards a choice the person already made', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: ROUTER_ACCOUNTS, __routerRefreshSequence: [ROUTER_ACCOUNTS_ACTIVE], __routerRefreshDelayMs: 2500 })
  try {
    await page.click('#tab-models')
    await page.evaluate(() => document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')[0].click())
    await page.waitForTimeout(4500)
    const modeIndex = await page.evaluate(() => Array.from(document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')).findIndex((b) => b.className === 'active'))
    assert.equal(modeIndex, 0, 'mode should remain "off"')
  } finally {
    await browser.close()
  }
})

test('nit 6: a status published without the request id but newer than the request still answers a save', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: ROUTER_ACCOUNTS, __routerRefreshWithoutId: true })
  try {
    await page.click('#tab-models')
    await page.evaluate(() => document.querySelector('.mode-buttons[data-model-router-target="home"]').querySelectorAll('button')[2].click())
    await page.click('#model-router-rows .checkbox-row:has(.mode-buttons[data-model-router-target="home"]) .model-router-save')
    await page.waitForFunction(() => window.__written.modelRouterConfigRequest?.mode === 'active', undefined, { timeout: 8000 })
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-leftovers.md L2 -- `skills-ready` is the first scenario
// whose skills mod has recorded decisions, built by running the real
// read-measurements.mjs over a synthetic mod-skills-measurements.jsonl (see
// screenshot-panels.mjs).
//
// JEVADV-63 removed the old flat "By project (whole log)" bar list this
// scenario used to also exercise (measurementsSummary.gate.byProject /
// .modSkills.byProject joined into one #projects-body .hrow list) -- the
// Activity tab's project cards below are fed by their own storage key,
// activityByProjectSummary, not by measurementsSummary at all.
// ---------------------------------------------------------------------------

test('skills-ready: the Skills tab shows what the mod recorded, not its empty sentence', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['skills-ready']
  assert.ok(scenario, 'screenshot-panels.mjs has no skills-ready scenario')
  const mod = scenario.measurementsSummary.modSkills
  assert.ok(mod.totalDecisions > 0 && mod.comparableCount > 0, 'the fixture must hold decisions the aggregator could compare')
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    await page.click('#tab-skills')
    const text = await page.evaluate(() => document.getElementById('skills-body').innerText)
    assert.doesNotMatch(text, /has not recorded any decision yet/)
    assert.match(text, /Skills suggested/)
    assert.match(text, /Listing characters not sent/)
    // W4 #11: below the readiness threshold, counts rather than a percentage.
    assert.match(text, new RegExp(`${mod.windows.day.matchedCount} of ${mod.windows.day.comparableCount} comparable prompts`))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// K0c (odd/tasks/typing-lead-time.md) -- the Skills card's "Typing before
// send" line, from consumptionSummary.typing (read-consumption.mjs's 7-day
// summary of the mod's typing-*.jsonl). `skills-ready` carries it, summarized
// by the real summarizeTypingLeadTime. No summary, no line: never a zero.
// ---------------------------------------------------------------------------

async function skillsCardText (page) {
  await page.click('#tab-skills')
  return page.evaluate(() => document.getElementById('card-skills').innerText)
}

test('K0c skills-ready: the Skills card shows the typing lead time line (en)', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['skills-ready']
  const typing = scenario.consumptionSummary?.typing?.windows?.day
  assert.ok(typing && typing.typed > 0 && typing.injected > 0, 'skills-ready must carry typed and injected prompts in its 24 h window')
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    const text = await skillsCardText(page)
    const seconds = (value) => (Math.round(value / 100) / 10).toLocaleString('en')
    assert.match(text, new RegExp(`Typing before send: p50 ${seconds(typing.p50Ms)} s · p90 ${seconds(typing.p90Ms)} s · ${typing.typed} typed prompts · ${typing.injected} injected`))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('K0c skills-ready: the typing lead time line in Spanish', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['skills-ready']
  const typing = scenario.consumptionSummary.typing.windows.day
  const { browser, page, errors } = await openBoardPanel(scenario, 'es')
  try {
    const text = await skillsCardText(page)
    assert.match(text, new RegExp(`Escritura antes de enviar: p50 .+ s · p90 .+ s · ${typing.typed} prompts escritos · ${typing.injected} inyectados`))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('K0c with no typing summary the Skills card has no typing line, not a zero', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  for (const consumptionSummary of [{ ...POPULATED_CONSUMPTION, typing: null }, POPULATED_CONSUMPTION, undefined]) {
    const scenario = { ...SCENARIOS['skills-ready'], consumptionSummary }
    const { browser, page, errors } = await openBoardPanel(scenario)
    try {
      const text = await skillsCardText(page)
      assert.doesNotMatch(text, /Typing before send/)
      assert.match(text, /Skills suggested/, 'the rest of the card is unchanged')
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
})

test('K0c only injected prompts: the line says no prompt was typed, never p50 0 s', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: { ...POPULATED_CONSUMPTION, typing: windowed({ typed: 0, injected: 4, p50Ms: null, p90Ms: null }) } })
  try {
    const text = await skillsCardText(page)
    assert.match(text, /Typing before send: no typed prompts yet · 4 injected/)
    assert.doesNotMatch(text, /p50/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-leftovers.md L3 -- the board's last tab, remembered where
// it can be inside Orca. Orca's sandboxed iframe throws on `localStorage`, so
// the tab also goes through the host storage bridge (storage.get/storage.set,
// the channel config.html already uses). localStorage stays as the fallback a
// plain browser uses. The board keeps its tab panels hidden until the stored
// tab is known, or 300 ms at most, so nobody sees the wrong tab first.
// ---------------------------------------------------------------------------

const BOARD_TAB_STORAGE_KEY = 'jevAdvisor.boardPanel.activeTab'

/** Installed before the board's script: from the first frame on, records
 *  each change in which tab-panel is really on screen (not `hidden` and not
 *  `visibility: hidden`), with its time, into `window.__shownPanels`. */
function recordShownPanels () {
  window.__shownPanels = []
  const tick = () => {
    const shown = Array.from(document.querySelectorAll('[role=tabpanel]'))
      .filter((panel) => !panel.hidden && getComputedStyle(panel).visibility === 'visible')
      .map((panel) => panel.id.replace(/^panel-/, ''))
    const key = shown.length > 0 ? shown.join(',') : '(none)'
    const last = window.__shownPanels[window.__shownPanels.length - 1]
    if (!last || last.key !== key) window.__shownPanels.push({ key, at: performance.now() })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** A host that receives the board's requests and never answers one. */
function silentHostBridge () {
  window.__written = {}
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (msg && msg.type === 'orca-panel-action' && msg.action === 'storage.set') window.__written[msg.params?.key] = msg.params?.value
  })
}

/** openBoardPanel's shape, plus: `localTab` pre-seeds localStorage, and
 *  `silent` swaps the answering host for one that never answers. */
async function openBoardForTabMemory (storage, { localTab = null, silent = false, settleMs = SETTLE_MS } = {}) {
  const context = await (await sharedBrowser()).newContext({ viewport: { width: 1440, height: 1200 }, colorScheme: 'light', locale: 'en-US' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message)))
  await page.addInitScript(recordShownPanels)
  if (silent) await page.addInitScript(silentHostBridge)
  else await page.addInitScript(hostBridge, storage)
  if (localTab !== null) {
    await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value) }, [BOARD_TAB_STORAGE_KEY, localTab])
  }
  await page.goto(`file://${await renderBoardPanel()}`)
  await page.waitForTimeout(settleMs)
  return { browser: context, page, errors }
}

function firstShown (timeline) {
  const entry = timeline.find((e) => e.key !== '(none)')
  return entry ? entry.key : null
}

test('L3: clicking a board tab stores it through the host storage bridge, and opening the board stores nothing', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardForTabMemory(SCENARIOS.ready)
  try {
    assert.equal(await page.evaluate((key) => window.__written[key], BOARD_TAB_STORAGE_KEY), undefined,
      'restoring the tab on open must not overwrite what the host holds')
    await page.click('#tab-consumption')
    await page.waitForFunction((key) => window.__written[key] !== undefined, BOARD_TAB_STORAGE_KEY, { timeout: 3000 })
    assert.equal(await page.evaluate((key) => window.__written[key], BOARD_TAB_STORAGE_KEY), 'consumption')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L3: a board whose host storage holds `activity` opens on Activity with localStorage empty, never showing Gate first', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardForTabMemory({ ...SCENARIOS.ready, [BOARD_TAB_STORAGE_KEY]: 'activity' })
  try {
    const state = await boardTabState(page)
    assert.deepEqual({ selected: state.selected, visible: state.visible }, { selected: ['activity'], visible: ['activity'] })
    const timeline = await page.evaluate(() => window.__shownPanels)
    assert.equal(firstShown(timeline), 'activity', `the first tab on screen was not Activity: ${JSON.stringify(timeline)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L3: the host\'s stored tab wins over localStorage, with no flash of the localStorage tab', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardForTabMemory({ ...SCENARIOS.ready, [BOARD_TAB_STORAGE_KEY]: 'activity' }, { localTab: 'skills' })
  try {
    assert.deepEqual((await boardTabState(page)).visible, ['activity'])
    const timeline = await page.evaluate(() => window.__shownPanels)
    assert.equal(firstShown(timeline), 'activity', `a tab other than the stored one showed first: ${JSON.stringify(timeline)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L3: a host that never answers still gets the board on screen within the 300 ms bound, on the localStorage tab', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardForTabMemory({}, { localTab: 'skills', silent: true, settleMs: 0 })
  try {
    await page.waitForFunction(() => window.__shownPanels.some((e) => e.key !== '(none)'), undefined, { timeout: 2000 })
    const timeline = await page.evaluate(() => window.__shownPanels)
    const shown = timeline.find((e) => e.key !== '(none)')
    assert.equal(shown.key, 'skills')
    const waited = shown.at - timeline[0].at
    // It waits for the host (so no wrong tab can flash), but never longer
    // than the bound; the slack is for a slow machine, not a looser bound.
    assert.ok(waited >= 150, `the panels showed after ${Math.round(waited)} ms, without waiting for the host at all: ${JSON.stringify(timeline)}`)
    assert.ok(waited <= 800, `the panels took ${Math.round(waited)} ms to show with a silent host: ${JSON.stringify(timeline)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L3: a host that never answers and an empty localStorage open the board on Gate', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardForTabMemory({}, { silent: true, settleMs: 0 })
  try {
    await page.waitForFunction(() => window.__shownPanels.some((e) => e.key !== '(none)'), undefined, { timeout: 2000 })
    assert.equal(firstShown(await page.evaluate(() => window.__shownPanels)), 'gate')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// JEVADV-63 removed this test's whole premise along with it: the old
// "By project" list merged the gate's and the skills mod's byProject rows
// (measurementsSummary.gate.byProject / .modSkills.byProject) into one flat
// bar list, keyed by projectLabel(). The Activity tab's project cards read
// activityByProjectSummary instead -- a different storage key, a different
// shape, never a merge of those two logs -- so there is nothing left here
// for an "(unknown)" skills-mod project to be merged with. The unknown-
// project label itself is still covered directly (see "activity: project:
// null renders as the unknown-project label" below).

test('the screenshot harness imports whenever playwright does, so a broken fixture fails instead of skipping', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // Re-importing rethrows the harness's own load error, if any, so the
  // failure names the cause rather than "SCENARIOS is null".
  const imported = await import('./screenshot-panels.mjs')
  assert.ok(imported.SCENARIOS && SCENARIOS, 'screenshot-panels.mjs loaded but this file saw no SCENARIOS')
})

// ---------------------------------------------------------------------------
// odd/tasks/board-leftovers.md L5 -- the Skills card drew "Skills suggested"
// (a count of prompts) and "Listing characters not sent" (characters) as
// bars on one shared scale, so 14 was an empty sliver beside a full bar, a
// comparison between two units that means nothing. At 390 and 320 both
// labels were also cut ("Skills suggest...", "Listing chara..."). Each
// figure is now a labelled number, and its label wraps instead of cutting.
// ---------------------------------------------------------------------------

async function skillsCardFigures (page) {
  await page.click('#tab-skills')
  return page.evaluate(() => {
    const body = document.getElementById('skills-body')
    const cut = Array.from(body.querySelectorAll('*')).filter((node) => {
      const style = getComputedStyle(node)
      return node.childElementCount === 0 && node.textContent.trim() !== '' &&
        (node.scrollWidth > node.clientWidth + 1 || (style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap'))
    }).map((node) => node.textContent.trim())
    return {
      text: body.innerText,
      bars: body.querySelectorAll('.htrack, .hfill, .bar, .cmp-track').length,
      cut
    }
  })
}

test('L5: skills-ready\'s Skills card shows each figure as a labelled number, with no bar', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['skills-ready']
  const mod = scenario.measurementsSummary.modSkills
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    const card = await skillsCardFigures(page)
    assert.equal(card.bars, 0, 'two figures in different units must not share one bar scale')
    assert.match(card.text, /Skills suggested/)
    assert.match(card.text, new RegExp(String(mod.suggestedCount)))
    assert.match(card.text, /Listing characters not sent/)
    assert.match(card.text, new RegExp(mod.listingCharsTotal.toLocaleString('en-US')))
    assert.match(card.text, /Measurement-mode match rate: 8 of 9 comparable prompts/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const locale of ['en', 'es']) {
  test(`L5: no Skills card label is cut at 320px (${locale})`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openBoardPanel(SCENARIOS['skills-ready'], locale, 'light', { viewport: { width: 320, height: 900 } })
    try {
      const card = await skillsCardFigures(page)
      assert.deepEqual(card.cut, [], `labels cut at 320px: ${JSON.stringify(card.cut)}`)
      const labels = locale === 'es'
        ? ['Skills sugeridas', 'Caracteres de listado no enviados', 'Acierto en modo medición']
        : ['Skills suggested', 'Listing characters not sent', 'Measurement-mode match rate']
      for (const label of labels) assert.ok(card.text.replace(/\s+/g, ' ').includes(label), `"${label}" is not shown whole in ${JSON.stringify(card.text)}`)
      const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
      assert.ok(size.scroll <= size.client, `the page is ${size.scroll}px in ${size.client}px`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('L5: a skills mod with nothing recorded still shows only its empty sentence', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(SCENARIOS.ready)
  try {
    const card = await skillsCardFigures(page)
    assert.equal(card.text.trim(), 'The skills mod has not recorded any decision yet.')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// odd/tasks/board-leftovers.md L6 -- the owner's live panel, 63 agents: the
// Live status list ran oldest first within each status, showed "working" for
// rows three days silent, and repeated one project and branch more than ten
// times. The board now lists one row per project and branch, newest first,
// with that group's latest state and a session count; a working or waiting
// row silent for over an hour reads "no signal"; and rows last seen over
// 24 h ago sit behind a "show more" toggle. Timestamps are explicit, relative
// to the moment each test builds its fixture.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

function liveEntry (fields, ageMs) {
  return {
    worktreeId: null, project: null, projectName: null, rama: null, paneKey: `pane-${Math.random().toString(36).slice(2)}`,
    state: 'done', receivedAt: Date.now() - ageMs, updatedAt: new Date(Date.now() - ageMs).toISOString(), ...fields
  }
}

async function liveList (page) {
  return page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('#cards .live-row')).map((row) => ({
      name: row.querySelector('.name').textContent,
      branch: row.querySelector('.tag.branch')?.textContent ?? null,
      state: row.querySelector('.tag.state')?.textContent ?? null,
      stateClass: row.querySelector('.tag.state')?.className ?? null,
      count: row.querySelector('.count:not(.branches)')?.textContent ?? null,
      when: row.querySelector('.when')?.textContent ?? null,
      text: row.innerText,
      title: row.title
    })),
    toggle: (() => {
      const button = document.querySelector('#cards button[data-live-toggle]')
      return button ? { text: button.textContent, expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls') } : null
    })(),
    text: document.getElementById('cards').innerText
  }))
}

test('L6: live rows run newest first overall, never grouped by status', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const board = {
    entries: [
      liveEntry({ worktreeId: 'wt-a', projectName: 'alpha', project: 'github:example/alpha', rama: 'main', state: 'working' }, 50 * MINUTE_MS),
      liveEntry({ worktreeId: 'wt-b', projectName: 'bravo', project: 'github:example/bravo', rama: 'main', state: 'done' }, 2 * MINUTE_MS),
      liveEntry({ worktreeId: 'wt-c', projectName: 'charlie', project: 'github:example/charlie', rama: 'main', state: 'working' }, 20 * MINUTE_MS),
      liveEntry({ worktreeId: 'wt-d', projectName: 'delta', project: 'github:example/delta', rama: 'main', state: 'done' }, 35 * MINUTE_MS)
    ]
  }
  const { browser, page, errors } = await openBoardPanel({ board })
  try {
    const { rows } = await liveList(page)
    assert.deepEqual(rows.map((row) => row.name), ['bravo', 'charlie', 'delta', 'alpha'])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// odd/tasks/board-global-window.md W6 (#14): one row per project now -- a
// second branch of the same project made the owner read it twice. The row
// shows the latest branch and counts the others.
test('L6 + W6: one row per project, with its latest state, branch, last-seen time, session count and other branches counted', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = []
  for (let i = 0; i < 12; i += 1) {
    entries.push(liveEntry({ worktreeId: `wt-project-a-${i}`, projectName: 'project-a', project: 'github:example/project-a', rama: 'main', state: i === 0 ? 'working' : 'done', paneKey: `pane-project-a-${i}` }, (5 + i * 30) * MINUTE_MS))
  }
  entries.push(liveEntry({ worktreeId: 'wt-project-a-feat', projectName: 'project-a', project: 'github:example/project-a', rama: 'feat/x', state: 'done' }, 90 * MINUTE_MS))
  const { browser, page, errors } = await openBoardPanel({ board: { entries } })
  try {
    const { rows } = await liveList(page)
    const projectA = rows.filter((row) => row.name === 'project-a')
    assert.equal(projectA.length, 1, `expected one project-a row: ${JSON.stringify(rows)}`)
    assert.equal(projectA[0].branch, 'main', 'the latest entry\'s branch')
    assert.equal(projectA[0].state, 'working', 'the group shows its latest entry\'s state')
    assert.equal(projectA[0].when, '5 min ago', 'the group shows its latest entry\'s time')
    assert.equal(projectA[0].count, '×13 sessions')
    assert.match(projectA[0].text, /\+1 branch/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: rows with no project name never merge: each keeps its own worktree, or its own pane when it has none', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = [
    liveEntry({ worktreeId: null, paneKey: 'pane-n1' }, 3 * MINUTE_MS),
    liveEntry({ worktreeId: null, paneKey: 'pane-n2' }, 4 * MINUTE_MS),
    liveEntry({ worktreeId: 'global-floating-terminal', paneKey: 'pane-f1', state: 'working' }, 5 * MINUTE_MS),
    liveEntry({ worktreeId: 'global-floating-terminal', paneKey: 'pane-f2', state: 'working' }, 6 * MINUTE_MS),
    liveEntry({ worktreeId: 'wt-gone-1', paneKey: 'pane-g1' }, 7 * MINUTE_MS),
    liveEntry({ worktreeId: 'wt-gone-2', paneKey: 'pane-g2' }, 8 * MINUTE_MS),
    // Two sessions in the same unnamed worktree are the same place: one row.
    liveEntry({ worktreeId: 'wt-gone-1', paneKey: 'pane-g1b' }, 9 * MINUTE_MS)
  ]
  const { browser, page, errors } = await openBoardPanel({ board: { entries } })
  try {
    const { rows } = await liveList(page)
    assert.deepEqual(rows.map((row) => row.title.split(' · ').pop()), ['pane-n1', 'pane-n2', 'pane-f1', 'pane-f2', 'pane-g1', 'pane-g2'])
    assert.deepEqual(rows.map((row) => row.count), [null, null, null, null, '×2 sessions', null])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: a working or waiting row silent for over an hour reads "no signal", muted; done stays done', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = [
    liveEntry({ worktreeId: 'wt-1', projectName: 'fresh-work', rama: 'main', state: 'working' }, 10 * MINUTE_MS),
    liveEntry({ worktreeId: 'wt-2', projectName: 'waiting-long', rama: 'main', state: 'waiting' }, 2 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-3', projectName: 'old-done', rama: 'main', state: 'done' }, 3 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-4', projectName: 'stuck-work', rama: 'main', state: 'working' }, 5 * HOUR_MS)
  ]
  const { browser, page, errors } = await openBoardPanel({ board: { entries } })
  try {
    const { rows } = await liveList(page)
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
    assert.equal(byName['fresh-work'].state, 'working')
    assert.equal(byName['waiting-long'].state, 'no signal')
    assert.equal(byName['stuck-work'].state, 'no signal')
    assert.equal(byName['old-done'].state, 'done')
    assert.match(byName['stuck-work'].stateClass, /\bnosignal\b/)
    const styles = await page.evaluate(() => {
      const quiet = document.querySelector('#cards .tag.state.nosignal')
      const when = document.querySelector('#cards .when')
      return { quiet: getComputedStyle(quiet).color, weight: getComputedStyle(quiet).fontWeight, muted: getComputedStyle(when).color }
    })
    assert.equal(styles.quiet, styles.muted, 'no signal is drawn in the muted colour')
    assert.notEqual(styles.weight, '600', 'no signal must not look like working\'s bold')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: groups last seen over 24 h ago wait behind "show more (N)", which expands and collapses with aria-expanded', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = [
    liveEntry({ worktreeId: 'wt-1', projectName: 'today-1', rama: 'main' }, 1 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-2', projectName: 'today-2', rama: 'main' }, 5 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-3', projectName: 'today-3', rama: 'main' }, 23 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-4', projectName: 'old-1', rama: 'main', state: 'working' }, 30 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-5', projectName: 'old-2', rama: 'main' }, 72 * HOUR_MS)
  ]
  const { browser, page, errors } = await openBoardPanel({ board: { entries } })
  try {
    let list = await liveList(page)
    assert.deepEqual(list.rows.map((row) => row.name), ['today-1', 'today-2', 'today-3'])
    assert.deepEqual({ text: list.toggle?.text, expanded: list.toggle?.expanded }, { text: 'show more (2)', expanded: 'false' })
    assert.ok(list.toggle.controls && await page.evaluate((id) => !!document.getElementById(id), list.toggle.controls), 'aria-controls must name a real element')
    await page.click('#tab-activity')
    await page.click('#cards button[data-live-toggle]')
    list = await liveList(page)
    assert.deepEqual(list.rows.map((row) => row.name), ['today-1', 'today-2', 'today-3', 'old-1', 'old-2'])
    assert.deepEqual({ text: list.toggle?.text, expanded: list.toggle?.expanded }, { text: 'show less', expanded: 'true' })
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-live-toggle')), true, 'focus stays on the toggle after it re-renders')
    await page.click('#cards button[data-live-toggle]')
    list = await liveList(page)
    assert.equal(list.rows.length, 3)
    assert.equal(list.toggle?.expanded, 'false')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: when nothing was seen in 24 h, one line says so, with the toggle for the rest', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = [
    liveEntry({ worktreeId: 'wt-4', projectName: 'old-1', rama: 'main' }, 30 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-5', projectName: 'old-2', rama: 'main' }, 72 * HOUR_MS)
  ]
  const { browser, page, errors } = await openBoardPanel({ board: { entries } })
  try {
    const list = await liveList(page)
    assert.equal(list.rows.length, 0)
    assert.match(list.text, /Nothing seen in the last 24 h\./)
    assert.equal(list.toggle?.text, 'show more (2)')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: the live-status copy is Spanish with its accents, and no " -- " in either language', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const entries = [
    liveEntry({ worktreeId: 'wt-1', projectName: 'project-a', rama: 'main', state: 'working' }, 3 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-2', projectName: 'project-a', rama: 'main' }, 4 * HOUR_MS),
    liveEntry({ worktreeId: 'wt-3', projectName: 'old', rama: 'main' }, 40 * HOUR_MS)
  ]
  const { browser, page, errors } = await openBoardPanel({ board: { entries } }, 'es')
  try {
    let list = await liveList(page)
    assert.equal(list.rows[0].state, 'sin señal')
    assert.equal(list.rows[0].count, '×2 sesiones')
    assert.equal(list.toggle?.text, 'ver más (1)')
    await page.click('#tab-activity')
    await page.click('#cards button[data-live-toggle]')
    list = await liveList(page)
    assert.equal(list.toggle?.text, 'ver menos')
    const catalog = await page.evaluate(() => window.CATALOG)
    const liveKeys = (lang) => Object.keys(catalog[lang]).filter((key) => key.indexOf('live.') === 0).sort()
    assert.deepEqual(liveKeys('es'), liveKeys('en'))
    for (const lang of ['es', 'en']) {
      for (const key of liveKeys(lang)) assert.doesNotMatch(catalog[lang][key], / -- /, `${lang} ${key}`)
    }
    assert.match(catalog.es['live.none24h'], /últimas/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('L6: live-busy shows project-a/main once with its twelve sessions, and keeps the three-day-old "working" behind show more', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['live-busy']
  assert.ok(scenario, 'screenshot-panels.mjs has no live-busy scenario')
  const { browser, page, errors } = await openBoardPanel(scenario)
  try {
    let list = await liveList(page)
    const projectA = list.rows.filter((row) => row.name === 'project-a')
    assert.deepEqual(projectA.map((row) => [row.branch, row.state, row.count]), [['main', 'working', '×12 sessions']])
    assert.equal(list.rows.some((row) => row.name === 'client-site-a-orchestrator'), false)
    assert.equal(list.toggle?.text, 'show more (3)')
    await page.click('#tab-activity')
    await page.click('#cards button[data-live-toggle]')
    list = await liveList(page)
    assert.equal(list.rows.find((row) => row.name === 'client-site-a-orchestrator')?.state, 'no signal')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// JEVADV-63, odd/tasks/board-global-window.md W1 -- the Activity tab's
// per-project list. `activityByProjectSummary` (src/core/activity_by_project.ts,
// adapters/orca/read-activity.mjs): {ok, windows: {day, week, version, all},
// corruptLines, checkedAt}; each window {available, sinceMs, coverageSinceMs,
// projects (already ranked by the reader: dearest first -- NEVER re-sorted by
// the panel), rest, totals}. Or {ok:false, reason, detail, checkedAt}.
// ---------------------------------------------------------------------------

/** One ProjectActivity row (aggregateActivityForWindow's own shape), with
 *  zero defaults so a test only names the fields it cares about. */
function activityProject (fields = {}) {
  return {
    project: null,
    lastActivityAt: new Date().toISOString(),
    judged: 0,
    gateOutcomes: { allowed: 0, advised: 0, asked: 0, blocked: 0 },
    steps: { main: 0, subagent: 0 },
    tokens: 0,
    estimatedCostUsd: 0,
    models: [],
    router: null,
    ...fields
  }
}
function activityWindow (projects, rest = null) {
  const sum = (pick) => projects.reduce((acc, p) => acc + pick(p), 0)
  return {
    projects,
    rest,
    totals: {
      projects: projects.length + (rest ? rest.projects : 0),
      judged: sum((p) => p.judged),
      steps: sum((p) => p.steps.main + p.steps.subagent),
      tokens: sum((p) => p.tokens),
      estimatedCostUsd: sum((p) => p.estimatedCostUsd),
      routerSavedEstimate: null
    }
  }
}
function activitySummary (projects, byKey = {}) {
  return { activityByProjectSummary: { ok: true, ...windowed(activityWindow(projects), byKey), corruptLines: 0, checkedAt: new Date().toISOString() } }
}

/** The list and its toggle, read without touching the tab. */
async function activityCardsState (page) {
  return page.evaluate(() => ({
    names: Array.from(document.querySelectorAll('#projects-body .act-row .act-name')).map((el) => el.textContent),
    toggle: (() => {
      const button = document.querySelector('#projects-body button[data-activity-toggle]')
      return button ? { text: button.textContent, expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls') } : null
    })()
  }))
}
async function activityCards (page) {
  await page.click('#tab-activity')
  return activityCardsState(page)
}

/** One project's row, found by its visible name. */
async function activityCardDetail (page, name) {
  await page.click('#tab-activity')
  return page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll('#projects-body .act-row'))
      .find((c) => c.querySelector('.act-name').textContent === name)
    if (!row) return null
    const blocked = row.querySelector('.act-sub .vd')
    return {
      cost: row.querySelector('.act-cost')?.textContent ?? null,
      blockedColor: blocked ? getComputedStyle(blocked).color : null,
      textColor: getComputedStyle(row.querySelector('.act-sub')).color,
      text: row.innerText
    }
  }, name)
}

test('activity: rows render the top 6 projects in the reader\'s own ranked order, never re-sorted', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const names = ['zulu', 'alpha', 'mike', 'bravo', 'yankee', 'charlie', 'delta', 'echo']
  const projects = names.map((project) => activityProject({ project }))
  const { browser, page, errors } = await openBoardPanel(activitySummary(projects))
  try {
    const { names: shown, toggle } = await activityCards(page)
    assert.deepEqual(shown, names.slice(0, 6), 'top 6 must keep the array\'s own order, not be alphabetised or otherwise resorted')
    assert.deepEqual({ text: toggle?.text, expanded: toggle?.expanded }, { text: 'show more (2)', expanded: 'false' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: the show-more toggle reveals the rest, aria-expanded toggles, and focus returns to the button', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const projects = Array.from({ length: 9 }, (_, i) => activityProject({ project: `p${i}` }))
  const { browser, page, errors } = await openBoardPanel(activitySummary(projects))
  try {
    let state = await activityCards(page)
    assert.equal(state.names.length, 6)
    assert.deepEqual({ text: state.toggle?.text, expanded: state.toggle?.expanded }, { text: 'show more (3)', expanded: 'false' })
    assert.ok(state.toggle.controls && await page.evaluate((id) => !!document.getElementById(id), state.toggle.controls), 'aria-controls must name a real element')

    await page.click('#projects-body button[data-activity-toggle]')
    state = await activityCardsState(page)
    assert.equal(state.names.length, 9)
    assert.deepEqual({ text: state.toggle?.text, expanded: state.toggle?.expanded }, { text: 'show less', expanded: 'true' })
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-activity-toggle')), true, 'focus stays on the toggle after it re-renders')

    await page.click('#projects-body button[data-activity-toggle]')
    state = await activityCardsState(page)
    assert.equal(state.names.length, 6)
    assert.equal(state.toggle?.expanded, 'false')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: no projects renders the honest empty sentence, not a blank section', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(activitySummary([]))
  try {
    await page.click('#tab-activity')
    const text = await page.evaluate(() => document.getElementById('card-projects').innerText)
    assert.match(text, /no activity yet/i)
    const rowCount = await page.evaluate(() => document.querySelectorAll('#projects-body .act-row').length)
    assert.equal(rowCount, 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('an {ok:false} activityByProjectSummary renders as a failure, never as "no activity yet"', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel({
    activityByProjectSummary: { ok: false, reason: 'exception', detail: 'boom', checkedAt: new Date().toISOString() }
  })
  try {
    await page.click('#tab-activity')
    const text = await page.evaluate(() => document.getElementById('card-projects').innerText)
    assert.notEqual(text.trim(), '', 'a failure must never render as a blank card')
    assert.doesNotMatch(text, /no activity yet/i, 'an ok:false summary must not read as the honest empty state')
    assert.match(text, /could not be calculated/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: project: null renders as the unknown-project label, never blank', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openBoardPanel(activitySummary([activityProject({ project: null })]))
  try {
    const { names } = await activityCards(page)
    assert.deepEqual(names, ['(unknown project)'])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: a populated row shows its labelled cost, counts with asked and blocked, tokens and its dearest models', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const project = activityProject({
    project: 'alpha',
    judged: 14,
    gateOutcomes: { allowed: 10, advised: 2, asked: 1, blocked: 1 },
    steps: { main: 2, subagent: 1 },
    tokens: 6500,
    estimatedCostUsd: 1.23,
    models: [{ model: 'claude-sonnet-5', steps: 3, estimatedCostUsd: 1.23 }]
  })
  const { browser, page, errors } = await openBoardPanel({ ...activitySummary([project]), models: BOARD_MODELS })
  try {
    const detail = await activityCardDetail(page, 'alpha')
    assert.ok(detail, 'expected a row for "alpha"')
    assert.match(detail.cost, /\$1\.23/)
    assert.match(detail.cost, /estimated cost/)
    assert.match(detail.text, /14 judged commands \(1 asked · 1 blocked\)/)
    assert.match(detail.text, /3 steps/)
    assert.match(detail.text, /6,500 tokens/)
    assert.match(detail.text, /Sonnet 5 \$1\.23/)
    assert.notEqual(detail.blockedColor, detail.textColor, 'a nonzero blocked count takes the destructive colour')
    assert.doesNotMatch(detail.text, /switch/i, 'router: null must omit the router line entirely')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: a positive router estimate reads "saved", a negative one reads "extra cost" -- never a negative number', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const saving = activityProject({ project: 'saver', router: { applied: 3, savedEstimate: 0.42 } })
  const costly = activityProject({ project: 'spender', router: { applied: 2, savedEstimate: -0.15 } })
  const { browser, page, errors } = await openBoardPanel(activitySummary([saving, costly]))
  try {
    const savingDetail = await activityCardDetail(page, 'saver')
    assert.match(savingDetail.text, /3 model switch/)
    assert.match(savingDetail.text, /\$0\.42 saved/)

    const costlyDetail = await activityCardDetail(page, 'spender')
    assert.match(costlyDetail.text, /2 model switch/)
    assert.match(costlyDetail.text, /extra cost/i)
    assert.match(costlyDetail.text, /\$0\.15/)
    assert.doesNotMatch(costlyDetail.text, /-0\.15/, 'a negative estimate must never be printed as a negative number')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: a project with no cost shows no cost and no model line, never a lone $0.00', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const project = activityProject({ project: 'no-tokens', judged: 3, gateOutcomes: { allowed: 3, advised: 0, asked: 0, blocked: 0 } })
  const { browser, page, errors } = await openBoardPanel(activitySummary([project]))
  try {
    const detail = await activityCardDetail(page, 'no-tokens')
    assert.equal(detail.cost, null)
    assert.doesNotMatch(detail.text, /\$0\.00|By model/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity: the total line sums the window, and a count of one reads singular, in both languages', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const project = activityProject({ project: 'single', judged: 1, gateOutcomes: { allowed: 1, advised: 0, asked: 0, blocked: 0 }, steps: { main: 1, subagent: 0 }, estimatedCostUsd: 0.5, models: [{ model: 'x', steps: 1, estimatedCostUsd: 0.5 }] })
  for (const [locale, judged, steps, total] of [['en', '1 judged command', '1 step', /Total: \$0\.50 estimated at list prices across 1 project/], ['es', '1 comando juzgado', '1 paso', /Total: 0,50\s?US\$ estimado a precio de lista en 1 proyecto/]]) {
    const { browser, page, errors } = await openBoardPanel(activitySummary([project]), locale)
    try {
      const detail = await activityCardDetail(page, 'single')
      assert.ok(detail.text.includes(`${judged} · ${steps}`), `${locale}: expected "${judged} · ${steps}" in ${JSON.stringify(detail.text)}`)
      const card = await page.evaluate(() => document.getElementById('card-projects').innerText)
      assert.match(card, total)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
})

test('activity: the projects past the ones the reader names are one row, never dropped from the total', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const projects = [activityProject({ project: 'named', judged: 2 })]
  const summary = { activityByProjectSummary: { ok: true, ...windowed(activityWindow(projects, { projects: 30, judged: 40, steps: 12, tokens: 0, estimatedCostUsd: 3.5 })), corruptLines: 0, checkedAt: new Date().toISOString() } }
  const { browser, page, errors } = await openBoardPanel(summary)
  try {
    await page.click('#tab-activity')
    const text = await page.evaluate(() => document.getElementById('card-projects').innerText)
    assert.match(text, /30 more project\(s\): \$3\.50 · 40 judged commands · 12 steps/)
    assert.match(text, /across 31 project/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('activity-ready: no two neighbouring controls touch on the Activity tab, including the show-more toggle', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const scenario = SCENARIOS['activity-ready']
  assert.ok(scenario, 'screenshot-panels.mjs has no activity-ready scenario')
  const { browser, page, errors } = await openBoardPanel(scenario, 'en', 'dark')
  try {
    await page.click('#tab-activity')
    // Force the toggle open too, so its re-rendered (9-project) layout is
    // checked as well as the collapsed one.
    const before = await touchingControls(page)
    await page.click('#projects-body button[data-activity-toggle]')
    const after = await touchingControls(page)
    assert.deepEqual(before, [])
    assert.deepEqual(after, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('every activity.* key in one language catalog exists in the other, and the es values are accented with no \' -- \'', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openBoardPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('activity.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('activity.') === 0)
    assert.ok(esKeys.length > 0, 'no activity.* keys found in the es catalog')
    const missingInEn = esKeys.filter((key) => enKeys.indexOf(key) === -1)
    const missingInEs = enKeys.filter((key) => esKeys.indexOf(key) === -1)
    assert.deepEqual(missingInEn, [], `es-only activity.* keys missing from en: ${missingInEn.join(', ')}`)
    assert.deepEqual(missingInEs, [], `en-only activity.* keys missing from es: ${missingInEs.join(', ')}`)

    // Same technique as the consumption.* parity test above (and
    // src/core/i18n_catalogs.test.ts, which never reads board.html's own
    // inline CATALOG), scoped to just the new keys.
    const mustBeAccented = [
      'limite', 'podria', 'podrian', 'maquina', 'automatica', 'automaticamente', 'despues', 'ningun',
      'catalogo', 'politica', 'politicas', 'aqui', 'alli', 'leido', 'codigo', 'sesion', 'tambien',
      'todavia', 'ademas', 'numero', 'ultimo', 'ultima', 'pagina', 'accion', 'opcion', 'configuracion',
      'revision', 'decision', 'informacion', 'funcion', 'razon', 'deberia', 'tendria', 'habria',
      'seria', 'estara', 'sera', 'facil', 'rapido', 'unico', 'unica', 'metodo'
    ]
    const problems = []
    for (const key of esKeys) {
      const value = catalog.es[key]
      if (value.includes(' -- ')) problems.push(`${key}: uses ' -- '`)
      const words = value.toLowerCase().split(/[^a-záéíóúüñ]+/u).filter((w) => w.length > 0)
      const missingAccents = words.filter((w) => mustBeAccented.includes(w))
      if (missingAccents.length > 0) problems.push(`${key}: missing accents on ${missingAccents.join(', ')}`)
    }
    assert.deepEqual(problems, [])
  } finally {
    await browser.close()
  }
})

// QA 0.6.5 A9 (JEVADV-69): esc() escaped & < > but not quotes, and its output
// lands inside title="..." and aria-label="..." through innerHTML. A branch
// or folder name is data the plugin reads from third-party repositories, and
// a `"` in one closed the attribute and bound a real handler.
test('a quote in a branch or project name stays text inside its attribute and binds no handler', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const hostile = 'x" onmouseover="window.__pwned=1" data-x=\'y'
  const board = { entries: [{ worktreeId: 'wt-evil', project: 'github:example/' + hostile, projectName: hostile, rama: hostile, paneKey: 'pane-e', state: 'working', receivedAt: 1, updatedAt: new Date().toISOString() }] }
  const { browser, page, errors } = await openBoardPanel({ board })
  try {
    const found = await page.evaluate(() => ({
      handlers: document.querySelectorAll('[onmouseover]').length,
      titles: Array.from(document.querySelectorAll('#cards .live-row')).map((row) => row.title)
    }))
    assert.equal(found.handlers, 0, 'a quote in the data closed an attribute and bound a handler')
    assert.ok(found.titles.some((title) => title.includes(hostile)), `the raw name must survive as text in the title: ${JSON.stringify(found.titles)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// 0.6.17 T4 (JEVADV-92): a decision the gate could not write is counted, and
// the "is the gate working?" card says so -- even with no decision written.
for (const [locale, text] of [['en', /3 decisions not logged, the last/], ['es', /3 decisiones sin registrar, la última/]]) {
  test(`the status card counts gate decisions that could not be written (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const ready = SCENARIOS.ready
    const health = { ...ready.measurementsSummary.gate.health, appendFailures: { count: 3, lastAt: new Date().toISOString() } }
    const withFailures = { ...ready, measurementsSummary: { ...ready.measurementsSummary, gate: { ...ready.measurementsSummary.gate, health } } }
    const { browser, page, errors } = await openBoardPanel(withFailures, locale)
    try {
      const chips = await page.$$eval('#status-body .chip', (items) => items.map((chip) => ({ text: chip.textContent, alarm: chip.classList.contains('alarm'), title: chip.getAttribute('title') })))
      const failed = chips.find((chip) => text.test(chip.text))
      assert.ok(failed, `no append-failure chip: ${JSON.stringify(chips)}`)
      assert.equal(failed.alarm, true)
      assert.match(failed.title, locale === 'en' ? /could not write these decisions/ : /no pudo escribir estas decisiones/)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('no append-failure chip when every decision was written, and the card shows failures with no decision at all', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const ready = await openBoardPanel(SCENARIOS.ready)
  try {
    const chips = await ready.page.$$eval('#status-body .chip', (items) => items.map((chip) => chip.textContent))
    assert.ok(!chips.some((chip) => /not logged/.test(chip)), JSON.stringify(chips))
  } finally {
    await ready.browser.close()
  }
  const empty = SCENARIOS.empty
  const health = { ...empty.measurementsSummary.gate.health, appendFailures: { count: 2, lastAt: new Date().toISOString() } }
  const onlyFailures = { ...empty, measurementsSummary: { ...empty.measurementsSummary, gate: { ...empty.measurementsSummary.gate, health } } }
  const { browser, page, errors } = await openBoardPanel(onlyFailures)
  try {
    assert.equal(await page.isVisible('#card-status'), true)
    assert.match(await page.textContent('#status-body'), /2 decisions not logged/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// 0.6.19 M14 (JEVADV-72): hostile names in every field. Each fixture below
// is a real scenario with a hostile tail appended to every string that is
// data -- a project, a branch, a command, a policy id or rule, a destination
// or model name -- carrying all five characters that can open markup or close
// an attribute. A timestamp keeps its value, or the rows it dates would not
// render at all. The panel must show the tail as text and build nothing from
// it. panel_markup_sinks.test.mjs pins the escaping these runs stand on.
const HOSTILE_TAIL = `"'><img data-pwn src=x onerror="window.__pwned=1">&amp;`

function withHostileNames (value) {
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : value + HOSTILE_TAIL
  if (Array.isArray(value)) return value.map(withHostileNames)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withHostileNames(inner)]))
  }
  return value
}

async function hostileFindings (page) {
  return page.evaluate((tail) => ({
    built: document.querySelectorAll('[data-pwn], [onerror], [onmouseover]').length,
    ran: window.__pwned === 1,
    shownAsText: document.body.textContent.split(tail).length - 1,
    inAttributes: Array.from(document.querySelectorAll('*')).filter((node) => Array.from(node.attributes).some((attr) => attr.value.includes(tail))).length
  }), HOSTILE_TAIL)
}

for (const scenario of ['ready', 'consumption-ready', 'router-ready', 'degraded']) {
  test(`board: hostile names in the ${scenario} scenario stay text and build nothing`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openBoardPanel(withHostileNames(SCENARIOS[scenario]))
    try {
      const found = await hostileFindings(page)
      assert.equal(found.built, 0, 'a hostile name became an element or a handler')
      assert.equal(found.ran, false)
      assert.ok(found.shownAsText + found.inAttributes > 0, `no hostile name reached the page at all, so this proves nothing: ${JSON.stringify(found)}`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

for (const scenario of ['ready', 'seeds', 'baseline', 'catalog-proposals', 'router-ready']) {
  test(`config: hostile catalog, policy, destination and model names in the ${scenario} scenario stay text and build nothing`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openPanel(withHostileNames(SCENARIOS[scenario]))
    try {
      const found = await hostileFindings(page)
      const values = await page.$$eval('input, textarea', (fields, tail) => fields.filter((field) => field.value.includes(tail)).length, HOSTILE_TAIL)
      assert.equal(found.built, 0, 'a hostile name became an element or a handler')
      assert.equal(found.ran, false)
      assert.ok(found.shownAsText + found.inAttributes + values > 0, `no hostile name reached the page at all, so this proves nothing: ${JSON.stringify(found)}`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

// 0.6.19 (JEVADV-72): every label names its control, and <html lang> is the
// language the panel paints in.
for (const scenario of ['ready', 'seeds', 'router-ready']) {
  test(`config: every label in the ${scenario} scenario is tied to a control, and every id is unique`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openPanel(SCENARIOS[scenario])
    try {
      const found = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll('[id]')).map((node) => node.id)
        return {
          labels: document.querySelectorAll('label').length,
          // A label that names a button group through aria-labelledby is the
          // group's name, not a field's; it has no single control to name.
          orphans: Array.from(document.querySelectorAll('label'))
            .filter((label) => label.control === null && !(label.id && document.querySelector(`[role="group"][aria-labelledby="${label.id}"]`)))
            .map((label) => label.textContent.trim() || label.outerHTML.slice(0, 80)),
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index)
        }
      })
      assert.ok(found.labels > 0)
      assert.deepEqual(found.orphans, [], 'a label with no control is read by no screen reader and focuses nothing on click')
      assert.deepEqual(found.duplicateIds, [])
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

for (const locale of ['en', 'es']) {
  test(`both panels set <html lang> to the language they paint in (${locale})`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    for (const open of [openPanel, openBoardPanel]) {
      const { browser, page, errors } = await open(SCENARIOS.ready, locale)
      try {
        assert.equal(await page.evaluate(() => document.documentElement.lang), locale)
        assert.deepEqual(errors, [])
      } finally {
        await browser.close()
      }
    }
  })
}

// 0.6.19 M16 (JEVADV-73): the owner's "treat as ready" is a switch of its own,
// stored with the legacy switch; the measured readiness stays on screen.
for (const [locale, onText, measured] of [['en', /Owner override on: rewrites are allowed although measurement says:/, /comparable decisions/], ['es', /Decisión del dueño activa: se permite reescribir aunque la medición dice:/, /decisiones comparables/]]) {
  test(`models: the owner's ready override shows beside the measured readiness, and survives a reload (${locale})`, { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
    const storage = { ...SCENARIOS.ready, modelsConfig: { active: true, readyOverride: true } }
    const { browser, page, errors } = await openPanel(storage, locale)
    try {
      assert.equal(await page.isChecked('#models-ready-override'), true, 'the stored override is shown on')
      const hint = await page.textContent('#models-ready-override-hint')
      assert.match(hint, onText)
      assert.match(hint, measured, 'the measured readiness line is still there')
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('models: saving the legacy switch writes the ready override with it, and an untouched override stays off', { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ ...SCENARIOS.ready, modelsConfig: { active: false } })
  try {
    await page.click('#tab-models')
    assert.equal(await page.isChecked('#models-ready-override'), false)
    await page.click('#models-save-config')
    await page.waitForTimeout(800)
    assert.deepEqual(await page.evaluate(() => window.__written.modelsConfig), { active: false, readyOverride: false })
    await page.check('#models-ready-override')
    await page.click('#models-save-config')
    await page.waitForTimeout(800)
    assert.deepEqual(await page.evaluate(() => window.__written.modelsConfig), { active: false, readyOverride: true })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// 0.6.28 T4: remembered delivery authorizations, in the Rules tab. The worker
// publishes `gateAuthorizationsStatus` ({ ok, repos }) from
// adapters/orca/gate-authorizations.mjs; a forget is a
// `gateAuthorizationForgetRequest` ({ id, at, repo, cls }), cls null for all.
// ---------------------------------------------------------------------------

const AUTH_AT = '2026-10-01T09:30:00.000Z'
const AUTH_EXPIRES = '2026-10-31T09:30:00.000Z'
const AUTH_STATUS = {
  ok: true,
  checkedAt: AUTH_AT,
  repos: [
    { repo: 'github.com/acme/widgets', classes: [
      { cls: 'push-branch', firstAt: AUTH_AT, lastAt: AUTH_AT, uses: 4, expiresAt: AUTH_EXPIRES },
      { cls: 'pr-merge', firstAt: AUTH_AT, lastAt: AUTH_AT, uses: 2, expiresAt: AUTH_EXPIRES },
    ] },
    { repo: 'github.com/acme/<b>site</b>', classes: [{ cls: 'release-create', firstAt: AUTH_AT, lastAt: AUTH_AT, uses: 1, expiresAt: AUTH_EXPIRES }] },
  ],
}

test('remembered authorizations: each repository lists its classes with last use and expiry, and nothing else shows the empty line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ gateAuthorizationsStatus: AUTH_STATUS })
  try {
    await page.click('#tab-rules')
    await page.waitForSelector('#gate-auth-rows .gate-auth-repo', { timeout: 15000 })
    const text = await page.innerText('#gate-auth-rows')
    assert.match(text, /github\.com\/acme\/widgets/)
    assert.match(text, /github\.com\/acme\/<b>site<\/b>/, 'a repository name is shown as text, never as markup')
    assert.match(text, /Push a feature branch/)
    assert.match(text, /Merge a pull request/)
    assert.match(text, /Create a release/)
    assert.match(text, /Last used/)
    assert.match(text, /Expires/)
    assert.equal(await page.locator('#gate-auth-rows .gate-auth-class').count(), 3)
    assert.equal(await page.isVisible('#gate-auth-empty'), false)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('remembered authorizations: forgetting one class, or a whole repository, sends exactly that request', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ gateAuthorizationsStatus: AUTH_STATUS })
  try {
    await page.click('#tab-rules')
    await page.click('#gate-auth-rows .gate-auth-repo:first-child .gate-auth-class:nth-of-type(2) button')
    await page.waitForFunction(() => !!window.__written.gateAuthorizationForgetRequest, undefined, { timeout: 25000 })
    const one = await page.evaluate(() => window.__written.gateAuthorizationForgetRequest)
    assert.equal(one.repo, 'github.com/acme/widgets')
    assert.equal(one.cls, 'pr-merge')
    assert.equal(typeof one.id, 'string')
    assert.equal(typeof one.at, 'string')
    await page.evaluate(() => { delete window.__written.gateAuthorizationForgetRequest })
    await page.click('#gate-auth-rows .gate-auth-repo:nth-child(2) .gate-auth-forget-all')
    await page.waitForFunction(() => !!window.__written.gateAuthorizationForgetRequest, undefined, { timeout: 25000 })
    const all = await page.evaluate(() => window.__written.gateAuthorizationForgetRequest)
    assert.equal(all.repo, 'github.com/acme/<b>site</b>')
    assert.equal(all.cls, null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const [locale, learned] of [['en', /confirms the same/i], ['es', /confirma la misma/i]]) {
  test(`remembered authorizations: with none, one line says how they are learned (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openPanel({}, locale)
    try {
      await page.click('#tab-rules')
      await page.waitForFunction((source) => new RegExp(source, 'i').test(document.getElementById('gate-auth-empty').innerText), learned.source, { timeout: 15000 })
      assert.equal(await page.isVisible('#gate-auth-empty'), true)
      assert.equal(await page.locator('#gate-auth-rows .gate-auth-repo').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('remembered authorizations: the list still arrives when the rest of the panel fails to load', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  // `policies` as an object, not an array: the main load throws in
  // addPolicyRow and paints its own error. The authorizations must not hang
  // on "Reading…" because of it.
  const { browser, page } = await openPanel({ policies: { rules: [] }, gateAuthorizationsStatus: AUTH_STATUS })
  try {
    await page.click('#tab-rules')
    await page.waitForSelector('#gate-authorizations-section[data-state="ready"]', { timeout: 15000 })
    assert.equal(await page.locator('#gate-auth-rows .gate-auth-repo').count(), 2)
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// 0.6.28 T7: the trusted programs list, in the Rules tab. The worker
// publishes `trustedProgramsStatus` ({ programs }); an add or a remove is a
// `trustedProgramRequest` ({ id, at, op, name }) answered by
// `trustedProgramResult` ({ id, ok, reason, name }). Synthetic names only.
// ---------------------------------------------------------------------------

const TRUSTED_STATUS = { programs: ['acme-notify', 'acme-<b>scope</b>'], checkedAt: AUTH_AT }

test('trusted programs: the list shows each name as text with a remove button, and no empty line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ trustedProgramsStatus: TRUSTED_STATUS })
  try {
    await page.click('#tab-rules')
    await page.waitForSelector('#trusted-programs-section[data-state="ready"]', { timeout: 15000 })
    assert.equal(await page.locator('#trusted-rows .trusted-row').count(), 2)
    const text = await page.innerText('#trusted-rows')
    assert.match(text, /acme-notify/)
    assert.match(text, /acme-<b>scope<\/b>/, 'a name is shown as text, never as markup')
    assert.equal(await page.isVisible('#trusted-empty'), false)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('trusted programs: adding sends the typed name and shows the list the worker publishes', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ trustedProgramsStatus: { programs: [] }, __trustedProgramsAfter: ['acme-notify'] })
  try {
    await page.click('#tab-rules')
    await page.fill('#trusted-name', 'Acme-Notify')
    await page.click('#trusted-add')
    await page.waitForFunction(() => !!window.__written.trustedProgramRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.trustedProgramRequest)
    assert.equal(request.op, 'add')
    assert.equal(request.name, 'Acme-Notify')
    assert.equal(typeof request.id, 'string')
    await page.waitForSelector('#trusted-rows .trusted-row', { timeout: 25000 })
    assert.match(await page.innerText('#trusted-rows'), /acme-notify/)
    assert.match(await page.innerText('#trusted-said'), /Added/)
    assert.equal(await page.inputValue('#trusted-name'), '')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('trusted programs: removing sends exactly that name', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page, errors } = await openPanel({ trustedProgramsStatus: TRUSTED_STATUS, __trustedProgramsAfter: ['acme-<b>scope</b>'] })
  try {
    await page.click('#tab-rules')
    await page.click('#trusted-rows .trusted-row:first-child .trusted-remove')
    await page.waitForFunction(() => !!window.__written.trustedProgramRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.trustedProgramRequest)
    assert.deepEqual({ op: request.op, name: request.name }, { op: 'remove', name: 'acme-notify' })
    await page.waitForFunction(() => document.querySelectorAll('#trusted-rows .trusted-row').length === 1, undefined, { timeout: 25000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const [locale, why] of [['en', /shell, an interpreter or a general tool/i], ['es', /shell, un intérprete o una herramienta general/i]]) {
  test(`trusted programs: a refused name says why (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openPanel({ trustedProgramsStatus: { programs: [] }, __trustedProgramResult: { ok: false, reason: 'refused' } }, locale)
    try {
      await page.click('#tab-rules')
      await page.fill('#trusted-name', 'python3')
      await page.click('#trusted-add')
      await page.waitForFunction((source) => new RegExp(source, 'i').test(document.getElementById('trusted-said').innerText), why.source, { timeout: 25000 })
      assert.equal(await page.inputValue('#trusted-name'), 'python3', 'a refused name stays in the field to correct')
      assert.equal(await page.locator('#trusted-rows .trusted-row').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

for (const [locale, meaning] of [['en', /without asking Jev/i], ['es', /sin preguntar a Jev/i]]) {
  test(`trusted programs: with none, one line says what trusting a program means (${locale})`, { skip: chromium ? false : 'playwright is not installed' }, async () => {
    const { browser, page, errors } = await openPanel({}, locale)
    try {
      await page.click('#tab-rules')
      await page.waitForFunction((source) => new RegExp(source, 'i').test(document.getElementById('trusted-empty').innerText), meaning.source, { timeout: 15000 })
      assert.equal(await page.isVisible('#trusted-empty'), true)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('every trusted.* key in one language catalog exists in the other', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({})
  try {
    const catalog = await page.evaluate(() => window.CATALOG)
    const esKeys = Object.keys(catalog.es).filter((key) => key.indexOf('trusted.') === 0)
    const enKeys = Object.keys(catalog.en).filter((key) => key.indexOf('trusted.') === 0)
    assert.ok(enKeys.length > 0, 'no trusted.* keys at all')
    assert.deepEqual(esKeys.filter((key) => enKeys.indexOf(key) === -1), [])
    assert.deepEqual(enKeys.filter((key) => esKeys.indexOf(key) === -1), [])
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// config.html -- the Modules section (feature-modules T5). First on the
// General tab. One card per module with its switch, what it does, what it
// costs and whether the Claude Code hooks match the choice; the switch is a
// request the worker attends, and a module that is off hides the settings
// that belong to it. The fixtures are screenshot-panels.mjs's own (ready: all
// active; modules-mixed: gate off, router shadow; modules-skipped: a newer
// install kept the gate's hooks), derived from the installer's real
// status().modules shape (fixture_shape.test.mjs).
// ---------------------------------------------------------------------------

const MODULE_IDS = ['gate', 'model-router', 'steward', 'skill-selection', 'board', 'verify-done', 'ci-watch', 'memory']
const SECRET_MIRROR_SCRIPT = join(ROOT, 'adapters', 'orca', 'write-secret-mirror.mjs')

/**
 * 0.8.0 V4: what the real worker's writer answers to the panel's request.
 * The fake host here accepts any map, which once hid a map the real sidecar
 * refuses; this runs the real `feature-modules-save` against a throwaway
 * config dir, exactly as main.mjs spawns it.
 */
function realSave (modules) {
  const home = mkdtempSync(join(ISOLATED_ROOT, 'feature-modules-save-'))
  const env = { ...process.env, HOME: home, ORCA_SUPERVISOR_CONFIG_DIR: join(home, '.config', 'orca-supervisor') }
  delete env.XDG_CONFIG_HOME
  return JSON.parse(execFileSync(process.execPath, [SECRET_MIRROR_SCRIPT, 'feature-modules-save'], { env, encoding: 'utf8', input: JSON.stringify({ modules }) }))
}
const MODULES_SKIP = { skip: chromium && SCENARIOS ? false : 'playwright is not installed' }

/** The ready fixture with the installer's per-module state replaced for `states`. */
function withModuleStates (states, extra = {}) {
  const base = SCENARIOS.ready.claudeIntegrationStatus
  const modules = Object.fromEntries(Object.entries(base.modules).map(([id, info]) => {
    const state = states[id] ?? info.state
    return [id, { ...info, state, installed: state !== 'off' || info.hookCount === 0, removed: state === 'off' || info.hookCount === 0, matchesState: true }]
  }))
  return { ...SCENARIOS.ready, ...extra, claudeIntegrationStatus: { ...base, modules } }
}

async function moduleCards (page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#modules-rows .module-row')).map((card) => {
    const group = card.querySelector('.module-states')
    const buttons = Array.from(group.querySelectorAll('button'))
    return {
      id: card.getAttribute('data-module-row'),
      name: card.querySelector('.module-name').textContent,
      states: buttons.map((b) => b.dataset.value),
      pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.value),
      labels: buttons.map((b) => b.textContent),
      disabled: buttons.map((b) => b.disabled),
      text: card.innerText
    }
  }))
}

test('Modules: the first section of General lists the eight modules with what they do and cost; the five earlier ones active by default, verify-done, ci-watch and memory in shadow', MODULES_SKIP, async () => {
  const { browser, page, errors } = await openPanel(SCENARIOS.ready)
  try {
    const first = await page.evaluate(() => document.querySelector('#panel-general section').id)
    assert.equal(first, 'modules-section')
    const cards = await moduleCards(page)
    assert.deepEqual(cards.map((c) => c.id), MODULE_IDS)
    assert.deepEqual(cards.map((c) => c.name), ['Gate', 'Model router', 'Context steward', 'Skill and tool selection', 'Board', 'Verify done', 'CI watcher', 'Memory'])
    // The registry decides the states: no shadow where the module has no measure mode of its own, no active where it only measures.
    assert.deepEqual(cards.map((c) => c.states), [['off', 'active'], ['off', 'shadow', 'active'], ['off', 'shadow', 'active'], ['off', 'shadow', 'active'], ['off', 'active'], ['off', 'shadow'], ['off', 'shadow', 'active'], ['off', 'shadow', 'active']])
    assert.deepEqual(cards.map((c) => c.pressed), [['active'], ['active'], ['active'], ['active'], ['active'], ['shadow'], ['shadow'], ['shadow']])
    assert.deepEqual(cards[5].labels, ['Off', 'Shadow'])
    const verify = cards[5].text
    assert.match(verify, /turns that edited files with no test passing/)
    assert.match(verify, /whether its final message says the work is done/)
    assert.match(verify, /It only measures: it blocks nothing and changes no answer\./)
    assert.match(verify, /final message, redacted and cut, and the turn's counts/)
    assert.match(verify, /about 0\.1 Jev calls per prompt/)
    assert.match(verify, /Background: nothing of its own\./)
    assert.match(verify, /follows the switch directly/)
    assert.deepEqual(cards[6].labels, ['Off', 'Shadow', 'Active'])
    const ci = cards[6].text
    assert.match(ci, /watches the CI run with gh and tells you here when it ends/)
    assert.match(ci, /In Shadow it sends nothing to the agent/)
    assert.match(ci, /In Active it also tells the agent once, when it is idle/)
    assert.match(ci, /at most 45 gh calls per watch \(the ceiling of its polling schedule, not a measurement\), no Jev or model calls/)
    assert.match(ci, /Background: nothing of its own\./)
    assert.match(ci, /follows the switch directly/)
    assert.deepEqual(cards[1].labels, ['Off', 'Shadow', 'Active'])
    const gate = cards[0].text
    assert.match(gate, /Checks every Bash command and file edit/)
    assert.match(gate, /about 9\.3 Jev calls per prompt, and 1\.9 hook processes per Bash command or file edit/)
    assert.match(gate, /about 236 node processes an hour with a panel open, none with no panel open/)
    assert.match(cards[1].text, /about 240 node processes an hour\./, 'a figure that does not change with the panel is one figure')
    assert.match(cards[3].text, /Background: nothing of its own\./)
    assert.match(cards[4].text, /no Jev calls and no hooks/)
    assert.match(gate, /Hooks installed \(5\), as you chose\./)
    assert.match(cards[2].text, /follows the switch directly/, 'a module with no hooks of its own says so')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('Modules: pressing a state sends the whole map to the worker, and the answer is shown on that card', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready)
  try {
    await page.click('[data-module-states="gate"] button[data-value="off"]')
    await page.waitForFunction(() => !!window.__written.featureModulesSaveRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.featureModulesSaveRequest)
    assert.equal(typeof request.id, 'string')
    assert.deepEqual(request.modules, { gate: 'off', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active', 'verify-done': 'shadow', 'ci-watch': 'shadow', memory: 'shadow' }, 'every card sends its state, the pressed one changed')
    assert.deepEqual(realSave(request.modules), { ok: true, value: request.modules }, 'the real writer takes the map the panel sent')
    await page.waitForFunction(() => /Saved\./.test(document.querySelector('[data-module-said="gate"]').textContent), undefined, { timeout: 25000 })
    assert.equal(await page.evaluate(() => document.querySelector('[data-module-said="steward"]').textContent), '', 'only the pressed card answers')
  } finally {
    await browser.close()
  }
})

test('Modules: verify-done offers Off and Shadow only, and switching it off sends the whole eight-module map the real writer accepts', MODULES_SKIP, async () => {
  const { browser, page, errors } = await openPanel(SCENARIOS.ready)
  try {
    await page.click('[data-module-states="verify-done"] button[data-value="off"]')
    await page.waitForFunction(() => !!window.__written.featureModulesSaveRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.featureModulesSaveRequest)
    assert.deepEqual(request.modules, { gate: 'active', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active', 'verify-done': 'off', 'ci-watch': 'shadow', memory: 'shadow' })
    assert.deepEqual(realSave(request.modules), { ok: true, value: request.modules })
    await page.waitForFunction(() => /Saved\./.test(document.querySelector('[data-module-said="verify-done"]').textContent), undefined, { timeout: 25000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('Modules: the verify-done card in Spanish says what it measures, that it blocks nothing and what it sends Jev', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready, 'es')
  try {
    const card = (await moduleCards(page))[5]
    assert.equal(card.name, 'Verificar «hecho»')
    assert.deepEqual(card.labels, ['Apagado', 'Sombra'])
    assert.match(card.text, /turnos que editaron archivos sin un test que pasara/)
    assert.match(card.text, /Solo mide: no bloquea nada ni cambia ninguna respuesta\./)
    assert.match(card.text, /el mensaje final, redactado y recortado, y los conteos del turno/)
    assert.match(card.text, /unas 0,1 llamadas a Jev por prompt/)
  } finally {
    await browser.close()
  }
})

test('Modules: ci-watch offers Off, Shadow and Active, and every state it offers goes through the real writer', MODULES_SKIP, async () => {
  for (const state of ['off', 'active']) {
    const { browser, page, errors } = await openPanel(SCENARIOS.ready)
    try {
      await page.click(`[data-module-states="ci-watch"] button[data-value="${state}"]`)
      await page.waitForFunction(() => !!window.__written.featureModulesSaveRequest, undefined, { timeout: 25000 })
      const request = await page.evaluate(() => window.__written.featureModulesSaveRequest)
      assert.deepEqual(request.modules, { gate: 'active', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active', 'verify-done': 'shadow', 'ci-watch': state, memory: 'shadow' })
      assert.deepEqual(realSave(request.modules), { ok: true, value: request.modules }, `the real writer takes ci-watch ${state}`)
      await page.waitForFunction(() => /Saved\./.test(document.querySelector('[data-module-said="ci-watch"]').textContent), undefined, { timeout: 25000 })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
  // Shadow, the state it starts in, is pressed already: pressing it again sends nothing, and pressing it from Active sends it.
  const active = withModuleStates({ 'ci-watch': 'active' })
  const { browser, page } = await openPanel(active)
  try {
    assert.deepEqual((await moduleCards(page))[6].pressed, ['active'])
    await page.click('[data-module-states="ci-watch"] button[data-value="shadow"]')
    await page.waitForFunction(() => !!window.__written.featureModulesSaveRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.featureModulesSaveRequest)
    assert.equal(request.modules['ci-watch'], 'shadow')
    assert.deepEqual(realSave(request.modules), { ok: true, value: request.modules })
  } finally {
    await browser.close()
  }
})

test('Modules: the ci-watch card in Spanish says what it watches, that Shadow tells the agent nothing and what it costs', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready, 'es')
  try {
    const card = (await moduleCards(page))[6]
    assert.equal(card.name, 'Vigía de CI')
    assert.deepEqual(card.labels, ['Apagado', 'Sombra', 'Activo'])
    assert.match(card.text, /vigila con gh la ejecución de CI y te avisa aquí cuando termina/)
    assert.match(card.text, /En Sombra no le envía nada al agente/)
    assert.match(card.text, /En Activo, además, le avisa al agente una vez, cuando está libre/)
    assert.match(card.text, /como máximo 45 llamadas a gh por cada vigilancia \(el tope de su calendario de consultas, no una medición\), sin llamadas a Jev ni a ningún modelo/)
  } finally {
    await browser.close()
  }
})

test('Modules: the ci-watch card shows a week of figures from the log, and says "not measured yet" - never zeros - when it has none', MODULES_SKIP, async () => {
  // The week's figures, as the measurements summary carries them.
  const measured = await openPanel(SCENARIOS.ready)
  try {
    const text = (await moduleCards(measured.page))[6].text
    assert.match(text, /Last 7 days: watches 14, CI checks by the agent meanwhile 38, long sleeps 27 \(what a note would replace\)\./)
    assert.doesNotMatch(text, /notes sent/, 'Shadow sends none, so the card does not mention them')
  } finally {
    await measured.browser.close()
  }
  // Active, with notes sent.
  const notes = await openPanel({ ...SCENARIOS.ready, measurementsSummary: { ...SCENARIOS.ready.measurementsSummary, ciWatch: { ...SCENARIOS.ready.measurementsSummary.ciWatch, injected: 9 } } })
  try {
    assert.match((await moduleCards(notes.page))[6].text, /long sleeps 27, notes sent 9 \(what a note would replace\)\./)
  } finally {
    await notes.browser.close()
  }
  // A worker older than the card sends no figure: unknown, not zero.
  const { ciWatch: _ignored, ...older } = SCENARIOS.ready.measurementsSummary
  const unknown = await openPanel({ ...SCENARIOS.ready, measurementsSummary: older })
  try {
    const text = (await moduleCards(unknown.page))[6].text
    assert.match(text, /Last 7 days: not measured yet\./)
    assert.doesNotMatch(text, /watches 0|CI checks by the agent meanwhile 0/)
  } finally {
    await unknown.browser.close()
  }
  // The log exists but holds no watch: say so, in words.
  const none = await openPanel({ ...SCENARIOS.ready, measurementsSummary: { ...SCENARIOS.ready.measurementsSummary, ciWatch: { watches: 0, finished: 0, failed: 0, ghCalls: 0, pollsReplaced: 0, sleepsReplaced: 0, injected: 0 } } })
  try {
    const text = (await moduleCards(none.page))[6].text
    assert.match(text, /Last 7 days: no watches yet\./)
    assert.doesNotMatch(text, /long sleeps 0/)
  } finally {
    await none.browser.close()
  }
  // Spanish.
  const es = await openPanel(SCENARIOS.ready, 'es')
  try {
    assert.match((await moduleCards(es.page))[6].text, /Últimos 7 días: vigilancias 14, consultas de CI del agente mientras tanto 38, esperas largas 27 \(lo que un aviso habría reemplazado\)\./)
  } finally {
    await es.browser.close()
  }
  const esUnknown = await openPanel({ ...SCENARIOS.ready, measurementsSummary: older }, 'es')
  try {
    assert.match((await moduleCards(esUnknown.page))[6].text, /Últimos 7 días: aún sin medir\./)
  } finally {
    await esUnknown.browser.close()
  }
})

// Memory (odd/tasks/memory-shadow.md M14, odd/tasks/memory-active-files.md A3):
// Off, Shadow and Active; the backend and the signal that decided it, what
// Active does on that backend, the fork sample in Shadow and every UPDATE in
// Active, what Haiku and the fork see, the quota note and the week's counts
// from the shared measurements summary.
test('Modules: the memory card offers Off, Shadow and Active, states the fork sample, what Haiku and the fork see, the quota and the week', MODULES_SKIP, async () => {
  const { browser, page, errors } = await openPanel(SCENARIOS.ready)
  try {
    const card = (await moduleCards(page))[7]
    assert.equal(card.id, 'memory')
    assert.deepEqual(card.labels, ['Off', 'Shadow', 'Active'])
    assert.deepEqual(card.pressed, ['shadow'])
    assert.match(card.text, /In Shadow it only measures: it saves nothing to Engram, judges no conflict and writes no memory file/)
    assert.match(card.text, /Active saves to Engram when Engram is live, and mirrors the rules for how to work and the facts about you into your auto-memory folder; with no Engram, or Engram configured but not answering, it writes into your auto-memory folder/)
    assert.match(card.text, /a file it rewrites or removes is first copied byte for byte to \.memory-backup/)
    assert.match(card.text, /It never deletes a memory in this release: a fallback copy is removed only once Engram has it\./)
    assert.match(card.text, /When your main thread saves to Engram in a turn, Active saves nothing of its own for that turn\./)
    assert.match(card.text, /In Shadow the only Engram call is a read-only check, once a session; in Active with Engram, each memory is one mem_save, and each conflict one read, one Haiku call and one mem_judge\./)
    assert.doesNotMatch(card.text, /not offered yet/)
    assert.match(card.text, /one Haiku call per answered turn\. In Shadow, on 1 in 5 turns Haiku marks for an update, one fork of the session drafts the memory; in Active, every such turn gets its fork\./)
    assert.match(card.text, /Haiku calls and forks count against your Max plan quota\./)
    assert.match(card.text, /Haiku sees your MEMORY\.md \(up to 8,000 characters\) and the last exchange \(up to 12,000 characters, secrets redacted/)
    assert.match(card.text, /The fork sees this session's own transcript/)
    assert.match(card.text, /Where it would save: Engram, which is live \(its tools are connected and it answered the check\)\./)
    assert.match(card.text, /This week: 212 Haiku decisions, 20% marked for an update, 8 forks\. The forks drafted 5 feedback, 1 user, 4 project and 1 reference\. Your main thread saved 65 times on its own, and Haiku agreed with it on 86% of turns\./)
    assert.doesNotMatch(card.text, /Written this week/, 'Shadow writes nothing, so it has no writes line')
    assert.match(card.text, /Background: nothing of its own\./)
    assert.match(card.text, /follows the switch directly/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('Modules: switching memory off or to Active sends the whole map, and the real writer accepts it', MODULES_SKIP, async () => {
  for (const state of ['off', 'active']) {
    const { browser, page, errors } = await openPanel(SCENARIOS.ready)
    try {
      await page.click(`[data-module-states="memory"] button[data-value="${state}"]`)
      await page.waitForFunction(() => !!window.__written.featureModulesSaveRequest, undefined, { timeout: 25000 })
      const request = await page.evaluate(() => window.__written.featureModulesSaveRequest)
      assert.deepEqual(request.modules, { gate: 'active', 'model-router': 'active', steward: 'active', 'skill-selection': 'active', board: 'active', 'verify-done': 'shadow', 'ci-watch': 'shadow', memory: state })
      assert.deepEqual(realSave(request.modules), { ok: true, value: request.modules })
      await page.waitForFunction(() => /Saved\./.test(document.querySelector('[data-module-said="memory"]').textContent), undefined, { timeout: 25000 })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
})

test('Modules: the memory card with nothing logged yet, and with Engram refused, down or absent, says so', MODULES_SKIP, async () => {
  const empty = await openPanel(SCENARIOS.empty)
  try {
    const card = (await moduleCards(empty.page))[7]
    assert.match(card.text, /Where it would save: not detected yet\. The first answered turn decides it\./)
    assert.match(card.text, /This week: nothing logged yet\./)
  } finally {
    await empty.browser.close()
  }
  const cases = [
    [{ backend: 'live', decidedBy: 'tools+health', permission: 'refused' }, /Engram is connected, but its check was refused for want of a permission rule/],
    [{ backend: 'configured-down', decidedBy: 'user-config', permission: 'unknown' }, /Engram is configured but not answering \(found in your user MCP config\)\. It would save to auto-memory and pass it to Engram later\./],
    [{ backend: 'absent', decidedBy: 'none', permission: 'unknown' }, /Where it would save: auto-memory, since there is no Engram \(no sign of Engram\)\./]
  ]
  for (const [latest, expected] of cases) {
    const ready = SCENARIOS.ready
    const scenario = { ...ready, measurementsSummary: { ...ready.measurementsSummary, memory: { ...ready.measurementsSummary.memory, latest: { at: '2026-09-24T17:40:00.000Z', ...latest } } } }
    const { browser, page } = await openPanel(scenario)
    try {
      assert.match((await moduleCards(page))[7].text, expected)
    } finally {
      await browser.close()
    }
  }
})

/** The ready machine with memory in Active, the newest row on `latest`'s backend, and a week of Active writes. */
function memoryActiveScenario (latest, writes = {}) {
  const ready = SCENARIOS.ready
  const memory = { ...ready.measurementsSummary.memory, activeDecisions: 40, draftFailures: 2, spooled: 31, written: 24, updated: 6, backups: 6, dropped: 1, writeFailures: 1, lockHeld: 0, replays: 2, replayed: 3, ...writes, latest: { at: '2026-09-24T17:40:00.000Z', ...latest } }
  return withModuleStates({ memory: 'active' }, { measurementsSummary: { ...ready.measurementsSummary, memory } })
}

test('Modules: memory in Active says, per backend, where it saves; with Engram it saves there, and with its check refused it keeps measuring and says so', MODULES_SKIP, async () => {
  const cases = [
    [{ backend: 'absent', decidedBy: 'none', permission: 'unknown' }, /Where it saves: your auto-memory folder, since there is no Engram \(no sign of Engram\)\./],
    [{ backend: 'configured-down', decidedBy: 'user-config', permission: 'unknown' }, /Where it saves: your auto-memory folder, because Engram is configured but not answering \(found in your user MCP config\)\. Each file it writes is marked pending_engram, and the next session that finds Engram live passes it to Engram\./],
    [{ backend: 'live', decidedBy: 'tools+health', permission: 'ok' }, /Where it saves: Engram, which is live \(its tools are connected and it answered the check\)\. Every memory goes to Engram; rules for how to work and facts about you are also mirrored as files in your auto-memory folder, so every session reads them\. When Engram reports a conflict, Haiku judges the clear ones and leaves the rest pending\./],
    [{ backend: 'live', decidedBy: 'tools', permission: 'refused' }, /Where it saves: nothing yet\. Engram is connected, but its check was refused for want of a permission rule \(its tools are connected\)\. Allow Engram's tools in your permissions; until then, Active keeps measuring\./]
  ]
  for (const [latest, expected] of cases) {
    const { browser, page, errors } = await openPanel(memoryActiveScenario(latest))
    try {
      const card = (await moduleCards(page))[7]
      assert.deepEqual(card.pressed, ['active'])
      assert.match(card.text, expected)
      assert.doesNotMatch(card.text, /Where it would save/, 'Active speaks of what it does, not what it would do')
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
  const unknown = await openPanel(withModuleStates({ memory: 'active' }, { measurementsSummary: SCENARIOS.empty.measurementsSummary }))
  try {
    assert.match((await moduleCards(unknown.page))[7].text, /Where it saves: not detected yet\. The first answered turn decides it\./)
  } finally {
    await unknown.browser.close()
  }
})

test('Modules: memory in Active shows the week\'s writes from its log; none yet, or not read, is said in words, never zeros', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(memoryActiveScenario({ backend: 'absent', decidedBy: 'none', permission: 'unknown' }))
  try {
    assert.match((await moduleCards(page))[7].text, /Written this week: 24 new memory files and 6 rewritten \(6 backups taken\)\. 31 saves went through the spool and 3 were finished at a session start\. Failed writes: 1; refused updates: 1\./)
  } finally {
    await browser.close()
  }
  const none = await openPanel(memoryActiveScenario({ backend: 'absent', decidedBy: 'none', permission: 'unknown' }, { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, replayed: 0 }))
  try {
    assert.match((await moduleCards(none.page))[7].text, /Written this week: nothing yet\./)
  } finally {
    await none.browser.close()
  }
  const unread = await openPanel(withModuleStates({ memory: 'active' }, { measurementsSummary: { ...SCENARIOS.ready.measurementsSummary, memory: undefined } }))
  try {
    const text = (await moduleCards(unread.page))[7].text
    assert.match(text, /Written this week: the counts could not be read yet\./)
    assert.doesNotMatch(text, /Written this week: 0/)
  } finally {
    await unread.browser.close()
  }
})

/** A week of Active with Engram live: what reached Engram, the mirrors, the judge and the dropped double saves. */
const ENGRAM_WEEK = { engramSaved: 18, engramFailed: 2, mirrored: 7, judged: 5, judgePending: 3, judgeUnavailable: 0, judgeFailed: 1, droppedMainSaved: 4, replayedToEngram: 2, fallbackRemoved: 1, fallbackMirrored: 1 }
const LIVE_OK = { backend: 'live', decidedBy: 'tools+health', permission: 'ok' }

test('Modules: memory in Active with Engram shows the week in Engram and the pending conflicts, with why they are not lost', MODULES_SKIP, async () => {
  const { browser, page, errors } = await openPanel(memoryActiveScenario(LIVE_OK, ENGRAM_WEEK))
  try {
    const text = (await moduleCards(page))[7].text
    assert.match(text, /Engram this week: 18 memories saved and 2 failed \(each kept as a file until Engram takes it\); 7 mirrored into files; 2 fallback copies passed to Engram at a session start\. Conflicts: 5 judged, 4 left pending, 0 not judged because this Engram has no mem_judge\. 4 drafts dropped because your main thread saved to Engram in the same turn\./)
    assert.match(text, /Pending conflicts this week: 4\. They stay in Engram, where the agent sees them and can resolve them; nothing is lost\./)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
  const none = await openPanel(memoryActiveScenario(LIVE_OK, { ...Object.fromEntries(Object.keys(ENGRAM_WEEK).map((key) => [key, 0])) }))
  try {
    const text = (await moduleCards(none.page))[7].text
    assert.match(text, /Engram this week: nothing yet\./)
    assert.match(text, /Pending conflicts this week: 0\./)
  } finally {
    await none.browser.close()
  }
  const unread = await openPanel(withModuleStates({ memory: 'active' }, { measurementsSummary: { ...SCENARIOS.ready.measurementsSummary, memory: { ...SCENARIOS.ready.measurementsSummary.memory, latest: { at: '2026-09-24T17:40:00.000Z', ...LIVE_OK } } } }))
  try {
    const text = (await moduleCards(unread.page))[7].text
    assert.match(text, /Engram this week: the counts could not be read yet\./, 'a summary from before 0.10.0 has no Engram figures: said in words, never zeros')
    assert.doesNotMatch(text, /Pending conflicts/)
  } finally {
    await unread.browser.close()
  }
  for (const [label, scenario] of [
    ['Shadow', withModuleStates({ memory: 'shadow' }, { measurementsSummary: { ...SCENARIOS.ready.measurementsSummary, memory: { ...SCENARIOS.ready.measurementsSummary.memory, ...ENGRAM_WEEK } } })],
    ['Active with no Engram and nothing sent to it', memoryActiveScenario({ backend: 'absent', decidedBy: 'none', permission: 'unknown' }, Object.fromEntries(Object.keys(ENGRAM_WEEK).map((key) => [key, 0])))]
  ]) {
    const { browser: other, page: otherPage } = await openPanel(scenario)
    try {
      const text = (await moduleCards(otherPage))[7].text
      assert.doesNotMatch(text, /Engram this week|Pending conflicts/, label)
    } finally {
      await other.close()
    }
  }
})

test('Modules: the memory card in Spanish speaks with tú and says the same', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready, 'es')
  try {
    const card = (await moduleCards(page))[7]
    assert.equal(card.name, 'Memoria')
    assert.deepEqual(card.labels, ['Apagado', 'Sombra', 'Activo'])
    assert.match(card.text, /En sombra solo mide: no guarda nada en Engram, no juzga conflictos y no escribe archivos de memoria/)
    assert.match(card.text, /En activo guarda en Engram cuando Engram está en marcha/)
    assert.match(card.text, /En este release nunca borra una memoria: una copia de reserva solo se quita cuando Engram ya la tiene\./)
    assert.match(card.text, /En sombra, en 1 de cada 5 turnos que Haiku marca para actualizar, un fork de la sesión redacta la memoria; en activo, cada uno de esos turnos tiene su fork\./)
    assert.match(card.text, /cuentan contra la cuota de tu plan Max/)
    assert.match(card.text, /Esta semana: 212 decisiones de Haiku, 20% para actualizar y 8 forks\./)
    assert.doesNotMatch(card.text, /\b(tenés|podés|revisá|decime|querés)\b/, 'no voseo')
  } finally {
    await browser.close()
  }
  const active = await openPanel(memoryActiveScenario({ backend: 'live', decidedBy: 'tools+health', permission: 'ok' }, ENGRAM_WEEK), 'es')
  try {
    const text = (await moduleCards(active.page))[7].text
    assert.match(text, /Dónde guarda: en Engram, que está en marcha \(sus herramientas están conectadas y respondió a la comprobación\)\. Cada memoria va a Engram; las reglas sobre cómo trabajar y los datos sobre ti también se reflejan como archivos en tu carpeta de auto-memoria, para que cada sesión los lea\. Cuando Engram avisa de un conflicto, Haiku juzga los claros y deja pendientes los demás\./)
    assert.match(text, /Escrito esta semana: 24 archivos de memoria nuevos y 6 reescritos \(6 copias de seguridad\)\./)
    assert.match(text, /Engram esta semana: 18 memorias guardadas y 2 fallidas \(cada una queda como archivo hasta que Engram la recibe\); 7 reflejadas en archivos; 2 copias de reserva pasadas a Engram al empezar una sesión\. Conflictos: 5 juzgados, 4 pendientes, 0 sin juzgar porque este Engram no tiene mem_judge\. 4 borradores descartados porque tu hilo principal guardó en Engram en el mismo turno\./)
    assert.match(text, /Conflictos pendientes esta semana: 4\. Siguen en Engram, donde el agente los ve y puede resolverlos; no se pierde nada\./)
    assert.doesNotMatch(text, /\b(tenés|podés|revisá|decime|querés)\b/, 'no voseo')
  } finally {
    await active.browser.close()
  }
})

test('Modules: a state the card already shows sends nothing', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS.ready)
  try {
    await page.click('[data-module-states="steward"] button[data-value="active"]')
    await page.waitForTimeout(1500)
    assert.equal(await page.evaluate(() => window.__written.featureModulesSaveRequest ?? null), null)
  } finally {
    await browser.close()
  }
})

test('Modules: an install left alone by a newer one is named on the card and in the answer', MODULES_SKIP, async () => {
  const storage = { ...SCENARIOS['modules-skipped'], __featureModulesResult: { skipped: true, reason: 'newer-install-present' } }
  const { browser, page } = await openPanel(storage)
  try {
    const cards = await moduleCards(page)
    const gate = cards[0]
    // verify-done has no hooks, so a newer install in the way changes nothing on its card.
    assert.deepEqual(cards[5].pressed, ['shadow'])
    assert.match(cards[5].text, /follows the switch directly/)
    assert.deepEqual(cards[6].pressed, ['shadow'])
    assert.match(cards[6].text, /follows the switch directly/)
    assert.match(gate.text, /Skipped: a newer install \(version 0\.7\.1\) keeps its own hooks\. Press "Set up" to replace it\./)
    assert.deepEqual(gate.pressed, ['off'])
    await page.click('[data-module-states="skill-selection"] button[data-value="shadow"]')
    await page.waitForFunction(() => /newer install keeps its hooks/.test(document.querySelector('[data-module-said="skill-selection"]').textContent), undefined, { timeout: 25000 })
  } finally {
    await browser.close()
  }
})

test('Modules: hooks that have not caught up with the choice read as pending, not as skipped, when no newer install is in the way', MODULES_SKIP, async () => {
  const pending = withModuleStates({ gate: 'off' })
  pending.claudeIntegrationStatus.modules.gate = { ...pending.claudeIntegrationStatus.modules.gate, installed: true, removed: false, matchesState: false }
  const { browser, page } = await openPanel(pending)
  try {
    assert.match((await moduleCards(page))[0].text, /Pending: the hooks have not caught up with this choice yet\./)
  } finally {
    await browser.close()
  }
})

test('Modules: a refused or failed switch says so in words and reads the real state back', MODULES_SKIP, async () => {
  const storage = { ...SCENARIOS.ready, __featureModulesResult: { ok: false, saved: true, reason: 'install-failed' } }
  const { browser, page } = await openPanel(storage)
  try {
    await page.click('[data-module-states="board"] button[data-value="off"]')
    await page.waitForFunction(() => /could not be updated/.test(document.querySelector('[data-module-said="board"]').textContent), undefined, { timeout: 25000 })
    assert.equal(await page.evaluate(() => document.querySelector('[data-module-said="board"]').className), 'said bad')
    // The buttons are usable again once the answer is in.
    await page.waitForFunction(() => !document.querySelector('[data-module-states="board"] button').disabled, undefined, { timeout: 25000 })
  } finally {
    await browser.close()
  }
})

test('Modules: with the gate off its settings are hidden, a note says why, and its removed hooks read as chosen', MODULES_SKIP, async () => {
  const { browser, page, errors } = await openPanel(SCENARIOS['modules-mixed'])
  try {
    const cards = await moduleCards(page)
    assert.deepEqual(cards.map((c) => c.pressed), [['off'], ['shadow'], ['active'], ['active'], ['active'], ['off'], ['shadow'], ['shadow']])
    assert.match(cards[0].text, /Hooks removed from Claude Code, as you chose\./)
    assert.match(cards[0].text, /With the gate off, nothing checks Bash commands or file edits/)
    const lines = await page.evaluate(() => document.getElementById('claude-integration-status').innerText)
    assert.match(lines, /Bash hook: removed on purpose \(the Gate module is off\)\./)
    assert.match(lines, /Edit guard \(the gate's own rules\): removed on purpose/)
    assert.doesNotMatch(lines, /Bash hook: not installed/)
    assert.match(lines, /Agent model hooks: installed/, 'the router keeps its hooks while it is in shadow')

    await page.click('#tab-rules')
    const rules = await page.evaluate(() => ({
      sections: ['deny-tier-section', 'gate-authorizations-section', 'trusted-programs-section'].map((id) => document.getElementById(id).offsetParent !== null),
      note: document.querySelector('#panel-rules [data-module-note="gate"]').innerText
    }))
    assert.deepEqual(rules.sections, [false, false, false])
    assert.match(rules.note, /The Gate module is off, so its settings are hidden\. Switch it on in General, under Modules\./)

    await page.click('#tab-policies')
    assert.equal(await page.evaluate(() => document.getElementById('queue-mode-section').offsetParent), null, 'queue mode is a gate setting')
    assert.notEqual(await page.evaluate(() => document.getElementById('policies-section').offsetParent), null, 'the policies feed advisor.decide too and stay')

    // Shadow keeps the settings and says what is capped.
    await page.click('#tab-models')
    const models = await page.evaluate(() => ({
      router: document.getElementById('model-router-section').offsetParent !== null,
      catalog: document.getElementById('models-section').offsetParent !== null,
      note: document.querySelector('#panel-models [data-module-note="model-router"]').innerText
    }))
    assert.equal(models.router, true)
    assert.equal(models.catalog, true)
    assert.match(models.note, /The Model router module is in shadow: it measures and logs what it would do, and changes nothing in your turns\./)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('Modules: skill selection off hides its tab content, and the steward off hides only its own rows', MODULES_SKIP, async () => {
  const storage = { ...withModuleStates({ 'skill-selection': 'off', steward: 'off' }), modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT }
  const { browser, page } = await openPanel(storage)
  try {
    await page.click('#tab-modskills')
    assert.equal(await page.evaluate(() => document.getElementById('mod-skills-section').offsetParent), null)
    assert.match(await page.evaluate(() => document.querySelector('[data-module-note="skill-selection"]').innerText), /Skill and tool selection module is off/)
    await page.click('#tab-models')
    const router = await page.evaluate(() => ({
      stewardRows: Array.from(document.querySelectorAll('[data-steward-target]')).filter((row) => row.offsetParent !== null).length,
      routerRows: document.querySelectorAll('#model-router-rows .mode-buttons[data-model-router-target]').length,
      stewardHint: Array.from(document.querySelectorAll('#model-router-section p[data-module="steward"]')).some((p) => p.offsetParent !== null),
      note: document.querySelector('#model-router-section [data-module-note="steward"]').innerText
    }))
    assert.equal(router.stewardRows, 0)
    assert.equal(router.routerRows, 2)
    assert.equal(router.stewardHint, false)
    assert.match(router.note, /Context steward module is off/)
  } finally {
    await browser.close()
  }
})

test('Modules: the model router and the steward lose their own Off button, unless a target still holds it', MODULES_SKIP, async () => {
  const status = {
    targets: [
      { target: 'home', mode: 'measure', steward: { mode: 'measure', threshold: 120000 } },
      { target: '11112222-3333-4444-5555-666677778888', mode: 'off', steward: { mode: 'off', threshold: 150000 } }
    ],
    checkedAt: new Date().toISOString()
  }
  const { browser, page } = await openPanel({ ...SCENARIOS.ready, modelRouterStatus: status })
  try {
    await page.click('#tab-models')
    const offButtons = await page.evaluate(() => {
      const shown = (group) => Array.from(group.querySelectorAll('button')).filter((b) => b.offsetParent !== null).map((b) => b.textContent)
      return {
        routerHome: shown(document.querySelector('#model-router-rows .mode-buttons[data-model-router-target="home"]')),
        stewardHome: shown(document.querySelector('[data-steward-target="home"] .mode-buttons')),
        routerHeld: shown(document.querySelector('#model-router-rows .mode-buttons[data-model-router-target="11112222-3333-4444-5555-666677778888"]')),
        stewardHeld: shown(document.querySelector('[data-steward-target="11112222-3333-4444-5555-666677778888"] .mode-buttons'))
      }
    })
    assert.deepEqual(offButtons.routerHome, ['Measure', 'Active'])
    assert.deepEqual(offButtons.stewardHome, ['Measure', 'Active'])
    assert.deepEqual(offButtons.routerHeld, ['Off', 'Measure', 'Active'])
    assert.deepEqual(offButtons.stewardHeld, ['Off', 'Measure', 'Active'])
  } finally {
    await browser.close()
  }
})

test('Modules: the section reads in Spanish, with no raw key and no neighbouring controls touching', MODULES_SKIP, async () => {
  const { browser, page } = await openPanel(SCENARIOS['modules-mixed'], 'es', 'dark', { width: 390, height: 1200 })
  try {
    const cards = await moduleCards(page)
    assert.equal(await page.evaluate(() => document.querySelector('#modules-section h2').textContent), 'Módulos')
    assert.deepEqual(cards[1].labels, ['Apagado', 'Sombra', 'Activo'])
    assert.match(cards[0].text, /Hooks quitados de Claude Code, como elegiste\./)
    assert.match(cards[0].text, /unas 9,3 llamadas a Jev por prompt/)
    assert.doesNotMatch(await page.evaluate(() => document.getElementById('modules-section').innerText), /(?:^|\s)(?:modules|integration)\.[a-z]/, 'a raw key was painted')
    assert.match(await page.evaluate(() => document.getElementById('claude-integration-status').innerText), /Hook de Bash: quitado a propósito/)
    assert.deepEqual(await touchingControls(page), [])
  } finally {
    await browser.close()
  }
})

test('Modules: nothing scrolls sideways at 320px, with every module on and with a mixed choice', MODULES_SKIP, async () => {
  for (const scenario of ['ready', 'modules-skipped']) {
    const { browser, page } = await openPanel(SCENARIOS[scenario], 'en', 'light', { width: 320, height: 900 })
    try {
      for (const tab of ['general', 'models', 'rules']) {
        await page.click(`#tab-${tab}`)
        const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
        assert.ok(overflow.scroll <= overflow.client, `${scenario}/${tab}: ${overflow.scroll}px in ${overflow.client}px`)
      }
    } finally {
      await browser.close()
    }
  }
})

test('every modules.* key and the module hook lines exist in both languages, accented in Spanish and free of " -- "', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const html = await readFile(CONFIG_PANEL, 'utf8')
  const keys = (block) => new Map(Array.from(block.matchAll(/^\s+'((?:modules\.[A-Za-z0-9_.-]+)|(?:integration\.[A-Za-z]*ModuleOff))':\s*(['"])(.*)\2,?\s*$/gm)).map((m) => [m[1], m[3]]))
  const es = keys(html.slice(html.indexOf('es: {'), html.indexOf('en: {')))
  const en = keys(html.slice(html.indexOf('en: {')))
  assert.ok(es.size > 40, `expected the modules keys, found ${es.size}`)
  assert.deepEqual([...es.keys()].sort(), [...en.keys()].sort())
  for (const [key, value] of [...es, ...en]) assert.ok(!value.includes(' -- '), key)
  for (const key of ['modules.heading', 'modules.intro', 'modules.noteOff', 'modules.install.pending']) {
    assert.match(es.get(key), /[áéíóúñ«]/, `${key} reads as Spanish with its accents`)
  }
  assert.doesNotMatch([...es.values()].join(' '), /\b(tenés|podés|elegí|pulsá|revisá)\b/i, 'tú, never voseo')
})

// Track S (odd/tasks/steward-pre-cold.md): the pre-cold tier has its own
// switch (off, measure, active; measure by default) in the same steward row,
// saved through the same writer, and its weekly numbers on the board.
test('steward: the pre-cold switch shows off, measure and active, measure by default, and saving sends it', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const status = { ...MODEL_ROUTER_STATUS_EFFORT, targets: MODEL_ROUTER_STATUS_EFFORT.targets.map((target, at) => (at === 1 ? { ...target, steward: { ...target.steward, coldMode: 'active' } } : target)) }
  const { browser, page, errors } = await openPanel({ modelRouterStatus: status })
  try {
    await page.click('#tab-models')
    const cold = await page.evaluate(() => Array.from(document.querySelectorAll('[data-steward-target]')).map((row) => {
      const group = row.querySelector('[data-steward-cold]')
      const buttons = group === null ? [] : Array.from(group.querySelectorAll('button'))
      const pressed = buttons.find((b) => b.className === 'active')
      return { text: group === null ? '' : group.innerText, values: buttons.map((b) => b.getAttribute('data-value')), pressed: pressed === undefined ? null : pressed.getAttribute('data-value') }
    }))
    assert.deepEqual(cold.map((c) => c.pressed), ['measure', 'active'])
    assert.deepEqual(cold[0].values, ['off', 'measure', 'active'])
    assert.match(cold[0].text, /cache/i)
    const hint = await page.evaluate(() => document.querySelector('#model-router-section').innerText)
    assert.match(hint, /idle/i)
    await page.evaluate(() => document.querySelector('[data-steward-target="home"] [data-steward-cold] button[data-value="off"]').click())
    await page.click('[data-steward-target="home"] .model-router-steward-save')
    await page.waitForFunction(() => !!window.__written.modelRouterConfigRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelRouterConfigRequest)
    assert.deepEqual(request.steward, { mode: 'measure', threshold: 120000, softMode: 'measure', coldMode: 'off' })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('steward: the pre-cold switch reads in Spanish too', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const { browser, page } = await openPanel({ modelRouterStatus: MODEL_ROUTER_STATUS_EFFORT }, 'es')
  try {
    await page.click('#tab-models')
    const text = await page.evaluate(() => document.querySelector('[data-steward-target="home"] [data-steward-cold]').innerText)
    assert.match(text, /caché/)
  } finally {
    await browser.close()
  }
})

// Track S: the pre-cold tier's weekly numbers under the steward's, both locales.
test('steward: the pre-cold tier shows fired, would fire, returned within 24 h, realized saving and waste for its window', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const preCold = { fired: 3, wouldFire: 5, skipped: 2, returned: 3, returnedEarly: 1, notReturned: 2, pending: 2, coldRewriteOnReturn: 410000, realizedSaving: 250000, waste: 44000, engineIdleCompactions: 0 }
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000, preCold }) }
  for (const locale of ['en', 'es']) {
    const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward }, locale)
    try {
      const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
      if (locale === 'en') {
        assert.match(text, /Before the cache goes cold: compacted 3 · would have compacted 5 \(measuring only\) · back within 24 h, cache already cold: 3 · back while still warm: 1 · not back: 2 · still waiting: 2/)
        assert.match(text, /Realized saving: 250,000 · waste \(nobody came back, or came back while warm\): 44,000 \(input-token equivalents\)/)
        assert.match(text, /Cold rewrite when the measured sessions came back: 410,000 tokens/)
      } else {
        assert.match(text, /Antes de que se enfríe la caché: compactó 3 · habría compactado 5 \(solo mide\) · retomadas en 24 h, con la caché ya fría: 3 · retomadas aún tibia: 1 · no retomadas: 2 · aún en espera: 2/)
        assert.match(text, /Ahorro realizado: 250,000|Ahorro realizado: 250.000/)
        assert.match(text, /Reescritura en frío/)
      }
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  }
})

test('steward: with no pre-cold row the board says so, and no saving line is invented', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000, preCold: null }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /Before the cache goes cold: no decision yet/)
    assert.doesNotMatch(text, /Realized saving/)
    assert.doesNotMatch(text, /Cold rewrite/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('steward: measured only, the pre-cold line shows no saving or waste line', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const preCold = { fired: 0, wouldFire: 2, skipped: 0, returned: 1, returnedEarly: 0, notReturned: 0, pending: 1, coldRewriteOnReturn: 150000, realizedSaving: null, waste: null, engineIdleCompactions: 0 }
  const withSteward = { ...POPULATED_CONSUMPTION, steward: windowed({ decisions: 6, applied: 2, wouldCompact: 1, freedPerStep: 140000, preCold }) }
  const { browser, page, errors } = await openBoardPanel({ consumptionSummary: withSteward })
  try {
    const text = await page.evaluate(() => document.getElementById('consumption-body').innerText)
    assert.match(text, /would have compacted 2/)
    assert.doesNotMatch(text, /Realized saving/)
    assert.match(text, /Cold rewrite when the measured sessions came back: 150,000 tokens/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
