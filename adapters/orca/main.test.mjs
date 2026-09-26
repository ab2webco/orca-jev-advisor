// Exercises the pure request/heartbeat logic in main.mjs directly, against
// fake StorageHost/SecretsHost objects -- these functions already take the
// host as a parameter (see main.mjs's own module note on host adapters), so
// no real Orca process or Electron is needed. See
// odd/tasks/panel-worker-wakeup.md for the task list this backs.

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { DEFAULT_DENY_TIER_SWITCHES, DENY_TOGGLE_KEYS } from '../../src/core/deny_tier_config.ts'
import { GATE_CONSEQUENCE_CEILING } from '../../src/core/decisions.ts'
import { POLICY_SEED_MARKER_KEY, parseSeedPolicies, parseSeedVersion } from '../../src/core/policy_seed.ts'
import { decidePolicySeedNotice } from '../../src/core/policy_seed_notice.ts'

// src/core/paths.ts's resolveConfigDir/resolveCacheDir refuse to compute a
// real path at all under node's test runner unless an explicit override is
// set (see that module's doc) -- main.mjs resolves its own CACHE_DIR/
// CONFIG_DIR unconditionally at module scope on import (this file never
// spawns a real sidecar against them; every test below that could reach
// one passes `noopMirror`, see below). A static `import ... from
// './main.mjs'` is hoisted ahead of any other top-level statement in this
// file, so the override could never be set first that way -- hence the
// plain dynamic import below, after the override is in place.
const PATHS_OVERRIDE_DIR = mkdtempSync(join(tmpdir(), 'orca-jev-main-test-'))
process.env.ORCA_SUPERVISOR_CONFIG_DIR = join(PATHS_OVERRIDE_DIR, 'config')
process.env.ORCA_SUPERVISOR_CACHE_DIR = join(PATHS_OVERRIDE_DIR, 'cache')
after(() => rmSync(PATHS_OVERRIDE_DIR, { recursive: true, force: true }))

const {
  applyOrcaUiLanguageAtActivation,
  attendCatalogProposalAcceptRequest,
  attendCatalogRefreshRequest,
  attendClaudeIntegrationRequest,
  attendDenyTierConfigRequest,
  attendLocaleRequest,
  attendModSkillsConfigRequest,
  attendPolicySeedDismissRequest,
  attendPolicySeedImportRequest,
  attendPolicySeedNoticeRefresh,
  attendSecretRequest,
  CATALOG_PROPOSAL_ACCEPT_RESULT_KEY,
  CATALOG_PROPOSALS_STATUS_KEY,
  CATALOG_REFRESH_RESULT_KEY,
  CLAUDE_INTEGRATION_RESULT_KEY,
  claudeIntegrationResultPayload,
  cmdImportPolicySeeds,
  cmdRefreshCatalog,
  DENY_TIER_CONFIG_RESULT_KEY,
  DENY_TIER_STATUS_KEY,
  deriveCatalogFromOrca,
  deriveInitialCatalogIfEmpty,
  GATE_DEFAULTS_KEY,
  LOCALE_ORCA_SETTING_KEY,
  LOCALE_RESULT_KEY,
  MOD_SKILLS_CONFIG_RESULT_KEY,
  MOD_SKILLS_STATUS_KEY,
  POLICY_SEED_DISMISS_RESULT_KEY,
  POLICY_SEED_IMPORT_RESULT_KEY,
  POLICY_SEED_NOTICE_STATUS_KEY,
  POLICY_SEED_OFFERED_VERSION_KEY,
  publishDenyTierStatus,
  publishGateDefaults,
  publishModSkillsStatus,
  publishPolicySeedNoticeStatus,
  publishWorkerHeartbeat,
  SECRET_RESULT_KEY,
  seedPoliciesIfEmpty,
  spawnSidecar,
  WORKER_HEARTBEAT_KEY
} = await import('./main.mjs')

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

// odd/tasks/production-honesty-pass.md P5 -- install-claude-integration.mjs's
// install() already returns modCopyWarning when the skills-mod copy fails
// even though the rest of the install succeeded; the bug was that the shape
// stored for the panel (`{id, at, ok, reason, detail}`) dropped it on the
// floor, so the panel said "Done." over an install that had not, in fact,
// fully succeeded. claudeIntegrationResultPayload is the exact shaping
// function attendClaudeIntegrationRequest hands to storageHost.set -- pulled
// out and exported so this can be proven without spawning the real
// installer subprocess against this developer's actual ~/.claude.
test('claudeIntegrationResultPayload carries modCopyWarning through -- P5, the panel must not say "Done." over a silently dropped failure', () => {
  const payload = claudeIntegrationResultPayload('ci-2', { ok: true, modCopyWarning: 'copy-failed' })
  assert.equal(payload.id, 'ci-2')
  assert.equal(payload.ok, true)
  assert.equal(payload.modCopyWarning, 'copy-failed')
})

