// 0.6.19 M14 (JEVADV-72): where the panels write markup, and what can reach it.
//
// config.html builds every row with DOM calls (textContent, value); it writes
// markup in exactly one place, the Claude Code integration hint, and that
// place takes only the panel's own catalog text. board.html builds its cards
// as markup, so every piece of data goes through esc(). scripts/panels.spec.mjs
// renders both panels with hostile names in every field; this file pins the
// two facts that coverage stands on.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { extractFunction, panelSource } from './panel_html_copies.mjs'

const configHtml = panelSource('config.html')
const boardHtml = panelSource('board.html')

/** Every `.innerHTML = <expression>` in `source` that is not a plain clear (`= ''`). */
function markupWrites (source) {
  return [...source.matchAll(/\.innerHTML\s*=\s*([^\n]+)/g)].map((match) => match[1].trim()).filter((rhs) => rhs !== "''")
}

/** The catalog value of `key` in each locale block of config.html, in source order. */
function catalogValues (source, key) {
  const values = []
  for (const match of source.matchAll(new RegExp(`'${key.replace('.', '\\.')}': ("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`, 'g'))) {
    values.push(new Function(`return ${match[1]}`)())
  }
  return values
}

test('config.html writes markup in one place only: the integration hint, from the catalog, with no parameters', () => {
  assert.deepEqual(markupWrites(configHtml), ["t('integration.hint')"])
  assert.equal(configHtml.includes('insertAdjacentHTML'), false)
  assert.equal(configHtml.includes('outerHTML'), false)
})

test("config.html: the integration hint's catalog text has no placeholder and no markup but <code>", () => {
  const values = catalogValues(configHtml, 'integration.hint')
  assert.equal(values.length, 2, 'one value per locale (es, en)')
  for (const value of values) {
    assert.equal(value.includes('{{'), false, 'a placeholder would let data into the markup')
    const tags = [...value.matchAll(/<\/?([a-zA-Z]+)[^>]*>/g)].map((match) => match[0])
    assert.ok(tags.length > 0)
    for (const tag of tags) assert.match(tag, /^<\/?code>$/, `unexpected markup in the hint: ${tag}`)
  }
})

test('board.html: esc() escapes all five characters that can open markup or close an attribute', () => {
  const esc = new Function(`${extractFunction(boardHtml, 'esc')}; return esc`)()
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
  assert.equal(esc(3), '3')
})

test('board.html writes no markup through insertAdjacentHTML, outerHTML or document.write', () => {
  assert.equal(boardHtml.includes('insertAdjacentHTML'), false)
  assert.equal(boardHtml.includes('outerHTML'), false)
  assert.equal(boardHtml.includes('document.write'), false)
})

// ---------- 0.6.19 small UI fixes (JEVADV-72) ---------------------------------

test('config.html: the models source line finds its link by id, not by the first <a> inside it', () => {
  assert.equal(configHtml.includes("querySelector('a')"), false)
  assert.match(configHtml, /<a id="models-source-link" href="https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/models\/overview"/)
  assert.match(configHtml, /el\('models-source-link'\)\.href/)
})

test('both panels declare a default language on <html>, for a host that sets none', () => {
  for (const source of [configHtml, boardHtml]) assert.match(source, /<!doctype html>\n<html lang="en">/)
})
