#!/usr/bin/env node
/**
 * install-claude-integration.mjs — sidecar for orca-jev-advisor's Claude
 * Code side: the PreToolUse hook in ~/.claude/settings.json, the
 * CLAUDE_CODE_ENABLE_FUNCTION_HOOKS env var, and the mod-skills symlink
 * under ~/.claude/skills/. Runs as a clean child of the plugin worker
 * (main.mjs's `sidecarEnv`), for the same reason write-secret-mirror.mjs
 * does: the worker's own permission sandbox only lets it read its plugin
 * root, and every one of these lives outside it.
 *
 * Usage: node install-claude-integration.mjs <install|uninstall|status> <pluginRoot>
 *
 * install     Idempotent. Adds our entry to the `Bash`-matcher group of
 *             hooks.PreToolUse (creating the group if none exists),
 *             merging into whatever hooks other owners already put there
 *             -- never replacing the group, never touching another
 *             entry. Sets CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in `env`,
 *             remembering (once, on the FIRST install only) whether that
 *             key already existed and what it held, so uninstall can put
 *             it back exactly. Symlinks <pluginRoot>/adapters/claude/
 *             mod-skills to ~/.claude/skills/orca-jev-mod-skills, which
 *             Claude Code auto-loads from (the "skills-dir" mechanism).
 *             Every settings.json write is atomic (temp file + rename)
 *             and preceded, on the very first install, by a full backup.
 * uninstall   Surgical: removes only the one hook entry our own
 *             `statusMessage` marks (dropping the `Bash` group entirely
 *             if that was its only entry), restores the env var to
 *             whatever it held before we ever touched it (or removes it,
 *             if it was never there), and removes the mod-skills symlink
 *             -- but only if it still points at OUR pluginRoot. Every
 *             other hook, and anything the user changed in between, is
 *             left exactly as found.
 * status      Read-only: reports whether each of the three is in place
 *             right now, for the config panel and advisor.doctor.
 *
 * Always prints exactly one JSON line to stdout, nothing else. Never
 * touches anything but ~/.claude/settings.json, ~/.claude/skills/
 * orca-jev-mod-skills, and our own bookkeeping under
 * ~/.config/orca-supervisor/.
 */
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizePlatform, resolveConfigDir } from '../../src/core/paths.ts'

// `~/.claude/...` is Claude Code's own convention, not ours to redefine --
// it stays home-relative on every platform (Claude Code's own docs give no
// OS-specific path for it). `os.homedir()` already resolves HOME vs
// USERPROFILE correctly per platform. Only our OWN bookkeeping directory
// (STATE_DIR) follows the `.config`/`%APPDATA%` convention this project
// does control -- see src/core/paths.ts.
const HOME = homedir()
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json')
const MOD_LINK_PATH = join(HOME, '.claude', 'skills', 'orca-jev-mod-skills')
const STATE_DIR = resolveConfigDir(normalizePlatform(process.platform), { home: HOME, appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA })
const STATE_PATH = join(STATE_DIR, 'claude-settings-install-state.json')
const BACKUP_PATH = join(STATE_DIR, 'claude-settings-backup.json')

const ENV_VAR_NAME = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'
const ENV_VAR_VALUE = '1'
const HOOK_STATUS_MESSAGE = 'orca-jev-advisor: asking Jev before running this command'
const HOOK_TIMEOUT_SECONDS = 6

// ---------------------------------------------------------------------------
// Small guards -- settings.json is a host-boundary value (unknown), and it
// is not ours: only the shape we read is checked, everything else survives
// untouched, whatever it is.
// ---------------------------------------------------------------------------

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A previous version of this hook was a shell pipeline (`INPUT=$(cat); ...
 * grep -qE ... | node ...`) that pre-filtered which commands even started
 * Node, using `jq`/`grep`/`printf`. That only runs under a POSIX shell:
 * Windows without Git Bash resolves a settings.json command hook through
 * PowerShell, where none of those exist -- verified against the settings
 * schema's own hook shapes, not assumed. The schema's `args` form is the
 * portable one: "When present, `command` is resolved as an executable and
 * spawned directly with these arguments — no shell." No `grep` prefilter
 * survives that -- and none is needed: gate-bash.ts already carries its
 * own local pattern tiers (OBVIOUSLY_SAFE, NEVER_SILENTLY), which is what
 * actually decided "does this need Jev" even before this rewrite. The only
 * real cost of dropping the shell prefilter is that Node now starts once
 * per Bash command instead of only for risky-looking ones -- measured
 * against this machine below (see the feature document).
 */