test('claudeIntegrationResultPayload reports modCopyWarning as null when the install had nothing to warn about', () => {
  const payload = claudeIntegrationResultPayload('ci-3', { ok: true })
  assert.equal(payload.modCopyWarning, null)
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

// JEVADV-10 -- odd/tasks/release-0.5.1.md. Orca's own explicit
// settings.uiLanguage (read once at activation, see
// applyOrcaUiLanguageAtActivation below) is authoritative over the panel's
// own navigator-derived guess: a person who set Orca itself to Spanish
// while their OS/browser locale is English must still get Spanish gate
// prompts, even though the panel's own per-open push would otherwise send
// 'en'. Every test here injects `saveLocale` -- the real one spawns a real
// sidecar child, exactly the hazard T9 already hit (see the module note
// above attendModSkillsConfigRequest's own tests).
test('attendLocaleRequest: Orca\'s own concrete setting overrides the panel\'s requested locale', async () => {
  const orca = fakeOrca()
  const saved = []
  const fakeSaveLocale = async (_orca, locale) => { saved.push(locale); return { ok: true } }
  const storageHost = fakeStorageHost({
    [LOCALE_ORCA_SETTING_KEY]: 'es',
    localeRequest: { id: 'loc-2', at: new Date().toISOString(), locale: 'en' }
  })
  await attendLocaleRequest(orca, storageHost, { saveLocale: fakeSaveLocale })
  assert.deepEqual(saved, ['es'], 'Orca\'s own explicit setting must win over the panel\'s navigator guess')
  const result = await storageHost.get(LOCALE_RESULT_KEY)
  assert.equal(result.ok, true)
})

test('attendLocaleRequest: with no concrete Orca setting, the panel\'s requested locale is used as before', async () => {
  const orca = fakeOrca()
  const saved = []
  const fakeSaveLocale = async (_orca, locale) => { saved.push(locale); return { ok: true } }
  const storageHost = fakeStorageHost({
    localeRequest: { id: 'loc-3', at: new Date().toISOString(), locale: 'es' }
  })
  await attendLocaleRequest(orca, storageHost, { saveLocale: fakeSaveLocale })
  assert.deepEqual(saved, ['es'])
})

test('applyOrcaUiLanguageAtActivation: a concrete reading is mirrored and remembered', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  const saved = []
  await applyOrcaUiLanguageAtActivation(orca, storageHost, {
    readOrcaUiLanguage: async () => ({ ok: true, value: 'es' }),
    saveLocale: async (_orca, locale) => { saved.push(locale); return { ok: true } }
  })
  assert.equal(await storageHost.get(LOCALE_ORCA_SETTING_KEY), 'es')
  assert.deepEqual(saved, ['es'])
})

test('applyOrcaUiLanguageAtActivation: "system"/missing/malformed (a successful read with no concrete value) records null and never mirrors anything', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  const saved = []
  await applyOrcaUiLanguageAtActivation(orca, storageHost, {
    readOrcaUiLanguage: async () => ({ ok: true, value: null }),
    saveLocale: async (_orca, locale) => { saved.push(locale); return { ok: true } }
  })
  assert.equal(await storageHost.get(LOCALE_ORCA_SETTING_KEY), null)
  assert.deepEqual(saved, [], 'a non-concrete reading must never mirror a language')
})

test('applyOrcaUiLanguageAtActivation: a read failure leaves the existing marker and mirror completely untouched', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ [LOCALE_ORCA_SETTING_KEY]: 'es' })
  const saved = []
  await applyOrcaUiLanguageAtActivation(orca, storageHost, {
    readOrcaUiLanguage: async () => ({ ok: false, reason: 'launch-failed', detail: 'boom' }),
    saveLocale: async (_orca, locale) => { saved.push(locale); return { ok: true } }
  })
  assert.equal(await storageHost.get(LOCALE_ORCA_SETTING_KEY), 'es', 'a transient read failure must not flip a prior marker to defer')
  assert.deepEqual(saved, [])
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
// Deny tier -- unlike mod-skills above, every failure/malformed-value case
// here must fail CLOSED (all three `true`, still denying), never open. See
// src/core/deny_tier_config.ts's module note.
// ---------------------------------------------------------------------------

