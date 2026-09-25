/**
 * models-worker.mjs — the worker-side orchestration for the model catalog
 * slice (odd/tasks/model-reclassification.md T6): seeding it once, mirroring
 * it out to `<configDir>/models-catalog.json` for the Agent PreToolUse/
 * PostToolUse hooks (adapters/claude/agent-model.ts), offering a newer
 * shipped baseline, and publishing the measurement readout. Pulled out of
 * main.mjs into its own file on purpose -- main.mjs is already the single
 * file every other slice of this plugin touches, and this module's own
 * functions already take their host(s) as plain parameters, the same
 * pattern every other request/attend/publish function in main.mjs already
 * follows (see that file's own header note on host adapters).
 *
 * Every exported function here takes `(orca, storageHost, options)`.
 * `options` is where a caller (main.mjs in production, this file's own test
 * suite otherwise) injects the two dependencies that must cross this
 * worker's own permission sandbox as a spawned sidecar rather than a plain
 * import:
 *
 *   options.mirror(mode, stdin)        -- write-secret-mirror.mjs's
 *                                          'models-save' mode (the same
 *                                          calling convention as main.mjs's
 *                                          own runSecretMirrorScript).
 *   options.readSummary(catalog)       -- read-model-measurements.mjs, fed
 *                                          the stored catalog.
 *
 * Neither has a default here: this file never spawns a child process
 * itself (that plumbing -- PLUGIN_ROOT, CONFIG_DIR, CACHE_DIR, sidecarEnv,
 * execFile permission flags -- already lives in main.mjs and duplicating it
 * here would be exactly the kind of second, driftable copy this codebase's
 * own comments repeatedly warn against). main.mjs passes its real
 * runSecretMirrorScript/runReadModelMeasurementsScript at every call site;
 * every test in models-worker.test.mjs passes a fake instead.
 *
 * `options.seedPayload` and `options.now` DO have real defaults below,
 * because both are things this file can honestly do on its own: reading the
 * plugin's own bundled seed/models.json needs no sidecar (the worker's
 * permission sandbox already allows reading its own plugin root -- see
 * main.mjs's seedPoliciesIfEmpty for the same reasoning applied to
 * seed/policies.json), and "the current time" needs no I/O at all.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRecord } from '../../src/guards.ts'
import { parseModelCatalog, parseModelSeedEntries, parseModelSeedVersion } from '../../src/core/model_catalog.ts'
import {
  applyModelSeedChoices,
  decideModelSeedNotice,
  diffModelSeed,
  MODEL_SEED_MARKER_KEY,
  MODEL_SEED_OFFERED_VERSION_KEY,
  parseModelOfferedVersion,
  shouldSeedModels,
} from '../../src/core/model_seed_notice.ts'

// ---------------------------------------------------------------------------
// Storage keys. `models`/`modelsConfig` are written directly by the config
// panel (T7, not this slice) exactly the way `catalog`/`policies` already
// are -- this worker only ever READS them, through the tolerant parsers
// above, never writes them except for the one-time seed plant below.
// ---------------------------------------------------------------------------

export const MODELS_KEY = 'models'
export const MODELS_CONFIG_KEY = 'modelsConfig'
export const MODELS_MIRROR_REQUEST_KEY = 'modelsMirrorRequest'
export const MODELS_SEED_NOTICE_KEY = 'modelsSeedNotice'
export const MODELS_SEED_REQUEST_KEY = 'modelsSeedRequest'
export const MODELS_SEED_RESULT_KEY = 'modelsSeedResult'
export const MODEL_MEASUREMENTS_KEY = 'modelMeasurements'
// Re-exported so every model-related storage key this plugin owns can be
// imported from one place; model_seed_notice.ts remains the one place that
// DEFINES them (it also owns shouldSeedModels/parseModelOfferedVersion,
// which read the same two keys).
export { MODEL_SEED_MARKER_KEY, MODEL_SEED_OFFERED_VERSION_KEY }

/** Same request/result TTL every other panel-request channel in this plugin
 *  uses (main.mjs's SECRET_REQUEST_TTL_MS) -- kept as this file's own
 *  constant rather than imported, since importing it would mean importing
 *  main.mjs itself, which imports THIS file (models-worker.mjs) to wire it
 *  into activation/runSecretPoll -- a circular import this file must never
 *  create. */
const MODELS_SEED_REQUEST_TTL_MS = 10 * 60 * 1000

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')
const MODELS_SEED_PATH = join(PLUGIN_ROOT, 'seed', 'models.json')

/** `options.now`'s real default: the current time as an ISO string,
 *  wherever this file needs to stamp a record or compute a request's age. A
 *  test can inject a fixed clock instead, the same reasoning src/core's own
 *  pure modules take clock/randomness as explicit parameters for. */
