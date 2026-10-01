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
import * as original from './panel_values.mjs'
import { loadPanelFunctions, panelStringVar } from './panel_html_copies.mjs'

// 0.6.19 (JEVADV-72): every case runs against the tested original AND the
// hand-copied ES5 copy each panel ships, so a copy that drifts fails here
// instead of on a person's screen. A panel's copy reads `t` and
// FLOATING_TERMINAL_WORKTREE_ID as globals; they are handed in by name.
const LIVE_LABELS = {
  'live.floatingTerminal': 'Floating terminal',
  'stats.unknownProject': 'Unknown project',
  'live.unknownWorktree': 'Unknown worktree',
}
const t = (key) => LIVE_LABELS[key] ?? key
const IMPLEMENTATIONS = [
  ['panel_values.mjs', original],
  ['config.html', loadPanelFunctions('config.html', ['stripUndefinedValues', 'buildDestinationRow', 'buildPolicyRow'])],
  ['board.html', loadPanelFunctions('board.html', ['defaultWindowKey', 'relativeAge', 'liveEntryView'], { t, FLOATING_TERMINAL_WORKTREE_ID: original.FLOATING_TERMINAL_WORKTREE_ID })],
]

/** Registers `body` once per implementation that carries `name`. */
function each (name, title, body) {
  for (const [where, impl] of IMPLEMENTATIONS) {
    if (typeof impl[name] === 'function') test(`${where}: ${title}`, () => body(impl[name]))
  }
}

test('every hand-copied helper exists in its panel, and the board names the floating terminal as the original does', () => {
  const names = IMPLEMENTATIONS.slice(1).flatMap(([, impl]) => Object.keys(impl)).sort()
  assert.deepEqual(names, ['buildDestinationRow', 'buildPolicyRow', 'defaultWindowKey', 'liveEntryView', 'relativeAge', 'stripUndefinedValues'])
  assert.equal(panelStringVar('board.html', 'FLOATING_TERMINAL_WORKTREE_ID'), original.FLOATING_TERMINAL_WORKTREE_ID)
})

// ---------- stripUndefinedValues --------------------------------------------

each('stripUndefinedValues', 'stripUndefinedValues: a top-level undefined-valued key is removed entirely', (stripUndefinedValues) => {
  const result = stripUndefinedValues({ a: 1, b: undefined })
  assert.equal(Object.hasOwn(result, 'b'), false, 'the key itself must be gone, not just falsy')
  assert.equal(result.a, 1)
})

each('stripUndefinedValues', 'stripUndefinedValues: every key undefined leaves an empty object, not a crash', (stripUndefinedValues) => {
  assert.deepEqual(stripUndefinedValues({ a: undefined }), {})
})

each('stripUndefinedValues', 'stripUndefinedValues: recurses into nested objects', (stripUndefinedValues) => {
  const result = stripUndefinedValues({ outer: { kept: 1, dropped: undefined } })
  assert.equal(Object.hasOwn(result.outer, 'dropped'), false)
  assert.equal(result.outer.kept, 1)
})

each('stripUndefinedValues', 'stripUndefinedValues: recurses into array elements', (stripUndefinedValues) => {
  const result = stripUndefinedValues([{ a: 1, b: undefined }, { c: undefined }])
  assert.deepEqual(result, [{ a: 1 }, {}])
})

each('stripUndefinedValues', 'stripUndefinedValues: falsy-but-real values are preserved, only undefined is stripped', (stripUndefinedValues) => {
  const result = stripUndefinedValues({ zero: 0, empty: '', no: false, nothing: null, missing: undefined })
  assert.equal(result.zero, 0)
  assert.equal(result.empty, '')
  assert.equal(result.no, false)
  assert.equal(result.nothing, null)
  assert.equal(Object.hasOwn(result, 'missing'), false)
})

