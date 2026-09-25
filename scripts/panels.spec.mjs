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

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

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
const { decidePolicySeedNotice } = await import('../src/core/policy_seed_notice.ts')
const { seedPoliciesIfEmpty } = await import('../adapters/orca/main.mjs')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_PANEL = join(ROOT, 'adapters/orca/panels/config.html')

/** The panel throttles its own host calls; anything shorter observes a spinner. */
const SETTLE_MS = 6000

let chromium = null
try {
  ({ chromium } = await import('playwright'))
} catch {
  chromium = null
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

/** Copies the panel out with a language tag, the way the Orca shell sets one. */
async function renderPanel (locale) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-panel-'))
  temps.push(dir)
  const html = await readFile(CONFIG_PANEL, 'utf8')
  const path = join(dir, 'config.html')
  await writeFile(path, html.replace('<html>', `<html lang="${locale}">`))
  return path
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
      } else if (key === 'policySeedImportResult' && window.__written.policySeedImportRequest) {
        value = {
          ok: true, added: 0, skipped: 0, replaced: 0, differing: [],
          ...storage.__policySeedImportResult,
          id: window.__written.policySeedImportRequest.id
        }
      } else if (key === 'policySeedDismissResult' && window.__written.policySeedDismissRequest) {
        value = { ok: true, ...storage.__policySeedDismissResult, id: window.__written.policySeedDismissRequest.id }
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
    window.postMessage(
      { type: 'orca-panel-action-result', requestId: msg.requestId, ok: true, value: { value } },
      '*'
    )
  })
}

async function openPanel (storage, locale = 'en', colorScheme = 'light') {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, colorScheme })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error.message)))
  await page.addInitScript(hostBridge, storage)
  await page.goto(`file://${await renderPanel(locale)}`)
  await page.waitForTimeout(SETTLE_MS)
  return { browser, page, errors }
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
    __refreshResult: { at: new Date().toISOString(), ok: false, added: null, reason: 'derivation-failed', detail: 'spawn orca ENOENT' }
  })
  try {
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
    __refreshResult: { at: new Date().toISOString(), ok: true, added: 0, reason: null, detail: null }
  })
  try {
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
  // t() falls back to the Spanish catalog on a missing key, which hides a
  // one-sided addition from a Spanish-locale reader but leaves an English
  // reader looking at the literal key string -- this catches either gap in
  // either direction, for every `policies.*` key, not only the new ones.
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
const KEY_FILE_PATH = '/Users/someone/.config/orca-supervisor/env'
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

test('adding a model with a duplicate id is refused, and a valid one lands unranked and unavailable', { skip: chromium ? false : 'playwright is not installed' }, async () => {
  const models = [modelRow({ id: 'existing', label: 'Existing', rank: 1, available: true })]
  const { browser, page } = await openPanel({ models })
  try {
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
    await page.click('#models-seed-notice-dismiss')
    await page.waitForFunction(() => !!window.__written.modelsSeedRequest, undefined, { timeout: 25000 })
    const request = await page.evaluate(() => window.__written.modelsSeedRequest)
    assert.equal(request.action, 'dismiss')
    assert.deepEqual(request.acceptedIds, [])
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
