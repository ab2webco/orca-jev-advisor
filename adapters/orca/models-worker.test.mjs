// Exercises models-worker.mjs's pure request/mirror/notice logic directly,
// against a fake StorageHost (a Map-backed object with get/set/delete, same
// shape main.test.mjs's own fakeStorageHost uses) and fake `mirror`/
// `readSummary` sidecar stand-ins -- never a real spawned process, same
// discipline as main.test.mjs. See odd/tasks/model-reclassification.md T6.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  attendModelsMirrorRequest,
  attendModelsSeedRequest,
  MODEL_MEASUREMENTS_KEY,
  MODEL_SEED_MARKER_KEY,
  MODEL_SEED_OFFERED_VERSION_KEY,
  MODELS_CONFIG_KEY,
  MODELS_KEY,
  MODELS_MIRROR_REQUEST_KEY,
  MODELS_SEED_NOTICE_KEY,
  MODELS_SEED_REQUEST_KEY,
  MODELS_SEED_RESULT_KEY,
  mirrorModels,
  publishModelMeasurements,
  publishModelsSeedNotice,
  seedModelsIfEmpty,
} from './models-worker.mjs'

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
    _store: store,
  }
}

function entry (overrides) {
  return {
    provider: 'anthropic',
    label: overrides.id,
    rank: 1,
    agentModel: overrides.id,
    source: 'https://example.test/doc',
    available: true,
    ...overrides,
  }
}

const SHIPPED_SEED = {
  version: 2,
  models: [
    entry({ id: 'small', rank: 2, label: 'Small' }),
    entry({ id: 'big', rank: 1, label: 'Big' }),
  ],
}

/** A fake `options.seedPayload` -- production reads seed/models.json off
 *  disk; every test here injects this instead, so no test depends on the
 *  real shipped file's exact contents. */
function fakeSeedPayload (payload = SHIPPED_SEED) {
  return async () => payload
}

/** Records every `(mode, stdin)` call it receives and always answers ok --
 *  the same shape runSecretMirrorScript resolves to. */
function recordingMirror () {
  const calls = []
  const fn = async (mode, stdin) => {
    calls.push({ mode, stdin })
    return { ok: true }
  }
  fn.calls = calls
  return fn
}

function noopMirror () { return async () => ({ ok: true }) }

// ---------------------------------------------------------------------------
// seedModelsIfEmpty
// ---------------------------------------------------------------------------

test('seedModelsIfEmpty: plants the shipped catalog once on a fresh install and marks it', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  await seedModelsIfEmpty(orca, storageHost, { seedPayload: fakeSeedPayload() })

  const models = await storageHost.get(MODELS_KEY)
  assert.equal(models.length, 2)
  assert.deepEqual(models.map((m) => m.id), ['small', 'big'])
  assert.equal(await storageHost.get(MODEL_SEED_MARKER_KEY), true)
  const offered = await storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY)
  assert.deepEqual(offered, { version: 2 }, 'the offered version marker is stored as exactly {version}')
})

test('seedModelsIfEmpty: never reseeds a catalog the person emptied on purpose', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ [MODEL_SEED_MARKER_KEY]: true, [MODELS_KEY]: [] })
  await seedModelsIfEmpty(orca, storageHost, { seedPayload: fakeSeedPayload() })
  assert.deepEqual(await storageHost.get(MODELS_KEY), [], 'an emptied, already-seeded catalog must stay empty')
})

test('seedModelsIfEmpty: never touches an existing catalog, seeded or not', async () => {
  const orca = fakeOrca()
  const mine = [entry({ id: 'mine-only', rank: 1 })]
  const storageHost = fakeStorageHost({ [MODELS_KEY]: mine })
  await seedModelsIfEmpty(orca, storageHost, { seedPayload: fakeSeedPayload() })
  assert.deepEqual(await storageHost.get(MODELS_KEY), mine)
  assert.equal(await storageHost.get(MODEL_SEED_MARKER_KEY), null, 'never touched -- untouched per this slice\'s scope')
})

// ---------------------------------------------------------------------------
// mirrorModels
// ---------------------------------------------------------------------------

