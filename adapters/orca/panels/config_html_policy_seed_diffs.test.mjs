// odd/tasks/release-0.5.1.md JEVADV-27 -- "pending baseline policy updates
// vanish from the panel". Before this fix, `#policy-diffs` (the tick list
// under the Team Policies baseline notice) only ever got painted as the side
// effect of a live import request/result round trip -- `load()` read
// POLICY_SEED_NOTICE_STATUS_KEY and rendered the notice banner's counts, but
// never the rows themselves, even though the worker's mergePolicySeeds
// result carried them all along. A person who saw "3 added" on one load and
// reopened the panel later never saw the 3 differing rows again.
//
// config.html is sandboxed HTML with no compiler to catch a drifted panel --
// same approach as config_html_mod_skills.test.mjs: read the panel's own
// source as text, `node --check` the extracted inline <script>s, and assert
// the wiring by hand. Behavioral (real-DOM) coverage for this same fix lives
// in scripts/panels.spec.mjs (Playwright, skipped on a machine without it).

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
  const dir = mkdtempSync(join(tmpdir(), 'config-html-policy-diffs-script-check-'))
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

test('config.html: #policy-diffs sits directly under #policy-seed-notice, before #policies-list', () => {
  const noticeIndex = configHtml.indexOf('id="policy-seed-notice"')
  const diffsIndex = configHtml.indexOf('id="policy-diffs"')
  const listIndex = configHtml.indexOf('id="policies-list"')
  assert.ok(noticeIndex >= 0 && diffsIndex >= 0 && listIndex >= 0, 'one of the three markers is missing')
  assert.ok(noticeIndex < diffsIndex, '#policy-diffs must come after #policy-seed-notice')
  assert.ok(diffsIndex < listIndex, '#policy-diffs must come before #policies-list, directly under the notice')
})

/** Extracts a named function's body by brace-matching from its `function
 *  name (` opening -- same helper config_html_mod_skills.test.mjs uses. */
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

test('config.html: renderPolicySeedNoticeAndDiffs gates the diff list on status.due, from status.differingItems', () => {
  const body = functionBody(configHtml, 'renderPolicySeedNoticeAndDiffs')
  assert.match(body, /differingItems/, 'must read differingItems off the stored status')
  assert.match(body, /status\.due/, 'must gate the diff list on due, not merely on the list being non-empty')
  assert.match(body, /renderPolicySeedDiffs/, 'must actually render the diff list, not only the notice banner')
})

test('config.html: load() renders both the notice and the diff list from the same stored status', () => {
  const body = functionBody(configHtml, 'load')
  assert.match(body, /renderPolicySeedNoticeAndDiffs/, 'load() must use the combined renderer, not the banner-only one')
  assert.equal(/\brenderPolicySeedNotice\(/.test(body), false, 'load() must not call the banner-only renderer directly anymore')
})

test('config.html: loadPolicySeedNoticeStatus renders both halves too, so Review/Dismiss stay in sync with the list', () => {
  const body = functionBody(configHtml, 'loadPolicySeedNoticeStatus')
  assert.match(body, /renderPolicySeedNoticeAndDiffs/)
})

test('config.html: runPolicySeedImport still renders the live result\'s differing rows unconditionally', () => {
  // A machine already marked "offered" from before this fix (or from a
  // dismissed/settled notice) must still be able to review on request: a
  // manual "Import policy seeds" click renders straight from the request's
  // own result, never gated on the persisted status's `due`.
  const body = functionBody(configHtml, 'runPolicySeedImport')
  assert.match(body, /renderPolicySeedDiffs\(result && result\.differing\)/)
})

test('config.html: both catalogs still define the policy-diff vocabulary this list depends on', () => {
  for (const key of ['policies.diffHeading', 'policies.diffLabel', 'policies.diffField', 'policies.diffApply', 'policies.diffNoneChosen', 'policies.diffAllDestinations']) {
    const occurrences = configHtml.split(`'${key}':`).length - 1
    assert.equal(occurrences, 2, `'${key}' must be defined in exactly both catalogs (es, en) -- found ${occurrences}`)
  }
})