each('stripUndefinedValues', 'stripUndefinedValues: never mutates its input', (stripUndefinedValues) => {
  const input = { a: 1, b: undefined }
  stripUndefinedValues(input)
  assert.equal(Object.hasOwn(input, 'b'), true, 'the original object is untouched')
})

each('stripUndefinedValues', 'stripUndefinedValues: a plain scalar passes through unchanged', (stripUndefinedValues) => {
  assert.equal(stripUndefinedValues('hello'), 'hello')
  assert.equal(stripUndefinedValues(42), 42)
  assert.equal(stripUndefinedValues(null), null)
})

// ---------- buildDestinationRow ---------------------------------------------
// This is the exact bug: config.html's addCatalogRow used to write
// `terminalTitleMatch: titleField.input.value.trim() || undefined` --
// fixed at the source here by omitting the key entirely instead of setting
// it to `undefined`.

each('buildDestinationRow', 'buildDestinationRow: a blank terminalTitleMatch produces an object with NO such key at all', (buildDestinationRow) => {
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
each('buildDestinationRow', 'buildDestinationRow: autonomy is an empty object -- no invented literal for a field no decision reads', (buildDestinationRow) => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: '',
  })
  assert.deepEqual(row.autonomy, {})
})

each('buildDestinationRow', 'buildDestinationRow: a non-blank terminalTitleMatch is kept', (buildDestinationRow) => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: 'repo-a*',
  })
  assert.equal(row.terminalTitleMatch, 'repo-a*')
})

each('buildDestinationRow', 'buildDestinationRow: the result never carries an explicit undefined value anywhere', (buildDestinationRow) => {
  const row = buildDestinationRow({
    id: 'repo-a', label: 'Repo A', kind: 'project', worktreePath: '/repo',
    terminalTitleMatch: '',
  })
  assert.equal(JSON.stringify(row).includes('undefined'), false)
  for (const key of Object.keys(row)) assert.notEqual(row[key], undefined)
})

// ---------- buildPolicyRow ---------------------------------------------------

each('buildPolicyRow', 'buildPolicyRow: an unset kind ("") produces an object with NO kind key at all', (buildPolicyRow) => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: '', destinations: [] })
  assert.equal(Object.hasOwn(row, 'kind'), false)
})

each('buildPolicyRow', 'buildPolicyRow: a chosen kind is kept', (buildPolicyRow) => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: 'prohibits', destinations: [] })
  assert.equal(row.kind, 'prohibits')
})

each('buildPolicyRow', 'buildPolicyRow: an empty destinations scope produces an object with NO destinations key at all', (buildPolicyRow) => {
  const row = buildPolicyRow({ id: 'p1', rule: 'never force push', kind: 'prohibits', destinations: [] })
  assert.equal(Object.hasOwn(row, 'destinations'), false)
})

