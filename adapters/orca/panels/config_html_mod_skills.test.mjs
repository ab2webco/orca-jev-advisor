// odd/tasks/production-honesty-pass.md P5 + P6.
//
// P5: install() can succeed overall (hook + env var went in) while the
// skills-mod copy specifically failed -- install-claude-integration.mjs's
// result already carried that as `modCopyWarning`, but the click handler
// used to discard the resolved result entirely and always say "Done.".
//
// P6: "Skills mod: linked" answered a question nobody asks, and was not
// even evidence -- on a real machine the links existed while
// mod-skills-measurements.jsonl did not exist at all (the mod had never
// run once), and the panel would have shown a green line over that. The
// panel must instead report one of three states derived from that file:
// not installed / installed but never run / recording N prompts since
// <date>, most recently <date>.
//
// config.html is sandboxed HTML with no compiler to catch a drifted panel,
// so -- same approach as config_html_thresholds.test.mjs -- this reads the
// panel's own source as text and checks it by hand, plus a node --check on
// the extracted inline <script> (the manual step this task also requires
// after every panel edit, made a permanent regression guard here).

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

test('config.html: the extracted inline <script> is syntactically valid', () => {
  const match = configHtml.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'inline <script> not found')
  const dir = mkdtempSync(join(tmpdir(), 'config-html-script-check-'))
  try {
    const scriptPath = join(dir, 'config-panel-script.js')
    writeFileSync(scriptPath, match[1], 'utf8')
    // Throws (and node --test reports it) on a syntax error; no output on success.
    execFileSync(process.execPath, ['--check', scriptPath])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.html: both catalogs define the three honest skills-mod states', () => {
  for (const key of ['integration.modNotInstalled', 'integration.modNeverRun', 'integration.modRecording']) {
    const occurrences = configHtml.split(`'${key}':`).length - 1
    assert.equal(occurrences, 2, `'${key}' must be defined in exactly both catalogs (es, en) -- found ${occurrences}`)
  }
})

test('config.html: the dead "linked" vocabulary is gone from both catalogs, not just unused', () => {
  for (const key of ['integration.modLinked', 'integration.modLinkedCount', 'integration.modNotLinked']) {
    assert.equal(configHtml.includes(`'${key}'`), false, `'${key}' must not exist -- "linked" was never evidence the mod had run (P6)`)
  }
})

test('config.html: install failure/warning vocabulary exists in both catalogs', () => {
  for (const key of ['integration.doneWithWarning', 'integration.modCopyFailed']) {
    const occurrences = configHtml.split(`'${key}':`).length - 1
    assert.equal(occurrences, 2, `'${key}' must be defined in exactly both catalogs (es, en) -- found ${occurrences}`)
  }
})

test('config.html: the panel never reads status.modLink anymore -- install-claude-integration.mjs reports modCopy now', () => {
  assert.equal(/\bmodLink\b/.test(configHtml), false, 'a stale modLink reference would silently read undefined forever')
})

/** Extracts a named function's body by brace-matching from its `function name (` opening, tolerant of nested braces (unlike the fixed-indent regexes config_html_thresholds.test.mjs uses, since this function's body is deeper here). */
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

test('config.html: modSkillsLine derives its count from the measurements summary, never from the hook install count', () => {
  const body = functionBody(configHtml, 'modSkillsLine')
  assert.match(body, /totalDecisions/, 'the prompt count must come from the mod-skills measurements aggregate')
  // The historical bug this replaces: modLinkedCount was rendered with
  // `{ installed: status.hook.totalCount, total: status.hook.totalCount }`
  // -- the Bash-hook install count, standing in for a completely different
  // number (recorded prompts) it happens to share no relationship with.
  assert.equal(/status\.hook\.totalCount/.test(body), false, 'must not reuse the Bash hook install count as a stand-in for recorded prompts')
})

test('config.html: modSkillsLine checks modCopy.exists, not modCopy.installed, before declaring the mod not installed', () => {
  // installed means "current for this exact plugin root"; exists means "a
  // copy is there at all" -- a stale-but-present copy can still have
  // produced real measurements worth reporting (see install-claude-
  // integration.mjs's own module note on modCopyState).
  const body = functionBody(configHtml, 'modSkillsLine')
  assert.match(body, /modCopy\.exists/, 'must check modCopy.exists')
})

test('config.html: the setup click handler surfaces a returned modCopyWarning instead of always saying "Done."', () => {
  const setupHandlerMatch = configHtml.match(/el\('claude-integration-setup'\)\.addEventListener\('click', function \(\) \{[\s\S]*?\n {6}\}\)/)
  assert.ok(setupHandlerMatch, 'setup click handler not found -- update this test if it moved')
  assert.match(setupHandlerMatch[0], /modCopyWarning/, 'the handler must inspect the resolved result for modCopyWarning')
  assert.match(setupHandlerMatch[0], /doneWithWarning/, 'a present warning must render through integration.doneWithWarning, not plain "Done."')
})
