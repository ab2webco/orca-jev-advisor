// Contact sheets: per view/theme/tab, the four widths side by side at a common scale.
// Usage: node sheet.mjs <shotsDir> <outDir>
import { chromium } from 'playwright'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, out] = process.argv.slice(2).map((p) => resolve(p))
await mkdir(out, { recursive: true })
const files = await readdir(dir)
const groups = {}
for (const f of files) {
  const m = f.match(/^(\w+)-(light|dark)-(\d+)-(\w+)\.png$/)
  if (!m) continue
  const key = `${m[1]}-${m[2]}-${m[4]}`
  ;(groups[key] ||= []).push({ f, w: Number(m[3]) })
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 2000, height: 1000 } })
for (const [key, list] of Object.entries(groups)) {
  list.sort((a, b) => b.w - a.w)
  const scale = 0.5
  const cells = list.map(({ f, w }) => `<figure><figcaption>${w}px</figcaption><img src="${pathToFileURL(join(dir, f)).href}" style="width:${w * scale}px"></figure>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#888;font:14px system-ui;display:flex;gap:16px;align-items:flex-start}figure{margin:0}figcaption{color:#fff;margin-bottom:4px}img{display:block;outline:1px solid #000}</style><body>${cells}</body>`
  const tmp = join(out, `${key}.html`)
  await writeFile(tmp, html)
  await page.goto(pathToFileURL(tmp).href)
  await page.waitForLoadState('load')
  const w = await page.evaluate(() => document.body.scrollWidth)
  await page.setViewportSize({ width: Math.max(400, w), height: 800 })
  await page.screenshot({ path: join(out, `${key}.png`), fullPage: true })
}
await browser.close()
console.log(Object.keys(groups).length + ' sheets in ' + out)