function gateHookEntry (nodeCommand, gatePath) {
  return { type: 'command', command: nodeCommand, args: [gatePath], timeout: HOOK_TIMEOUT_SECONDS, statusMessage: HOOK_STATUS_MESSAGE }
}

/**
 * The `node` to put in the hook's `command`: resolved here, never assumed.
 * This sidecar itself runs as whatever binary the worker uses as "node"
 * (the same executable, re-invoked cleanly with a NODE_OPTIONS-stripped env by
 * main.mjs) -- `process.versions.electron` says for certain whether that
 * binary is a real Node or Electron acting as one (`ELECTRON_RUN_AS_NODE`).
 * A real Node's own `process.execPath` is exactly right to hand to Claude
 * Code. Electron's is not safe to hand it: run directly (no
 * `ELECTRON_RUN_AS_NODE`) it opens a window instead of executing a script,
 * and the settings.json hook schema has no `env` field to carry that
 * variable through -- verified against the fetched schema, not assumed.
 * The fallback is the bare `"node"` on PATH, the same resolution the
 * previous shell-based hook already relied on (`node <path>`, resolved by
 * the shell); undocumented until a real install without Node on PATH is
 * observed, which this environment cannot exercise.
 */
function resolveNodeCommand () {
  if (process.versions.electron === undefined) return { command: process.execPath, verified: true }
  return { command: 'node', verified: false }
}

// ---------------------------------------------------------------------------
// Atomic, backed-up settings.json read/write
// ---------------------------------------------------------------------------

async function readSettings () {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`settings.json exists but could not be read/parsed: ${String(error?.message ?? error)}`)
  }
}

/** Writes settings.json atomically (temp file + rename): a crash mid-write
 *  leaves an incomplete TEMP file, never a half-written real one.
 *
 *  `ORCA_TEST_DELAY_BEFORE_RENAME_MS` is read only for the "corrupt the
 *  write on purpose" verification (a real SIGKILL sent to this process
 *  between the temp write and the rename); it is never set in normal
 *  operation, so it is a no-op there. */
