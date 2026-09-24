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

import { DENY_TOGGLE_KEYS } from '../../src/core/deny_tier_config.ts'
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
  GATE_CONSEQUENCE_CEILING,
  interpretDestinationPolicy
} from '../../src/core/decisions.ts'
import { ORCA_CLI_ARGUMENTS, orcaCliOptions } from '../../src/core/orca_cli.ts'
import { POLICY_SEED_MARKER_KEY, parseSeedPolicies, parseSeedVersion, shouldSeedPolicies } from '../../src/core/policy_seed.ts'
import { applyPolicySeedChoices, mergePolicySeeds } from '../../src/core/policy_seed_import.ts'
import { decidePolicySeedNotice, parseOfferedVersion } from '../../src/core/policy_seed_notice.ts'
import { resolveApiKey, SECRET_KEY_NAME } from '../../src/core/secrets.ts'
import { getBoard, getCatalog, getConfig, getPolicies, setBoard, setCatalog, setPolicies } from '../../src/core/store.ts'
import { deriveDestinations, parseWorktreeList } from '../../src/core/worktree_catalog.ts'
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
const HOME_PATHS = {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
}
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

const SECRET_MIRROR_READ_ONLY_MODES = new Set(['read', 'locale-read', 'stat', 'mod-skills-config-read', 'deny-tier-config-read'])

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
// Catalog derivation -- the previous seed/catalog.json was generated from
// one machine and named that person's own clients and paths, matching
// nothing on anyone else's disk (see src/core/worktree_catalog.ts's module
// comment). Orca already knows the installing developer's own worktrees, so
// the catalog is derived from `orca worktree ps --json` instead of shipped.
// This is a DIFFERENT subcommand from `orca worktree list --json`, used by
// resolveWorktreeProjects above for an unrelated purpose (resolving a
// worktreeId to project/branch for the board) -- not the same call, not
// reusing that cache.
// ---------------------------------------------------------------------------

/** Runs `orca worktree ps --json` and turns the result into destinations.
 *  Never throws: a derivation that cannot run leaves the catalog exactly as
 *  it was, which is always a safe, working state -- same fail-open shape as
 *  resolveWorktreeProjects's own `orca worktree list` call. Reports the
 *  failure detail rather than swallowing it (see cmdRefreshCatalog below for
 *  why that distinction matters to the caller). */
async function deriveCatalogFromOrca (orca) {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync(ORCA_CLI_BIN, ORCA_CLI_ARGUMENTS.worktreePs, orcaCliOptions(PLATFORM, PLUGIN_ROOT))
    const worktrees = parseWorktreeList(JSON.parse(stdout))
    return { destinations: deriveDestinations(worktrees), failure: null }
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 200)
    orca.log(`catalog derivation (orca worktree ps) failed: ${detail.slice(0, 160)}`)
    return { destinations: [], failure: detail }
  }
}

/** Bootstraps the catalog from Orca's own worktree list, but ONLY when it
 *  is still empty -- destination ids key the developer's own per-destination
 *  settings (thresholds, policy scoping), so a catalog they have already
 *  edited, even down to one row, is never touched here. Never throws: this
 *  is a nice-to-have bootstrap, not something that should ever block
 *  activation. */
async function deriveInitialCatalogIfEmpty (orca, storageHost) {
  try {
    const catalog = await getCatalog(storageHost)
    if (catalog.destinations.length > 0) return
    const { destinations: derived } = await deriveCatalogFromOrca(orca)
    if (derived.length === 0) return
    await setCatalog(storageHost, { destinations: derived })
  } catch (error) {
    orca.log(`initial catalog derivation failed: ${String(error?.message ?? error).slice(0, 160)}`)
  }
}

/** Plants `seed/policies.json` on an install that has never been offered it.
 *  The shipped file had never been read by anything, so every machine ran
 *  with an empty policy stage -- see src/core/policy_seed.ts for why the
 *  decision hangs on a marker key rather than on the list being empty, and
 *  why a machine that already holds policies is left alone. Never throws and
 *  never mirrors: like the catalog bootstrap above it is a nice-to-have that
 *  must not block activation, and the caller chains the single mirror that
 *  carries both. */
