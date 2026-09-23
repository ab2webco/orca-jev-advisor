/**
 * Jev Advisor — Orca plugin worker entry point.
 *
 * Runs in Orca's out-of-process worker (plain Node, forked with
 * ELECTRON_RUN_AS_NODE, no Electron, no inherited shell env). This is the
 * real host contract, verified against orca-wa-inbox/main.mjs -- a working,
 * installed plugin on this machine -- rather than assumed from the API
 * method list alone:
 *
 *   - `export default function activate(orca) { ... }`: a DEFAULT export,
 *     SYNCHRONOUS (not async), returning a teardown function that clears
 *     every timer and subscription it started.
 *   - `orca.events.on(name, cb)` -- not `.subscribe`.
 *   - `await orca.host.call('<method>', { ...args })` for every host method:
 *     `notifications.show`, `storage.get`/`storage.set`/`storage.delete`/
 *     `storage.keys`, `secrets.get`/`secrets.set`/`secrets.delete`,
 *     `settings.get`/`settings.set`. `storage.get`/`secrets.get` resolve to
 *     `{ value }`; `storage.keys` resolves to `{ keys }`; the rest resolve
 *     to `{ ok: true }`.
 *   - `orca.commands.register(id, async (args) => ...)`.
 *   - `orca.log('...')` -- there is no console in the worker.
 *
 * Workers are lazy and disposable: Orca forks one on a command invocation
 * or a subscribed event, reaps it after 5 minutes idle, and kills it if
 * events pile up unacked. Nothing in this module keeps state in memory
 * across calls -- every read and write goes through storage
 * (src/core/store.ts), so a killed-and-restarted worker picks up exactly
 * where the last one left off. Storage is also the ONLY channel to the
 * panels: they never call the worker directly, only `storage.get`/
 * `storage.set` through the postMessage bridge (see panels/board.html and
 * panels/config.html).
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callJev, JevRequestError, JevTimeoutError } from '../../src/core/jev.ts'
import {
  buildDestinationRiskQuestions,
  buildDestinationState,
  buildPolicyQuestions,
  decideDestination,
  interpretDestinationPolicy
} from '../../src/core/decisions.ts'
import { resolveApiKey, SECRET_KEY_NAME } from '../../src/core/secrets.ts'
import { getBoard, getCatalog, getConfig, getPolicies, setBoard } from '../../src/core/store.ts'
import { recordDecision } from '../../src/core/log.ts'
import { DEFAULT_LOCALE, parseLocaleFile, translate } from '../../src/core/i18n.ts'
import { ADVISOR_CATALOG } from '../../src/core/i18n_advisor.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'
import { ORCA_USER_DATA_ENV, claudeAccountsDir, homeConfigTarget, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'

// Every sidecar below (write-secret-mirror.mjs, install-claude-integration.mjs,
// read-measurements.mjs) is spawned with an explicit `--permission` sandbox
// instead of relying on whatever this worker process itself happens to run
// under: measured live, a sidecar spawned with no explicit grants of its own
// inherits a permission model scoped to PLUGIN_ROOT only, and every one of
// these sidecars touches paths outside it (the cache dir, the config dir,
// `~/.claude`, Orca's per-account Claude config roots) -- so without this it
// fails with "Access to this API has been restricted", not a clean error, a
// silent-looking one instead ({ok:false, reason:'exception', detail: the
// permission message}). Being explicit here is also just correct least
// privilege: each sidecar gets exactly the directories its own docstring
// says it touches, on purpose, rather than by accident of inheritance.
const PLATFORM = normalizePlatform(process.platform)
const HOME_PATHS = { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA }
const CACHE_DIR = resolveCacheDir(PLATFORM, HOME_PATHS)
const CONFIG_DIR = resolveConfigDir(PLATFORM, HOME_PATHS)
// Claude Code's own config roots the install sidecar writes into -- see
// src/core/orca_accounts.ts. `claudeAccountsDir` is one parent directory
// covering every Orca-managed account, so granting it once is enough; the
// sidecar itself discovers which account subdirectories actually exist.
const CLAUDE_HOME_DIR = homeConfigTarget(PLATFORM, HOME_PATHS.home).configDir
const ORCA_USER_DATA_DIR = resolveOrcaUserDataDir(PLATFORM, { home: HOME_PATHS.home, appDataDir: HOME_PATHS.appDataDir, xdgConfigHome: process.env.XDG_CONFIG_HOME, orcaUserDataPath: process.env[ORCA_USER_DATA_ENV] }).path
const CLAUDE_ACCOUNTS_DIR = claudeAccountsDir(PLATFORM, ORCA_USER_DATA_DIR)

const DEFAULT_CONTEXT = 'Worktree de Orca gestionado por orca-jev-advisor.'

// ---------------------------------------------------------------------------
// Secret mirror -- keeps ~/.config/orca-supervisor/env (the fallback the CLI
// tools and adapters/claude/gate-bash.ts read; see src/core/secrets.ts) in
// sync with whatever is in `secrets`, so the panel stays the ONE place the
// user types the key and every consumer agrees on it.
//
// The worker cannot write that file itself -- measured, not assumed: its
// permission sandbox only allows reading its own plugin root, and writing
// there threw rather than resolving. write-secret-mirror.mjs runs as a
// clean child instead: the older design routed through `/usr/bin/env -u
// NODE_OPTIONS` (orca-wa-inbox's own pattern for exactly this class of
// problem), which does not exist on Windows -- orca-wa-inbox's own docs
// say so ("se lanza directo y el hijo queda vallado"). `sidecarEnv` below
// gets the same result (a child whose env has no NODE_OPTIONS, the
// variable that could carry the worker's own permission flags to it)
// directly through `execFile`'s own `env` option, with no wrapper binary
// at all -- portable to every platform `execFile` itself runs on. The key
// crosses to that child over stdin only -- never argv (visible to any
// `ps`), never a log line.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET_MIRROR_SCRIPT = join(__dirname, 'write-secret-mirror.mjs')
const SECRET_MIRROR_TIMEOUT_MS = 5000

/** The child's environment, `process.env` with `NODE_OPTIONS` removed (never
 *  just left unset, in case a lower-precedence source of `env` supplied one)
 *  plus whatever the caller adds. No `/usr/bin/env`, no platform branch. */
