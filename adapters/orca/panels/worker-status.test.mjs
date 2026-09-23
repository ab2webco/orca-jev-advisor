// TDD: written before worker-status.mjs exists, so the first run of this
// file must fail on the import itself (module not found) -- see
// odd/tasks/panel-worker-wakeup.md, T1.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildSecretTombstone, isHeartbeatFresh } from './worker-status.mjs'

test('isHeartbeatFresh: a heartbeat well inside the threshold is fresh', () => {
  const now = Date.parse('2026-01-01T00:00:10.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' }
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), true)
})

test('isHeartbeatFresh: a heartbeat exactly at the threshold is still fresh', () => {
  const now = Date.parse('2026-01-01T00:00:40.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' }
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), true)
})

test('isHeartbeatFresh: a heartbeat older than the threshold is stale', () => {
  const now = Date.parse('2026-01-01T00:01:00.000Z')
  const heartbeat = { at: '2026-01-01T00:00:00.000Z' } // 60s old, 40s threshold
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), false)
})

test('isHeartbeatFresh: a missing heartbeat (null or undefined) is not fresh', () => {
  assert.equal(isHeartbeatFresh(null, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh(undefined, Date.now(), 40000), false)
})

test('isHeartbeatFresh: malformed shapes are rejected rather than trusted', () => {
  assert.equal(isHeartbeatFresh({}, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh({ at: 12345 }, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh({ at: 'not-a-date' }, Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh('2026-01-01T00:00:00.000Z', Date.now(), 40000), false)
  assert.equal(isHeartbeatFresh([], Date.now(), 40000), false)
})

test('isHeartbeatFresh: a heartbeat from the future (clock skew) is not trusted', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const heartbeat = { at: '2026-01-01T00:01:00.000Z' } // 60s in the future
  assert.equal(isHeartbeatFresh(heartbeat, now, 40000), false)
})

test('buildSecretTombstone: carries the id and a timestamp, marked as a tombstone, nothing else', () => {
  const tombstone = buildSecretTombstone('secret-123', '2026-01-01T00:00:00.000Z')
  assert.deepEqual(tombstone, { id: 'secret-123', at: '2026-01-01T00:00:00.000Z', tombstone: true })
  assert.equal('value' in tombstone, false)
  assert.equal('intent' in tombstone, false)
})