async function seedPoliciesIfEmpty (orca, storageHost) {
  try {
    const [marker, stored] = await Promise.all([
      storageHost.get(POLICY_SEED_MARKER_KEY),
      storageHost.get('policies')
    ])
    if (marker !== undefined && marker !== null) return
    if (!shouldSeedPolicies(marker, stored)) {
      // Declining still marks the install. Without this an existing machine --
      // one that upgraded into this code holding its own rules -- would carry
      // no marker at all, and the day its owner deletes every row on purpose,
      // the next activation would read that as a fresh install and plant all
      // twenty-three, ten `prohibits` among them. The marker is what makes
      // "deliberately empty" a state this function can recognise later.
      //
      // Deliberately NOT writing POLICY_SEED_OFFERED_VERSION_KEY here: this
      // branch is exactly the install policy_seed_notice.ts exists for -- one
      // that already holds its own rules and has never had this baseline
      // offered to it at all. Leaving the marker unset makes
      // parseOfferedVersion read it as 0, so the notice can tell this install
      // about the shipped baseline the first time this code ever runs on it,
      // instead of silently agreeing it has already seen it.
      await storageHost.set(POLICY_SEED_MARKER_KEY, { at: new Date().toISOString(), planted: 0, reason: 'already-had-policies' })
      return
    }
    const { readFile } = await import('node:fs/promises')
    // A seed that is missing or unreadable throws here and is retried on the
    // next activation, which costs one log line and is the behaviour we want:
    // the rows are worth another attempt once the file is readable again.
    const raw = await readFile(join(PLUGIN_ROOT, 'seed', 'policies.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const seeded = parseSeedPolicies(parsed)
    const shippedVersion = parseSeedVersion(parsed)
    if (seeded.length > 0) await setPolicies(storageHost, seeded)
    // Written after the rows, never before: if the process dies in between,
    // the next activation finds twenty-three valid rows and no marker,
    // declines, and marks. Nothing is planted twice and nothing is lost.
    await storageHost.set(POLICY_SEED_MARKER_KEY, { at: new Date().toISOString(), planted: seeded.length })
    // Planted the shipped rows at exactly this version, so there is nothing
    // yet for the baseline notice to say -- see cmdImportPolicySeeds and
    // attendPolicySeedDismissRequest for the other two places this same
    // marker gets written.
    await storageHost.set(POLICY_SEED_OFFERED_VERSION_KEY, { version: shippedVersion, at: new Date().toISOString() })
    orca.log(`policy seed planted: ${seeded.length} row(s)`)
  } catch (error) {
    orca.log(`initial policy seeding failed: ${String(error?.message ?? error).slice(0, 160)}`)
  }
}

/** advisor.refreshCatalog -- adds destinations for worktrees Orca has seen
 *  that are not yet in the catalog. Every id already present (and every
 *  field on it: thresholds, consequenceCeiling, everything) is left
 *  completely untouched, and nothing already in the catalog is ever
 *  removed -- a worktree disappearing from Orca's list is not this
 *  plugin's call to prune. Re-mirrors to catalog.json when it changes
 *  anything, so the gate sees the addition without waiting for the panel's
 *  own save button. */
async function cmdRefreshCatalog (orca, storageHost) {
  try {
    const current = await getCatalog(storageHost)
    const { destinations: derived, failure } = await deriveCatalogFromOrca(orca)
    // A refresh that could not ask Orca anything is NOT a refresh that found
    // nothing new. Reporting both as `ok: true, added: 0` is what made a
    // broken CLI call look to the developer like a dead button, with the real
    // cause reachable only by opening Orca's log.
    if (failure !== null) return { ok: false, reason: 'derivation-failed', detail: failure }
    const existingIds = new Set(current.destinations.map((d) => d.id))
    const additions = derived.filter((d) => !existingIds.has(d.id))
    if (additions.length > 0) {
      await setCatalog(storageHost, { destinations: [...current.destinations, ...additions] })
      await mirrorCatalogAndPolicies(orca, storageHost)
    }
    return { ok: true, added: additions.length }
  } catch (error) {
    return { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
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

/** The CLI this plugin shells out to. Named so every invocation is findable,
 *  and so the three call sites cannot drift apart again. */
const ORCA_CLI_BIN = 'orca'
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
  } else if (result.modCopyWarning) {
    orca.log(`claude integration install: skills mod copy warning -- ${result.modCopyWarning}`)
  }
  return result
}

/**
 * The exact shape attendClaudeIntegrationRequest publishes to
 * CLAUDE_INTEGRATION_RESULT_KEY, pulled out so it is unit-testable without
 * spawning the real install-claude-integration.mjs subprocess (which would
 * touch this developer's actual ~/.claude -- see this file's own test
 * suite's warning on that).
 *
 * odd/tasks/production-honesty-pass.md P5: `modCopyWarning` used to be
 * dropped here -- install-claude-integration.mjs's install() already
 * returned it (a stable reason code, e.g. 'copy-failed'; never the raw
 * English detail string, same rule as `reason` below), but only
 * `{id, at, ok, reason, detail}` reached storage, so an install whose mod
 * copy silently failed still told the panel "Done."
 */
function claudeIntegrationResultPayload (id, result) {
  return {
    id,
    at: new Date().toISOString(),
    ok: result.ok,
    reason: result.reason ?? null,
    detail: result.detail ?? null,
    modCopyWarning: result.modCopyWarning ?? null
  }
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
// Policy seed import -- seed/policies.json ships with the plugin as its
// shared baseline. seedPoliciesIfEmpty (above) plants it automatically on a
// fresh install; this is the OTHER path to the same file, for a developer
// who wants to pull the baseline in later -- onto a machine that already has
// some policies of its own, after the marker has already been consumed, or
// simply on demand from the panel's "Import baseline policies" button.
//
// Reads the seed file with parseSeedPolicies (src/core/policy_seed.ts) --
// the same reader seedPoliciesIfEmpty uses, on purpose: two different
// readers of the one shipped file would drift, and parseSeedPolicies's
// "malformed rows cost only themselves" behaviour is exactly what a manual
// import should do with a seed file, not throw the whole import away over
// one bad row (loadPolicies in src/core/policies.ts is a different, stricter
// contract for tools/decide.ts and tools/policy-gate.ts's own
// developer-authored policy files, where a malformed row IS a
// misconfiguration to surface loudly; it is not reused here).
//
// Resolved relative to PLUGIN_ROOT (this worker's own installed tree), never
// an absolute path -- the seed ships inside the plugin, wherever it happens
// to be installed. Merge-only, by id (see src/core/policy_seed_import.ts):
// an id the developer already has, however that row looks, complete or not,
// is left exactly as it is; only genuinely new ids are added. Never throws.
// ---------------------------------------------------------------------------

const POLICY_SEED_PATH = join(PLUGIN_ROOT, 'seed', 'policies.json')

/** advisor's policy-seed-import action, attended the same way as
 *  advisor.refreshCatalog: reads the shipped seed file, merges it into
 *  whatever is already stored (raw, not through getPolicies -- that would
 *  silently drop an existing incomplete row instead of preserving it), and
 *  re-mirrors on any real change. `options.seedPath`/`options.mirror` are
 *  test-only: production always reads the plugin's own POLICY_SEED_PATH and
 *  always re-mirrors for real. (mirrorCatalogAndPolicies spawns a real
 *  sidecar that writes to the actual machine's CONFIG_DIR regardless of
 *  which storageHost is passed to it -- tests MUST override this, never let
 *  it run against a fake host, or it silently overwrites this developer's
 *  own real catalog.json/policies.json on disk.)
 *
 *  `options.acceptedIds` is the only way a shared id already on this machine
 *  can be replaced by the seed's version -- see policy_seed_import.ts's
 *  applyPolicySeedChoices. Omitting it (the default, and the only behaviour
 *  when this runs with no arguments) never replaces anything; the `differing`
 *  list in the result is how a panel finds out there is something to offer
 *  the developer in the first place. */
async function cmdImportPolicySeeds (orca, storageHost, options = {}) {
  const seedPath = options.seedPath ?? POLICY_SEED_PATH
  const mirror = options.mirror ?? mirrorCatalogAndPolicies
  const acceptedIds = Array.isArray(options.acceptedIds) ? options.acceptedIds : []
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(seedPath, 'utf8')
    const parsed = JSON.parse(raw)
    const seeds = parseSeedPolicies(parsed)
    const shippedVersion = parseSeedVersion(parsed)
    const existingRaw = await storageHost.get('policies')
    const existing = Array.isArray(existingRaw) ? existingRaw : []
    const { merged, added, skipped, differing } = mergePolicySeeds(existing, seeds)
    const { result: finalPolicies, replaced } = applyPolicySeedChoices(merged, seeds, acceptedIds)
    if (added > 0 || replaced > 0) {
      await storageHost.set('policies', finalPolicies)
      await mirror(orca, storageHost)
    }
    // A successful import -- whether it added rows, replaced some, or did
    // neither -- means this install has now seen the shipped baseline at
    // this version, so the notice must not keep offering it again even if a
    // reported `differing` id was left unticked. See policy_seed_notice.ts.
    await storageHost.set(POLICY_SEED_OFFERED_VERSION_KEY, { version: shippedVersion, at: new Date().toISOString() })
      .catch((error) => orca.log(`policy seed offered-version marker publish failed: ${error.message}`))
    await publishPolicySeedNoticeStatus(orca, storageHost, options)
    return { ok: true, added, skipped, differing, replaced }
  } catch (error) {
    orca.log(`policy seed import failed: ${String(error?.message ?? error).slice(0, 200)}`)
    return { ok: false, reason: 'seed-unavailable', detail: String(error?.message ?? error).slice(0, 300) }
  }
}

// ---------------------------------------------------------------------------
// Baseline notice -- seed/policies.json now carries a hand-bumped `version`
// (src/core/policy_seed.ts's parseSeedVersion), and the shipped baseline can
// be corrected across releases without any existing install ever finding
// out: merge-only-by-id is what protects an edited row, and that same
// protection is what makes a corrected shipped row invisible to an install
// that already has that id. This is the part that removes the silence,
// without ever touching a stored row itself -- see decidePolicySeedNotice
// (src/core/policy_seed_notice.ts) for the pure decision, and
// applyPolicySeedChoices for the only path that can actually replace a row,
// which always stays an explicit human choice.
// ---------------------------------------------------------------------------

/** Records the shipped version this install was last offered -- a sibling
 *  of POLICY_SEED_MARKER_KEY, not a reuse of it: that marker means "seeded
 *  or declined once, ever" and never carries a version, while this one is
 *  read fresh every time to decide whether a LATER release has moved past
 *  it. Written on fresh seeding (seedPoliciesIfEmpty), a successful import
 *  (cmdImportPolicySeeds), a dismiss (attendPolicySeedDismissRequest), and
 *  by publishPolicySeedNoticeStatus itself when the computed gap is empty. */
const POLICY_SEED_OFFERED_VERSION_KEY = 'policySeedOfferedVersion'

/** What the panel's Team Policies notice reads -- only computed numbers, and
 *  never the shipped version by itself: the panel is told whether it should
 *  say something and, if so, how much, not asked to compare versions of its
 *  own. See config.html's renderPolicySeedNotice. */
const POLICY_SEED_NOTICE_STATUS_KEY = 'policySeedNoticeStatus'

const POLICY_SEED_DISMISS_REQUEST_KEY = 'policySeedDismissRequest'
const POLICY_SEED_DISMISS_RESULT_KEY = 'policySeedDismissResult'

/** Computes the same decision decidePolicySeedNotice would report, from a
 *  fresh read of the shipped seed file and storage. Returns `null` (and
 *  logs) rather than throwing on any failure to read either -- the caller
 *  decides what "could not compute this tick" should mean: leaving a
 *  previous status in place (publishPolicySeedNoticeStatus) or skipping a
 *  poll tick outright (attendPolicySeedNoticeRefresh). */
async function computePolicySeedNoticeDecision (orca, storageHost, options = {}) {
  const seedPath = options.seedPath ?? POLICY_SEED_PATH
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(seedPath, 'utf8')
    const parsed = JSON.parse(raw)
    const shipped = parseSeedPolicies(parsed)
    const shippedVersion = parseSeedVersion(parsed)
    const [offeredMarker, existingRaw] = await Promise.all([
      storageHost.get(POLICY_SEED_OFFERED_VERSION_KEY),
      storageHost.get('policies')
    ])
    const offeredVersion = parseOfferedVersion(offeredMarker)
    const existing = Array.isArray(existingRaw) ? existingRaw : []
    return decidePolicySeedNotice({ shippedVersion, offeredVersion, existing, shipped })
  } catch (error) {
    orca.log(`policy seed notice computation failed: ${String(error?.message ?? error).slice(0, 160)}`)
    return null
  }
}

/** Writes a computed decision to storage: the status the panel reads, and --
 *  only when the gap this decision found is genuinely empty (added and
 *  differing both 0) -- the offered-version marker, so a version bump with
 *  nothing to say to THIS particular install does not keep recomputing the
 *  same no-op merge on every later tick. Harmless to also run when the
 *  shipped version is not actually ahead: it only ever rewrites the same
 *  marker to the same value. */
async function writePolicySeedNoticeDecision (orca, storageHost, decision) {
  await storageHost.set(POLICY_SEED_NOTICE_STATUS_KEY, { ...decision, at: new Date().toISOString() })
    .catch((error) => orca.log(`policy seed notice status publish failed: ${error.message}`))
  if (!decision.due && decision.added === 0 && decision.differing === 0) {
    await storageHost.set(POLICY_SEED_OFFERED_VERSION_KEY, { version: decision.shippedVersion, at: new Date().toISOString() })
      .catch((error) => orca.log(`policy seed offered-version marker publish failed: ${error.message}`))
  }
}

/** Publishes the baseline-notice status for the panel to render on load --
 *  the panel has no way to compute this itself, the same reason every other
 *  *Status key in this file exists. Called at activation, and again after
 *  every import and every dismiss so the panel's very next read (not the
 *  next poll tick) already reflects the change. A failed computation leaves
 *  whatever status was already published in place, rather than overwriting
 *  it with a guess. */
async function publishPolicySeedNoticeStatus (orca, storageHost, options = {}) {
  const decision = await computePolicySeedNoticeDecision(orca, storageHost, options)
  if (decision === null) return
  await writePolicySeedNoticeDecision(orca, storageHost, decision)
}

/** Poll-loop wrapper: recomputes the decision every tick -- a plain "Save
 *  configuration" edit to `policies` changes the counts with no request of
 *  its own to hang a republish off of -- but only actually writes to
 *  storage when the decision changed, so a panel left open does not cost a
 *  seed-file read AND a storage write every second for nothing. Same dedupe
 *  shape as attendCatalogPolicyMirrorRequest's `lastSeen` box, except
 *  compared on the decision's own fields, never on a timestamp: two ticks
 *  with the same due/added/differing/shippedVersion must count as
 *  unchanged even though `at` would differ. */
async function attendPolicySeedNoticeRefresh (orca, storageHost, lastPublished, options = {}) {
  const decision = await computePolicySeedNoticeDecision(orca, storageHost, options)
  if (decision === null) return
  const fingerprint = JSON.stringify([decision.due, decision.added, decision.differing, decision.shippedVersion])
  if (fingerprint === lastPublished.value) return
  lastPublished.value = fingerprint
  await writePolicySeedNoticeDecision(orca, storageHost, decision)
}

/** Attends one pending "dismiss the baseline notice" request from the panel.
 *  Dismissing never touches a stored policy row -- it only marks this
 *  install as having been offered the shipped version, the same marker a
 *  successful import already writes, so the notice stops nagging about a
 *  baseline change the person has consciously chosen to ignore. The status
 *  is republished BEFORE the result key is written, deliberately: the
 *  panel's waitForPolicySeedDismissResult resolves the instant the result
 *  carries its id, and if that raced ahead of the status write the notice
 *  would stay lit until the panel's next full reload. */
async function attendPolicySeedDismissRequest (orca, storageHost, options = {}) {
  const request = await storageHost.get(POLICY_SEED_DISMISS_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(POLICY_SEED_DISMISS_REQUEST_KEY).catch((error) =>
    orca.log(`policy seed dismiss request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(POLICY_SEED_DISMISS_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`policy seed dismiss result publish failed: ${err.message}`))
    return
  }

  const decision = await computePolicySeedNoticeDecision(orca, storageHost, options)
  let result
  if (decision === null) {
    result = { ok: false, reason: 'seed-unavailable', detail: 'the shipped seed could not be read to record the dismissed version.' }
  } else {
    await storageHost.set(POLICY_SEED_OFFERED_VERSION_KEY, { version: decision.shippedVersion, at: new Date().toISOString() })
      .catch((error) => orca.log(`policy seed offered-version marker publish failed: ${error.message}`))
    await publishPolicySeedNoticeStatus(orca, storageHost, options)
    result = { ok: true }
  }

  await storageHost.set(POLICY_SEED_DISMISS_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`policy seed dismiss result publish failed: ${err.message}`))
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
// Worker heartbeat -- a panel cannot wake a reaped worker (see this module's
// header and odd/tasks/panel-worker-wakeup.md): the only five panel-callable
// host actions are answered in Orca's Electron main process without ever
// reaching this worker. So before a panel writes anything secret-carrying it
// needs to know whether a worker is actually alive right now, rather than
// trust a poll that will never come. This key is that signal: written once
// at activation and again on every runSecretPoll tick, so its age tracks how
// long ago a worker was last definitely running.
// ---------------------------------------------------------------------------

const WORKER_HEARTBEAT_KEY = 'workerHeartbeat'
/**
 * Must exceed SECRET_POLL_IDLE_MS (15s) -- otherwise a live worker idling
 * between its own slow-poll ticks would look dead to a panel. 40s is a
 * little under 3x that interval: generous enough to absorb one missed or
 * slow tick and ordinary event-loop jitter, but still short enough that
 * "no worker is running" is reported within under a minute of it actually
 * not running, not after however long a panel happens to have been open.
 */
const WORKER_HEARTBEAT_STALE_MS = 40 * 1000

/** Written once at activation and on every poll tick -- see the module note above. */
async function publishWorkerHeartbeat (orca, storageHost) {
  await storageHost.set(WORKER_HEARTBEAT_KEY, { at: new Date().toISOString() })
    .catch((error) => orca.log(`worker heartbeat publish failed: ${error.message}`))
}

// ---------------------------------------------------------------------------
// Gate defaults mirror -- the config panel's Thresholds section used to
// fall back to a hardcoded 1.5 for consequenceCeiling, a stale copy of a
// value decisions.ts has since re-measured to 1.78 (GATE_CONSEQUENCE_CEILING
// there). A panel is a sandboxed HTML document and cannot import from
// src/core (see odd/tasks/panel-worker-wakeup.md, T7); this worker is the
// only thing that can, so it mirrors the constants it is actually exported
// into storage once at activation, the same one-shot pattern as
// publishLocaleStatus. These are static, compiled-in numbers: republishing
// on every poll tick would be pointless, since they cannot change without a
// new build of this plugin.
//
// GATE_REVERSIBLE_GATE and GATE_EXTERNAL_GATE (decisions.ts's other two gate
// constants) are NOT exported there, so they cannot be mirrored the same way
// without editing src/core -- out of scope here; see that task doc's report
// for the audit of which panel fallbacks currently agree with them anyway.
// ---------------------------------------------------------------------------

const GATE_DEFAULTS_KEY = 'gateDefaults'

async function publishGateDefaults (orca, storageHost) {
  await storageHost.set(GATE_DEFAULTS_KEY, { consequenceCeiling: GATE_CONSEQUENCE_CEILING, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`gate defaults publish failed: ${error.message}`))
}

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
  // A panel that gave up waiting overwrites its own pending request with a
  // redacted tombstone (buildSecretTombstone in worker-status.mjs and its
  // config.html copy) rather than let a plaintext key linger in storage --
  // a panel cannot delete a key. This is never a live request: leave it
  // exactly as it is, redacted, and never attend it.
  if (request.tombstone === true) return

  await storageHost.delete(SECRET_REQUEST_KEY).catch((error) =>
    orca.log(`secret request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    // Was a silent discard: the person was already told the save/clear
    // failed once the panel's own 20s wait ran out, so simply dropping the
    // request here lost the only record of what actually happened to it.
    // 'expired' is a stable reason code (see the note below) so a panel
    // open later can still show the real cause instead of nothing.
    await storageHost.set(SECRET_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`secret result publish failed: ${err.message}`))
    return
  }

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
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(CLAUDE_INTEGRATION_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`claude integration result publish failed: ${err.message}`))
    return
  }

  let result
  if (request.intent === 'install') {
    result = await installClaudeIntegration(orca)
  } else if (request.intent === 'uninstall') {
    result = await uninstallClaudeIntegration(orca)
  } else {
    result = { ok: false, reason: 'unknown-intent', detail: `unrecognized claude integration request intent: ${String(request.intent).slice(0, 60)}` }
  }

  await storageHost.set(CLAUDE_INTEGRATION_RESULT_KEY, claudeIntegrationResultPayload(request.id, result))
    .catch((err) => orca.log(`claude integration result publish failed: ${err.message}`))

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
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(LOCALE_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`locale result publish failed: ${err.message}`))
    return
  }

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
// Skill/tool selection switches -- mod-skills' `active`/`activeTools`
// (adapters/claude/mod-skills/hooks/index.ts) used to read only Claude
// Code's `options`, which nothing in this repo populates (no `userConfig`
// declared anywhere -- see src/core/mod_skills_config.ts's own module note),
// so both switches were permanently unreachable (T10,
// odd/tasks/panel-worker-wakeup.md). Same request/result/TTL shape and same
// mirror sidecar as the locale channel above: the config panel cannot write
// a file itself, so it leaves a request here and this worker mirrors it to
// `<configDir>/mod-skills-config.json`, which the hooks sandbox reads
// directly (it has no channel into `storage`, same reason as the locale and
// secret-key files).
// ---------------------------------------------------------------------------