test('attendDenyTierConfigRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    denyTierConfigRequest: { id: 'dt-1', at: TEN_MINUTES_AGO, denyRmRf: false, denyDropTable: false, denyTerraformDestroy: false }
  })
  await attendDenyTierConfigRequest(orca, storageHost)
  const result = await storageHost.get(DENY_TIER_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'dt-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  // Expiry must never reach the mirror -- no status republish either.
  assert.equal(await storageHost.get(DENY_TIER_STATUS_KEY), null)
})

test('attendDenyTierConfigRequest: a fresh request saves through the mirror and publishes an ok result', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    denyTierConfigRequest: { id: 'dt-2', at: new Date().toISOString(), denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true }
  })
  const saved = { current: null }
  const mirror = async (mode, stdin) => {
    if (mode === 'deny-tier-config-save') {
      saved.current = JSON.parse(stdin)
      return { ok: true }
    }
    if (mode === 'deny-tier-config-read') {
      return { ok: true, value: saved.current }
    }
    throw new Error(`unexpected mode: ${mode}`)
  }
  await attendDenyTierConfigRequest(orca, storageHost, { mirror })
  const result = await storageHost.get(DENY_TIER_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'dt-2')
  assert.equal(result.ok, true)
  assert.deepEqual(saved.current, { ...DEFAULT_DENY_TIER_SWITCHES, denyRmRf: false })
  const status = await storageHost.get(DENY_TIER_STATUS_KEY)
  assert.equal(status.denyRmRf, false)
  for (const key of DENY_TOGGLE_KEYS.filter((k) => k !== 'denyRmRf')) assert.equal(status[key], true, key)
  assert.equal(typeof status.checkedAt, 'string')
})

test('attendDenyTierConfigRequest: a non-boolean field in the request fails CLOSED to true, never to false', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    denyTierConfigRequest: { id: 'dt-3', at: new Date().toISOString(), denyRmRf: 'no', denyDropTable: 0, denyTerraformDestroy: false }
  })
  const saved = { current: null }
  const mirror = async (mode, stdin) => {
    if (mode === 'deny-tier-config-save') { saved.current = JSON.parse(stdin); return { ok: true } }
    return { ok: true, value: saved.current }
  }
  await attendDenyTierConfigRequest(orca, storageHost, { mirror })
  assert.deepEqual(saved.current, { ...DEFAULT_DENY_TIER_SWITCHES, denyTerraformDestroy: false })
})

test('attendDenyTierConfigRequest: a mirror failure is reported, not silently swallowed as success', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    denyTierConfigRequest: { id: 'dt-4', at: new Date().toISOString(), denyRmRf: false, denyDropTable: false, denyTerraformDestroy: false }
  })
  const mirror = async (mode) => {
    if (mode === 'deny-tier-config-save') return { ok: false, reason: 'exception', detail: 'disk is full' }
    return { ok: false, reason: 'exception', detail: 'disk is full' }
  }
  await attendDenyTierConfigRequest(orca, storageHost, { mirror })
  const result = await storageHost.get(DENY_TIER_CONFIG_RESULT_KEY)
  assert.equal(result.id, 'dt-4')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'exception')
})

test('publishDenyTierStatus: a failed mirror read fails CLOSED to all three true, never throws', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const mirror = async () => ({ ok: false, reason: 'launch-failed', detail: 'boom' })
  await publishDenyTierStatus(orca, storageHost, { mirror })
  const status = await storageHost.get(DENY_TIER_STATUS_KEY)
  for (const key of DENY_TOGGLE_KEYS) assert.equal(status[key], true, key)
})

// Fails closed FIELD BY FIELD, which is what parseDenyTierConfig always
// promised and what this publish path used to contradict: it threw away the
// whole object if any one field was wrong-typed. A wrong-typed field must not
// decide anything for its neighbours -- in either direction.
test('publishDenyTierStatus: a wrong-typed field fails CLOSED for that field alone', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const mirror = async () => ({ ok: true, value: { denyRmRf: 'yes', denyDropTable: null, denyTerraformDestroy: false } })
  await publishDenyTierStatus(orca, storageHost, { mirror })
  const status = await storageHost.get(DENY_TIER_STATUS_KEY)
  assert.equal(status.denyRmRf, true, 'a string is not a boolean, so it stays denying')
  assert.equal(status.denyDropTable, true, 'null is not a boolean, so it stays denying')
  assert.equal(status.denyTerraformDestroy, false, 'a real false is honoured, whatever its neighbours look like')
  const named = ['denyRmRf', 'denyDropTable', 'denyTerraformDestroy']
  for (const key of DENY_TOGGLE_KEYS.filter((k) => !named.includes(k))) {
    assert.equal(status[key], true, `${key} was never mentioned, so it stays denying`)
  }
})

