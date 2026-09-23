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
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizePlatform, resolveConfigDirCandidates } from '../../src/core/paths.ts'
import {
  ORCA_USER_DATA_ENV,
  accountConfigTarget,
  claudeAccountsDir,
  homeConfigTarget,
  resolveOrcaUserDataDir,
  settingsPathFor,
  skillsDirFor
} from '../../src/core/orca_accounts.ts'

// `~/.claude/...` is Claude Code's own convention, not ours to redefine --
// it stays home-relative on every platform (Claude Code's own docs give no
// OS-specific path for it). `os.homedir()` already resolves HOME vs
// USERPROFILE correctly per platform. Only our OWN bookkeeping directory
// (STATE_DIR) follows the `.config`/`%APPDATA%` convention this project
// does control -- see src/core/paths.ts.
const HOME = homedir()
const PLATFORM = normalizePlatform(process.platform)
// Writes go to the first candidate; reads try each in turn. On Linux, once
// XDG_CONFIG_HOME is honoured, an existing install's state and backup sit in
// ~/.config/orca-supervisor -- and losing sight of them would mean uninstall
// could no longer restore what install captured, which is the one file that
// cannot be reconstructed later.
const STATE_DIRS = resolveConfigDirCandidates(PLATFORM, { home: HOME, appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME })
const STATE_DIR = STATE_DIRS[0]
const STATE_PATH = join(STATE_DIR, 'claude-settings-install-state.json')

// ---------------------------------------------------------------------------
// Install targets.
//
// `~/.claude` alone is NOT enough, and getting this wrong was invisible:
// Orca launches every agent pane with CLAUDE_CONFIG_DIR pointing at
// <userData>/claude-accounts/<uuid>/auth, so a hook written to the home
// settings.json never runs in the panes -- the one place a plugin built
// FOR Orca most needs it. See src/core/orca_accounts.ts.
//
// Discovery is by directory listing, never a hardcoded account id, and the
// userData root comes from Orca's own ORCA_USER_DATA_PATH so that a machine
// running both a release and a development Orca gets the one that is
// actually hosting this plugin.
// ---------------------------------------------------------------------------

async function discoverTargets () {
  const targets = [homeConfigTarget(PLATFORM, HOME)]
  const userData = resolveOrcaUserDataDir(PLATFORM, {
    home: HOME,
    appDataDir: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    orcaUserDataPath: process.env[ORCA_USER_DATA_ENV]
  })
  const accountsDir = claudeAccountsDir(PLATFORM, userData.path)
  let entries = []
  try {
    entries = await readdir(accountsDir, { withFileTypes: true })
  } catch (error) {
    // No Orca accounts reachable from here (not installed, a different
    // userData, or the installer run from a plain terminal). The home
    // target still installs; the caller reports the gap rather than
    // pretending the panes are covered.
    return { targets, userData, accountsDir, accountsFound: false, reason: String(error?.code ?? error) }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    targets.push(accountConfigTarget(PLATFORM, accountsDir, entry.name))
  }
  return { targets, userData, accountsDir, accountsFound: true, reason: null }
}

