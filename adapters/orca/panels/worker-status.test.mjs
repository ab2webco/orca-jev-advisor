// TDD: written before worker-status.mjs exists, so the first run of this
// file must fail on the import itself (module not found) -- see
// odd/tasks/panel-worker-wakeup.md, T1.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as original from './worker-status.mjs'
import { loadPanelFunctions } from './panel_html_copies.mjs'

// 0.6.19 (JEVADV-72): every case runs against the tested original AND each
// panel's hand-copied ES5 copy, so a copy that drifts fails here.
const IMPLEMENTATIONS = [
  ['worker-status.mjs', original],
  ['config.html', loadPanelFunctions('config.html', ['isHeartbeatFresh', 'buildSecretTombstone'])],
  ['board.html', loadPanelFunctions('board.html', ['isHeartbeatFresh'])],
]

/** Registers `body` once per implementation that carries `name`. */
function each (name, title, body) {
  for (const [where, impl] of IMPLEMENTATIONS) {
    if (typeof impl[name] === 'function') test(`${where}: ${title}`, () => body(impl[name]))
  }
}

each('isHeartbeatFresh', 'isHeartbeatFresh: a heartbeat well inside the threshold is fresh', (isHeartbeatFresh) => {
  const now = Date.parse('2026-01-01T00:00:10.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' }
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), true)
})

each('isHeartbeatFresh', 'isHeartbeatFresh: a heartbeat exactly at the threshold is still fresh', (isHeartbeatFresh) => {
  const now = Date.parse('2026-01-01T00:00:40.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' }
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), true)
})

each('isHeartbeatFresh', 'isHeartbeatFresh: a heartbeat older than the threshold is stale', (isHeartbeatFresh) => {
  const now = Date.parse('2026-01-01T00:01:00.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' } // 60s old, 40s threshold
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), false)
})

each('isHeartbeatFresh', 'isHeartbeatFresh: a missing heartbeat (null or undefined) is not fresh', (isHeartbeatFresh) => {
  assert.equal(isHeartbeatFresh(null, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh(undefined, Date.now(), 40000), false)
})

each('isHeartbeatFresh', 'isHeartbeatFresh: malformed shapes are rejected rather than trusted', (isHeartbeatFresh) => {
  assert.equal(isHeartbeatFresh({}, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh({ at: 12345 }, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh({ at: 'not-a-date' }, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh('2026-01-01T00:00:00.000Z', Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh([], Date.now(), 40000), false)
})

each('isHeartbeatFresh', 'isHeartbeatFresh: a heartbeat from the future (clock skew) is not trusted', (isHeartbeatFresh) => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const heartbeat = { at: '2026-01-01T00:01:00.000Z' } // 60s in the future
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), false)
})

each('buildSecretTombstone', 'buildSecretTombstone: carries the id and a timestamp, marked as a tombstone, nothing else', (buildSecretTombstone) => {
  const tombstone = buildSecretTombstone('secret-123', '2026-01-01T00:00:00.000Z')
  assert.deepEqual(tombstone, { id: 'secret-123', at: '2026-01-01T00:00:00.000Z', tombstone: true })
  assert.equal('value' in tombstone, false)
  assert.equal('intent' in tombstone, false)
})