function sidecarEnv (extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_OPTIONS
  return env
}

const SECRET_MIRROR_READ_ONLY_MODES = new Set(['read', 'locale-read', 'stat'])

function runSecretMirrorScript (mode, stdin, extraArgs = []) {
  return new Promise((resolve) => {
    try {
      const permissionArgs = ['--permission', `--allow-fs-read=${PLUGIN_ROOT}`, `--allow-fs-read=${CONFIG_DIR}`]
      if (!SECRET_MIRROR_READ_ONLY_MODES.has(mode)) permissionArgs.push(`--allow-fs-write=${CONFIG_DIR}`)
      const child = execFile(process.execPath, [...permissionArgs, SECRET_MIRROR_SCRIPT, mode, ...extraArgs], {
        timeout: SECRET_MIRROR_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        // The worker may be Electron's helper binary acting as `process.execPath`;
        // without this it would try to open a window instead of running Node.
        env: sidecarEnv({ ELECTRON_RUN_AS_NODE: '1' })
      }, (error, stdout) => {
        let result = null
        try {
          result = JSON.parse(stdout || 'null')
        } catch {
          result = null
        }
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          resolve({ ok: false, reason: 'no-json', detail: String(error?.message ?? "the script didn't return JSON").slice(0, 200) })
          return
        }
        resolve(result)
      })
      if (typeof stdin === 'string') child.stdin.write(stdin)
      child.stdin.end()
    } catch (error) {
      // The permission sandbox refuses `execFile` in the act, not through the
      // callback, when process:spawn is missing -- same shape orca-wa-inbox
      // already had to guard against.
      resolve({ ok: false, reason: 'launch-failed', detail: String(error?.message ?? error).slice(0, 200) })
    }
  })
}

/** Mirrors the current key (or its absence) to the fallback file. Logs a
 *  failure by reason/detail only -- the key itself never reaches `orca.log`. */
async function mirrorSecretToEnvFile (orca, key) {
  const mode = key === null ? 'clear' : 'save'
  const result = await runSecretMirrorScript(mode, mode === 'save' ? key : undefined)
  if (!result.ok) {
    orca.log(`secret mirror (${mode}) failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 160)}`)
  }
  return result
}

/** Reads the mirror's current key, for the doctor's consistency check. Never logs the value. */
async function readSecretMirror () {
  return runSecretMirrorScript('read')
}

/** Existence and permissions of the mirror file, never the key -- what the config panel's disclosure section shows. */
async function statSecretMirror () {
  return runSecretMirrorScript('stat')
}

// ---------------------------------------------------------------------------
// Catalog and policies -- gate-bash.ts (outside this worker's process, same
// as the key and locale above) needs the destination catalog and team
// policies to decide, but has zero channel into `storage`. Neither is
// secret -- the config panel already shows both in the clear -- so they
// mirror to their own plain-permission JSON files next to the key's env
// file, via the same sidecar and the same clean-child sandbox.
// ---------------------------------------------------------------------------

/** Mirrors the current catalog and policies to their JSON files. Best-effort
 *  on each: a mirror failure is logged, never thrown, so it can never turn
 *  a successful panel save into a reported failure. */
async function mirrorCatalogAndPolicies (orca, storageHost) {
  const [catalog, policies] = await Promise.all([getCatalog(storageHost), getPolicies(storageHost)])
  const catalogResult = await runSecretMirrorScript('catalog-save', JSON.stringify(catalog))
  if (!catalogResult.ok) {
    orca.log(`catalog mirror failed: ${String(catalogResult.reason ?? 'unknown')} -- ${String(catalogResult.detail ?? '').slice(0, 160)}`)
  }
  const policiesResult = await runSecretMirrorScript('policies-save', JSON.stringify(policies))
  if (!policiesResult.ok) {
    orca.log(`policies mirror failed: ${String(policiesResult.reason ?? 'unknown')} -- ${String(policiesResult.detail ?? '').slice(0, 160)}`)
  }
}

// ---------------------------------------------------------------------------
// Locale -- the panel's own message-language choice (not Orca's
// `contributes.languagePacks`; see src/core/i18n.ts for why), mirrored to
// its own plain-text file next to the key's, for gate-bash.ts and
// mod-skills to read directly. Not sensitive, so it crosses via argv, not
// stdin.
// ---------------------------------------------------------------------------

async function saveLocale (orca, locale) {
  const result = await runSecretMirrorScript('locale-save', undefined, [locale])
  if (!result.ok) {
    orca.log(`locale mirror (save) failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 160)}`)
  }
  return result
}

async function readLocaleMirror () {
  return runSecretMirrorScript('locale-read')
}

/** The resolved locale this worker's own text is in right now: the mirrored choice, or DEFAULT_LOCALE when there is none yet or it could not be read. */
async function resolveWorkerLocale () {
  const result = await readLocaleMirror()
  if (result.ok && typeof result.value === 'string') return parseLocaleFile(result.value)
  return DEFAULT_LOCALE
}

// ---------------------------------------------------------------------------
// Claude Code integration -- installs and removes this plugin's OWN side of
// Claude Code: the PreToolUse hook, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, and
// the mod-skills symlink. Before this, all three were hand-wired on one
// machine; installing the plugin elsewhere did nothing (see the feature
// document / T8). Same clean-child pattern as the secret mirror, and for
// the same reason: none of the three live under this worker's own
// permission sandbox.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = join(__dirname, '..', '..')
const CLAUDE_INTEGRATION_SCRIPT = join(__dirname, 'install-claude-integration.mjs')
const CLAUDE_INTEGRATION_TIMEOUT_MS = 8000