const MOD_SKILLS_CONFIG_REQUEST_KEY = 'modSkillsConfigRequest'
const MOD_SKILLS_CONFIG_RESULT_KEY = 'modSkillsConfigResult'
const MOD_SKILLS_STATUS_KEY = 'modSkillsStatus'

/** Reads the mirror file's current switches, defaulting to both off on any
 *  failure or malformed value -- never thrown, matching the file's own
 *  best-effort contract (src/core/mod_skills_config.ts). `options.mirror`
 *  lets tests substitute a fake in place of the real sidecar; production
 *  passes none and gets the real runSecretMirrorScript. */
async function readModSkillsConfigMirror (options = {}) {
  const mirror = options.mirror ?? runSecretMirrorScript
  return mirror('mod-skills-config-read')
}

/** Publishes the mirror's current switches for the panel to render on load
 *  -- the panel has no way to read the file itself. Called at activation and
 *  again after every successful save, same one-shot-plus-refresh shape as
 *  publishLocaleStatus. */
async function publishModSkillsStatus (orca, storageHost, options = {}) {
  const result = await readModSkillsConfigMirror(options)
  const value = result.ok && isRecord(result.value) &&
    typeof result.value.active === 'boolean' && typeof result.value.activeTools === 'boolean'
    ? { active: result.value.active, activeTools: result.value.activeTools }
    : { active: false, activeTools: false }
  await storageHost.set(MOD_SKILLS_STATUS_KEY, { ...value, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`mod-skills status publish failed: ${error.message}`))
}