/** State and backup files are per target, so one account's original shape is never mistaken for another's. */
function stateKey (target) {
  return target.id.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function backupPathFor (target) {
  return join(STATE_DIR, `claude-settings-backup.${stateKey(target)}.json`)
}

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

async function readSettings (settingsPath) {
  try {
    const raw = await readFile(settingsPath, 'utf8')
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
async function writeSettingsAtomic (settingsPath, settings) {
  await mkdir(dirname(settingsPath), { recursive: true })
  const tempPath = `${settingsPath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  const testDelay = Number(process.env.ORCA_TEST_DELAY_BEFORE_RENAME_MS ?? '0')
  if (testDelay > 0) await new Promise((resolve) => setTimeout(resolve, testDelay))
  await rename(tempPath, settingsPath)
}

/** Backs up the pre-modification settings.json exactly once: a run that
 *  finds a backup already there leaves it alone, so a later, already-
 *  modified state is never mistaken for the original. */
async function backupSettingsOnce (backupPath, currentRawText) {
  await mkdir(STATE_DIR, { recursive: true })
  try {
    await readFile(backupPath, 'utf8')
    return // already backed up once; never overwrite the original capture
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const tempPath = `${backupPath}.${randomUUID()}.tmp`
  await writeFile(tempPath, currentRawText, 'utf8')
  await rename(tempPath, backupPath)
}

// ---------------------------------------------------------------------------
// Install-state bookkeeping -- what the env var held before we ever touched
// it, captured once, on the first install, and reused (never recomputed) on
// every install after that. Recomputing it on a second install would see
// OUR OWN prior write and "remember" that as the user's original value.
// ---------------------------------------------------------------------------

async function readInstallState () {
  for (const dir of STATE_DIRS) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'claude-settings-install-state.json'), 'utf8'))
      if (isRecord(parsed)) return parsed
    } catch {
      continue
    }
  }
  return null
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

async function currentModLinkTarget (modLinkPath) {
  try {
    const stat = await lstat(modLinkPath)
    if (!stat.isSymbolicLink()) return { exists: true, isSymlink: false, target: null }
    return { exists: true, isSymlink: true, target: await readlink(modLinkPath) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, isSymlink: false, target: null }
    throw error
  }
}

async function installModLink (pluginRoot, modLinkPath) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const current = await currentModLinkTarget(modLinkPath)
  if (current.isSymlink && current.target === source) return { changed: false }
  if (current.exists) {
    // Ours by convention (the distinctive name), but not pointing where we
    // expect (a stale link from a moved plugin root, or a leftover
    // non-symlink): replace it rather than leaving two conflicting copies.
    await rm(modLinkPath, { recursive: true, force: true })
  }
  await mkdir(dirname(modLinkPath), { recursive: true })
  try {
    await symlink(source, modLinkPath, 'dir')
  } catch (error) {
    return { changed: false, error: `could not symlink the mod (${String(error?.message ?? error)}); Windows or a restricted filesystem may not allow it here` }
  }
  return { changed: true }
}

async function uninstallModLink (pluginRoot, modLinkPath) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const current = await currentModLinkTarget(modLinkPath)
  if (!current.exists) return { changed: false }
  if (!current.isSymlink || current.target !== source) {
    // Not ours (or not pointing at this plugin root): leave it alone rather
    // than guessing whose it is.
    return { changed: false, skipped: true }
  }
  await unlink(modLinkPath)
  return { changed: true }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** Per-target bookkeeping. v1 stored one flat record for ~/.claude alone;
 *  it is migrated under the `home` key so an existing install keeps the
 *  "what did this look like before we touched it" facts it captured, which
 *  are only knowable once and cannot be recomputed. */
function targetStates (state) {
  if (isRecord(state.targets)) return state.targets
  const legacy = { ...state }
  delete legacy.installedAt
  return Object.keys(legacy).length > 0 ? { home: legacy } : {}
}

function modLinkPathFor (target) {
  return join(skillsDirFor(PLATFORM, target), 'orca-jev-mod-skills')
}

async function install (pluginRoot) {
  const gatePath = join(pluginRoot, 'adapters', 'claude', 'gate-bash.ts')
  const discovery = await discoverTargets()
  const stored = (await readInstallState()) ?? {}
  const states = targetStates(stored)

  const perTarget = []
  let nodeVerified = true
  for (const target of discovery.targets) {
    const settingsPath = settingsPathFor(PLATFORM, target)
    const state = isRecord(states[target.id]) ? states[target.id] : {}
    try {
      const rawBefore = await readFile(settingsPath, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return '{}\n'
        throw error
      })
      await backupSettingsOnce(backupPathFor(target), rawBefore)

      const settings = await readSettings(settingsPath)
      const hook = installHookEntry(settings, gatePath, state)
      const envChanged = installEnvVar(settings, state)
      await writeSettingsAtomic(settingsPath, settings)
      states[target.id] = state
      if (!hook.nodeVerified) nodeVerified = false

      const modResult = await installModLink(pluginRoot, modLinkPathFor(target))
      perTarget.push({
        id: target.id,
        label: target.label,
        orcaManaged: target.orcaManaged,
        ok: true,
        changes: { hook: hook.changed, env: envChanged, modLink: modResult.changed },
        modLinkWarning: modResult.error ?? null
      })
    } catch (error) {
      // One unwritable target (a permission problem, a settings.json
      // someone is editing) must not abandon the others half-installed.
      perTarget.push({ id: target.id, label: target.label, orcaManaged: target.orcaManaged, ok: false, detail: String(error?.message ?? error).slice(0, 300) })
    }
  }
  await writeInstallState({ version: 2, targets: states, installedAt: stored.installedAt ?? new Date().toISOString() })

  const failed = perTarget.filter((t) => !t.ok)
  const orcaTargets = perTarget.filter((t) => t.orcaManaged && t.ok).length
  return {
    ok: failed.length < perTarget.length,
    targets: perTarget,
    orcaAccountsInstalled: orcaTargets,
    // Where the Orca accounts were looked for, and whether Orca itself said
    // so -- `convention` means we guessed a standard install path, which is
    // right on a normal machine but cannot tell two Orca installs apart.
    orcaUserData: { path: discovery.userData.path, source: discovery.userData.source, accountsDir: discovery.accountsDir, found: discovery.accountsFound, reason: discovery.reason },
    changes: {
      hook: perTarget.some((t) => t.ok && t.changes.hook),
      env: perTarget.some((t) => t.ok && t.changes.env),
      modLink: perTarget.some((t) => t.ok && t.changes.modLink)
    },
    modLinkWarning: perTarget.find((t) => t.ok && t.modLinkWarning)?.modLinkWarning ?? null,
    failures: failed,
    nodeCommandVerified: nodeVerified
  }
}

async function uninstall (pluginRoot) {
  const discovery = await discoverTargets()
  const stored = (await readInstallState()) ?? {}
  const states = targetStates(stored)
  // A target we no longer discover (an account Orca removed) is still
  // cleaned if we have a record of installing into it: uninstall must not
  // leave our hook behind just because discovery moved on.
  const byId = new Map(discovery.targets.map((t) => [t.id, t]))
  for (const id of Object.keys(states)) {
    if (byId.has(id)) continue
    if (id === 'home') byId.set(id, homeConfigTarget(PLATFORM, HOME))
    else if (id.startsWith('account:')) byId.set(id, accountConfigTarget(PLATFORM, discovery.accountsDir, id.slice('account:'.length)))
  }

  const perTarget = []
  for (const target of byId.values()) {
    const settingsPath = settingsPathFor(PLATFORM, target)
    // Missing state fails toward NOT deleting a container that might be the
    // user's own: every "existed before" flag defaults to true, so an absent
    // record only ever under-cleans.
    const state = isRecord(states[target.id]) ? states[target.id] : {
      hadEnvVarBefore: false, priorEnvValue: null, envObjectExistedBefore: true,
      hooksObjectExistedBefore: true, preToolUseArrayExistedBefore: true, bashGroupExistedBefore: true
    }
    try {
      const settings = await readSettings(settingsPath)
      const hookChanged = uninstallHookEntry(settings, state)
      const envChanged = uninstallEnvVar(settings, state)
      await writeSettingsAtomic(settingsPath, settings)
      const modResult = await uninstallModLink(pluginRoot, modLinkPathFor(target))
      await rm(backupPathFor(target), { force: true })
      perTarget.push({
        id: target.id, label: target.label, orcaManaged: target.orcaManaged, ok: true,
        changes: { hook: hookChanged, env: envChanged, modLink: modResult.changed },
        modLinkWarning: modResult.skipped ? 'mod-skills link did not point at this plugin; left untouched' : null
      })
    } catch (error) {
      perTarget.push({ id: target.id, label: target.label, orcaManaged: target.orcaManaged, ok: false, detail: String(error?.message ?? error).slice(0, 300) })
    }
  }
  await rm(STATE_PATH, { force: true })

  return {
    ok: perTarget.some((t) => t.ok),
    targets: perTarget,
    changes: {
      hook: perTarget.some((t) => t.ok && t.changes.hook),
      env: perTarget.some((t) => t.ok && t.changes.env),
      modLink: perTarget.some((t) => t.ok && t.changes.modLink)
    },
    modLinkWarning: perTarget.find((t) => t.ok && t.modLinkWarning)?.modLinkWarning ?? null,
    failures: perTarget.filter((t) => !t.ok)
  }
}

async function status (pluginRoot) {
  const gatePath = join(pluginRoot, 'adapters', 'claude', 'gate-bash.ts')
  const modSource = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const discovery = await discoverTargets()

  const perTarget = []
  for (const target of discovery.targets) {
    const settingsPath = settingsPathFor(PLATFORM, target)
    let settings = {}
    let readError = null
    try {
      settings = await readSettings(settingsPath)
    } catch (error) {
      readError = String(error?.message ?? error).slice(0, 200)
    }
    const group = isRecord(settings.hooks) && Array.isArray(settings.hooks.PreToolUse)
      ? settings.hooks.PreToolUse.find((g) => isRecord(g) && g.matcher === 'Bash')
      : undefined
    const ownHook = group && Array.isArray(group.hooks) ? group.hooks.find((h) => isRecord(h) && h.statusMessage === HOOK_STATUS_MESSAGE) : undefined
    const modLink = await currentModLinkTarget(modLinkPathFor(target)).catch(() => ({ isSymlink: false, target: null }))
    perTarget.push({
      id: target.id,
      label: target.label,
      orcaManaged: target.orcaManaged,
      settingsPath,
      readError,
      hook: { installed: ownHook !== undefined, pathMatches: ownHook !== undefined && Array.isArray(ownHook.args) && ownHook.args.includes(gatePath) },
      env: { installed: isRecord(settings.env) && settings.env[ENV_VAR_NAME] === ENV_VAR_VALUE },
      modLink: { installed: modLink.isSymlink && modLink.target === modSource }
    })
  }

  const orcaTargets = perTarget.filter((t) => t.orcaManaged)
  return {
    ok: true,
    targets: perTarget,
    // The headline figures the panel shows: "installed" must mean every
    // place Claude Code actually reads, and the Orca panes are the ones
    // that matter most for a plugin shipped for Orca.
    hook: {
      installed: perTarget.every((t) => t.hook.installed),
      installedCount: perTarget.filter((t) => t.hook.installed).length,
      totalCount: perTarget.length,
      orcaPanesCovered: orcaTargets.length > 0 && orcaTargets.every((t) => t.hook.installed),
      orcaPaneCount: orcaTargets.length
    },
    env: { installed: perTarget.every((t) => t.env.installed), name: ENV_VAR_NAME },
    modLink: { installed: perTarget.every((t) => t.modLink.installed) },
    orcaUserData: { path: discovery.userData.path, source: discovery.userData.source, accountsDir: discovery.accountsDir, found: discovery.accountsFound, reason: discovery.reason },
    statePath: STATE_PATH
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
