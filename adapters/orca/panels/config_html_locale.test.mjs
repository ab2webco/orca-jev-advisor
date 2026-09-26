// odd/tasks/release-0.5.1.md JEVADV-10: config.html/board.html's
// localeFromOrca() read `document.documentElement.getAttribute('lang')`,
// which Orca never sets on plugin content -- its shells hardcode `<html
// lang="en">` -- so it always returned 'en', and config.html re-sent that
// wrong value to the worker's mirror on EVERY settings-panel open (an
// active overwrite; see main.mjs's attendLocaleRequest for the fix on that
// side). The fix reads `navigator.languages[0] || navigator.language`
// instead -- the same application-locale source Electron's
// `app.getLocale()` reads in the main process -- and maps any `es*` tag to
// 'es', everything else to 'en'.
//
// config.html/board.html are sandboxed HTML with no compiler, so -- same
// approach as config_html_mod_skills.test.mjs's modSkillsLine -- this lifts
// the pure `localeFromOrca` function out with `new Function`, passing a
// stub `navigator` as its own parameter (shadowing the real global), and
// runs it for real rather than grepping for a string.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')
const boardHtml = readFileSync(new URL('./board.html', import.meta.url), 'utf8')

/** Extracts localeFromOrca and runs it against a stub `navigator`, exactly
 *  like loadModSkillsLine does for modSkillsLine (config_html_mod_skills.test.mjs). */
function localeFromOrcaWith (source, navigatorStub) {
  const match = source.match(/function localeFromOrca \([\s\S]*?\n {6}\}/)
  assert.ok(match, 'localeFromOrca not found -- update this test if it moved or was renamed')
  const factory = new Function('navigator', `${match[0]}; return localeFromOrca`)
  return factory(navigatorStub)()
}

for (const [label, source] of [['config.html', configHtml], ['board.html', boardHtml]]) {
  test(`${label}: localeFromOrca reads navigator.languages, not document.documentElement.lang`, () => {
    const body = source.match(/function localeFromOrca \([\s\S]*?\n {6}\}/)[0]
    assert.equal(/documentElement/.test(body), false, 'must no longer read the hardcoded <html lang>')
    assert.match(body, /navigator/, 'must read the navigator-reported application locale')
  })

  test(`${label}: localeFromOrca maps an es-CO navigator tag to 'es', never 'en'`, () => {
    const result = localeFromOrcaWith(source, { languages: ['es-CO'], language: 'es-CO' })
    assert.equal(result, 'es')
  })

  test(`${label}: localeFromOrca maps a plain 'es' navigator tag to 'es'`, () => {
    const result = localeFromOrcaWith(source, { languages: ['es'], language: 'es' })
    assert.equal(result, 'es')
  })

  test(`${label}: localeFromOrca maps an en-US navigator tag to 'en'`, () => {
    const result = localeFromOrcaWith(source, { languages: ['en-US'], language: 'en-US' })
    assert.equal(result, 'en')
  })

  test(`${label}: localeFromOrca maps an unrelated tag (fr-FR) to the 'en' fallback`, () => {
    const result = localeFromOrcaWith(source, { languages: ['fr-FR'], language: 'fr-FR' })
    assert.equal(result, 'en')
  })

  test(`${label}: localeFromOrca falls back to navigator.language when navigator.languages is empty/absent`, () => {
    assert.equal(localeFromOrcaWith(source, { languages: [], language: 'es-MX' }), 'es')
    assert.equal(localeFromOrcaWith(source, { language: 'es-AR' }), 'es')
  })

  test(`${label}: t() falls back to the English catalog on a missing key, matching src/core/i18n.ts's DEFAULT_LOCALE`, () => {
    const tBody = source.match(/function t \([\s\S]*?\n {6}\}/)[0]
    assert.match(tBody, /CATALOG\.en\[key\]/, 't() must fall back to CATALOG.en, aligned with DEFAULT_LOCALE = "en"')
    assert.equal(/CATALOG\.es\[key\]/.test(tBody), false, 't() must no longer fall back to CATALOG.es')
  })

  test(`${label}: the localeFromOrca doc comment no longer claims Orca substitutes a UI locale into <html lang>`, () => {
    const docMatch = source.match(/\/\*\*[\s\S]*?\*\/\s*\n\s*function localeFromOrca/)
    assert.ok(docMatch, 'expected a doc comment directly above localeFromOrca')
    assert.equal(/substitutes/i.test(docMatch[0]), false, 'the stale claim that Orca substitutes the UI locale into <html lang> must be gone')
  })
}