function runClaudeIntegrationScript (mode) {
  return new Promise((resolve) => {
    try {
      const permissionArgs = [
        '--permission',
        `--allow-fs-read=${PLUGIN_ROOT}`,
        `--allow-fs-read=${CONFIG_DIR}`,
        `--allow-fs-read=${CLAUDE_HOME_DIR}`,
        `--allow-fs-read=${CLAUDE_ACCOUNTS_DIR}`
      ]
      if (mode !== 'status') {
        permissionArgs.push(`--allow-fs-write=${CONFIG_DIR}`, `--allow-fs-write=${CLAUDE_HOME_DIR}`, `--allow-fs-write=${CLAUDE_ACCOUNTS_DIR}`)
      }
      execFile(process.execPath, [...permissionArgs, CLAUDE_INTEGRATION_SCRIPT, mode, PLUGIN_ROOT], {
        timeout: CLAUDE_INTEGRATION_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: sidecarEnv({ ELECTRON_RUN_AS_NODE: '1' })
      }, (error, stdout) => {
        let result = null
        try {
          result = JSON.parse(stdout || 'null')
        } catch {
          result = null
        }
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          resolve({ ok: false, reason: 'no-json', detail: String(error?.message ?? "the script didn't return JSON").slice(0, 200) })
          return
        }
        resolve(result)
      })
    } catch (error) {
      resolve({ ok: false, reason: 'launch-failed', detail: String(error?.message ?? error).slice(0, 200) })
    }
  })
}

async function installClaudeIntegration (orca) {
  const result = await runClaudeIntegrationScript('install')
  if (!result.ok) {
    orca.log(`claude integration install failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 200)}`)
  } else if (result.modLinkWarning) {
    orca.log(`claude integration install: ${result.modLinkWarning}`)
  }
  return result
}

async function uninstallClaudeIntegration (orca) {
  const result = await runClaudeIntegrationScript('uninstall')
  if (!result.ok) {
    orca.log(`claude integration uninstall failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 200)}`)
  }
  return result
}

async function claudeIntegrationStatus () {
  return runClaudeIntegrationScript('status')
}

// ---------------------------------------------------------------------------
// Measurement aggregation -- adapters/orca/read-measurements.mjs reads and
// sums adapters/claude/gate-bash.ts's and adapters/claude/mod-skills'
// own JSONL logs, both under ~/.cache/orca-supervisor/, outside this
// worker's own permission sandbox. Every number in the result comes from
// counting entries in those two files; nothing here estimates a saved
// dollar, a saved token or a deliberation time -- none of that is
// measured anywhere in this plugin.
// ---------------------------------------------------------------------------

const MEASUREMENTS_SCRIPT = join(__dirname, 'read-measurements.mjs')
const MEASUREMENTS_TIMEOUT_MS = 8000
const MEASUREMENTS_STATUS_KEY = 'measurementsSummary'
const MEASUREMENTS_REFRESH_MS = 15 * 1000

async function readMeasurementsSummary () {
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, ['--permission', `--allow-fs-read=${PLUGIN_ROOT}`, `--allow-fs-read=${CACHE_DIR}`, MEASUREMENTS_SCRIPT], {
        timeout: MEASUREMENTS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: sidecarEnv({ ELECTRON_RUN_AS_NODE: '1' })
      }, (error, stdout) => {
        let result = null
        try {
          result = JSON.parse(stdout || 'null')
        } catch {
          result = null
        }
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          resolve({ ok: false, reason: 'no-json', detail: String(error?.message ?? "the script didn't return JSON").slice(0, 200) })
          return
        }
        resolve(result)
      })
    } catch (error) {
      resolve({ ok: false, reason: 'launch-failed', detail: String(error?.message ?? error).slice(0, 200) })
    }
  })
}

async function publishMeasurementsSummary (orca, storageHost) {
  const summary = await readMeasurementsSummary()
  if (!summary.ok) {
    orca.log(`measurements summary failed: ${String(summary.reason ?? 'unknown')} -- ${String(summary.detail ?? '').slice(0, 200)}`)
  }
  await storageHost.set(MEASUREMENTS_STATUS_KEY, { ...summary, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`measurements summary publish failed: ${error.message}`))
}

// ---------------------------------------------------------------------------
// Secret request/result channel -- sandboxed panels may call ONLY
// `notifications.show`, `storage.get` and `storage.set` over the postMessage
// bridge (`isPluginPanelAction`, orca-oss plugin-host-api.ts /
// plugin-panel-bridge.ts); `secrets.get`/`secrets.set`/`secrets.delete` are
// worker-only. This is the panel's only channel to change the plugin secret:
// it writes a request here and this worker attends it on a timer, same shape
// as orca-wa-inbox's SIDECAR_REQUEST_KEY/SIDECAR_RESULT_KEY pair (two keys,
// not one, because the verdict cannot live inside the request -- the request
// is deleted as soon as it is read).
// ---------------------------------------------------------------------------

const SECRET_REQUEST_KEY = 'secretRequest'
const SECRET_RESULT_KEY = 'secretResult'
const SECRET_STATUS_KEY = 'secretStatus'
const PANEL_SEEN_KEY = 'configPanelSeen'

/** Guards against a request left over from a worker that died mid-attend. */
const SECRET_REQUEST_TTL_MS = 10 * 60 * 1000
/** The panel refreshes PANEL_SEEN_KEY roughly every 2s while open; anything
 *  older than this means nobody is watching the result right now. */
