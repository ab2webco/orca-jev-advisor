// Exercises the pure request/heartbeat logic in main.mjs directly, against
// fake StorageHost/SecretsHost objects -- these functions already take the
// host as a parameter (see main.mjs's own module note on host adapters), so
// no real Orca process or Electron is needed. See
// odd/tasks/panel-worker-wakeup.md for the task list this backs.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { publishWorkerHeartbeat, WORKER_HEARTBEAT_KEY } from './main.mjs'

function fakeOrca () {
  const logs = []
  return { log: (message) => logs.push(message), _logs: logs }
}

function fakeStorageHost (initial) {
  const store = { ...(initial || {}) }
  return {
    async get (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    async set (key, value) { store[key] = value },
    async delete (key) { delete store[key] },
    async keys () { return Object.keys(store) },
    _store: store
  }
}

// ---------------------------------------------------------------------------
// T1 -- worker heartbeat
// ---------------------------------------------------------------------------

test('publishWorkerHeartbeat writes an ISO timestamp under WORKER_HEARTBEAT_KEY', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const before = Date.now()
  await publishWorkerHeartbeat(orca, storageHost)
  const published = await storageHost.get(WORKER_HEARTBEAT_KEY)
  assert.equal(typeof published.at, 'string')
  const at = Date.parse(published.at)
  assert.ok(at >= before && at <= Date.now())
})
