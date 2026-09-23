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
  workerHeartbeat: { at: iso },
  secretStatus: { isConfigured: true, endsWith: '9f2a', checkedAt: iso },
  claudeIntegrationStatus: {
    installed: true,
    accounts: [{ id: 'account-one', hooksInstalled: true }],
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
  policies: { rules: [] },
  board: { entries: [] },
  measurementsSummary: { asked: 12, approved: 9, rejected: 3, unresolved: 0 }
}

const SCENARIOS = { fresh: FRESH, ready: READY }

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