/** Attends one pending switch-change request from the panel, if any. */
async function attendModSkillsConfigRequest (orca, storageHost, options = {}) {
  const request = await storageHost.get(MOD_SKILLS_CONFIG_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(MOD_SKILLS_CONFIG_REQUEST_KEY).catch((error) =>
    orca.log(`mod-skills config request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(MOD_SKILLS_CONFIG_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`mod-skills config result publish failed: ${err.message}`))
    return
  }

  const active = request.active === true
  const activeTools = request.activeTools === true
  const mirror = options.mirror ?? runSecretMirrorScript
  const result = await mirror('mod-skills-config-save', JSON.stringify({ active, activeTools }))
  if (!result.ok) {
    orca.log(`mod-skills config mirror (save) failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 160)}`)
  }

  await storageHost.set(MOD_SKILLS_CONFIG_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`mod-skills config result publish failed: ${err.message}`))

  await publishModSkillsStatus(orca, storageHost, options)
}

// ---------------------------------------------------------------------------
// Deny-tier switches -- same request/result/status shape as the skill/tool
// selection switches above, for the nine switches that guard the
// NEVER_SILENTLY rules adapters/claude/gate-bash.ts denies by default (DENY_TOGGLE_KEYS in
// src/core/deny_tier_config.ts). See that file's module note for why this
// one is different: it fails CLOSED (every switch defaults to `true`, still
// denying) rather than open, so a missing or malformed mirror file must
// never quietly disable protection.
// ---------------------------------------------------------------------------

const DENY_TIER_CONFIG_REQUEST_KEY = 'denyTierConfigRequest'
const DENY_TIER_CONFIG_RESULT_KEY = 'denyTierConfigResult'
const DENY_TIER_STATUS_KEY = 'denyTierStatus'

/** Reads the mirror file's current switches, defaulting to all of them on
 *  (still denying) on any failure or malformed value -- never thrown,
 *  matching the file's own fail-CLOSED contract (src/core/deny_tier_config.ts).
 *  `options.mirror` lets tests substitute a fake in place of the real
 *  sidecar; production passes none and gets the real runSecretMirrorScript. */
async function readDenyTierConfigMirror (options = {}) {
  const mirror = options.mirror ?? runSecretMirrorScript
  return mirror('deny-tier-config-read')
}

/** Publishes the mirror's current switches for the panel to render on load
 *  -- the panel has no way to read the file itself. Called at activation and
 *  again after every successful save, same one-shot-plus-refresh shape as
 *  publishModSkillsStatus. Fails CLOSED: any read failure or malformed value
 *  publishes all three `true` (still denying), never `false`. */
async function publishDenyTierStatus (orca, storageHost, options = {}) {
  const result = await readDenyTierConfigMirror(options)
  // Built from DENY_TOGGLE_KEYS so a rule added to the gate cannot be missing
  // here, and so a field that is absent or the wrong type publishes `true`
  // (still denying) for that field alone.
  const source = result.ok && isRecord(result.value) ? result.value : {}
  const value = Object.fromEntries(
    DENY_TOGGLE_KEYS.map((key) => [key, typeof source[key] === 'boolean' ? source[key] : true]),
  )
  await storageHost.set(DENY_TIER_STATUS_KEY, { ...value, checkedAt: new Date().toISOString() })
    .catch((error) => orca.log(`deny-tier status publish failed: ${error.message}`))
}

/** Attends one pending switch-change request from the panel, if any. A
 *  missing/non-boolean field in the request itself is treated as `true`
 *  (still denying) -- the same fail-CLOSED default as an unreadable file --
 *  never as `false`. */
async function attendDenyTierConfigRequest (orca, storageHost, options = {}) {
  const request = await storageHost.get(DENY_TIER_CONFIG_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(DENY_TIER_CONFIG_REQUEST_KEY).catch((error) =>
    orca.log(`deny-tier config request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(DENY_TIER_CONFIG_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`deny-tier config result publish failed: ${err.message}`))
    return
  }

  // Anything that is not an explicit `false` stays denying.
  const switches = Object.fromEntries(DENY_TOGGLE_KEYS.map((key) => [key, request[key] !== false]))
  const mirror = options.mirror ?? runSecretMirrorScript
  const result = await mirror('deny-tier-config-save', JSON.stringify(switches))
  if (!result.ok) {
    orca.log(`deny-tier config mirror (save) failed: ${String(result.reason ?? 'unknown')} -- ${String(result.detail ?? '').slice(0, 160)}`)
  }

  await storageHost.set(DENY_TIER_CONFIG_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`deny-tier config result publish failed: ${err.message}`))

  await publishDenyTierStatus(orca, storageHost, options)
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
// Catalog refresh -- same request/result shape as the secret/Claude-
// integration/locale channels: the panel cannot call
// orca.commands.register'd 'advisor.refreshCatalog' directly (the
// sandboxed bridge only allows notifications.show/storage.get/
// storage.set), so its "Refresh from Orca" button leaves a request here.
// ---------------------------------------------------------------------------