test('publishDenyTierStatus: a well-formed mirror value with one switch off is published as-is', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const mirror = async () => ({ ok: true, value: { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true } })
  await publishDenyTierStatus(orca, storageHost, { mirror })
  const status = await storageHost.get(DENY_TIER_STATUS_KEY)
  assert.equal(status.denyRmRf, false)
  for (const key of DENY_TOGGLE_KEYS.filter((k) => k !== 'denyRmRf')) assert.equal(status[key], true, key)
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

// ---------------------------------------------------------------------------
// JEVADV-11 (odd/tasks/release-0.5.1.md) -- cmdRefreshCatalog only ever
// added a newly-seen worktree with `kind: "project"` hardcoded
// (worktree_catalog.ts's deriveDestinations has nothing else to guess from),
// which is exactly why a real client repository never got "client-site"
// treatment: nothing ever asked. It no longer WRITES anything; it computes
// and publishes a proposal list instead (src/core/catalog_proposals.ts's
// deriveCatalogProposals), and a NEW request/result channel
// (attendCatalogProposalAcceptRequest) is the only path that can add one,
// always with a kind the person explicitly chose. Every test here injects
// `fetchOrcaWorktrees` -- the real one shells out to `orca worktree ps`,
// exactly the hazard T8's own tests above already guard against for
// deriveCatalogFromOrca.
// ---------------------------------------------------------------------------

function fakeWorktreeFetch (worktrees) {
  return async () => ({ worktrees, failure: null })
}

test('cmdRefreshCatalog: proposes an uncatalogued repository without writing it to the catalog', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ catalog: { destinations: [] } })
  const result = await cmdRefreshCatalog(orca, storageHost, {
    fetchOrcaWorktrees: fakeWorktreeFetch([{ repo: 'myparkplanner-be', path: '/Users/dev/Projects/myparkplanner-be' }])
  })
  assert.equal(result.ok, true)
  assert.equal(result.proposed, 1)
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 0, 'a proposal must never be written to the catalog on its own')
  const status = await storageHost.get(CATALOG_PROPOSALS_STATUS_KEY)
  assert.equal(status.ok, true)
  assert.equal(status.proposals.length, 1)
  assert.equal(status.proposals[0].worktreePath, '/Users/dev/Projects/myparkplanner-be')
  assert.equal('kind' in status.proposals[0], false, 'a proposal must never carry a guessed kind')
})

test('cmdRefreshCatalog: a repository the catalog already covers is never proposed', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [{ id: 'cineco-frontend', label: 'cineco-frontend', kind: 'client-site', worktreePath: '/Users/dev/Projects/cineco-frontend', autonomy: {} }] }
  })
  const result = await cmdRefreshCatalog(orca, storageHost, {
    fetchOrcaWorktrees: fakeWorktreeFetch([{ repo: 'cineco-frontend', path: '/Users/dev/Projects/cineco-frontend' }])
  })
  assert.equal(result.ok, true)
  assert.equal(result.proposed, 0)
})

test('attendCatalogProposalAcceptRequest: an expired request publishes reason "expired"', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalogProposalAcceptRequest: { id: 'cpa-1', at: TEN_MINUTES_AGO, accepted: [] }
  })
  await attendCatalogProposalAcceptRequest(orca, storageHost)
  const result = await storageHost.get(CATALOG_PROPOSAL_ACCEPT_RESULT_KEY)
  assert.equal(result.id, 'cpa-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('attendCatalogProposalAcceptRequest: adds only the accepted proposals, each with its chosen kind, and republishes the status', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [] },
    catalogProposalAcceptRequest: {
      id: 'cpa-2', at: new Date().toISOString(),
      accepted: [{ id: 'cineco-backend', kind: 'client-site' }]
    }
  })
  await attendCatalogProposalAcceptRequest(orca, storageHost, {
    mirror: noopMirror,
    fetchOrcaWorktrees: fakeWorktreeFetch([
      { repo: 'cineco-backend', path: '/Users/dev/Projects/cineco-backend' },
      { repo: 'myparkplanner-be', path: '/Users/dev/Projects/myparkplanner-be' }
    ])
  })
  const result = await storageHost.get(CATALOG_PROPOSAL_ACCEPT_RESULT_KEY)
  assert.equal(result.id, 'cpa-2')
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 1)
  assert.equal(catalog.destinations[0].kind, 'client-site')
  assert.equal(catalog.destinations[0].worktreePath, '/Users/dev/Projects/cineco-backend')
  // The accepted repo drops out of the republished proposal list; the other one stays.
  const status = await storageHost.get(CATALOG_PROPOSALS_STATUS_KEY)
  assert.deepEqual(status.proposals.map((p) => p.worktreePath), ['/Users/dev/Projects/myparkplanner-be'])
})

