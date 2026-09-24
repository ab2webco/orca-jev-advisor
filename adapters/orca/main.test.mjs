// Exercises the pure request/heartbeat logic in main.mjs directly, against
// fake StorageHost/SecretsHost objects -- these functions already take the
// host as a parameter (see main.mjs's own module note on host adapters), so
// no real Orca process or Electron is needed. See
// odd/tasks/panel-worker-wakeup.md for the task list this backs.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { GATE_CONSEQUENCE_CEILING } from '../../src/core/decisions.ts'
import {
  attendCatalogRefreshRequest,
  attendClaudeIntegrationRequest,
  attendLocaleRequest,
  attendSecretRequest,
  CATALOG_REFRESH_RESULT_KEY,
  CLAUDE_INTEGRATION_RESULT_KEY,
  GATE_DEFAULTS_KEY,
  LOCALE_RESULT_KEY,
  publishGateDefaults,
  publishWorkerHeartbeat,
  SECRET_RESULT_KEY,
  seedPoliciesIfEmpty,
  WORKER_HEARTBEAT_KEY
} from './main.mjs'
import { POLICY_SEED_MARKER_KEY } from '../../src/core/policy_seed.ts'

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

function fakeSecretsHost (initial) {
  const store = { ...(initial || {}) }
  return {
    async get (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    async set (key, value) { store[key] = value },
    async delete (key) { delete store[key] }
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

// ---------------------------------------------------------------------------
// T2 -- worker-side half of the tombstone: a redacted request must never be
// mistaken for a live one, regardless of how old or new it is.
// ---------------------------------------------------------------------------

test('attendSecretRequest: a tombstoned request is never attended, even though it has an id/at shape', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    secretRequest: { id: 'secret-2', at: new Date().toISOString(), tombstone: true }
  })
  const secretsHost = fakeSecretsHost()
  await attendSecretRequest(orca, storageHost, secretsHost)
  assert.equal(await storageHost.get(SECRET_RESULT_KEY), null)
  assert.equal(await secretsHost.get('TYPESAFE_API_KEY'), null)
  // The tombstone itself is left in place -- already redacted, harmless.
  assert.equal((await storageHost.get('secretRequest')).tombstone, true)
})

// ---------------------------------------------------------------------------
// T7 -- the panel's Thresholds section must never guess a number that
// disagrees with the real gate constant. publishGateDefaults is the only
// route decisions.ts's GATE_CONSEQUENCE_CEILING can reach a sandboxed panel
// (which cannot import from src/core) -- this test fails if main.mjs ever
// goes back to a hardcoded literal instead of importing the real constant.
// ---------------------------------------------------------------------------

test('publishGateDefaults mirrors the real GATE_CONSEQUENCE_CEILING, not a hardcoded literal', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  await publishGateDefaults(orca, storageHost)
  const published = await storageHost.get(GATE_DEFAULTS_KEY)
  assert.equal(published.consequenceCeiling, GATE_CONSEQUENCE_CEILING)
})

// ---------------------------------------------------------------------------
// T3 -- an expired request must publish a stable 'expired' result instead
// of being discarded in silence, for every attend* function that has this
// request/result/TTL shape.
// ---------------------------------------------------------------------------

const TEN_MINUTES_AGO = new Date(Date.now() - 11 * 60 * 1000).toISOString()

test('attendSecretRequest: a request older than the TTL publishes an expired result, not silence', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    secretRequest: { id: 'secret-1', at: TEN_MINUTES_AGO, intent: 'save', value: 'sk-should-not-be-used' }
  })
  const secretsHost = fakeSecretsHost()
  await attendSecretRequest(orca, storageHost, secretsHost)
  const result = await storageHost.get(SECRET_RESULT_KEY)
  assert.equal(result.id, 'secret-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  // The stale request must never have reached secrets -- expiry is a
  // discard, not a delayed attend.
  assert.equal(await secretsHost.get('TYPESAFE_API_KEY'), null)
})

test('attendClaudeIntegrationRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    claudeIntegrationRequest: { id: 'ci-1', at: TEN_MINUTES_AGO, intent: 'install' }
  })
  await attendClaudeIntegrationRequest(orca, storageHost)
  const result = await storageHost.get(CLAUDE_INTEGRATION_RESULT_KEY)
  assert.equal(result.id, 'ci-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('attendLocaleRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    localeRequest: { id: 'loc-1', at: TEN_MINUTES_AGO, locale: 'en' }
  })
  await attendLocaleRequest(orca, storageHost)
  const result = await storageHost.get(LOCALE_RESULT_KEY)
  assert.equal(result.id, 'loc-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('attendCatalogRefreshRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalogRefreshRequest: { id: 'cr-1', at: TEN_MINUTES_AGO }
  })
  await attendCatalogRefreshRequest(orca, storageHost)
  const result = await storageHost.get(CATALOG_REFRESH_RESULT_KEY)
  assert.equal(result.id, 'cr-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

// ---------------------------------------------------------------------------
// Policy seeding at activation.
//
// seed/policies.json shipped for the life of this plugin and nothing read it,
// so every install ran with an empty policy stage. These exercise the real
// function against the real shipped file -- the point is precisely that the
// file is read, so stubbing it away would test nothing.
// ---------------------------------------------------------------------------

test('a fresh install gets the shipped policies, and the marker that stops a second planting', async () => {
  const orca = fakeOrca()
  const host = fakeStorageHost({})

  await seedPoliciesIfEmpty(orca, host)

  const planted = host._store.policies
  assert.ok(Array.isArray(planted), 'nothing was planted')
  assert.ok(planted.length > 0, 'the seed planted an empty list')
  for (const row of planted) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.rule, 'string')
    assert.ok(['permits', 'requires_human', 'prohibits'].includes(row.kind), `bad kind: ${row.kind}`)
  }
  assert.equal(typeof host._store[POLICY_SEED_MARKER_KEY]?.at, 'string', 'no marker was written')
})

test('a second activation plants nothing, because the marker is already there', async () => {
  const orca = fakeOrca()
  const host = fakeStorageHost({})
  await seedPoliciesIfEmpty(orca, host)
  const first = host._store.policies

  host._store.policies = []          // the developer deleted every row on purpose
  await seedPoliciesIfEmpty(orca, host)

  assert.deepEqual(host._store.policies, [], 'a deliberately emptied list was resurrected')
  assert.ok(first.length > 0, 'the first planting did nothing, so this proves nothing')
})

test("policies already on the machine are never overwritten", async () => {
  const orca = fakeOrca()
  const mine = [{ id: 'mine', kind: 'prohibits', rule: 'my own rule' }]
  const host = fakeStorageHost({ policies: mine })

  await seedPoliciesIfEmpty(orca, host)

  assert.deepEqual(host._store.policies, mine, 'an existing policy list was replaced by the seed')
})

test('a storage that throws is survived rather than propagated, because this must not block activation', async () => {
  const orca = fakeOrca()
  const host = {
    async get () { throw new Error('storage is down') },
    async set () { throw new Error('storage is down') }
  }

  await seedPoliciesIfEmpty(orca, host)   // must not reject

  assert.ok(orca._logs.some((line) => line.includes('policy seeding failed')), 'the failure was not logged')
})
