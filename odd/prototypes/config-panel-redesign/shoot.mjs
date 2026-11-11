// Photographs the JEVADV-121 prototype: every tab x 4 widths x light/dark (data view),
// plus loading and empty views at 1440 light and 390 dark. Measures overflow; never eyeballs it.
// Usage: node shoot.mjs <prototype.html> <outDir> [--dpr 1]
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [file, out] = process.argv.slice(2)
const dpr = process.argv.includes('--dpr') ? Number(process.argv[process.argv.indexOf('--dpr') + 1]) : 1
const TABS = ['general', 'destinations', 'policies', 'models', 'modskills', 'rules']
const WIDTHS = [1440, 768, 390, 320]
const url = pathToFileURL(resolve(file)).href
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const problems = []
let n = 0

async function shoot(theme, width, view, tab) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dpr, colorScheme: theme, locale: 'es-ES' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url + '#' + tab)
  await page.evaluate(({ theme, view }) => {
    document.documentElement.dataset.theme = theme
    document.body.dataset.view = view
  }, { theme, view })
  await page.waitForTimeout(150)
  const report = await page.evaluate(() => {
    const doc = document.documentElement
    const out = { overflowX: doc.scrollWidth - doc.clientWidth, clipped: [], offscreen: [] }
    const vw = doc.clientWidth
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (el.closest('.skel, .visually-hidden, .proto-group input, .seg input, .menu, .more-menu:not([open]) .menu')) continue
      if (r.right > vw + 0.5 || r.left < -0.5) out.offscreen.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`)
      const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
      if (hasText && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && !el.matches('input, textarea, select, .pol-rule')) out.clipped.push(`${el.tagName.toLowerCase()}.${el.className}: "${el.textContent.trim().slice(0, 40)}"`)
    }
    out.offscreen = out.offscreen.slice(0, 8); out.clipped = out.clipped.slice(0, 8)
    return out
  })
  const name = `${view}-${theme}-${width}-${tab}.png`
  // Grow the viewport to the page so the sticky save bar sits at the bottom, where a person sees it.
  const h = await page.evaluate(() => document.documentElement.scrollHeight)
  await page.setViewportSize({ width, height: Math.max(900, h) })
  await page.waitForTimeout(80)
  await page.screenshot({ path: join(out, name), fullPage: true })
  n++
  const label = `${view}/${theme}/${width}/${tab}`
  if (report.overflowX > 0) problems.push(`${label}: page overflows by ${report.overflowX}px`)
  if (report.offscreen.length) problems.push(`${label}: off-screen ${report.offscreen.join(' | ')}`)
  if (report.clipped.length) problems.push(`${label}: clipped ${report.clipped.join(' | ')}`)
  if (errors.length) problems.push(`${label}: script errors ${errors.join(' | ')}`)
  await ctx.close()
}

for (const theme of ['light', 'dark']) for (const width of WIDTHS) for (const tab of TABS) await shoot(theme, width, 'data', tab)
for (const view of ['loading', 'empty']) for (const [theme, width] of [['light', 1440], ['dark', 390]]) for (const tab of TABS) await shoot(theme, width, view, tab)
await browser.close()
console.log(`${n} screenshots written to ${out}`)
console.log(problems.length ? problems.join('\n') : 'no horizontal overflow, no off-screen or clipped text, no script errors')