test('attendCatalogProposalAcceptRequest: an entry with an invalid or missing kind is skipped, never written with a guessed one', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [] },
    catalogProposalAcceptRequest: {
      id: 'cpa-3', at: new Date().toISOString(),
      accepted: [{ id: 'myparkplanner-be', kind: 'not-a-real-kind' }]
    }
  })
  await attendCatalogProposalAcceptRequest(orca, storageHost, {
    mirror: noopMirror,
    fetchOrcaWorktrees: fakeWorktreeFetch([{ repo: 'myparkplanner-be', path: '/Users/dev/Projects/myparkplanner-be' }])
  })
  const result = await storageHost.get(CATALOG_PROPOSAL_ACCEPT_RESULT_KEY)
  assert.equal(result.ok, true)
  assert.equal(result.added, 0)
  const catalog = await storageHost.get('catalog')
  assert.equal(catalog.destinations.length, 0)
})

test('attendCatalogProposalAcceptRequest: a stale proposal id (no longer in the live derivation) is ignored, not thrown', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [] },
    catalogProposalAcceptRequest: {
      id: 'cpa-4', at: new Date().toISOString(),
      accepted: [{ id: 'a-repo-that-no-longer-appears', kind: 'project' }]
    }
  })
  await attendCatalogProposalAcceptRequest(orca, storageHost, {
    mirror: noopMirror,
    fetchOrcaWorktrees: fakeWorktreeFetch([])
  })
  const result = await storageHost.get(CATALOG_PROPOSAL_ACCEPT_RESULT_KEY)
  assert.equal(result.ok, true)
  assert.equal(result.added, 0)
})

test('deriveInitialCatalogIfEmpty: the "only when empty" guard leaves an already-populated catalog untouched', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    catalog: { destinations: [{ id: 'x', label: 'x', kind: 'project', worktreePath: '/x', autonomy: {} }] }
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
  assert.ok(Array.isArray(result.differing))
})

test('cmdImportPolicySeeds: reports a differing id without applying it when no ids are accepted', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.equal(result.ok, true)
  assert.equal(result.replaced, 0)
  const entry = result.differing.find((d) => d.id === 'read_and_test')
  assert.ok(entry, 'expected read_and_test to be reported as differing')
  assert.ok(entry.fields.includes('rule'))
  assert.ok(entry.fields.includes('kind'))
  const stored = await storageHost.get('policies')
  const row = stored.find((r) => r.id === 'read_and_test')
  assert.equal(row.rule, 'my own edited rule')
  assert.equal(row.kind, 'prohibits')
})

test('cmdImportPolicySeeds: applies only the explicitly accepted differing ids', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror, acceptedIds: ['read_and_test'] })
  assert.equal(result.ok, true)
  assert.equal(result.replaced, 1)
  const stored = await storageHost.get('policies')
  const row = stored.find((r) => r.id === 'read_and_test')
  assert.equal(row.kind, 'permits')
  assert.notEqual(row.rule, 'my own edited rule')
})

test('cmdImportPolicySeeds: an accepted id absent from this seed run is ignored, not thrown', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror, acceptedIds: ['stale-panel-selection'] })
  assert.equal(result.ok, true)
  assert.equal(result.replaced, 0)
  const stored = await storageHost.get('policies')
  const row = stored.find((r) => r.id === 'read_and_test')
  assert.equal(row.rule, 'my own edited rule')
})

test('attendPolicySeedImportRequest: forwards the request\'s acceptedIds to apply the chosen differences', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }],
    policySeedImportRequest: { id: 'psi-3', at: new Date().toISOString(), acceptedIds: ['read_and_test'] }
  })
  await attendPolicySeedImportRequest(orca, storageHost, { mirror: noopMirror })
  const result = await storageHost.get(POLICY_SEED_IMPORT_RESULT_KEY)
  assert.equal(result.id, 'psi-3')
  assert.equal(result.ok, true)
  assert.equal(result.replaced, 1)
  const stored = await storageHost.get('policies')
  const row = stored.find((r) => r.id === 'read_and_test')
  assert.notEqual(row.rule, 'my own edited rule')
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

// ---------------------------------------------------------------------------
// T2b -- telling an install the shipped baseline moved. See
// odd/tasks/gate-destructive-restore-and-seed-refresh.md and
// src/core/policy_seed_notice.ts for the design; every test below reads the
// REAL shipped seed file, never a fake one, so a version bump or a row edit
// there is exactly what these are meant to catch.
// ---------------------------------------------------------------------------

