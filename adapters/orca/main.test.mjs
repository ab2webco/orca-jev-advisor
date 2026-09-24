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
  attendPolicySeedImportRequest,
  attendSecretRequest,
  CATALOG_REFRESH_RESULT_KEY,
  CLAUDE_INTEGRATION_RESULT_KEY,
  cmdImportPolicySeeds,
  cmdRefreshCatalog,
  deriveCatalogFromOrca,
  deriveInitialCatalogIfEmpty,
  GATE_DEFAULTS_KEY,
  LOCALE_RESULT_KEY,
  POLICY_SEED_IMPORT_RESULT_KEY,
  publishGateDefaults,
  publishWorkerHeartbeat,
  SECRET_RESULT_KEY,
  WORKER_HEARTBEAT_KEY
} from './main.mjs'

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

// cmdImportPolicySeeds/cmdRefreshCatalog's real `mirrorCatalogAndPolicies`
// spawns a real child process that writes to the ACTUAL machine's
// CONFIG_DIR (~/.config/orca-supervisor), regardless of which storageHost is
// passed to it -- it is never scoped to the fake host above. Every test that
// can reach `added > 0` MUST override it with this no-op, or it silently
// overwrites this developer's own real catalog.json/policies.json on disk.
function noopMirror () { return Promise.resolve() }

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
// T8 -- the CLI resolution must be derived from process.execPath (never a
// hardcoded install path), and "the CLI could not be found" must never be
// reported the same way as "the CLI ran and found nothing". See
// odd/tasks/panel-worker-wakeup.md.
// ---------------------------------------------------------------------------

function enoentError (command) {
  const error = new Error(`spawn ${command} ENOENT`)
  error.code = 'ENOENT'
  return error
}

const DARWIN_EXEC_PATH = '/Applications/Orca.app/Contents/MacOS/Orca'

test('deriveCatalogFromOrca: every candidate missing reports orca-cli-not-found, not an empty success', async () => {
  const orca = fakeOrca()
  const calls = []
  const result = await deriveCatalogFromOrca(orca, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async (command) => { calls.push(command); throw enoentError(command) }
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'orca-cli-not-found')
  // Both candidates (the bundled path derived from execPath, then the bare
  // PATH fallback) must actually have been tried, in that order.
  assert.deepEqual(calls, ['/Applications/Orca.app/Contents/Resources/bin/orca', 'orca'])
})

test('deriveCatalogFromOrca: falls through a missing bundled path to a bare "orca" that is actually on PATH', async () => {
  const orca = fakeOrca()
  const payload = JSON.stringify({ id: 1, ok: true, result: { worktrees: [{ repo: 'demo', path: '/Users/dev/demo' }] } })
  const result = await deriveCatalogFromOrca(orca, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async (command) => {
      if (command === 'orca') return { stdout: payload }
      throw enoentError(command)
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.destinations.length, 1)
  assert.equal(result.destinations[0].worktreePath, '/Users/dev/demo')
})

test('deriveCatalogFromOrca: a candidate that is found but errors reports orca-cli-failed, not orca-cli-not-found', async () => {
  const orca = fakeOrca()
  const result = await deriveCatalogFromOrca(orca, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async () => { throw new Error('Command failed: exit code 1') }
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'orca-cli-failed')
})

test('cmdRefreshCatalog: surfaces orca-cli-not-found instead of reporting success with zero additions', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ catalog: { destinations: [] } })
  const result = await cmdRefreshCatalog(orca, storageHost, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async (command) => { throw enoentError(command) }
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'orca-cli-not-found')
  assert.equal(result.added, undefined)
})

test('deriveInitialCatalogIfEmpty: the "only when empty" guard skips derivation entirely -- runCommand is never called', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [{ id: 'x', label: 'x', kind: 'project', worktreePath: '/x', autonomy: { actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2 } }] }
  })
  await deriveInitialCatalogIfEmpty(orca, storageHost, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async () => { throw new Error('must not be called: the catalog was not empty') }
  })
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 1)
})

test('deriveInitialCatalogIfEmpty: stays non-throwing and leaves the catalog empty when the CLI cannot be found', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ catalog: { destinations: [] } })
  await deriveInitialCatalogIfEmpty(orca, storageHost, {
    execPath: DARWIN_EXEC_PATH,
    platform: 'darwin',
    runCommand: async (command) => { throw enoentError(command) }
  })
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 0)
})

// ---------------------------------------------------------------------------
// T9 -- seed/policies.json ships with the plugin but nothing could import
// it; adding it must merge by id and never clobber an existing row. See
// odd/tasks/panel-worker-wakeup.md.
// ---------------------------------------------------------------------------

test('cmdImportPolicySeeds: imports the real shipped seed policies into an empty store', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.equal(result.ok, true)
  assert.ok(result.added > 0)
  assert.equal(result.skipped, 0)
  const stored = await storageHost.get('policies')
  assert.ok(stored.some((row) => row.id === 'read_and_test'))
})

test('cmdImportPolicySeeds: never overwrites a policy id the developer already has', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.equal(result.ok, true)
  const stored = await storageHost.get('policies')
  const row = stored.find((r) => r.id === 'read_and_test')
  assert.equal(row.rule, 'my own edited rule')
  assert.equal(row.kind, 'prohibits')
})

test('cmdImportPolicySeeds: reports a real reason code when the seed file cannot be read', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const result = await cmdImportPolicySeeds(orca, storageHost, { seedPath: '/nonexistent/policies.json' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'seed-unavailable')
  // Never partially written on failure.
  assert.equal(await storageHost.get('policies'), null)
})

test('attendPolicySeedImportRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policySeedImportRequest: { id: 'psi-1', at: TEN_MINUTES_AGO }
  })
  await attendPolicySeedImportRequest(orca, storageHost)
  const result = await storageHost.get(POLICY_SEED_IMPORT_RESULT_KEY)
  assert.equal(result.id, 'psi-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('attendPolicySeedImportRequest: a fresh request imports the seeds and publishes an ok result', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policySeedImportRequest: { id: 'psi-2', at: new Date().toISOString() }
  })
  await attendPolicySeedImportRequest(orca, storageHost, { mirror: noopMirror })
  const result = await storageHost.get(POLICY_SEED_IMPORT_RESULT_KEY)
  assert.equal(result.id, 'psi-2')
  assert.equal(result.ok, true)
  assert.ok(result.added > 0)
})