const PANEL_SEEN_FRESH_MS = 5 * 1000
const SECRET_POLL_ACTIVE_MS = 1 * 1000
const SECRET_POLL_IDLE_MS = 15 * 1000

// ---------------------------------------------------------------------------
// Host adapters -- src/core/store.ts and src/core/secrets.ts each declare a
// small interface (StorageHost, SecretsHost) so the same decision logic
// runs against a real host and against a fake one in tests. Here they are
// wired to the one real transport: `orca.host.call(method, params)`.
// ---------------------------------------------------------------------------

function makeStorageHost (orca) {
  return {
    async get (key) {
      const result = await orca.host.call('storage.get', { key })
      return result?.value ?? null
    },
    async set (key, value) {
      await orca.host.call('storage.set', { key, value })
    },
    async delete (key) {
      await orca.host.call('storage.delete', { key })
    },
    async keys () {
      const result = await orca.host.call('storage.keys', {})
      return Array.isArray(result?.keys) ? result.keys : []
    }
  }
}

function makeSecretsHost (orca) {
  return {
    async get (key) {
      const result = await orca.host.call('secrets.get', { key }).catch((error) => {
        orca.log(`secrets.get ${key} failed: ${error.message}`)
        return null
      })
      return result?.value ?? null
    },
    async set (key, value) {
      await orca.host.call('secrets.set', { key, value })
    },
    async delete (key) {
      await orca.host.call('secrets.delete', { key })
    }
  }
}

// ---------------------------------------------------------------------------
// Small internal guards for event payloads and command params -- these are
// host-boundary values (unknown), so every field is checked explicitly
// before use, same discipline as src/core/guards.ts.
// ---------------------------------------------------------------------------

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentStatusChangedPayload (value) {
  if (!isRecord(value)) return false
  const worktreeIdOk = value.worktreeId === null || typeof value.worktreeId === 'string'
  return worktreeIdOk && typeof value.paneKey === 'string' &&
    typeof value.state === 'string' && typeof value.receivedAt === 'number'
}

function isWorktreeLifecyclePayload (value) {
  return isRecord(value) && typeof value.worktreeId === 'string'
}

// ---------------------------------------------------------------------------
// Secret status -- published for the panel to render, since it cannot call
// `secrets.get` itself. `endsWith` is at most the last 4 characters; the full
// key is never written to storage.
// ---------------------------------------------------------------------------

async function publishSecretStatus (orca, storageHost, secretsHost) {
  const value = await secretsHost.get(SECRET_KEY_NAME)
  const configured = typeof value === 'string' && value.trim().length > 0
  const status = {
    configured,
    endsWith: configured ? value.trim().slice(-4) : null,
    checkedAt: new Date().toISOString()
  }
  await storageHost.set(SECRET_STATUS_KEY, status).catch((error) =>
    orca.log(`secret status publish failed: ${error.message}`))
}

/** Attends one pending secret request from the panel, if any. The raw key
 *  transits plugin storage only for the moment between the panel's write and
 *  this read -- the request is deleted FIRST, before secrets.set/delete even
 *  runs, so that window is as short as it can be. */