function nowIso (options) {
  return (options.now ?? (() => new Date().toISOString()))()
}

/** `options.seedPayload`'s real default: the plugin's own bundled seed
 *  file, read fresh every call (never cached) so a corrected shipped
 *  baseline in a later release is picked up the moment the plugin updates,
 *  with no worker restart needed beyond the one Orca already does on
 *  upgrade. Throws on a missing/unreadable/malformed file -- every caller
 *  below is already wrapped in a try/catch that logs and does nothing
 *  destructive, the same "retried next tick, costs one log line" contract
 *  seedPoliciesIfEmpty/computePolicySeedNoticeDecision already use for
 *  their own seed file. */
async function readSeedPayload (options) {
  if (typeof options.seedPayload === 'function') return options.seedPayload()
  const raw = await readFile(MODELS_SEED_PATH, 'utf8')
  return JSON.parse(raw)
}

/** Whether the last readout this worker published considered the catalog
 *  "ready" for active mode -- read straight from `modelMeasurements`
 *  (published by publishModelMeasurements below), never recomputed from the
 *  raw log here: that would mean spawning read-model-measurements.mjs on
 *  every mirror write, which is exactly the per-Agent-call cost
 *  model_mirror.ts's own module note says this mirror exists to avoid.
 *  Missing, malformed, or a failed last readout all read as "not ready" --
 *  the same fail-toward-measurement default parseModelsMirror itself uses
 *  for a missing/malformed mirror file. */
async function lastPublishedReady (storageHost) {
  const published = await storageHost.get(MODEL_MEASUREMENTS_KEY)
  return (
    isRecord(published) &&
    published.ok === true &&
    isRecord(published.summary) &&
    isRecord(published.summary.readiness) &&
    published.summary.readiness.ready === true
  )
}

/**
 * Mirrors the current catalog to `<configDir>/models-catalog.json`, for the
 * Agent hooks to read (see model_mirror.ts's ModelsMirror). `active` comes
 * straight from `modelsConfig` (the panel's own on/off switch); `ready`
 * comes from `options.ready` when a caller already knows it (e.g.
 * publishModelMeasurements, which just computed a fresh readout and would
 * otherwise have to read its own just-published value straight back), or
 * from the last published readout otherwise. Never throws: a failed mirror
 * write is logged and returned, exactly like main.mjs's own
 * mirrorCatalogAndPolicies treats a failed catalog-save/policies-save.
 */
export async function mirrorModels (orca, storageHost, options = {}) {
  const [storedModels, storedConfig] = await Promise.all([
    storageHost.get(MODELS_KEY),
    storageHost.get(MODELS_CONFIG_KEY),
  ])
  const models = parseModelCatalog(storedModels)
  const active = isRecord(storedConfig) && storedConfig.active === true
  const ready = typeof options.ready === 'boolean' ? options.ready : await lastPublishedReady(storageHost)

  const result = await options.mirror('models-save', JSON.stringify({ active, ready, models }))
  if (!result.ok) {
    orca.log(`models mirror failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 160)}`)
  }
  return result
}

/**
 * Plants seed/models.json's baseline on an install that has never been
 * offered it and whose catalog is genuinely empty (shouldSeedModels, from
 * model_seed_notice.ts) -- the same "at most once, and only ever onto a
 * blank slate" contract seedPoliciesIfEmpty enforces for the team policies.
 * An existing catalog, empty or not, is left completely untouched when the
 * marker already says this install has seen a seed decision before, or
 * when it holds rows of its own; deciding what to do about a NEWER shipped
 * baseline on top of an untouched catalog is publishModelsSeedNotice's job,
 * not this function's. Never throws: a seed file that cannot be read is
 * retried on the next activation, at the cost of one log line, the same
 * shape as every other seed planter in this plugin.
 */
export async function seedModelsIfEmpty (orca, storageHost, options = {}) {
  try {
    const [marker, stored] = await Promise.all([
      storageHost.get(MODEL_SEED_MARKER_KEY),
      storageHost.get(MODELS_KEY),
    ])
    const existing = parseModelCatalog(stored)
    if (!shouldSeedModels(marker, existing)) return

    const seed = await readSeedPayload(options)
    const entries = parseModelSeedEntries(seed)
    if (entries.length > 0) await storageHost.set(MODELS_KEY, entries)
    await storageHost.set(MODEL_SEED_MARKER_KEY, true)
    // Stored as exactly {version} -- see model_seed_notice.ts's
    // parseModelOfferedVersion and odd/tasks/model-reclassification.md's
    // follow-up R3-003, which this shape satisfies literally.
    await storageHost.set(MODEL_SEED_OFFERED_VERSION_KEY, { version: parseModelSeedVersion(seed) })
    orca.log(`model catalog seed planted: ${entries.length} row(s)`)
  } catch (error) {
    orca.log(`initial model seeding failed: ${String(error?.message ?? error).slice(0, 160)}`)
  }
}

