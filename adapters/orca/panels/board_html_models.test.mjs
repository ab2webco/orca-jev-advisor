// The Board names models from the stored catalog (`models` storage key),
// not from a hand-kept map: a model the catalog gains is named without a
// panel release, and an id the catalog does not know is shown as itself.
// board.html is sandboxed HTML with no module graph, so its helpers are
// read from the panel's own source and evaluated here.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const boardHtml = readFileSync(new URL('./board.html', import.meta.url), 'utf8')

function extractFunction (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  assert.ok(startMatch, `function ${name} not found -- update this test if it moved or was renamed`)
  const start = startMatch.index
  let depth = 0
  let i = start + startMatch[0].length - 1
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

function loadModelLabels () {
  const src = extractFunction(boardHtml, 'modelLabelsFromCatalog')
  return new Function(`${src}; return modelLabelsFromCatalog`)()
}

function loadFriendlyName (labels) {
  const src = extractFunction(boardHtml, 'friendlyModelName')
  return new Function('modelLabels', `${src}; return friendlyModelName`)(labels)
}

test('board.html: no hand-kept id-to-label map remains', () => {
  assert.doesNotMatch(boardHtml, /'claude-sonnet-5': 'Sonnet 5'/)
  assert.doesNotMatch(boardHtml, /MODEL_FRIENDLY_NAMES/)
})

test('modelLabelsFromCatalog: the catalog label without its "Claude " prefix, per id; malformed rows are skipped', () => {
  const modelLabelsFromCatalog = loadModelLabels()
  const labels = modelLabelsFromCatalog([
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'glm-5.3', label: 'GLM 5.3' },
    { id: 'no-label' },
    { id: 'blank', label: '  ' },
    'garbage',
    null,
  ])
  assert.deepEqual(labels, { 'claude-sonnet-5-5': 'Sonnet 5.5', 'glm-5.3': 'GLM 5.3' })
  assert.deepEqual(modelLabelsFromCatalog(null), {})
})

test('friendlyModelName: the catalog label, also behind a context-window suffix, else the id itself', () => {
  const friendlyModelName = loadFriendlyName({ 'claude-opus-5-5': 'Opus 5.5' })
  assert.equal(friendlyModelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(friendlyModelName('claude-opus-5-5[1m]'), 'Opus 5.5')
  assert.equal(friendlyModelName('claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(friendlyModelName('toString'), 'toString')
})
