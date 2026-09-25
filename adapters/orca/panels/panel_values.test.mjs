// TDD: written before panel_values.mjs exists, so the first run of this
// file must fail on the import itself (module not found) -- same contract
// as worker-status.test.mjs (see that file's own header comment).
//
// Covers the defect described in config.html's own module note: the
// sandboxed panel's postMessage bridge uses structured clone, not
// JSON.stringify, so an object property explicitly set to `undefined`
// SURVIVES onto the wire (the key stays, the value is `undefined`) where
// JSON.stringify would have silently dropped it. Orca's `storage.set`
// validates its `value` param with `z.json()`, which refuses a plain
// `undefined` anywhere in the object graph -- so every one of
// config.html's `field || undefined` spots failed the save whenever that
// field was left blank.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildDestinationRow, buildPolicyRow, defaultWindowKey, liveEntryView, relativeAge, stripUndefinedValues } from './panel_values.mjs'

// ---------- stripUndefinedValues --------------------------------------------

test('stripUndefinedValues: a top-level undefined-valued key is removed entirely', () => {
  const result = stripUndefinedValues({ a: 1, b: undefined })
  assert.equal(Object.hasOwn(result, 'b'), false, 'the key itself must be gone, not just falsy')
  assert.equal(result.a, 1)
})

test('stripUndefinedValues: every key undefined leaves an empty object, not a crash', () => {
  assert.deepEqual(stripUndefinedValues({ a: undefined }), {})
})

test('stripUndefinedValues: recurses into nested objects', () => {
  const result = stripUndefinedValues({ outer: { kept: 1, dropped: undefined } })
  assert.equal(Object.hasOwn(result.outer, 'dropped'), false)
  assert.equal(result.outer.kept, 1)
})

test('stripUndefinedValues: recurses into array elements', () => {
  const result = stripUndefinedValues([{ a: 1, b: undefined }, { c: undefined }])
  assert.deepEqual(result, [{ a: 1 }, {}])
})

test('stripUndefinedValues: falsy-but-real values are preserved, only undefined is stripped', () => {
  const result = stripUndefinedValues({ zero: 0, empty: '', no: false, nothing: null, missing: undefined })
  assert.equal(result.zero, 0)
  assert.equal(result.empty, '')
  assert.equal(result.no, false)
  assert.equal(result.nothing, null)
  assert.equal(Object.hasOwn(result, 'missing'), false)
})

test('stripUndefinedValues: never mutates its input', () => {
  const input = { a: 1, b: undefined }
  stripUndefinedValues(input)
  assert.equal(Object.hasOwn(input, 'b'), true, 'the original object is untouched')
})

test('stripUndefinedValues: a plain scalar passes through unchanged', () => {
  assert.equal(stripUndefinedValues('hello'), 'hello')
  assert.equal(stripUndefinedValues(42), 42)
  assert.equal(stripUndefinedValues(null), null)
})

// ---------- buildDestinationRow ---------------------------------------------
// This is the exact bug: config.html's addCatalogRow used to write
// `terminalTitleMatch: titleField.input.value.trim() || undefined` --
// fixed at the source here by omitting the key entirely instead of setting
// it to `undefined`.

test('buildDestinationRow: a blank terminalTitleMatch produces an object with NO such key at all', () => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: '',
  })
  assert.equal(Object.hasOwn(row, 'terminalTitleMatch'), false)
})

// AB-benchmark pass: actThreshold/confirmThreshold/maxAutoDelicateness used
// to be seeded here as a bare literal (`0.9`/`0.6`/`2`) next to the widget.
// Traced to zero decisions anywhere (see src/core/store.ts's own note on
// AutonomyConfig) and removed -- autonomy is an empty object now, since
// there is no panel control left for consequenceCeiling (AutonomyConfig's
// one surviving field) either.
test('buildDestinationRow: autonomy is an empty object -- no invented literal for a field no decision reads', () => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: '',
  })
  assert.deepEqual(row.autonomy, {})
})

test('buildDestinationRow: a non-blank terminalTitleMatch is kept', () => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: 'repo-a*',
  })
  assert.equal(row.terminalTitleMatch, 'repo-a*')
})

test('buildDestinationRow: the result never carries an explicit undefined value anywhere', () => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: '',
  })
  assert.equal(JSON.stringify(row).includes('undefined'), false)
  for (const key of Object.keys(row)) assert.notEqual(row[key], undefined)
})

// ---------- buildPolicyRow ---------------------------------------------------

test('buildPolicyRow: an unset kind ("") produces an object with NO kind key at all', () => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: '', destinations: [] })
  assert.equal(Object.hasOwn(row, 'kind'), false)
})

