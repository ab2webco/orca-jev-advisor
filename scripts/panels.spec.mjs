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

const { parseSeedPolicies } = await import('../src/core/policy_seed.ts')
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

const SHIPPED = parseSeedPolicies(JSON.parse(await readFile(join(ROOT, 'seed/policies.json'), 'utf8')))

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
      // A refresh request is answered with the paired result, keyed by the id
      // the panel itself minted -- the same handshake the worker performs.
      if (key === 'catalogRefreshResult' && window.__written.catalogRefreshRequest) {
        value = { ...storage.__refreshResult, id: window.__written.catalogRefreshRequest.id }
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

async function openPanel (storage, locale = 'en') {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
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