const REAL_SEED_RAW = JSON.parse(readFileSync(new URL('../../seed/policies.json', import.meta.url), 'utf8'))
const REAL_SEED_ROWS = parseSeedPolicies(REAL_SEED_RAW)
const REAL_SEED_VERSION = parseSeedVersion(REAL_SEED_RAW)

test('seedPoliciesIfEmpty: fresh seeding also marks this install as offered the shipped version', async () => {
  const orca = fakeOrca()
  const host = fakeStorageHost({})

  await seedPoliciesIfEmpty(orca, host)

  const offered = host._store[POLICY_SEED_OFFERED_VERSION_KEY]
  assert.equal(typeof offered?.at, 'string', 'no offered-version marker was written')
  assert.equal(offered.version, REAL_SEED_VERSION)
})

test('seedPoliciesIfEmpty: an install that already had its own policies is NOT marked offered', async () => {
  // This is exactly the install policy_seed_notice.ts exists for: one that
  // upgraded into this code holding its own rules. Marking it offered here
  // would make parseOfferedVersion read it as already caught up, and the
  // baseline notice would never tell it anything.
  const orca = fakeOrca()
  const mine = [{ id: 'mine', kind: 'prohibits', rule: 'my own rule' }]
  const host = fakeStorageHost({ policies: mine })

  await seedPoliciesIfEmpty(orca, host)

  assert.equal(host._store[POLICY_SEED_OFFERED_VERSION_KEY], undefined,
    'an install that already had policies was marked offered, so it will never be told about the baseline')
})

test('cmdImportPolicySeeds: a successful import marks this install as offered the shipped version', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.equal(result.ok, true)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION)
})

test('cmdImportPolicySeeds: marks this install as offered even when nothing was added or replaced', async () => {
  // Importing with the full shipped seed already stored (added===0,
  // replaced===0) is still a successful import: the install has seen this
  // version, whatever it decided to do about it.
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ policies: REAL_SEED_ROWS })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.equal(result.ok, true)
  assert.equal(result.added, 0)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION)
})

test('cmdImportPolicySeeds: a failed import (unreadable seed) never marks this install offered', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost()
  await cmdImportPolicySeeds(orca, storageHost, { seedPath: '/nonexistent/policies.json' })
  assert.equal(await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY), null)
})

// JEVADV-27 -- odd/tasks/release-0.5.1.md. Before this fix,
// cmdImportPolicySeeds bumped POLICY_SEED_OFFERED_VERSION_KEY unconditionally
// on every successful import, so a person who imported the additions but
// left a differing row unticked (exactly what clicking the notice's "Review"
// button does: runPolicySeedImport([]), i.e. this same call with
// acceptedIds: []) silenced the notice for that row forever -- the offered
// marker is never lowered, so it would never come back until the shipped
// version bumped again. The three rows this observed live: "3 added" shown,
// the 3 differing rows never seen again.
test('cmdImportPolicySeeds: an unresolved differing row keeps the notice due, even though additions landed', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror })
  assert.ok(result.added > 0, 'the fixture must add something for this to prove anything')
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, true, 'an unresolved differing row silently marked this install offered')
  assert.equal(status.added, 0, 'the additions are already merged in by the time the status is read again')
  assert.equal(status.differing, 1)
  assert.equal(status.shippedVersion, REAL_SEED_VERSION)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered, null, 'the offered marker must not move while a differing row is still unticked')
})

test('cmdImportPolicySeeds: accepting every differing id settles the notice and marks the install offered', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror, acceptedIds: ['read_and_test'] })
  assert.equal(result.replaced, 1)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, false, 'every differing row was resolved, so nothing is left to show')
  assert.equal(status.differing, 0)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION)
})

test('cmdImportPolicySeeds: result.differing reports only the rows still unresolved after this apply, not the original pre-apply list', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [
      { id: 'read_and_test', rule: 'my own edited rule a', kind: 'prohibits' },
      { id: 'own_branch', rule: 'my own edited rule b', kind: 'prohibits' }
    ]
  })
  const result = await cmdImportPolicySeeds(orca, storageHost, { mirror: noopMirror, acceptedIds: ['read_and_test'] })
  assert.equal(result.differing.some((d) => d.id === 'read_and_test'), false, 'an accepted, now-matching id must drop out of the reported list')
  assert.ok(result.differing.some((d) => d.id === 'own_branch'), 'an unaccepted, still-differing id must stay reported')
})

test('attendPolicySeedImportRequest: reviewing with no accepted ids (the notice\'s Review button) leaves a real difference due', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }],
    policySeedImportRequest: { id: 'psi-4', at: new Date().toISOString(), acceptedIds: [] }
  })
  await attendPolicySeedImportRequest(orca, storageHost, { mirror: noopMirror })
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, true, 'opening Review and accepting nothing must not silence the notice')
  assert.equal(await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY), null)
})