test('buildPolicyRow: a chosen kind is kept', () => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: 'prohibits', destinations: [] })
  assert.equal(row.kind, 'prohibits')
})

test('buildPolicyRow: an empty destinations scope produces an object with NO destinations key at all', () => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: 'prohibits', destinations: [] })
  assert.equal(Object.hasOwn(row, 'destinations'), false)
})

test('buildPolicyRow: a non-empty destinations scope is kept', () => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: 'prohibits', destinations: ['repo-a'] })
  assert.deepEqual(row.destinations, ['repo-a'])
})

// ---------- board.html helpers ----------------------------------------------
// odd/tasks/panel-interventions-and-mod-copy.md T11: the board's window
// picker, its "N min ago" labels and its live-status chips, hand-copied
// into board.html the same way config.html copies the helpers above.

function boardWindow (overrides = {}) {
  return { available: true, totalDecisions: 10, ...overrides }
}

test('defaultWindowKey: the current plugin version when it is available and has decisions', () => {
  const windows = { version: boardWindow(), day: boardWindow(), week: boardWindow(), all: boardWindow() }
  assert.equal(defaultWindowKey(windows), 'version')
})

test('defaultWindowKey: the last 7 days when no record carries a version yet', () => {
  const windows = { version: boardWindow({ available: false, totalDecisions: 0 }), day: boardWindow(), week: boardWindow(), all: boardWindow() }
  assert.equal(defaultWindowKey(windows), 'week')
})

test('defaultWindowKey: all time when the last 7 days are empty but older decisions exist', () => {
  const windows = {
    version: boardWindow({ available: false, totalDecisions: 0 }),
    day: boardWindow({ totalDecisions: 0 }),
    week: boardWindow({ totalDecisions: 0 }),
    all: boardWindow({ totalDecisions: 4 }),
  }
  assert.equal(defaultWindowKey(windows), 'all')
})

test('defaultWindowKey: all time for an empty log, and for a summary with no windows at all', () => {
  const empty = boardWindow({ totalDecisions: 0 })
  assert.equal(defaultWindowKey({ version: { ...empty, available: false }, day: empty, week: empty, all: empty }), 'all')
  assert.equal(defaultWindowKey(undefined), 'all')
  assert.equal(defaultWindowKey(null), 'all')
})

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

test('relativeAge: under a minute is "now", including a timestamp slightly in the future', () => {
  assert.deepEqual(relativeAge('2026-09-24T11:59:30.000Z', NOW), { unit: 'now', n: 0 })
  assert.deepEqual(relativeAge('2026-09-24T12:00:05.000Z', NOW), { unit: 'now', n: 0 })
})

test('relativeAge: minutes, then hours, then days, always whole and rounded down', () => {
  assert.deepEqual(relativeAge('2026-09-24T11:55:59.000Z', NOW), { unit: 'min', n: 4 })
  assert.deepEqual(relativeAge('2026-09-24T09:30:00.000Z', NOW), { unit: 'h', n: 2 })
  assert.deepEqual(relativeAge('2026-09-21T11:00:00.000Z', NOW), { unit: 'd', n: 3 })
})

test('relativeAge: null for a missing or unparseable timestamp, never NaN or "undefined"', () => {
  assert.equal(relativeAge(null, NOW), null)
  assert.equal(relativeAge(undefined, NOW), null)
  assert.equal(relativeAge('not a date', NOW), null)
})

test('liveEntryView: project and branch as the chips, the pane and worktree ids only in the tooltip', () => {
  const view = liveEntryView({ worktreeId: 'wt-1', project: 'orca-supervisor', rama: 'feat/board', paneKey: '1e1fff06-aaaa:a62d09bd-bbbb' })
  assert.deepEqual(view, {
    name: 'orca-supervisor',
    branch: 'feat/board',
    title: 'wt-1 · 1e1fff06-aaaa:a62d09bd-bbbb',
  })
})

test('liveEntryView: an unresolved worktree has no name and no branch, and its ids still land in the tooltip only', () => {
  const view = liveEntryView({ worktreeId: null, project: null, rama: null, paneKey: '1e1fff06-aaaa:a62d09bd-bbbb' })
  assert.deepEqual(view, { name: null, branch: null, title: '1e1fff06-aaaa:a62d09bd-bbbb' })
})

test('liveEntryView: empty strings count as missing, and a malformed entry never throws', () => {
  assert.deepEqual(liveEntryView({ project: '', rama: '', paneKey: '' }), { name: null, branch: null, title: '' })
  assert.deepEqual(liveEntryView(null), { name: null, branch: null, title: '' })
})