/**
 * Re-mirrors the catalog only when the panel's fire-and-forget trigger
 * value has changed since the last tick that looked at it -- the exact same
 * dedupe shape as main.mjs's own attendCatalogPolicyMirrorRequest, for the
 * exact same reason: the panel already writes `models`/`modelsConfig`
 * straight to storage on save, so this is only a nudge telling the poll
 * loop to re-mirror them, never a request with a result to report back.
 */
export async function attendModelsMirrorRequest (orca, storageHost, lastSeen, options = {}) {
  const request = await storageHost.get(MODELS_MIRROR_REQUEST_KEY)
  if (typeof request !== 'string' || request.length === 0 || request === lastSeen.value) return
  lastSeen.value = request
  await mirrorModels(orca, storageHost, options)
}

/** The `{id, label, kind, fields}` rows the panel needs to let the person
 *  pick which changes to accept -- built from diffModelSeed
 *  (model_seed_notice.ts), never from decideModelSeedNotice's own counts
 *  alone, since those are just the two lengths. An added row carries no
 *  `fields`: nothing on it differs from anything the install already has,
 *  because the install does not have it at all. A changed row's `label` is
 *  the SHIPPED entry's label (what accepting it would replace the row
 *  with), not the person's current one. */
function noticeItems (diff) {
  return [
    ...diff.added.map((row) => ({ id: row.id, label: row.label, kind: 'added', fields: [] })),
    ...diff.differing.map((row) => ({ id: row.id, label: row.seed.label, kind: 'changed', fields: row.fields })),
  ]
}

/** Computes the notice decision fresh from the shipped seed and storage.
 *  Returns `null` (and logs) on any failure to read either, the same
 *  "leave whatever was already published in place" contract as main.mjs's
 *  own computePolicySeedNoticeDecision. */
async function computeModelsSeedNotice (orca, storageHost, options) {
  try {
    const seed = await readSeedPayload(options)
    const shipped = parseModelSeedEntries(seed)
    const shippedVersion = parseModelSeedVersion(seed)
    const [offeredMarker, storedModels] = await Promise.all([
      storageHost.get(MODEL_SEED_OFFERED_VERSION_KEY),
      storageHost.get(MODELS_KEY),
    ])
    const existing = parseModelCatalog(storedModels)
    const offeredVersion = parseModelOfferedVersion(offeredMarker)
    const decision = decideModelSeedNotice({ shippedVersion, offeredVersion, existing, shipped })
    const items = noticeItems(diffModelSeed(existing, shipped))
    return { decision, items }
  } catch (error) {
    orca.log(`model seed notice computation failed: ${String(error?.message ?? error).slice(0, 160)}`)
    return null
  }
}

/**
 * Publishes the baseline-notice status for the panel to render on load --
 * same reason every other *Status/*Notice key in this plugin exists: the
 * panel has no way to compute this itself. Called at activation and again
 * after every seed-request attend, so the panel's very next read already
 * reflects the change. When the decision says `markOffered` (a newer
 * shipped version this install has already seen everything that changed
 * about, i.e. nothing left to show), the offered-version marker is bumped
 * to match and the published status carries `due: false` -- decideModelSeedNotice
 * itself already guarantees `markOffered` and `due` are mutually exclusive,
 * so this never needs to override `due` separately, and the marker is never
 * lowered (decideModelSeedNotice only sets `markOffered` when the shipped
 * version is strictly newer than what was already offered).
 */
export async function publishModelsSeedNotice (orca, storageHost, options = {}) {
  const computed = await computeModelsSeedNotice(orca, storageHost, options)
  if (computed === null) return
  const { decision, items } = computed

  await storageHost.set(MODELS_SEED_NOTICE_KEY, {
    due: decision.due,
    added: decision.added,
    differing: decision.differing,
    shippedVersion: decision.shippedVersion,
    items,
    checkedAt: nowIso(options),
  }).catch((error) => orca.log(`model seed notice publish failed: ${error.message}`))

  if (decision.markOffered) {
    await storageHost.set(MODEL_SEED_OFFERED_VERSION_KEY, { version: decision.shippedVersion })
      .catch((error) => orca.log(`model seed offered-version marker publish failed: ${error.message}`))
  }
}

/**
 * Applies one already-validated (present, TTL-checked) seed request. Split
 * out of attendModelsSeedRequest below only so that function's own
 * try/catch has a single call to wrap -- this is not itself exported.
 *
 * `apply`: only the ids named in `acceptedIds` are replaced/added
 * (applyModelSeedChoices, model_seed_notice.ts -- the only function in this
 * codebase allowed to change a stored model row), the catalog is saved,
 * the offered-version marker is bumped to the shipped version (this
 * install has now seen it, whatever it chose to accept), and the mirror is
 * refreshed so the Agent hooks see the change without waiting for the next
 * poll tick.
 *
 * `dismiss`: touches ONLY the offered-version marker. Exactly like
 * main.mjs's own attendPolicySeedDismissRequest, dismissing a baseline
 * notice is never a way to change a stored row -- it only records that this
 * install has been told about the shipped version and chooses not to act
 * on it, so the notice stops nagging.
 */