async function writeSettingsAtomic (settings) {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  const tempPath = `${SETTINGS_PATH}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  const testDelay = Number(process.env.ORCA_TEST_DELAY_BEFORE_RENAME_MS ?? '0')
  if (testDelay > 0) await new Promise((resolve) => setTimeout(resolve, testDelay))
  await rename(tempPath, SETTINGS_PATH)
}

/** Backs up the pre-modification settings.json exactly once: a run that
 *  finds a backup already there leaves it alone, so a later, already-
 *  modified state is never mistaken for the original. */
async function backupSettingsOnce (currentRawText) {
  await mkdir(STATE_DIR, { recursive: true })
  try {
    await readFile(BACKUP_PATH, 'utf8')
    return // already backed up once; never overwrite the original capture
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const tempPath = `${BACKUP_PATH}.${randomUUID()}.tmp`
  await writeFile(tempPath, currentRawText, 'utf8')
  await rename(tempPath, BACKUP_PATH)
}

// ---------------------------------------------------------------------------
// Install-state bookkeeping -- what the env var held before we ever touched
// it, captured once, on the first install, and reused (never recomputed) on
// every install after that. Recomputing it on a second install would see
// OUR OWN prior write and "remember" that as the user's original value.
// ---------------------------------------------------------------------------

async function readInstallState () {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeInstallState (state) {
  await mkdir(STATE_DIR, { recursive: true })
  const tempPath = `${STATE_PATH}.${randomUUID()}.tmp`
  await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8')
  await rename(tempPath, STATE_PATH)
}

// ---------------------------------------------------------------------------
// Hook merge -- idempotent by construction: re-running install finds our
// own marked entry and replaces it in place rather than adding a second one.
//
// Uninstall's goal is byte-identical restoration when nothing else changed
// in between, not merely "our entry is gone": a container we CREATED
// (`hooks`, `hooks.PreToolUse`, the `Bash` group) is removed once emptying
// it leaves nothing else in it, but a container that already existed before
// we ever touched it -- even one that happens to end up empty -- is left in
// place exactly as it was, empty or not. That distinction is only knowable
// once, at the moment of the very first install (a second install would see
// the shape OUR OWN first install already left), so it is captured into
// `state` then and reused on every run after.
// ---------------------------------------------------------------------------

function findOwnHookIndex (hooks) {
  return hooks.findIndex((h) => isRecord(h) && h.statusMessage === HOOK_STATUS_MESSAGE)
}

function installHookEntry (settings, gatePath, state) {
  if (state.hooksObjectExistedBefore === undefined) state.hooksObjectExistedBefore = isRecord(settings.hooks)
  if (!isRecord(settings.hooks)) settings.hooks = {}

  if (state.preToolUseArrayExistedBefore === undefined) state.preToolUseArrayExistedBefore = Array.isArray(settings.hooks.PreToolUse)
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = []

  let group = settings.hooks.PreToolUse.find((g) => isRecord(g) && g.matcher === 'Bash')
  if (state.bashGroupExistedBefore === undefined) state.bashGroupExistedBefore = group !== undefined
  if (!group) {
    group = { matcher: 'Bash', hooks: [] }
    settings.hooks.PreToolUse.push(group)
  }
  if (!Array.isArray(group.hooks)) group.hooks = []

  const node = resolveNodeCommand()
  const entry = gateHookEntry(node.command, gatePath)
  const existingIndex = findOwnHookIndex(group.hooks)
  const changed = existingIndex === -1 || JSON.stringify(group.hooks[existingIndex]) !== JSON.stringify(entry)
  if (existingIndex === -1) group.hooks.push(entry)
  else group.hooks[existingIndex] = entry
  return { changed, nodeVerified: node.verified }
}

/** Removes only our own entry, then unwinds exactly the containers install
 *  created (never one that pre-existed, however empty it now is) -- see the
 *  note above. */
function uninstallHookEntry (settings, state) {
  if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return false
  const preToolUse = settings.hooks.PreToolUse
  const groupIndex = preToolUse.findIndex((g) => isRecord(g) && g.matcher === 'Bash')
  if (groupIndex === -1) return false
  const group = preToolUse[groupIndex]
  if (!Array.isArray(group.hooks)) return false
  const hookIndex = findOwnHookIndex(group.hooks)
  if (hookIndex === -1) return false

  group.hooks.splice(hookIndex, 1)
  if (group.hooks.length === 0 && !state.bashGroupExistedBefore) preToolUse.splice(groupIndex, 1)
  if (preToolUse.length === 0 && !state.preToolUseArrayExistedBefore) delete settings.hooks.PreToolUse
  if (Object.keys(settings.hooks).length === 0 && !state.hooksObjectExistedBefore) delete settings.hooks
  return true
}

// ---------------------------------------------------------------------------
// Env var
// ---------------------------------------------------------------------------

function installEnvVar (settings, state) {
  // Captured once, on the first install only (see the note above the hook
  // functions): a later install must never re-derive this from a state
  // OUR OWN earlier install already produced.
  if (state.envObjectExistedBefore === undefined) state.envObjectExistedBefore = isRecord(settings.env)
  if (!isRecord(settings.env)) settings.env = {}
  if (state.hadEnvVarBefore === undefined) {
    state.hadEnvVarBefore = Object.prototype.hasOwnProperty.call(settings.env, ENV_VAR_NAME)
    state.priorEnvValue = state.hadEnvVarBefore ? settings.env[ENV_VAR_NAME] : null
  }
  const changed = settings.env[ENV_VAR_NAME] !== ENV_VAR_VALUE
  settings.env[ENV_VAR_NAME] = ENV_VAR_VALUE
  return changed
}

function uninstallEnvVar (settings, state) {
  if (!isRecord(settings.env)) return false
  if (!(ENV_VAR_NAME in settings.env)) return false
  if (state.hadEnvVarBefore) settings.env[ENV_VAR_NAME] = state.priorEnvValue
  else delete settings.env[ENV_VAR_NAME]
  if (Object.keys(settings.env).length === 0 && !state.envObjectExistedBefore) delete settings.env
  return true
}

// ---------------------------------------------------------------------------
// mod-skills symlink
// ---------------------------------------------------------------------------

async function currentModLinkTarget () {
  try {
    const stat = await lstat(MOD_LINK_PATH)
    if (!stat.isSymbolicLink()) return { exists: true, isSymlink: false, target: null }
    return { exists: true, isSymlink: true, target: await readlink(MOD_LINK_PATH) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, isSymlink: false, target: null }
    throw error
  }
}

async function installModLink (pluginRoot) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const current = await currentModLinkTarget()
  if (current.isSymlink && current.target === source) return { changed: false }
  if (current.exists) {
    // Ours by convention (the distinctive name), but not pointing where we
    // expect (a stale link from a moved plugin root, or a leftover
    // non-symlink): replace it rather than leaving two conflicting copies.
    await rm(MOD_LINK_PATH, { recursive: true, force: true })
  }
  await mkdir(dirname(MOD_LINK_PATH), { recursive: true })
  try {
    await symlink(source, MOD_LINK_PATH, 'dir')
  } catch (error) {
    return { changed: false, error: `could not symlink the mod (${String(error?.message ?? error)}); Windows or a restricted filesystem may not allow it here` }
  }
  return { changed: true }
}

async function uninstallModLink (pluginRoot) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const current = await currentModLinkTarget()
  if (!current.exists) return { changed: false }
  if (!current.isSymlink || current.target !== source) {
    // Not ours (or not pointing at this plugin root): leave it alone rather
    // than guessing whose it is.
    return { changed: false, skipped: true }
  }
  await unlink(MOD_LINK_PATH)
  return { changed: true }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function install (pluginRoot) {
  const gatePath = join(pluginRoot, 'adapters', 'claude', 'gate-bash.ts')
  const rawBefore = await readFile(SETTINGS_PATH, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '{}\n'
    throw error
  })
  await backupSettingsOnce(rawBefore)

  const settings = await readSettings()
  const state = (await readInstallState()) ?? {}

  const hook = installHookEntry(settings, gatePath, state)
  const envChanged = installEnvVar(settings, state)
  await writeSettingsAtomic(settings)
  await writeInstallState({ ...state, installedAt: state.installedAt ?? new Date().toISOString() })

  const modResult = await installModLink(pluginRoot)

  return {
    ok: true,
    changes: { hook: hook.changed, env: envChanged, modLink: modResult.changed },
    modLinkWarning: modResult.error ?? null,
    // false only when the running interpreter is Electron-as-node and the
    // hook had to fall back to a bare "node" on PATH -- see
    // resolveNodeCommand. Surfaced so the doctor/panel can say so instead
    // of silently hoping PATH resolves it.
    nodeCommandVerified: hook.nodeVerified,
  }
}

async function uninstall (pluginRoot) {
  const settings = await readSettings()
  // Missing state (e.g. deleted by hand) fails toward NOT deleting a
  // container that might be the user's own: every "existed before" flag
  // defaults to true, so an absent record only ever under-cleans, never
  // removes something it cannot prove it created.
  const state = (await readInstallState()) ?? {
    hadEnvVarBefore: false,
    priorEnvValue: null,
    envObjectExistedBefore: true,
    hooksObjectExistedBefore: true,
    preToolUseArrayExistedBefore: true,
    bashGroupExistedBefore: true,
  }

  const hookChanged = uninstallHookEntry(settings, state)
  const envChanged = uninstallEnvVar(settings, state)
  await writeSettingsAtomic(settings)

  const modResult = await uninstallModLink(pluginRoot)

  await rm(STATE_PATH, { force: true })
  await rm(BACKUP_PATH, { force: true })

  return {
    ok: true,
    changes: { hook: hookChanged, env: envChanged, modLink: modResult.changed },
    modLinkWarning: modResult.skipped ? 'mod-skills link did not point at this plugin; left untouched' : null,
  }
}

async function status (pluginRoot) {
  const settings = await readSettings()
  const gatePath = join(pluginRoot, 'adapters', 'claude', 'gate-bash.ts')
  const group = isRecord(settings.hooks) && Array.isArray(settings.hooks.PreToolUse)
    ? settings.hooks.PreToolUse.find((g) => isRecord(g) && g.matcher === 'Bash')
    : undefined
  const ownHook = group && Array.isArray(group.hooks) ? group.hooks.find((h) => isRecord(h) && h.statusMessage === HOOK_STATUS_MESSAGE) : undefined
  const hookInstalled = ownHook !== undefined
  const hookPathMatches = hookInstalled && Array.isArray(ownHook.args) && ownHook.args.includes(gatePath)
  const envInstalled = isRecord(settings.env) && settings.env[ENV_VAR_NAME] === ENV_VAR_VALUE
  const modLink = await currentModLinkTarget()
  const modInstalled = modLink.isSymlink && modLink.target === join(pluginRoot, 'adapters', 'claude', 'mod-skills')

  return {
    ok: true,
    hook: { installed: hookInstalled, pathMatches: hookPathMatches, path: SETTINGS_PATH },
    env: { installed: envInstalled, name: ENV_VAR_NAME },
    modLink: { installed: modInstalled, path: MOD_LINK_PATH },
    backupPath: BACKUP_PATH,
    statePath: STATE_PATH,
  }
}

async function main () {
  const mode = process.argv[2]
  const pluginRoot = process.argv[3]
  let result
  try {
    if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
      result = { ok: false, reason: 'missing-plugin-root', detail: 'usage: install-claude-integration.mjs <install|uninstall|status> <pluginRoot>' }
    } else if (mode === 'install') {
      result = await install(pluginRoot)
    } else if (mode === 'uninstall') {
      result = await uninstall(pluginRoot)
    } else if (mode === 'status') {
      result = await status(pluginRoot)
    } else {
      result = { ok: false, reason: 'unknown-mode', detail: `unrecognized mode: ${String(mode).slice(0, 60)}` }
    }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 500) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