test('publishPolicySeedNoticeStatus: an install offered nothing before, with real added counts, is due', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  const expected = decidePolicySeedNotice({
    shippedVersion: REAL_SEED_VERSION, offeredVersion: 0, existing: [], shipped: REAL_SEED_ROWS
  })
  assert.equal(status.due, expected.due)
  assert.equal(status.added, expected.added)
  assert.equal(status.differing, expected.differing)
  assert.equal(status.shippedVersion, REAL_SEED_VERSION)
  assert.ok(status.added > 0, 'the shipped seed is empty, so this proves nothing')
  assert.equal(typeof status.at, 'string')
})

test('publishPolicySeedNoticeStatus: already offered the shipped version is never due, whatever the counts', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    [POLICY_SEED_OFFERED_VERSION_KEY]: { version: REAL_SEED_VERSION, at: new Date().toISOString() },
    policies: [{ id: 'read_and_test', rule: 'edited long ago', kind: 'prohibits' }]
  })
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, false)
})

test('publishPolicySeedNoticeStatus: nothing new for THIS install marks it offered even though it never asked', async () => {
  // The shipped rows are already exactly what this install has -- a version
  // bump with nothing to say to this particular machine.
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ policies: REAL_SEED_ROWS })
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, false)
  assert.equal(status.added, 0)
  assert.equal(status.differing, 0)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION, 'a no-op gap must still mark the install offered')
})

test('publishPolicySeedNoticeStatus: an unreadable seed leaves the previous status untouched rather than guessing', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({ [POLICY_SEED_NOTICE_STATUS_KEY]: { due: true, added: 1, differing: 0, shippedVersion: 1, at: 'before' } })
  await publishPolicySeedNoticeStatus(orca, storageHost, { seedPath: '/nonexistent/policies.json' })
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.at, 'before', 'a failed computation overwrote the previous status instead of leaving it alone')
})

test('attendPolicySeedDismissRequest: an expired request publishes reason "expired" and marks nothing', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policySeedDismissRequest: { id: 'psd-1', at: TEN_MINUTES_AGO }
  })
  await attendPolicySeedDismissRequest(orca, storageHost)
  const result = await storageHost.get(POLICY_SEED_DISMISS_RESULT_KEY)
  assert.equal(result.id, 'psd-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
  assert.equal(await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY), null)
})

test('attendPolicySeedDismissRequest: a fresh request marks the shipped version offered and republishes a not-due status', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }],
    policySeedDismissRequest: { id: 'psd-2', at: new Date().toISOString() }
  })
  await attendPolicySeedDismissRequest(orca, storageHost)
  const result = await storageHost.get(POLICY_SEED_DISMISS_RESULT_KEY)
  assert.equal(result.id, 'psd-2')
  assert.equal(result.ok, true)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.due, false, 'dismissing did not clear the notice')
  // Dismissing never touches stored policies -- only merge-by-id (via
  // applyPolicySeedChoices, from an explicit accept) may ever do that.
  const stored = await storageHost.get('policies')
  assert.equal(stored[0].rule, 'my own edited rule')
})

test('attendPolicySeedNoticeRefresh: recomputes but only republishes when the decision actually changed', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  const lastPublished = { value: null }

  await attendPolicySeedNoticeRefresh(orca, storageHost, lastPublished)
  const first = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.ok(first, 'the first tick never published anything')

  // Overwrite with a sentinel and tick again with nothing changed: an
  // unconditional publisher would clobber the sentinel; the dedupe must not.
  await storageHost.set(POLICY_SEED_NOTICE_STATUS_KEY, { ...first, at: 'sentinel' })
  await attendPolicySeedNoticeRefresh(orca, storageHost, lastPublished)
  const second = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(second.at, 'sentinel', 'an unchanged decision was republished anyway')

  // Now change the underlying data (an import happened) and tick again: the
  // dedupe must let the new decision through.
  await storageHost.set('policies', REAL_SEED_ROWS)
  await attendPolicySeedNoticeRefresh(orca, storageHost, lastPublished)
  const third = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.notEqual(third.at, 'sentinel', 'a genuinely changed decision was not republished')
  assert.equal(third.added, 0)
})

/** A storage host whose writes to one key reject, as a full or locked store would. */
function storageFailingOn (failingKey, initial) {
  const host = fakeStorageHost(initial)
  const set = host.set
  host.set = async (key, value) => {
    if (key === failingKey) throw new Error(`simulated write failure on ${key}`)
    return set(key, value)
  }
  return host
}