async function applyModelsSeedRequest (orca, storageHost, request, options) {
  const seed = await readSeedPayload(options)
  const shipped = parseModelSeedEntries(seed)
  const shippedVersion = parseModelSeedVersion(seed)

  if (request.action === 'apply') {
    const existing = parseModelCatalog(await storageHost.get(MODELS_KEY))
    const acceptedIds = Array.isArray(request.acceptedIds) ? request.acceptedIds.filter((id) => typeof id === 'string') : []
    const { result, replaced, added } = applyModelSeedChoices(existing, shipped, acceptedIds)
    await storageHost.set(MODELS_KEY, result)
    await storageHost.set(MODEL_SEED_OFFERED_VERSION_KEY, { version: shippedVersion })
    await mirrorModels(orca, storageHost, options)
    return { ok: true, replaced, added }
  }
  if (request.action === 'dismiss') {
    await storageHost.set(MODEL_SEED_OFFERED_VERSION_KEY, { version: shippedVersion })
    return { ok: true, replaced: 0, added: 0 }
  }
  return { ok: false, reason: 'invalid-action', detail: `unrecognized action: ${String(request.action).slice(0, 20)}` }
}

/**
 * Attends one pending seed-choice request from the panel -- same
 * request/result/TTL shape as main.mjs's own mod-skills-config channel
 * (delete-on-read, expire after MODELS_SEED_REQUEST_TTL_MS, always publish
 * a result the panel's own wait loop resolves on). Always republishes the
 * notice afterward, whichever action ran, so the panel's next read reflects
 * whatever just changed.
 */
export async function attendModelsSeedRequest (orca, storageHost, options = {}) {
  const request = await storageHost.get(MODELS_SEED_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(MODELS_SEED_REQUEST_KEY).catch((error) =>
    orca.log(`models seed request cleanup failed: ${error.message}`))

  const age = Date.parse(nowIso(options)) - Date.parse(request.at)
  if (!(age >= 0) || age > MODELS_SEED_REQUEST_TTL_MS) {
    await storageHost.set(MODELS_SEED_RESULT_KEY, {
      id: request.id, at: nowIso(options), ok: false, replaced: null, added: null,
      reason: 'expired', detail: 'the request is older than MODELS_SEED_REQUEST_TTL_MS and was never attended.',
    }).catch((err) => orca.log(`models seed result publish failed: ${err.message}`))
    return
  }

  let result
  try {
    result = await applyModelsSeedRequest(orca, storageHost, request, options)
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }

  await storageHost.set(MODELS_SEED_RESULT_KEY, {
    id: request.id,
    at: nowIso(options),
    ok: result.ok,
    replaced: result.replaced ?? null,
    added: result.added ?? null,
    reason: result.reason ?? null,
    detail: result.detail ?? null,
  }).catch((err) => orca.log(`models seed result publish failed: ${err.message}`))

  await publishModelsSeedNotice(orca, storageHost, options)
}

/**
 * Runs the measurement sidecar over the stored catalog and publishes the
 * readout for the panel. If the readiness verdict flipped since the last
 * published readout (either direction -- becoming ready OR losing
 * readiness, e.g. after a long gap with no new decisions changes nothing
 * about comparableCount going backwards, but this stays symmetric on
 * purpose rather than assuming only one direction can happen), the catalog
 * is re-mirrored immediately: `ready` is part of what the Agent PreToolUse
 * hook reads from the mirror file (model_mirror.ts's ModelsMirror) to
 * decide whether active mode may even be considered, and that must not
 * wait for an unrelated mirror trigger to catch up.
 */
export async function publishModelMeasurements (orca, storageHost, options = {}) {
  const catalog = parseModelCatalog(await storageHost.get(MODELS_KEY))
  const previousReady = await lastPublishedReady(storageHost)

  const result = await options.readSummary(catalog)
  if (!result.ok) {
    orca.log(`model measurements summary failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 200)}`)
  }
  await storageHost.set(MODEL_MEASUREMENTS_KEY, { ...result, checkedAt: nowIso(options) })
    .catch((error) => orca.log(`model measurements publish failed: ${error.message}`))

  const nextReady = result.ok && isRecord(result.summary) && isRecord(result.summary.readiness) && result.summary.readiness.ready === true
  if (nextReady !== previousReady) {
    await mirrorModels(orca, storageHost, { ...options, ready: nextReady })
  }
}