test('mirrorModels: writes active from modelsConfig and ready from the last published readout', async () => {
  const orca = fakeOrca()
  const models = [entry({ id: 'sonnet', rank: 1 })]
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: models,
    [MODELS_CONFIG_KEY]: { active: true },
    [MODEL_MEASUREMENTS_KEY]: { ok: true, summary: { readiness: { ready: true } } },
  })
  const mirror = recordingMirror()
  await mirrorModels(orca, storageHost, { mirror })

  assert.equal(mirror.calls.length, 1)
  assert.equal(mirror.calls[0].mode, 'models-save')
  const payload = JSON.parse(mirror.calls[0].stdin)
  assert.deepEqual(payload, { active: true, ready: true, models })
})

test('mirrorModels: defaults active/ready to false when nothing has been configured or measured yet', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  const mirror = recordingMirror()
  await mirrorModels(orca, storageHost, { mirror })
  const payload = JSON.parse(mirror.calls[0].stdin)
  assert.deepEqual(payload, { active: false, ready: false, models: [] })
})

test('mirrorModels: a failed sidecar call is logged, never thrown', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  const mirror = async () => ({ ok: false, reason: 'launch-failed', detail: 'boom' })
  await mirrorModels(orca, storageHost, { mirror })
  assert.ok(orca._logs.some((line) => line.includes('launch-failed')))
})

// ---------------------------------------------------------------------------
// attendModelsMirrorRequest
// ---------------------------------------------------------------------------

test('attendModelsMirrorRequest: re-mirrors only when the trigger value actually changed', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ [MODELS_MIRROR_REQUEST_KEY]: 't1' })
  const mirror = recordingMirror()
  const lastSeen = { value: null }

  await attendModelsMirrorRequest(orca, storageHost, lastSeen, { mirror })
  assert.equal(mirror.calls.length, 1)

  await attendModelsMirrorRequest(orca, storageHost, lastSeen, { mirror })
  assert.equal(mirror.calls.length, 1, 'an unchanged trigger must not re-mirror')

  await storageHost.set(MODELS_MIRROR_REQUEST_KEY, 't2')
  await attendModelsMirrorRequest(orca, storageHost, lastSeen, { mirror })
  assert.equal(mirror.calls.length, 2, 'a genuinely new trigger must re-mirror')
})

// ---------------------------------------------------------------------------
// publishModelsSeedNotice
// ---------------------------------------------------------------------------

test('publishModelsSeedNotice: reports added and changed items the person can pick from', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: [entry({ id: 'small', rank: 5 })], // "small" differs (rank), "big" is missing entirely
  })
  await publishModelsSeedNotice(orca, storageHost, { seedPayload: fakeSeedPayload() })

  const notice = await storageHost.get(MODELS_SEED_NOTICE_KEY)
  assert.equal(notice.due, true)
  assert.equal(notice.added, 1)
  assert.equal(notice.differing, 1)
  assert.equal(notice.shippedVersion, 2)
  assert.deepEqual(
    notice.items.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'big', label: 'Big', kind: 'added', fields: [] },
      { id: 'small', label: 'Small', kind: 'changed', fields: ['label', 'rank'] },
    ],
  )
})

test('publishModelsSeedNotice: a newer version with nothing to show marks offered and publishes due:false', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ [MODELS_KEY]: SHIPPED_SEED.models })
  await publishModelsSeedNotice(orca, storageHost, { seedPayload: fakeSeedPayload() })

  const notice = await storageHost.get(MODELS_SEED_NOTICE_KEY)
  assert.equal(notice.due, false)
  const offered = await storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY)
  assert.deepEqual(offered, { version: 2 })
})

test('publishModelsSeedNotice: the offered marker is never lowered', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: SHIPPED_SEED.models,
    [MODEL_SEED_OFFERED_VERSION_KEY]: { version: 5 },
  })
  await publishModelsSeedNotice(orca, storageHost, { seedPayload: fakeSeedPayload() })
  const offered = await storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY)
  assert.deepEqual(offered, { version: 5 }, 'a shipped version behind the offered marker must never roll it back')
})

// ---------------------------------------------------------------------------
// attendModelsSeedRequest
// ---------------------------------------------------------------------------

