// odd/tasks/release-0.5.1.md JEVADV-11: "Search Orca" (cmdRefreshCatalog)
// used to silently ADD a newly-seen worktree with `kind: "project"`
// hardcoded -- exactly why a real client repository never got
// "client-site" treatment. It now only computes and publishes a proposal
// list (CATALOG_PROPOSALS_STATUS_KEY); the panel renders it as a tick list
// with a per-row kind picker, and only "Add ticked" (a new
// catalogProposalAcceptRequest/Result channel) can turn one into a real
// catalog row -- never a guessed kind.
//
// config.html is sandboxed HTML with no compiler, so -- same approach as
// config_html_policy_seed_diffs.test.mjs -- this reads the panel's own
// source as text and checks it by hand, plus a node --check on the
// extracted inline <script>s. Behavioral (real-DOM) coverage for this same
// fix lives in scripts/panels.spec.mjs (Playwright, skipped on a machine
// without it).

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

test('config.html: every extracted inline <script> is syntactically valid', () => {
  const scripts = [...configHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length >= 1, 'no inline <script> found')
  const dir = mkdtempSync(join(tmpdir(), 'config-html-catalog-proposals-script-check-'))
  try {
    scripts.forEach((body, index) => {
      const scriptPath = join(dir, `config-panel-script-${index}.js`)
      writeFileSync(scriptPath, body, 'utf8')
      execFileSync(process.execPath, ['--check', scriptPath])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.html: #catalog-proposals sits directly under #catalog-list, before the add/refresh actions row', () => {
  const listIndex = configHtml.indexOf('id="catalog-list"')
  const proposalsIndex = configHtml.indexOf('id="catalog-proposals"')
  const addRowIndex = configHtml.indexOf('id="add-catalog-row"')
  assert.ok(listIndex >= 0 && proposalsIndex >= 0 && addRowIndex >= 0, 'one of the three markers is missing')
  assert.ok(listIndex < proposalsIndex, '#catalog-proposals must come after #catalog-list')
  assert.ok(proposalsIndex < addRowIndex, '#catalog-proposals must come before the actions row')
})

/** Extracts a named function's body by brace-matching -- same helper
 *  config_html_mod_skills.test.mjs and config_html_policy_seed_diffs.test.mjs use. */
function functionBody (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  if (!startMatch) throw new Error(`function ${name} not found -- update this test if it moved or was renamed`)
  let depth = 0
  let i = startMatch.index + startMatch[0].length - 1
  const start = i
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

test('config.html: renderCatalogProposals renders a kind <select> per row, with an empty first option -- never a pre-selected/guessed kind', () => {
  const body = functionBody(configHtml, 'renderCatalogProposals')
  assert.match(body, /emptyOpt\.value = ''/, 'the kind select must start with a blank option')
  assert.equal(/proposal\.kind/.test(body), false, 'a proposal never carries a kind to preselect from')
  assert.match(body, /DESTINATION_KINDS/, 'must reuse the same kind vocabulary as an ordinary catalog row')
})

test('config.html: "Add ticked" refuses when any ticked row has no kind chosen, without sending a request', () => {
  const body = functionBody(configHtml, 'renderCatalogProposals')
  assert.match(body, /missingKind/)
  assert.match(body, /proposalsMissingKind/)
})

test('config.html: load() reads the catalog proposals status and renders it', () => {
  const body = functionBody(configHtml, 'load')
  assert.match(body, /CATALOG_PROPOSALS_STATUS_KEY/)
  assert.match(body, /renderCatalogProposals/)
})

test('config.html: the refresh-catalog handler no longer rewrites the catalog list -- it only refreshes the proposal list', () => {
  const handlerMatch = configHtml.match(/el\('refresh-catalog'\)\.addEventListener\('click', function \(\) \{[\s\S]*?\n {6}\}\)/)
  assert.ok(handlerMatch, 'refresh-catalog click handler not found -- update this test if it moved')
  const body = handlerMatch[0]
  assert.match(body, /result\.proposed/, 'must read the new `proposed` count, not the old `added` one')
  assert.match(body, /renderCatalogProposals/)
  assert.equal(/addCatalogRow/.test(body), false, 'refresh must not repaint the catalog list -- it never writes the catalog anymore')
})

test('config.html: both catalogs define the new catalog-proposals vocabulary', () => {
  for (const key of [
    'catalog.proposalsHeading', 'catalog.proposalsKindPlaceholder', 'catalog.proposalsAdd',
    'catalog.proposalsNoneChosen', 'catalog.proposalsMissingKind', 'catalog.proposalsAdding',
    'catalog.proposalsAdded', 'catalog.proposalsLimitHint', 'catalog.refreshFound'
  ]) {
    const occurrences = configHtml.split(`'${key}':`).length - 1
    assert.equal(occurrences, 2, `'${key}' must be defined in exactly both catalogs (es, en) -- found ${occurrences}`)
  }
})

test('config.html: the dead catalog.refreshDone key is gone -- refresh no longer reports an "added" count', () => {
  assert.equal(configHtml.includes("'catalog.refreshDone'"), false)
})
