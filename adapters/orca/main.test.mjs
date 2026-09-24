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
  attendModSkillsConfigRequest,
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
  MOD_SKILLS_CONFIG_RESULT_KEY,
  MOD_SKILLS_STATUS_KEY,
  POLICY_SEED_IMPORT_RESULT_KEY,
  publishGateDefaults,
  publishModSkillsStatus,
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
// T10 -- the skills mod's `active`/`activeTools` switches were wired only to
// Claude Code's `options`, which this repo never populates (no `userConfig`
// declared anywhere), so both were permanently unreachable. This channel
// mirrors them to the plugin's own config file, the same request/result/TTL
// shape as locale/catalog-refresh/policy-import above. The real save/read
// both go through write-secret-mirror.mjs, a real child process that writes
// to the ACTUAL machine's CONFIG_DIR -- exactly the hazard T9 already hit --
// so every test that can reach a successful save/read MUST inject a fake
// `options.mirror`, never let the real sidecar run. See
// odd/tasks/panel-worker-wakeup.md.
// ---------------------------------------------------------------------------

test('attendModSkillsConfigRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    modSkillsConfigRequest: { id: 'msc-1', at: TEN_MINUTES_AGO, active: true, activeTools: true }
  })
  await attendModSkillsConfigRequest(orca, storageHost)
  const result = await storageHost.get(MOD_SKILLS_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'msc-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  // Expiry must never reach the mirror -- no status republish either.
  assert.equal(await storageHost.get(MOD_SKILLS_STATUS_KEY), null)
})

test('attendModSkillsConfigRequest: a fresh request saves through the mirror and publishes an ok result', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    modSkillsConfigRequest: { id: 'msc-2', at: new Date().toISOString(), active: true, activeTools: false }
  })
  const saved = { current: null }
  const mirror = async (mode, stdin) => {
    if (mode === 'mod-skills-config-save') {
      saved.current = JSON.parse(stdin)
      return { ok: true }
    }
    if (mode === 'mod-skills-config-read') {
      return { ok: true, value: saved.current }
    }
    throw new Error(`unexpected mode: ${mode}`)
  }
  await attendModSkillsConfigRequest(orca, storageHost, { mirror })
  const result = await storageHost.get(MOD_SKILLS_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'msc-2')
  assert.equal(result.ok, true)
  assert.deepEqual(saved.current, { active: true, activeTools: false })
  // The status mirror is republished from what was actually saved, so the
  // panel's next read reflects it without a second round trip.
  const status = await storageHost.get(MOD_SKILLS_STATUS_KEY)
  assert.equal(status.active, true)
  assert.equal(status.activeTools, false)
  assert.equal(typeof status.checkedAt, 'string')
})

test('attendModSkillsConfigRequest: a non-boolean field in the request is treated as false, never crashes', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    modSkillsConfigRequest: { id: 'msc-3', at: new Date().toISOString(), active: 'yes', activeTools: 1 }
  })
  const saved = { current: null }
  const mirror = async (mode, stdin) => {
    if (mode === 'mod-skills-config-save') { saved.current = JSON.parse(stdin); return { ok: true } }
    return { ok: true, value: saved.current }
  }
  await attendModSkillsConfigRequest(orca, storageHost, { mirror })
  assert.deepEqual(saved.current, { active: false, activeTools: false })
})

test('attendModSkillsConfigRequest: a mirror failure is reported, not silently swallowed as success', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    modSkillsConfigRequest: { id: 'msc-4', at: new Date().toISOString(), active: true, activeTools: true }
  })
  const mirror = async (mode) => {
    if (mode === 'mod-skills-config-save') return { ok: false, reason: 'exception', detail: 'disk is full' }
    return { ok: false, reason: 'exception', detail: 'disk is full' }
  }
  await attendModSkillsConfigRequest(orca, storageHost, { mirror })
  const result = await storageHost.get(MOD_SKILLS_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'msc-4')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'exception')
})

test('publishModSkillsStatus: a failed mirror read normalizes to both switches off, never throws', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const mirror = async () => ({ ok: false, reason: 'launch-failed', detail: 'boom' })
  await publishModSkillsStatus(orca, storageHost, { mirror })
  const status = await storageHost.get(MOD_SKILLS_STATUS_KEY)
  assert.equal(status.active, false)
  assert.equal(status.activeTools, false)
})

test('publishModSkillsStatus: a malformed mirror value (wrong types) normalizes to both switches off', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const mirror = async () => ({ ok: true, value: { active: 'yes', activeTools: null } })
  await publishModSkillsStatus(orca, storageHost, { mirror })
  const status = await storageHost.get(MOD_SKILLS_STATUS_KEY)
  assert.equal(status.active, false)
  assert.equal(status.activeTools, false)
})

// ---------------------------------------------------------------------------
// T8 -- "the CLI could not be found or errored" must never be reported the
// same way as "the CLI ran and found nothing to add" (see cmdRefreshCatalog's
// own module note). deriveCatalogFromOrca now shells out for real, through
// the same cross-platform helper as the other two call sites (see
// src/core/orca_cli.ts and src/core/orca_cli.test.ts for the Windows/shell
// contract itself); it takes no injectable runCommand, so these force a real,
// deterministic failure by clearing PATH for the duration of the call rather
// than stubbing the child process. See odd/tasks/panel-worker-wakeup.md.
// ---------------------------------------------------------------------------

/** Runs `fn` with PATH cleared, so a bare command name genuinely ENOENTs
 *  instead of depending on whatever happens to be on this machine or this
 *  developer's shell -- restores PATH afterwards no matter what. */
async function withoutPath (fn) {
  const savedPath = process.env.PATH
  process.env.PATH = ''
  try {
    return await fn()
  } finally {
    process.env.PATH = savedPath
  }
}

test('deriveCatalogFromOrca: reports a real failure detail instead of a fake empty success', async () => {
  const orca = fakeOrca()
  const result = await withoutPath(() => deriveCatalogFromOrca(orca))
  assert.equal(result.destinations.length, 0)
  assert.ok(typeof result.failure === 'string' && result.failure.length > 0, 'no failure detail was reported')
  assert.match(result.failure, /ENOENT/)
})

test('cmdRefreshCatalog: surfaces derivation-failed instead of reporting success with zero additions', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ catalog: { destinations: [] } })
  const result = await withoutPath(() => cmdRefreshCatalog(orca, storageHost))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'derivation-failed')
  assert.equal(result.added, undefined)
})

test('deriveInitialCatalogIfEmpty: the "only when empty" guard leaves an already-populated catalog untouched', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [{ id: 'x', label: 'x', kind: 'project', worktreePath: '/x', autonomy: { actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2 } }] }
  })
  await withoutPath(() => deriveInitialCatalogIfEmpty(orca, storageHost))
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 1)
})

test('deriveInitialCatalogIfEmpty: stays non-throwing and leaves the catalog empty when the CLI cannot be found', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ catalog: { destinations: [] } })
  await withoutPath(() => deriveInitialCatalogIfEmpty(orca, storageHost))
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

test('policies already on the machine are never overwritten', async () => {
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