test('attendPolicySeedDismissRequest: a marker write that fails is reported as not ok, never as dismissed', async () => {
  const orca = fakeOrca()
  const storageHost = storageFailingOn(POLICY_SEED_OFFERED_VERSION_KEY, {
    policySeedDismissRequest: { id: 'psd-3', at: new Date().toISOString() }
  })
  await attendPolicySeedDismissRequest(orca, storageHost)
  const result = await storageHost.get(POLICY_SEED_DISMISS_RESULT_KEY)
  assert.equal(result.id, 'psd-3')
  assert.equal(result.ok, false, 'the panel was told the dismiss worked although nothing was recorded')
  assert.equal(result.reason, 'marker-write-failed')
})

test('attendPolicySeedNoticeRefresh: a status write that fails is retried on the next tick, not deduped away', async () => {
  const orca = fakeOrca()
  const failing = storageFailingOn(POLICY_SEED_NOTICE_STATUS_KEY, {})
  const lastPublished = { value: null }
  await attendPolicySeedNoticeRefresh(orca, failing, lastPublished)
  assert.equal(await failing.get(POLICY_SEED_NOTICE_STATUS_KEY), null)
  // Same decision, storage healthy again: the tick must write it now.
  const healthy = fakeStorageHost({})
  await attendPolicySeedNoticeRefresh(orca, healthy, lastPublished)
  assert.ok(await healthy.get(POLICY_SEED_NOTICE_STATUS_KEY), 'a failed write was remembered as published')
})

test('publishPolicySeedNoticeStatus: an offered marker ahead of the shipped version is never lowered', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: REAL_SEED_ROWS,
    [POLICY_SEED_OFFERED_VERSION_KEY]: { version: REAL_SEED_VERSION + 5, at: 'later release' }
  })
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const offered = await storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY)
  assert.equal(offered.version, REAL_SEED_VERSION + 5, 'a downgrade lowered the offered marker')
})

test('policySeedNoticeStatus carries only what the panel renders', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({})
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.deepEqual(Object.keys(status).sort(), ['added', 'at', 'differing', 'differingItems', 'due', 'shippedVersion'])
})

// JEVADV-27 -- the differing rows themselves, not just their count, so the
// panel can render the tick list straight from this status on every load
// instead of only right after a live import request/result round trip (the
// only place they used to be available at all -- see config.html's
// renderPolicySeedDiffs and its caller before this fix).
test('policySeedNoticeStatus carries the real differing rows, not just their count', async () => {
  const orca = fakeOrca()
  const storageHost = fakeStorageHost({
    policies: [{ id: 'read_and_test', rule: 'my own edited rule', kind: 'prohibits' }]
  })
  await publishPolicySeedNoticeStatus(orca, storageHost)
  const status = await storageHost.get(POLICY_SEED_NOTICE_STATUS_KEY)
  assert.equal(status.differing, 1)
  assert.equal(status.differingItems.length, 1)
  assert.equal(status.differingItems[0].id, 'read_and_test')
  assert.ok(Array.isArray(status.differingItems[0].fields) && status.differingItems[0].fields.length > 0)
})

// ---------------------------------------------------------------------------
// spawnSidecar -- the generic helper every real sidecar call in this file
// shares (runSecretMirrorScript, runReadModelMeasurementsScript). The defect
// this closes: writing to a spawned child's stdin after it has already
// exited (or never reads it) emits an unhandled 'error' (EPIPE, most often)
// on the stream. With no listener, that is an uncaught exception that
// crashes the whole background worker -- gate, board, mods and secrets all
// share this one process.
// ---------------------------------------------------------------------------

const spawnSidecarTempDirs = []
after(() => {
  for (const dir of spawnSidecarTempDirs) rmSync(dir, { recursive: true, force: true })
})

test('spawnSidecar settles an ordinary failure, never an unhandled error, when the child exits before reading stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-spawn-sidecar-epipe-test-'))
  spawnSidecarTempDirs.push(dir)
  const script = join(dir, 'exits-without-reading-stdin.mjs')
  // Exits immediately, before Node ever drains stdin, so the write below is
  // guaranteed to land on an already-closed pipe.
  writeFileSync(script, 'process.exit(0)\n', 'utf8')
  // Larger than any OS pipe buffer, so the write cannot complete in one
  // syscall before the child's end of the pipe is gone -- deterministic
  // EPIPE, not a timing-dependent flake.
  const oversizedPayload = 'x'.repeat(2 * 1024 * 1024)
  const result = await spawnSidecar([script], { timeout: 5000, maxBuffer: 64 * 1024 }, oversizedPayload)
  assert.equal(result.ok, false)
})