async function attendSecretRequest (orca, storageHost, secretsHost) {
  const request = await storageHost.get(SECRET_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(SECRET_REQUEST_KEY).catch((error) =>
    orca.log(`secret request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) return

  // `reason` is a stable code, never prose: the config panel translates it
  // through its own catalog rather than surfacing whatever language this
  // worker happens to log in (see i18n.ts's module comment, and the config
  // panel's own note on `waitForSecretResult`). `detail` stays a plain,
  // English, best-effort diagnostic -- useful for `orca.log`, never shown to
  // the user as the primary message.
  let ok = false
  let reason = null
  let detail = null
  try {
    if (request.intent === 'save') {
      if (typeof request.value !== 'string' || request.value.trim().length === 0) {
        reason = 'empty-key'
        detail = 'the key cannot be empty.'
      } else {
        const value = request.value.trim()
        await secretsHost.set(SECRET_KEY_NAME, value)
        ok = true
        // Best-effort: the panel's save already succeeded against `secrets`,
        // which is the source of truth. A mirror failure is logged, not
        // reported -- it must never turn a successful save into a reported
        // failure the user would try to "fix" by retyping the same key.
        await mirrorSecretToEnvFile(orca, value)
      }
    } else if (request.intent === 'clear') {
      await secretsHost.delete(SECRET_KEY_NAME)
      ok = true
      await mirrorSecretToEnvFile(orca, null)
    } else {
      reason = 'unknown-intent'
      detail = `unrecognized secret request intent: ${String(request.intent).slice(0, 60)}`
    }
  } catch (err) {
    reason = 'exception'
    detail = String(err?.message ?? err).slice(0, 300)
  }

  await storageHost.set(SECRET_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok, reason, detail
  }).catch((err) => orca.log(`secret result publish failed: ${err.message}`))

  await publishSecretStatus(orca, storageHost, secretsHost)
}

// ---------------------------------------------------------------------------
// Claude integration request/result/status -- same request/result/status
// shape as the secret channel above, and for the same reason: the config
// panel's "Set up" / "Revert" buttons cannot call install/uninstall
// directly (a sandboxed panel may only call storage.get/storage.set), so
// they write a request here and this worker's poll loop attends it.
// ---------------------------------------------------------------------------

const CLAUDE_INTEGRATION_REQUEST_KEY = 'claudeIntegrationRequest'
const CLAUDE_INTEGRATION_RESULT_KEY = 'claudeIntegrationResult'
const CLAUDE_INTEGRATION_STATUS_KEY = 'claudeIntegrationStatus'

async function publishClaudeIntegrationStatus (orca, storageHost) {
  const status = await claudeIntegrationStatus()
  const mirror = await statSecretMirror()
  await storageHost.set(CLAUDE_INTEGRATION_STATUS_KEY, { ...status, secretMirror: mirror, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`claude integration status publish failed: ${error.message}`))
}

/** Attends one pending install/uninstall request from the panel, if any. */
async function attendClaudeIntegrationRequest (orca, storageHost) {
  const request = await storageHost.get(CLAUDE_INTEGRATION_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(CLAUDE_INTEGRATION_REQUEST_KEY).catch((error) =>
    orca.log(`claude integration request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) return

  let result
  if (request.intent === 'install') {
    result = await installClaudeIntegration(orca)
  } else if (request.intent === 'uninstall') {
    result = await uninstallClaudeIntegration(orca)
  } else {
    result = { ok: false, reason: 'unknown-intent', detail: `unrecognized claude integration request intent: ${String(request.intent).slice(0, 60)}` }
  }

  await storageHost.set(CLAUDE_INTEGRATION_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`claude integration result publish failed: ${err.message}`))

  await publishClaudeIntegrationStatus(orca, storageHost)
}

// ---------------------------------------------------------------------------
// Locale request/result/status -- same shape again: the panel's language
// buttons cannot write ~/.config/orca-supervisor/locale themselves (same
// permission sandbox), so they request a change and this worker's poll
// loop attends it and mirrors it through write-secret-mirror.mjs.
// ---------------------------------------------------------------------------

const LOCALE_REQUEST_KEY = 'localeRequest'
const LOCALE_RESULT_KEY = 'localeResult'
const LOCALE_STATUS_KEY = 'localeStatus'

async function publishLocaleStatus (orca, storageHost) {
  const locale = await resolveWorkerLocale()
  await storageHost.set(LOCALE_STATUS_KEY, { value: locale, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`locale status publish failed: ${error.message}`))
}

/** Attends one pending language-change request from the panel, if any. */
async function attendLocaleRequest (orca, storageHost) {
  const request = await storageHost.get(LOCALE_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(LOCALE_REQUEST_KEY).catch((error) =>
    orca.log(`locale request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) return

  const locale = request.locale === 'en' ? 'en' : request.locale === 'es' ? 'es' : null
  const result = locale === null
    ? { ok: false, reason: 'invalid-locale', detail: `unrecognized locale: ${String(request.locale).slice(0, 20)}` }
    : await saveLocale(orca, locale)

  await storageHost.set(LOCALE_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`locale result publish failed: ${err.message}`))

  await publishLocaleStatus(orca, storageHost)
}

// ---------------------------------------------------------------------------
// Catalog/policies mirror trigger -- unlike the secret/Claude-integration/
// locale channels above, nothing in the UI waits on this: the panel already
// writes the catalog and policies straight to storage on save, so this is
// only a fire-and-forget nudge telling the poll loop to re-mirror them. One
// plain timestamp string, compared against the last value this poll saw
// (`lastSeen`, a tiny mutable box the caller owns across ticks) rather than
// the delete-on-read id/at request shape the other channels use, since there
// is no result to report back and no request to consume.
// ---------------------------------------------------------------------------

const CATALOG_POLICY_MIRROR_REQUEST_KEY = 'catalog-policy-mirror-request'

/** Re-mirrors the catalog and policies only when the panel's trigger value
 *  has changed since the last tick that looked at it. */
async function attendCatalogPolicyMirrorRequest (orca, storageHost, lastSeen) {
  const request = await storageHost.get(CATALOG_POLICY_MIRROR_REQUEST_KEY)
  if (typeof request !== 'string' || request.length === 0 || request === lastSeen.value) return
  lastSeen.value = request
  await mirrorCatalogAndPolicies(orca, storageHost)
}

// ---------------------------------------------------------------------------
// Board maintenance -- the only cross-worktree awareness this plugin has
// that does not require spawning the `orca` CLI, since `agent.status.changed`
// is the one global event and storage is shared across worktree instances.
// ---------------------------------------------------------------------------

function boardEntryKey (entry) {
  return `${entry.worktreeId ?? '(no-worktree)'}::${entry.paneKey}`
}

// `orca worktree list --json` resolves a worktreeId to its project and
// branch (raw `refs/heads/...` shortened) -- best-effort: `agent.status.
// changed`'s own `worktreeId` format was never independently confirmed to
// match `orca worktree list`'s `id` field, so a miss just leaves both
// null rather than guessing. Cached briefly so a burst of status events
// does not spawn `orca` once per event.
const WORKTREE_LIST_CACHE_MS = 30 * 1000
let worktreeListCache = null
let worktreeListCacheAt = 0

async function resolveWorktreeProjects (orca) {
  const now = Date.now()
  if (worktreeListCache && now - worktreeListCacheAt < WORKTREE_LIST_CACHE_MS) return worktreeListCache
  const map = new Map()
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('orca', ['worktree', 'list', '--json'], { timeout: 5000 })
    const parsed = JSON.parse(stdout)
    const worktrees = parsed?.result?.worktrees
    if (Array.isArray(worktrees)) {
      for (const wt of worktrees) {
        if (!wt || typeof wt.id !== 'string') continue
        const branch = typeof wt.branch === 'string' ? wt.branch.replace(/^refs\/heads\//, '') : null
        const rama = branch && branch.length > 0 ? branch : (typeof wt.displayName === 'string' ? wt.displayName : null)
        map.set(wt.id, { project: typeof wt.projectId === 'string' ? wt.projectId : null, rama })
      }
    }
  } catch (error) {
    orca.log(`orca worktree list --json failed: ${String(error?.message ?? error).slice(0, 160)}`)
  }
  worktreeListCache = map
  worktreeListCacheAt = now
  return map
}

async function onAgentStatusChanged (orca, storageHost, payload) {
  if (!isAgentStatusChangedPayload(payload)) return

  const projects = await resolveWorktreeProjects(orca)
  const resolved = payload.worktreeId !== null ? projects.get(payload.worktreeId) : undefined

  const board = await getBoard(storageHost)
  const updated = {
    worktreeId: payload.worktreeId,
    project: resolved?.project ?? null,
    rama: resolved?.rama ?? null,
    paneKey: payload.paneKey,
    state: payload.state,
    receivedAt: payload.receivedAt,
    updatedAt: new Date().toISOString()
  }
  const key = boardEntryKey(updated)
  const index = board.entries.findIndex((entry) => boardEntryKey(entry) === key)
  const entries = index === -1
    ? [...board.entries, updated]
    : board.entries.map((entry, i) => (i === index ? updated : entry))
  await setBoard(storageHost, { entries }).catch((error) =>
    orca.log(`setBoard failed: ${error.message}`))
}

async function onWorktreeCreated (orca, storageHost, payload) {
  // Nothing to do yet beyond letting agent.status.changed populate the
  // board once that worktree's agents start reporting. Kept as an
  // explicit no-op handler (not just an unregistered event) so the
  // subscription list below stays the single source of truth for what
  // this worker listens to.
  void orca
  void storageHost
  void payload
}

async function onWorktreeRemoved (orca, storageHost, payload) {
  if (!isWorktreeLifecyclePayload(payload)) return
  const board = await getBoard(storageHost)
  const entries = board.entries.filter((entry) => entry.worktreeId !== payload.worktreeId)
  if (entries.length !== board.entries.length) {
    await setBoard(storageHost, { entries }).catch((error) =>
      orca.log(`setBoard failed: ${error.message}`))
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** advisor.decide -- judges one or more proposed actions, policy first, risk fallback. */
async function cmdDecide (orca, storageHost, secretsHost, args) {
  const actions = isRecord(args) && Array.isArray(args.actions)
    ? args.actions.filter((a) => typeof a === 'string' && a.trim().length > 0)
    : []
  if (actions.length === 0) {
    throw new Error('advisor.decide requires { actions: string[] } with at least one non-empty action.')
  }

  const apiKey = await resolveApiKey(secretsHost)
  if (apiKey === null) {
    const locale = await resolveWorkerLocale()
    await orca.host.call('notifications.show', {
      title: translate(ADVISOR_CATALOG, locale, 'title'),
      body: translate(ADVISOR_CATALOG, locale, 'notify.noKey.body')
    }).catch((error) => orca.log(`notification failed: ${error.message}`))
    throw new Error(translate(ADVISOR_CATALOG, locale, 'error.noApiKey'))
  }

  const [policies, config] = await Promise.all([getPolicies(storageHost), getConfig(storageHost)])
  const context = DEFAULT_CONTEXT

  const decisions = await Promise.all(
    actions.map(async (action) => {
      let policyAnswers = null
      if (policies.length > 0) {
        const request = await callJev(
          apiKey, buildDestinationState(action, context, policies), buildPolicyQuestions(policies),
          { budgetMs: config.jevBudgetMs })
        policyAnswers = request.answers
      }

      const resolvedByPolicy = policyAnswers !== null
        ? interpretDestinationPolicy(action, policies, policyAnswers)
        : null

      let riskAnswers = null
      if (resolvedByPolicy === null) {
        const request = await callJev(
          apiKey, buildDestinationState(action, context), buildDestinationRiskQuestions(),
          { budgetMs: config.jevBudgetMs })
        riskAnswers = request.answers
      }

      const decision = decideDestination({ action, policies, policyAnswers, riskAnswers })
      const rawAnswers = { ...(policyAnswers ?? {}), ...(riskAnswers ?? {}) }
      await recordDecision(storageHost, { kind: 'destination', judged: action, rawAnswers, verdict: decision.outcome })
      return decision
    })
  )

  const act = decisions.filter((d) => d.outcome === 'act').length
  const blocked = decisions.filter((d) => d.outcome === 'do_not').length
  const ask = decisions.filter((d) => d.outcome === 'ask').length
  const decideLocale = await resolveWorkerLocale()
  await orca.host.call('notifications.show', {
    title: translate(ADVISOR_CATALOG, decideLocale, 'title'),
    body: translate(ADVISOR_CATALOG, decideLocale, 'notify.decide.body', { act: String(act), blocked: String(blocked), ask: String(ask) })
  }).catch((error) => orca.log(`notification failed: ${error.message}`))

  return { decisions }
}

/** advisor.board -- dumps the current cross-worktree board. */
async function cmdBoard (storageHost) {
  return getBoard(storageHost)
}

const DOCTOR_PING_BUDGET_MS = 6000

/** A trivial, harmless Jev round-trip: the doctor's job is to prove the key
 *  authenticates, not to judge anything, so the question asks nothing about
 *  the user's work and its answer is never read. */
async function pingJev (apiKey) {
  await callJev(
    apiKey,
    { proposito: 'Verificacion de configuracion de orca-jev-advisor (advisor.doctor). No es una decision real.' },
    {
      verificacion: {
        type: 'noul',
        instructions: 'Este es un chequeo de conectividad, no una decision real. Responde con cualquier valor.',
        criteria: { chequeo: 'Confirma unicamente que la clave autentica; el valor de la respuesta no se usa.' }
      }
    },
    { budgetMs: DOCTOR_PING_BUDGET_MS }
  )
}

/** Checks the key past "is one configured": whether Jev actually accepts it
 *  right now, distinguishing a dead key (401/403) from no network at all --
 *  a key that "is configured" and a key that works are different facts,
 *  and only one of them is what "advisor.doctor" is for. */
async function checkApiKey (secretsHost) {
  const apiKey = await resolveApiKey(secretsHost)
  if (apiKey === null) {
    return { id: 'api-key', ok: false, detail: 'No key: TYPESAFE_API_KEY is not set in secrets, the environment, or the fallback file.' }
  }
  try {
    await pingJev(apiKey)
    return { id: 'api-key', ok: true, detail: 'Key valid: Jev responded.' }
  } catch (error) {
    if (error instanceof JevRequestError && (error.status === 401 || error.status === 403)) {
      return { id: 'api-key', ok: false, detail: `Key rejected (${error.status}).` }
    }
    if (error instanceof JevTimeoutError) {
      return { id: 'api-key', ok: false, detail: "No network: Jev didn't respond within the budget." }
    }
    if (error instanceof JevRequestError) {
      return { id: 'api-key', ok: false, detail: `Jev responded with an error${error.status !== null ? ` (${error.status})` : ''}: ${String(error.message).slice(0, 160)}` }
    }
    return { id: 'api-key', ok: false, detail: `No network: ${String(error?.message ?? error).slice(0, 160)}` }
  }
}

/** Whether the mirror file agrees with `secrets` right now -- the two can
 *  drift if the mirror write ever failed silently (logged, not thrown; see
 *  mirrorSecretToEnvFile) or the file was edited by hand. Compares against
 *  `secrets` directly, not `resolveApiKey`'s env/file-inclusive resolution,
 *  since that would make an empty `secrets` trivially "match" its own
 *  fallback file. */
async function checkSecretMirror (secretsHost) {
  const secretValue = await secretsHost.get(SECRET_KEY_NAME)
  const mirror = await readSecretMirror()
  if (!mirror.ok) {
    return { id: 'secret-mirror', ok: false, detail: `Could not read the mirror file: ${String(mirror.detail ?? mirror.reason ?? 'no detail').slice(0, 160)}` }
  }
  const mirrored = typeof mirror.value === 'string' ? mirror.value : null
  if (secretValue === null && mirrored === null) {
    return { id: 'secret-mirror', ok: true, detail: 'No key configured and no mirror file: consistent.' }
  }
  if (secretValue !== null && mirrored === secretValue) {
    return { id: 'secret-mirror', ok: true, detail: 'The mirror file matches secrets.' }
  }
  return { id: 'secret-mirror', ok: false, detail: 'The mirror file does not match secrets (out of sync) -- save the key again from the panel.' }
}

/** Whether the Claude Code side (hook, env var, mod link) is actually in place right now. */
async function checkClaudeIntegration () {
  const status = await claudeIntegrationStatus()
  if (!status.ok) {
    return { id: 'claude-integration', ok: false, detail: `Could not read the status: ${String(status.detail ?? status.reason ?? 'no detail').slice(0, 160)}` }
  }
  const parts = []
  if (!status.hook.installed) parts.push('missing the PreToolUse hook')
  else if (!status.hook.pathMatches) parts.push('the hook points at a different gate-bash.ts path')
  if (!status.env.installed) parts.push(`missing ${status.env.name}=1`)
  if (!status.modLink.installed) parts.push('the skills mod is not linked')
  if (parts.length === 0) return { id: 'claude-integration', ok: true, detail: 'Hook, environment variable and skills mod all installed.' }
  return { id: 'claude-integration', ok: false, detail: `Not fully installed: ${parts.join('; ')}.` }
}

/** advisor.doctor -- checks the key against a real Jev call, CLI reachability, catalog validity, the secret mirror, and the Claude Code integration. */
async function cmdDoctor (orca, storageHost, secretsHost) {
  const checks = []

  checks.push(await checkApiKey(secretsHost))
  checks.push(await checkSecretMirror(secretsHost))
  checks.push(await checkClaudeIntegration())

  let cliOk = false
  let cliDetail = 'Could not verify (missing the process:spawn capability, or the binary does not respond).'
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    // Read-only reachability probe -- never touches a terminal. `status`
    // requires a running Orca Lab runtime, which this check can assume:
    // this code only runs inside the plugin worker, which Orca itself forked.
    await execFileAsync('orca', ['status', '--json'], { timeout: 5000 })
    cliOk = true
    cliDetail = 'orca CLI responds (status ok).'
  } catch (error) {
    cliDetail = `orca CLI did not respond: ${String(error?.message ?? error).slice(0, 160)}`
  }
  checks.push({ id: 'orca-cli', ok: cliOk, detail: cliDetail })

  try {
    const catalog = await getCatalog(storageHost)
    checks.push({ id: 'catalog', ok: true, detail: `Valid catalog with ${catalog.destinations.length} destination(s).` })
  } catch (error) {
    checks.push({ id: 'catalog', ok: false, detail: `Invalid catalog: ${error?.message ?? error}` })
  }

  const allOk = checks.every((c) => c.ok)
  const doctorLocale = await resolveWorkerLocale()
  await orca.host.call('notifications.show', {
    title: translate(ADVISOR_CATALOG, doctorLocale, 'titleDoctor'),
    body: translate(ADVISOR_CATALOG, doctorLocale, allOk ? 'notify.doctor.ok' : 'notify.doctor.problem')
  }).catch((error) => orca.log(`notification failed: ${error.message}`))
  return { ok: allOk, checks }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export default function activate (orca) {
  const storageHost = makeStorageHost(orca)
  const secretsHost = makeSecretsHost(orca)

  const offStatus = orca.events.on('agent.status.changed', (payload) => {
    onAgentStatusChanged(orca, storageHost, payload)
      .catch((error) => orca.log(`agent.status.changed handler failed: ${error.message}`))
  })
  const offCreated = orca.events.on('worktree.created', (payload) => {
    onWorktreeCreated(orca, storageHost, payload)
      .catch((error) => orca.log(`worktree.created handler failed: ${error.message}`))
  })
  const offRemoved = orca.events.on('worktree.removed', (payload) => {
    onWorktreeRemoved(orca, storageHost, payload)
      .catch((error) => orca.log(`worktree.removed handler failed: ${error.message}`))
  })

  orca.commands.register('advisor.decide', (args) => cmdDecide(orca, storageHost, secretsHost, args))
  orca.commands.register('advisor.board', () => cmdBoard(storageHost))
  orca.commands.register('advisor.doctor', () => cmdDoctor(orca, storageHost, secretsHost))
  orca.commands.register('advisor.installClaude', () => installClaudeIntegration(orca))
  orca.commands.register('advisor.uninstallClaude', () => uninstallClaudeIntegration(orca))

  // Secret AND Claude-integration request/result polling loop (see
  // attendSecretRequest / attendClaudeIntegrationRequest above). Polls fast
  // while the config panel has recently signalled it is open, and backs off
  // to an idle-cheap cadence otherwise -- the worker is reaped after 5
  // minutes idle, so this timer must be (and is) cleared by teardown below.
  let secretPollStopped = false
  let secretTimer = null
  const catalogPolicyMirrorSeen = { value: null }
  const runSecretPoll = () => {
    attendSecretRequest(orca, storageHost, secretsHost)
      .catch((error) => orca.log(`secret request handling failed: ${error.message}`))
      .then(() => attendClaudeIntegrationRequest(orca, storageHost))
      .catch((error) => orca.log(`claude integration request handling failed: ${error.message}`))
      .then(() => attendLocaleRequest(orca, storageHost))
      .catch((error) => orca.log(`locale request handling failed: ${error.message}`))
      .then(() => attendCatalogPolicyMirrorRequest(orca, storageHost, catalogPolicyMirrorSeen))
      .catch((error) => orca.log(`catalog/policies mirror handling failed: ${error.message}`))
      .then(() => storageHost.get(PANEL_SEEN_KEY).catch(() => null))
      .then((seen) => {
        if (secretPollStopped) return
        return isRecord(seen) && typeof seen.at === 'string' &&
          (Date.now() - Date.parse(seen.at)) < PANEL_SEEN_FRESH_MS
      })
      // Rescheduling must survive anything above it. Without this the loop
      // stops on the first unexpected error and the panel waits forever on a
      // request nobody will ever attend -- silently, which is the worst kind.
      .catch((error) => {
        orca.log(`secret poll iteration failed: ${error.message}`)
        return false
      })
      .then((fresh) => {
        if (secretPollStopped) return
        secretTimer = setTimeout(runSecretPoll, fresh === true ? SECRET_POLL_ACTIVE_MS : SECRET_POLL_IDLE_MS)
        if (typeof secretTimer.unref === 'function') secretTimer.unref()
      })
  }
  publishSecretStatus(orca, storageHost, secretsHost)
    .catch((error) => orca.log(`initial secret status failed: ${error.message}`))
  // Mirrors whatever is already in `secrets` at activation, so a worker
  // restarted after the mirror file was lost, edited by hand, or never
  // written by an older version of this plugin converges without the user
  // having to retype the key.
  secretsHost.get(SECRET_KEY_NAME)
    .then((value) => mirrorSecretToEnvFile(orca, typeof value === 'string' && value.trim().length > 0 ? value.trim() : null))
    .catch((error) => orca.log(`initial secret mirror failed: ${error.message}`))
  // Same convergence guarantee as the key above: a worker restarted after
  // the catalog/policies mirror files were lost or never written by an
  // older version of this plugin catches up without the user having to
  // touch the panel's save button again.
  mirrorCatalogAndPolicies(orca, storageHost)
    .catch((error) => orca.log(`initial catalog/policies mirror failed: ${error.message}`))
  // "Al activarse, el worker debe dejar funcionando todo lo que hoy es
  // manual" (T8): every activation re-asserts the hook, the env var and the
  // mod-skills link, idempotently -- a fresh install where none of this
  // exists yet, and a silent no-op everywhere it already does. This is what
  // makes "install the plugin, save the key" enough on another machine.
  installClaudeIntegration(orca)
    .then(() => publishClaudeIntegrationStatus(orca, storageHost))
    .catch((error) => orca.log(`initial claude integration install failed: ${error.message}`))
  publishLocaleStatus(orca, storageHost)
    .catch((error) => orca.log(`initial locale status failed: ${error.message}`))
  runSecretPoll()

  // Measurements refresh on its own light cadence -- these two JSONL files
  // change only when a real Bash command or a real prompt happens
  // elsewhere, never from this worker's own actions, so there is no need
  // to tie this to the secret/panel poll's fast cadence.
  publishMeasurementsSummary(orca, storageHost)
    .catch((error) => orca.log(`initial measurements summary failed: ${error.message}`))
  const measurementsTimer = setInterval(() => {
    publishMeasurementsSummary(orca, storageHost)
      .catch((error) => orca.log(`measurements summary refresh failed: ${error.message}`))
  }, MEASUREMENTS_REFRESH_MS)
  if (typeof measurementsTimer.unref === 'function') measurementsTimer.unref()

  // Deliberately NOT wired here: Orca reaps an idle worker (or restarts one
  // for any other reason) by calling this same teardown, and that is a
  // routine event, not the user disabling the plugin -- there is no
  // verified way from inside the worker to tell the two apart. Undoing the
  // Claude Code side from teardown would mean it comes and goes with every
  // idle cycle. Uninstall is instead only ever explicit: the panel's revert
  // button (CLAUDE_INTEGRATION_REQUEST_KEY, attended above) or the
  // advisor.uninstallClaude command -- both unambiguous regardless of what
  // triggers teardown.
  return () => {
    for (const off of [offStatus, offCreated, offRemoved]) {
      if (typeof off === 'function') off()
    }
    secretPollStopped = true
    if (secretTimer) clearTimeout(secretTimer)
    clearInterval(measurementsTimer)
  }
}