test('attendModelsSeedRequest: apply replaces only the named ids and keeps the person\'s availability', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: [entry({ id: 'small', rank: 9, available: false })],
    [MODELS_SEED_REQUEST_KEY]: { id: 'req-1', at: new Date().toISOString(), action: 'apply', acceptedIds: ['small', 'big'] },
  })
  await attendModelsSeedRequest(orca, storageHost, { seedPayload: fakeSeedPayload(), mirror: noopMirror() })

  const models = await storageHost.get(MODELS_KEY)
  assert.deepEqual(models.map((m) => m.id).sort(), ['big', 'small'])
  const small = models.find((m) => m.id === 'small')
  assert.equal(small.rank, 2, 'the accepted shipped row replaced the stale one')
  assert.equal(small.available, false, 'availability stays the person\'s own choice')

  const result = await storageHost.get(MODELS_SEED_RESULT_KEY)
  assert.equal(result.id, 'req-1')
  assert.equal(result.ok, true)
  assert.equal(result.replaced, 1)
  assert.equal(result.added, 1)

  assert.deepEqual(await storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY), { version: 2 })
  assert.equal((await storageHost.get(MODELS_SEED_NOTICE_KEY)).due, false, 'the notice is republished after applying')
})

test('attendModelsSeedRequest: dismiss changes only the offered version, never the catalog', async () => {
  const orca = fakeOrca()
  const mine = [entry({ id: 'mine-only', rank: 1 })]
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: mine,
    [MODELS_SEED_REQUEST_KEY]: { id: 'req-2', at: new Date().toISOString(), action: 'dismiss', acceptedIds: [] },
  })
  await attendModelsSeedRequest(orca, storageHost, { seedPayload: fakeSeedPayload(), mirror: noopMirror() })

  assert.deepEqual(await storageHost.get(MODELS_KEY), mine, 'dismiss never touches the stored catalog')
  assert.deepEqual(await storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY), { version: 2 })
  const result = await storageHost.get(MODELS_SEED_RESULT_KEY)
  assert.equal(result.id, 'req-2')
  assert.equal(result.ok, true)
})

test('attendModelsSeedRequest: an expired request publishes reason "expired" and changes nothing', async () => {
  const orca = fakeOrca()
  const tenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString()
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: [],
    [MODELS_SEED_REQUEST_KEY]: { id: 'req-3', at: tenMinutesAgo, action: 'apply', acceptedIds: ['big'] },
  })
  await attendModelsSeedRequest(orca, storageHost, { seedPayload: fakeSeedPayload(), mirror: noopMirror() })

  const result = await storageHost.get(MODELS_SEED_RESULT_KEY)
  assert.equal(result.id, 'req-3')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  assert.deepEqual(await storageHost.get(MODELS_KEY), [], 'an expired request must never be attended')
})

// ---------------------------------------------------------------------------
// publishModelMeasurements
// ---------------------------------------------------------------------------

test('publishModelMeasurements: publishes the sidecar result and re-mirrors when readiness flips', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [MODELS_KEY]: [entry({ id: 'sonnet', rank: 1 })],
    [MODELS_CONFIG_KEY]: { active: true },
    // Previously published as NOT ready.
    [MODEL_MEASUREMENTS_KEY]: { ok: true, summary: { readiness: { ready: false } } },
  })
  const mirror = recordingMirror()
  const readSummary = async () => ({ ok: true, summary: { readiness: { ready: true } } })

  await publishModelMeasurements(orca, storageHost, { mirror, readSummary })

  const published = await storageHost.get(MODEL_MEASUREMENTS_KEY)
  assert.equal(published.ok, true)
  assert.equal(published.summary.readiness.ready, true)
  assert.equal(typeof published.checkedAt, 'string')

  assert.equal(mirror.calls.length, 1, 'a readiness flip must trigger exactly one re-mirror')
  const payload = JSON.parse(mirror.calls[0].stdin)
  assert.equal(payload.ready, true)
})

test('publishModelMeasurements: does not re-mirror when readiness is unchanged', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [MODEL_MEASUREMENTS_KEY]: { ok: true, summary: { readiness: { ready: true } } },
  })
  const mirror = recordingMirror()
  const readSummary = async () => ({ ok: true, summary: { readiness: { ready: true } } })

  await publishModelMeasurements(orca, storageHost, { mirror, readSummary })
  assert.equal(mirror.calls.length, 0)
})