const CATALOG_REFRESH_REQUEST_KEY = 'catalogRefreshRequest'
const CATALOG_REFRESH_RESULT_KEY = 'catalogRefreshResult'

/** Attends one pending catalog-refresh request from the panel, if any. */
async function attendCatalogRefreshRequest (orca, storageHost) {
  const request = await storageHost.get(CATALOG_REFRESH_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(CATALOG_REFRESH_REQUEST_KEY).catch((error) =>
    orca.log(`catalog refresh request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(CATALOG_REFRESH_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, added: null, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`catalog refresh result publish failed: ${err.message}`))
    return
  }

  const result = await cmdRefreshCatalog(orca, storageHost)
  await storageHost.set(CATALOG_REFRESH_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, added: result.added ?? null, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`catalog refresh result publish failed: ${err.message}`))
}

// ---------------------------------------------------------------------------
// Policy seed import -- same request/result shape as catalog refresh above:
// the panel's TEAM POLICIES section cannot call cmdImportPolicySeeds
// directly (same sandboxed bridge restriction), so its import action leaves
// a request here.
// ---------------------------------------------------------------------------

const POLICY_SEED_IMPORT_REQUEST_KEY = 'policySeedImportRequest'
const POLICY_SEED_IMPORT_RESULT_KEY = 'policySeedImportResult'

/** Attends one pending policy-seed-import request from the panel, if any.
 *  `request.acceptedIds`, when present, is the developer's explicit choice of
 *  which reported `differing` ids to actually replace -- see
 *  cmdImportPolicySeeds and policy_seed_import.ts's applyPolicySeedChoices.
 *  A request with no `acceptedIds` (or an old panel state that never sent
 *  one) only adds new ids, exactly like calling the command with none. */
async function attendPolicySeedImportRequest (orca, storageHost, options = {}) {
  const request = await storageHost.get(POLICY_SEED_IMPORT_REQUEST_KEY)
  if (!isRecord(request) || typeof request.id !== 'string' || typeof request.at !== 'string') return

  await storageHost.delete(POLICY_SEED_IMPORT_REQUEST_KEY).catch((error) =>
    orca.log(`policy seed import request cleanup failed: ${error.message}`))

  const age = Date.now() - Date.parse(request.at)
  if (!(age >= 0) || age > SECRET_REQUEST_TTL_MS) {
    await storageHost.set(POLICY_SEED_IMPORT_RESULT_KEY, {
      id: request.id, at: new Date().toISOString(), ok: false, added: null, skipped: null, differing: null, replaced: null, reason: 'expired', detail: 'the request is older than SECRET_REQUEST_TTL_MS and was never attended.'
    }).catch((err) => orca.log(`policy seed import result publish failed: ${err.message}`))
    return
  }

  const acceptedIds = Array.isArray(request.acceptedIds) ? request.acceptedIds : options.acceptedIds
  const result = await cmdImportPolicySeeds(orca, storageHost, { ...options, acceptedIds })
  await storageHost.set(POLICY_SEED_IMPORT_RESULT_KEY, {
    id: request.id, at: new Date().toISOString(), ok: result.ok, added: result.added ?? null, skipped: result.skipped ?? null, differing: result.differing ?? null, replaced: result.replaced ?? null, reason: result.reason ?? null, detail: result.detail ?? null
  }).catch((err) => orca.log(`policy seed import result publish failed: ${err.message}`))
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
    const { stdout } = await execFileAsync(ORCA_CLI_BIN, ORCA_CLI_ARGUMENTS.worktreeList, orcaCliOptions(PLATFORM, PLUGIN_ROOT))
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
  if (!status.modCopy.installed) parts.push('the skills mod copy is missing or stale')
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
    await execFileAsync(ORCA_CLI_BIN, ORCA_CLI_ARGUMENTS.status, orcaCliOptions(PLATFORM, PLUGIN_ROOT))
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
  orca.commands.register('advisor.refreshCatalog', () => cmdRefreshCatalog(orca, storageHost))

  // Secret AND Claude-integration request/result polling loop (see
  // attendSecretRequest / attendClaudeIntegrationRequest above). Polls fast
  // while the config panel has recently signalled it is open, and backs off
  // to an idle-cheap cadence otherwise -- the worker is reaped after 5
  // minutes idle, so this timer must be (and is) cleared by teardown below.
  let secretPollStopped = false
  let secretTimer = null
  const catalogPolicyMirrorSeen = { value: null }
  const policySeedNoticeSeen = { value: null }
  const runSecretPoll = () => {
    publishWorkerHeartbeat(orca, storageHost)
      .then(() => attendSecretRequest(orca, storageHost, secretsHost))
      .catch((error) => orca.log(`secret request handling failed: ${error.message}`))
      .then(() => attendClaudeIntegrationRequest(orca, storageHost))
      .catch((error) => orca.log(`claude integration request handling failed: ${error.message}`))
      .then(() => attendLocaleRequest(orca, storageHost))
      .catch((error) => orca.log(`locale request handling failed: ${error.message}`))
      .then(() => attendModSkillsConfigRequest(orca, storageHost))
      .catch((error) => orca.log(`mod-skills config request handling failed: ${error.message}`))
      .then(() => attendDenyTierConfigRequest(orca, storageHost))
      .catch((error) => orca.log(`deny-tier config request handling failed: ${error.message}`))
      .then(() => attendCatalogPolicyMirrorRequest(orca, storageHost, catalogPolicyMirrorSeen))
      .catch((error) => orca.log(`catalog/policies mirror handling failed: ${error.message}`))
      .then(() => attendCatalogRefreshRequest(orca, storageHost))
      .catch((error) => orca.log(`catalog refresh request handling failed: ${error.message}`))
      .then(() => attendPolicySeedImportRequest(orca, storageHost))
      .catch((error) => orca.log(`policy seed import request handling failed: ${error.message}`))
      .then(() => attendPolicySeedDismissRequest(orca, storageHost))
      .catch((error) => orca.log(`policy seed dismiss request handling failed: ${error.message}`))
      .then(() => attendPolicySeedNoticeRefresh(orca, storageHost, policySeedNoticeSeen))
      .catch((error) => orca.log(`policy seed notice refresh failed: ${error.message}`))
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
  // Bootstraps the catalog from Orca's own worktrees when it is still
  // empty (never otherwise -- see deriveInitialCatalogIfEmpty), chained
  // before the mirror below so a freshly-derived catalog reaches
  // catalog.json on this same activation. Same convergence guarantee as
  // the key above for the mirror itself: a worker restarted after the
  // catalog/policies mirror files were lost or never written by an older
  // version of this plugin catches up without the user having to touch
  // the panel's save button again.
  deriveInitialCatalogIfEmpty(orca, storageHost)
    .catch((error) => orca.log(`initial catalog derivation failed: ${error.message}`))
    .then(() => seedPoliciesIfEmpty(orca, storageHost))
    .catch((error) => orca.log(`initial policy seeding failed: ${error.message}`))
    .then(() => mirrorCatalogAndPolicies(orca, storageHost))
    .catch((error) => orca.log(`initial catalog/policies mirror failed: ${error.message}`))
    .then(() => publishPolicySeedNoticeStatus(orca, storageHost))
    .catch((error) => orca.log(`initial policy seed notice status failed: ${error.message}`))
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
  publishModSkillsStatus(orca, storageHost)
    .catch((error) => orca.log(`initial mod-skills status failed: ${error.message}`))
  publishDenyTierStatus(orca, storageHost)
    .catch((error) => orca.log(`initial deny-tier status failed: ${error.message}`))
  publishWorkerHeartbeat(orca, storageHost)
  publishGateDefaults(orca, storageHost)
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

// ---------------------------------------------------------------------------
// Named exports -- for `node --test` only. `activate` above is the one
// export Orca itself loads (see this module's header); everything below is
// already a plain function taking its host(s) as a parameter, so exporting
// it needs no restructuring, just a name to import by
// (adapters/orca/main.test.mjs, odd/tasks/panel-worker-wakeup.md).
// ---------------------------------------------------------------------------

export {
  attendCatalogRefreshRequest,
  attendClaudeIntegrationRequest,
  attendDenyTierConfigRequest,
  attendLocaleRequest,
  attendModSkillsConfigRequest,
  attendPolicySeedDismissRequest,
  attendPolicySeedImportRequest,
  attendPolicySeedNoticeRefresh,
  attendSecretRequest,
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
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_STALE_MS
}