each('buildPolicyRow', 'buildPolicyRow: a non-empty destinations scope is kept', (buildPolicyRow) => {
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

each('defaultWindowKey', 'defaultWindowKey: the current plugin version when it is available and has decisions', (defaultWindowKey) => {
  const windows = { version: boardWindow(), day: boardWindow(), week: boardWindow(), all: boardWindow() }
  assert.equal(defaultWindowKey(windows), 'version')
})

each('defaultWindowKey', 'defaultWindowKey: the last 7 days when no record carries a version yet', (defaultWindowKey) => {
  const windows = { version: boardWindow({ available: false, totalDecisions: 0 }), day: boardWindow(), week: boardWindow(), all: boardWindow() }
  assert.equal(defaultWindowKey(windows), 'week')
})

each('defaultWindowKey', 'defaultWindowKey: all time when the last 7 days are empty but older decisions exist', (defaultWindowKey) => {
  const windows = {
    version: boardWindow({ available: false, totalDecisions: 0 }),
    day: boardWindow({ totalDecisions: 0 }),
    week: boardWindow({ totalDecisions: 0 }),
    all: boardWindow({ totalDecisions: 4 }),
  }
  assert.equal(defaultWindowKey(windows), 'all')
})

each('defaultWindowKey', 'defaultWindowKey: all time for an empty log, and for a summary with no windows at all', (defaultWindowKey) => {
  const empty = boardWindow({ totalDecisions: 0 })
  assert.equal(defaultWindowKey({ version: { ...empty, available: false }, day: empty, week: empty, all: empty }), 'all')
  assert.equal(defaultWindowKey(undefined), 'all')
  assert.equal(defaultWindowKey(null), 'all')
})

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

each('relativeAge', 'relativeAge: under a minute is "now", including a timestamp slightly in the future', (relativeAge) => {
  assert.deepEqual(relativeAge('2026-09-24T11:59:30.000Z', NOW), { unit: 'now', n: 0 })
  assert.deepEqual(relativeAge('2026-09-24T12:00:05.000Z', NOW), { unit: 'now', n: 0 })
})

each('relativeAge', 'relativeAge: minutes, then hours, then days, always whole and rounded down', (relativeAge) => {
  assert.deepEqual(relativeAge('2026-09-24T11:55:59.000Z', NOW), { unit: 'min', n: 4 })
  assert.deepEqual(relativeAge('2026-09-24T09:30:00.000Z', NOW), { unit: 'h', n: 2 })
  assert.deepEqual(relativeAge('2026-09-21T11:00:00.000Z', NOW), { unit: 'd', n: 3 })
})

each('relativeAge', 'relativeAge: null for a missing or unparseable timestamp, never NaN or "undefined"', (relativeAge) => {
  assert.equal(relativeAge(null, NOW), null)
  assert.equal(relativeAge(undefined, NOW), null)
  assert.equal(relativeAge('not a date', NOW), null)
})

each('liveEntryView', 'liveEntryView: the project name and branch as the chips; the project, worktree and pane ids only in the tooltip', (liveEntryView) => {
  const view = liveEntryView({ worktreeId: 'wt-1', project: 'github:example/orca-supervisor', projectName: 'orca-supervisor', rama: 'feat/board', paneKey: '1e1fff06-aaaa:a62d09bd-bbbb' }, t)
  assert.deepEqual(view, {
    name: 'orca-supervisor',
    branch: 'feat/board',
    title: 'github:example/orca-supervisor · wt-1 · 1e1fff06-aaaa:a62d09bd-bbbb',
  })
})

each('liveEntryView', 'liveEntryView: the floating terminal is named as such, not as an unknown worktree', (liveEntryView) => {
  const view = liveEntryView({ worktreeId: original.FLOATING_TERMINAL_WORKTREE_ID, project: null, projectName: null, rama: null, paneKey: 'pane-f' }, t)
  assert.deepEqual(view, { name: 'Floating terminal', branch: null, title: 'global-floating-terminal · pane-f' })
})

each('liveEntryView', 'liveEntryView: a project with no name is an unknown project; no project at all is an unknown worktree', (liveEntryView) => {
  assert.equal(liveEntryView({ worktreeId: 'wt-gone', project: 'repo:5c1d0e4f', projectName: null, rama: 'main', paneKey: 'pane-r' }, t).name, 'Unknown project')
  assert.deepEqual(liveEntryView({ worktreeId: null, project: null, rama: null, paneKey: '1e1fff06-aaaa:a62d09bd-bbbb' }, t), { name: 'Unknown worktree', branch: null, title: '1e1fff06-aaaa:a62d09bd-bbbb' })
})

each('liveEntryView', 'liveEntryView: empty strings count as missing, and a malformed entry never throws', (liveEntryView) => {
  assert.deepEqual(liveEntryView({ projectName: '', project: '', rama: '', paneKey: '' }, t), { name: 'Unknown worktree', branch: null, title: '' })
  assert.deepEqual(liveEntryView(null, t), { name: 'Unknown worktree', branch: null, title: '' })
})
