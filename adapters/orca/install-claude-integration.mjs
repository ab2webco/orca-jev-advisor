#!/usr/bin/env node
/**
 * install-claude-integration.mjs — sidecar for orca-jev-advisor's Claude
 * Code side: the gate and outcome hooks in ~/.claude/settings.json, the
 * CLAUDE_CODE_ENABLE_FUNCTION_HOOKS env var, and the mod-skills copy
 * under ~/.claude/skills/. Runs as a clean child of the plugin worker
 * (main.mjs's `sidecarEnv`), for the same reason write-secret-mirror.mjs
 * does: the worker's own permission sandbox only lets it read its plugin
 * root, and every one of these lives outside it.
 *
 * Usage: node install-claude-integration.mjs <install|uninstall|status> <pluginRoot>
 *
 * Seven hook entries are managed in total: four in each event's own
 * `Bash`-matcher group (the command gate), and three more in a separate
 * `Agent`-matcher group on the events the Agent tool actually fires
 * (Claude Code's Agent tool is not Bash, so it needs its own matcher
 * group, coexisting with -- never replacing -- the Bash one on the same
 * event):
 *
 *   PreToolUse         adapters/claude/gate-bash.ts     asks Jev before running       (matcher Bash)
 *   PostToolUse        adapters/claude/gate-outcome.ts  the command ran and succeeded -> approved (matcher Bash)
 *   PostToolUseFailure adapters/claude/gate-outcome.ts  the command ran and failed -> still approved (matcher Bash)
 *   PermissionDenied   adapters/claude/gate-outcome.ts  it did not run -> rejected     (matcher Bash)
 *   PreToolUse         adapters/claude/agent-model.ts   asks Jev which model a subagent needs (matcher Agent)
 *   PostToolUse        adapters/claude/agent-model.ts   records the model the subagent ran on (matcher Agent)
 *   PostToolUseFailure adapters/claude/agent-model.ts   records the model, run status "failed" (matcher Agent)
 *
 * install     Idempotent. Adds our entry to the right matcher group (`Bash`
 *             for the command gate, `Agent` for the model-reclassification
 *             hooks) of each event array above (creating the array and the
 *             group when none exists), merging into whatever hooks other
 *             owners already put there, under EITHER matcher -- never
 *             replacing a group, never touching another entry. Sets
 *             CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in `env`, remembering
 *             (once, on the FIRST install only) whether that key already
 *             existed and what it held, so uninstall can put it back
 *             exactly -- the same "captured once, never recomputed" rule
 *             applies per event to whether its array, its `Bash` group and
 *             its `Agent` group already existed. Copies <pluginRoot>/
 *             adapters/claude/mod-skills into
 *             ~/.claude/skills/orca-jev-mod-skills, which Claude Code
 *             auto-loads from (the "skills-dir" mechanism) -- see the
 *             module note above `installModCopy` for why this is a copy
 *             and not a symlink. Every settings.json write is atomic (temp
 *             file + rename) and preceded, on the very first install, by a
 *             full backup.
 * uninstall   Surgical: removes only the hook entry each event's own
 *             `statusMessage` marks, from whichever matcher group (`Bash`
 *             or `Agent`) it lives in (dropping that group entirely if that
 *             was its only entry, and the event's own array if that was its
 *             only group -- across both matchers independently), restores
 *             the env var to whatever it held before we ever touched it (or
 *             removes it, if it was never there), and removes the
 *             mod-skills copy -- but only if its marker still names OUR
 *             pluginRoot (a pre-fix symlink install, which never wrote a
 *             marker, is recognized by its target instead). Every other
 *             hook -- a third party's own `Bash` OR `Agent` group included
 *             -- and anything the user changed in between, is left exactly
 *             as found.
 * status      Read-only: reports whether each of the seven is in place
 *             right now, for the config panel and advisor.doctor.
 *
 * Always prints exactly one JSON line to stdout, nothing else. Never
 * touches anything but ~/.claude/settings.json, ~/.claude/skills/
 * orca-jev-mod-skills (plus its own marker file), and our own bookkeeping
 * under ~/.config/orca-supervisor/.
 */
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises'
// Guarded stand-ins for the mutating fs/promises calls this file makes --
// see guarded_fs.ts's module doc for why every write in this script goes
// through them instead of node:fs/promises's own mkdir/writeFile/rename/rm/cp.
import {
  guardedChmod as chmod,
  guardedMkdir as mkdir,
  guardedRename as rename,
  guardedRm as rm,
  guardedWriteFile as writeFile
} from '../../src/core/guarded_fs.ts'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { buildModSkillsHooksManifest, buildModSkillsPluginManifest, computeModSkillsDigest, walkModSkillsClosure } from '../../src/core/mod_skills_copy.ts'

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
//
// resolveConfigDirCandidates itself now refuses to hand back a real path at
// all while running under node's test runner with no explicit
// ORCA_SUPERVISOR_CONFIG_DIR override (see src/core/paths.ts's module doc)
// -- a stronger, earlier version of exactly the guarantee guarded_fs.ts's
// per-write checks already gave this file. That refusal is deliberately
// caught here, at module scope, rather than left to crash the process
// uncaught: main()'s own try/catch below already reports every other
// failure through `{ok:false, reason:'exception', detail}` on stdout, and
// a path-resolution refusal deserves the exact same clean, parseable
// report instead of an uncaught-exception stack trace on stderr with a
// non-zero exit and no JSON at all.
let STATE_DIRS = []
let STATE_DIR = ''
let STATE_PATH = ''
let STATE_DIR_RESOLUTION_ERROR = null
try {
  STATE_DIRS = resolveConfigDirCandidates(PLATFORM, { home: HOME, appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME })
  STATE_DIR = STATE_DIRS[0]
  STATE_PATH = join(STATE_DIR, 'claude-settings-install-state.json')
} catch (error) {
  STATE_DIR_RESOLUTION_ERROR = error
}

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

// The outcome hook (gate-outcome.ts) only appends one line to a log after
// the command already ran or was denied -- it decides nothing and must
// never be the reason a command's result is delayed, so its timeout is far
// shorter than the gate's own (which has to allow time for a real Jev call).
const OUTCOME_HOOK_STATUS_MESSAGE = 'orca-jev-advisor: recording what you decided'
const OUTCOME_HOOK_TIMEOUT_SECONDS = 2

// The Agent-matcher hooks (adapters/claude/agent-model.ts) -- distinct
// markers from the Bash-matcher ones above, so the two families are never
// confused with each other or with a third party's own Agent hook.
// PreToolUse gets the gate's own timeout budget (it makes a real Jev call,
// same tradeoff as HOOK_TIMEOUT_SECONDS above); PostToolUse/
// PostToolUseFailure only append a log line, so they share the outcome
// hook's short timeout -- see agent-model.ts's own module note.
const AGENT_MODEL_STATUS_MESSAGE = 'orca-jev-advisor: asking Jev which model this subagent needs'
const AGENT_OUTCOME_STATUS_MESSAGE = 'orca-jev-advisor: recording which model the subagent ran on'

/** Every hook entry this installer manages, across BOTH matcher groups
 *  (`Bash` for the command gate, `Agent` for the model-reclassification
 *  hooks). `marker` is the `statusMessage` `findOwnHookIndex` looks for --
 *  distinct per hook, so no two of ours, and no hook of ours and one a
 *  third party owns, are ever confused with each other. `matcher` says
 *  which matcher GROUP an entry's own `Bash`/`Agent` hooks live inside;
 *  installHookEntry/uninstallHookEntry are generalized over it (see their
 *  own doc comments) so a third party's own group under either matcher is
 *  never mistaken for ours. */
function hookSpecs (pluginRoot) {
  const gatePath = join(pluginRoot, 'adapters', 'claude', 'gate-bash.ts')
  const outcomePath = join(pluginRoot, 'adapters', 'claude', 'gate-outcome.ts')
  const agentModelPath = join(pluginRoot, 'adapters', 'claude', 'agent-model.ts')
  const node = resolveNodeCommand()
  return {
    node,
    specs: [
      { event: 'PreToolUse', matcher: 'Bash', marker: HOOK_STATUS_MESSAGE, path: gatePath, entry: gateHookEntry(node.command, gatePath) },
      { event: 'PostToolUse', matcher: 'Bash', marker: OUTCOME_HOOK_STATUS_MESSAGE, path: outcomePath, entry: outcomeHookEntry(node.command, outcomePath) },
      { event: 'PermissionDenied', matcher: 'Bash', marker: OUTCOME_HOOK_STATUS_MESSAGE, path: outcomePath, entry: outcomeHookEntry(node.command, outcomePath) },
      // Appended, never inserted before PermissionDenied: every other spot in
      // this file addresses specs[0..2] by their original positional index,
      // and a new entry at the end keeps every one of those indices meaning
      // exactly what it always meant.
      { event: 'PostToolUseFailure', matcher: 'Bash', marker: OUTCOME_HOOK_STATUS_MESSAGE, path: outcomePath, entry: outcomeHookEntry(node.command, outcomePath) },
      // Agent-matcher hooks, appended after the four Bash ones for the same
      // reason: install()/uninstall()/status() below address specs[0..3] by
      // their original positional index, and these three land at [4..6]
      // without disturbing any of that.
      { event: 'PreToolUse', matcher: 'Agent', marker: AGENT_MODEL_STATUS_MESSAGE, path: agentModelPath, entry: agentModelHookEntry(node.command, agentModelPath, HOOK_TIMEOUT_SECONDS, AGENT_MODEL_STATUS_MESSAGE) },
      { event: 'PostToolUse', matcher: 'Agent', marker: AGENT_OUTCOME_STATUS_MESSAGE, path: agentModelPath, entry: agentModelHookEntry(node.command, agentModelPath, OUTCOME_HOOK_TIMEOUT_SECONDS, AGENT_OUTCOME_STATUS_MESSAGE) },
      { event: 'PostToolUseFailure', matcher: 'Agent', marker: AGENT_OUTCOME_STATUS_MESSAGE, path: agentModelPath, entry: agentModelHookEntry(node.command, agentModelPath, OUTCOME_HOOK_TIMEOUT_SECONDS, AGENT_OUTCOME_STATUS_MESSAGE) }
    ]
  }
}

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

/** Same shape as {@link gateHookEntry}, for the after-the-fact recorder
 *  (adapters/claude/gate-outcome.ts) registered on PostToolUse and
 *  PermissionDenied. Its own short timeout is the point: this hook never
 *  decides anything, so it must never be why a command's result is late. */
function outcomeHookEntry (nodeCommand, outcomePath) {
  return { type: 'command', command: nodeCommand, args: [outcomePath], timeout: OUTCOME_HOOK_TIMEOUT_SECONDS, statusMessage: OUTCOME_HOOK_STATUS_MESSAGE }
}

/** Same shape as {@link gateHookEntry}/{@link outcomeHookEntry}, generalized
 *  over the timeout and marker: the Agent-matcher hooks share one script
 *  (agent-model.ts) across three events with two different timeout budgets
 *  and two different markers, so a single fixed-marker builder does not fit
 *  the way the two hardcoded ones above do. */
function agentModelHookEntry (nodeCommand, agentModelPath, timeoutSeconds, marker) {
  return { type: 'command', command: nodeCommand, args: [agentModelPath], timeout: timeoutSeconds, statusMessage: marker }
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
// own marked entry (per event) and replaces it in place rather than adding
// a second one.
//
// Uninstall's goal is byte-identical restoration when nothing else changed
// in between, not merely "our entry is gone": a container we CREATED
// (`hooks`, one event's array, that event's `Bash` group) is removed once
// emptying it leaves nothing else in it, but a container that already
// existed before we ever touched it -- even one that happens to end up
// empty -- is left in place exactly as it was, empty or not. That
// distinction is only knowable once, at the moment of the very first
// install (a second install would see the shape OUR OWN first install
// already left), so it is captured into `state` then and reused on every
// run after.
//
// `hooks` itself is one container shared by all three events, so its own
// "did it exist before" flag stays a single per-target fact
// (`hooksObjectExistedBefore`). Each event's array and each event's own
// `Bash` group are separate containers, tracked per event under
// `state.events[event]` -- one event having pre-existed the day we started
// must never be mistaken for another one having pre-existed too.
// ---------------------------------------------------------------------------

function findOwnHookIndex (hooks, marker) {
  return hooks.findIndex((h) => isRecord(h) && h.statusMessage === marker)
}

/** A pre-change install-state record kept its PreToolUse bookkeeping as two
 *  flat fields (`preToolUseArrayExistedBefore`, `bashGroupExistedBefore`),
 *  from back when this installer only ever touched one event. Folded into
 *  `state.events.PreToolUse` here, once, so an upgrade never re-derives
 *  "did it exist before" from settings.json as it stands NOW -- by then it
 *  already carries our own first install's shape, which is exactly the
 *  mistake this bookkeeping exists to avoid. A record that already has
 *  `events` (this version, or a fresh one) is left untouched. */
function migrateLegacyPreToolUseFlags (state) {
  if (state.events !== undefined) return
  if (state.preToolUseArrayExistedBefore === undefined && state.bashGroupExistedBefore === undefined) return
  state.events = {
    PreToolUse: {
      arrayExistedBefore: state.preToolUseArrayExistedBefore,
      bashGroupExistedBefore: state.bashGroupExistedBefore
    }
  }
  delete state.preToolUseArrayExistedBefore
  delete state.bashGroupExistedBefore
}

/** The per-event bookkeeping slot for `event`, creating it (empty) the
 *  first time this event is touched -- which is exactly the moment its
 *  `arrayExistedBefore`/`bashGroupExistedBefore` flags get their one real
 *  capture, below. */
function eventState (state, event) {
  if (!isRecord(state.events)) state.events = {}
  if (!isRecord(state.events[event])) state.events[event] = {}
  return state.events[event]
}

/**
 * Whether `event`'s own `matcher` group already existed before we ever
 * touched it -- captured once, the same "never recomputed" rule every other
 * flag in this section follows (see the module note above). `Bash` keeps
 * its original flat field name (`bashGroupExistedBefore`) so an existing
 * install-state file, written before any other matcher existed, keeps
 * meaning exactly what it always meant; every OTHER matcher (today: only
 * `Agent`) is tracked in a keyed sibling, `groupExistedBefore`, which an
 * upgrade from an older state file simply does not have yet -- reading it
 * as `undefined` is exactly right, since it means "not captured yet", not
 * "did not exist".
 */
function groupExistedBefore (es, matcher) {
  if (matcher === 'Bash') return es.bashGroupExistedBefore
  return isRecord(es.groupExistedBefore) ? es.groupExistedBefore[matcher] : undefined
}

function setGroupExistedBefore (es, matcher, value) {
  if (matcher === 'Bash') {
    es.bashGroupExistedBefore = value
    return
  }
  if (!isRecord(es.groupExistedBefore)) es.groupExistedBefore = {}
  es.groupExistedBefore[matcher] = value
}

function installHookEntry (settings, event, matcher, marker, entry, state) {
  if (state.hooksObjectExistedBefore === undefined) state.hooksObjectExistedBefore = isRecord(settings.hooks)
  if (!isRecord(settings.hooks)) settings.hooks = {}

  const es = eventState(state, event)
  if (es.arrayExistedBefore === undefined) es.arrayExistedBefore = Array.isArray(settings.hooks[event])
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []

  let group = settings.hooks[event].find((g) => isRecord(g) && g.matcher === matcher)
  if (groupExistedBefore(es, matcher) === undefined) setGroupExistedBefore(es, matcher, group !== undefined)
  if (!group) {
    group = { matcher, hooks: [] }
    settings.hooks[event].push(group)
  }
  if (!Array.isArray(group.hooks)) group.hooks = []

  const existingIndex = findOwnHookIndex(group.hooks, marker)
  const changed = existingIndex === -1 || JSON.stringify(group.hooks[existingIndex]) !== JSON.stringify(entry)
  if (existingIndex === -1) group.hooks.push(entry)
  else group.hooks[existingIndex] = entry
  return changed
}

/** Removes only our own entry for `event`'s `matcher` group, then unwinds
 *  exactly the containers install created for that event/matcher (never one
 *  that pre-existed, however empty it now is) -- see the note above. */
function uninstallHookEntry (settings, event, matcher, marker, state) {
  if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks[event])) return false
  const eventHooks = settings.hooks[event]
  const groupIndex = eventHooks.findIndex((g) => isRecord(g) && g.matcher === matcher)
  if (groupIndex === -1) return false
  const group = eventHooks[groupIndex]
  if (!Array.isArray(group.hooks)) return false
  const hookIndex = findOwnHookIndex(group.hooks, marker)
  if (hookIndex === -1) return false

  const es = eventState(state, event)
  group.hooks.splice(hookIndex, 1)
  if (group.hooks.length === 0 && !groupExistedBefore(es, matcher)) eventHooks.splice(groupIndex, 1)
  if (eventHooks.length === 0 && !es.arrayExistedBefore) delete settings.hooks[event]
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
// mod-skills copy
//
// This used to be a symlink (<pluginRoot>/adapters/claude/mod-skills ->
// ~/.claude/skills/orca-jev-mod-skills). Measured on two machines: Node's
// permission model refuses fs.symlink unless the caller holds BOTH fs.read
// AND fs.write UNSCOPED --
//
//   ERR_ACCESS_DENIED: fs.symlink API requires full fs.read and fs.write permissions.
//
// -- and the only way this sidecar is ever actually launched in production
// (main.mjs's `runClaudeIntegrationScript`, above) passes SCOPED
// `--allow-fs-write` grants, on purpose, for the same sandboxing reason
// every other cross-boundary write in this plugin goes through a clean
// child. So the symlink failed for everyone, always, and only ever worked
// when someone ran this script by hand outside the sandbox (no
// `--permission` flag at all -- `process.permission` would be undefined,
// and fs.symlink is unrestricted there). That branch is real but this file
// has no way to exercise it under test (it would require asserting on an
// unsandboxed subprocess this suite never launches), and keeping two
// installation mechanisms -- one tested, one that only a hand run can ever
// reach -- is exactly the kind of condition nobody can reach that this
// plugin's own rules forbid. So: always copy. A copy needs no special
// permission beyond the write grant this sidecar already has, and it is
// simple enough that "one mechanism, well tested" beats "two, one of them
// dark."
//
// JEVADV-43 -- mod-skills had never actually loaded on any machine, in part
// because a flat copy of `adapters/claude/mod-skills/` puts its hooks
// module's own `../../../../src/core/*` imports OUTSIDE any plugin folder
// rooted there; the engine refuses a module whose imports leave its own
// plugin folder. The copy now mirrors the REPO's own relative layout
// instead: `planModSkillsCopy` walks hooks/index.ts's transitive import
// closure (src/core/mod_skills_copy.ts) and `writeModSkillsCopy` copies
// each file to that SAME repo-relative path under the copy's own root, so
// `../../../../src/core/jev.ts` resolves inside the copy exactly as it does
// inside the repo. Two files are generated fresh at the copy's root instead
// of copied: `.claude-plugin/plugin.json` (the manifest the engine
// requires -- reason #1 of the diagnosis: `author` must be an object, never
// a bare string) and `hooks/hooks.json` (pointing at
// `../adapters/claude/mod-skills/hooks/index.ts`, the mirrored entry).
//
// A copy used to be judged "current" purely by the marker's `source` path
// -- which never changes for a plugin loaded straight off a fixed dev path
// (`--plugin-dir`, or a symlinked checkout), so a copy could sit there
// stale forever even after every source file under it changed. The marker
// now also records a content digest (computeModSkillsDigest) over every
// closure file's bytes AND the two generated files' own content, and a
// copy is current only when the source path, the digest, AND the presence
// of `.claude-plugin/plugin.json` all agree -- see modCopyState below.
// ---------------------------------------------------------------------------

const MOD_SKILLS_ENTRY = 'adapters/claude/mod-skills/hooks/index.ts'
const MOD_SKILLS_PLUGIN_NAME = 'orca-jev-mod-skills'
const MOD_SKILLS_AUTHOR_NAME = 'Ab2Web'
const MOD_SKILLS_MANIFEST_PATH = '.claude-plugin/plugin.json'
const MOD_SKILLS_HOOKS_JSON_PATH = 'hooks/hooks.json'

function modCopyMarkerPathFor (modCopyPath) {
  return join(dirname(modCopyPath), '.orca-jev-mod-skills.source.json')
}

async function readModCopyMarker (markerPath) {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8'))
    return isRecord(parsed) && typeof parsed.source === 'string' ? parsed : null
  } catch {
    return null
  }
}

async function writeModCopyMarker (markerPath, source, digest) {
  await mkdir(dirname(markerPath), { recursive: true })
  const tempPath = `${markerPath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify({ source, digest, copiedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  await rename(tempPath, markerPath)
}

async function pathExists (path) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  )
}

/** A reader (src/core/mod_skills_copy.ts's own `ModSkillsCopyReader` shape) over `pluginRoot`'s real files, keyed by repo-relative posix path. */
function repoFileReader (pluginRoot) {
  return { read: (repoRelativePath) => readFile(join(pluginRoot, ...repoRelativePath.split('/')), 'utf8') }
}

/**
 * Everything an installed copy of mod-skills needs to be judged "current"
 * for `pluginRoot`, and everything `writeModSkillsCopy` needs to actually
 * write it: the transitive closure starting at hooks/index.ts, the two
 * generated files (the manifest and the root hooks.json), and their
 * combined digest. Exported so the repo's own validate test builds exactly
 * what `install` would build, through this one function, rather than a
 * second hand-rolled copy of this logic.
 *
 * The plugin manifest's version comes from `pluginRoot`'s own package.json
 * (never hardcoded); both generated files' `description` is read from the
 * SOURCE's own `adapters/claude/mod-skills/hooks/hooks.json` (its author's
 * hand-maintained description of what this mod does), so that file stays a
 * live part of the product instead of dead weight after this layout change.
 */
export async function planModSkillsCopy (pluginRoot) {
  const reader = repoFileReader(pluginRoot)
  const closurePaths = await walkModSkillsClosure(MOD_SKILLS_ENTRY, reader)

  const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  const version = isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : '0.0.0'

  const sourceHooksJson = JSON.parse(await readFile(join(pluginRoot, 'adapters', 'claude', 'mod-skills', 'hooks', 'hooks.json'), 'utf8'))
  const description = isRecord(sourceHooksJson) && typeof sourceHooksJson.description === 'string' ? sourceHooksJson.description : MOD_SKILLS_PLUGIN_NAME

  const generatedFiles = [
    { path: MOD_SKILLS_MANIFEST_PATH, content: buildModSkillsPluginManifest({ name: MOD_SKILLS_PLUGIN_NAME, version, description, authorName: MOD_SKILLS_AUTHOR_NAME }) },
    { path: MOD_SKILLS_HOOKS_JSON_PATH, content: buildModSkillsHooksManifest({ description, modulePath: `../${MOD_SKILLS_ENTRY}` }) }
  ]

  const digest = await computeModSkillsDigest(closurePaths, reader, generatedFiles)
  return { closurePaths, generatedFiles, digest }
}

/**
 * Writes exactly `plan`'s closure files (each at its own repo-relative
 * path under `destination`) and generated files. Assumes `destination`
 * is either absent or was just wiped by the caller (installModCopy below
 * always wipes wholesale rather than merging into whatever is already
 * there -- never trusting a stale or foreign directory, or a symlink's
 * target, as good enough to write into directly).
 */
export async function writeModSkillsCopy (pluginRoot, destination, plan) {
  for (const repoRelativePath of plan.closurePaths) {
    const from = join(pluginRoot, ...repoRelativePath.split('/'))
    const to = join(destination, ...repoRelativePath.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, await readFile(from))
    // writeFile creates 0644 regardless of the source, so the mode has to
    // be carried over deliberately. Today every file in the closure is
    // 0644 and this is a no-op -- but the day one has to be executable,
    // losing the bit here would be silent, and a hook that cannot run
    // looks exactly like a hook that was never installed.
    const mode = (await stat(from)).mode & 0o777
    if (mode !== 0o644) await chmod(to, mode)
  }
  for (const file of plan.generatedFiles) {
    const to = join(destination, ...file.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, file.content, 'utf8')
  }
}

/**
 * Whether the copy at `modCopyPath` is ours, and current, for `source`.
 *
 * `ours`: a marker naming `source` is the ordinary case. Absent a marker, a
 * symlink whose own target already names `source` is a pre-fix install
 * this code has not touched yet -- still ours, just not migrated to a copy
 * on disk yet (that happens the next time `install` runs). Anything else
 * (a foreign directory, a symlink to somewhere else, a marker for a
 * different plugin root) is not ours.
 *
 * `current`: ours AND a real directory (never a symlink -- a pre-fix
 * install always needs migrating) AND the marker's own digest matches
 * `digest` AND `.claude-plugin/plugin.json` is actually present. `digest`
 * may be `null` (uninstall does not need "current", only "ours"), which
 * makes `current` always false.
 */
async function modCopyState (modCopyPath, markerPath, source, digest) {
  const st = await lstat(modCopyPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!st) return { exists: false, ours: false, current: false, hasManifest: false }

  const marker = await readModCopyMarker(markerPath)
  let ours
  if (marker !== null) {
    ours = marker.source === source
  } else if (st.isSymbolicLink()) {
    const target = await readlink(modCopyPath).catch(() => null)
    ours = target === source
  } else {
    ours = false
  }

  const hasManifest = await pathExists(join(modCopyPath, ...MOD_SKILLS_MANIFEST_PATH.split('/')))
  const current = ours && !st.isSymbolicLink() && marker !== null && typeof marker.digest === 'string' && digest !== null && marker.digest === digest && hasManifest
  return { exists: true, ours, current, hasManifest }
}

async function installModCopy (pluginRoot, modCopyPath, markerPath) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  let plan
  try {
    plan = await planModSkillsCopy(pluginRoot)
  } catch (error) {
    return { changed: false, reason: 'copy-failed', detail: `could not copy the skills mod (${String(error?.message ?? error)})` }
  }

  const state = await modCopyState(modCopyPath, markerPath, source, plan.digest)
  if (state.current) return { changed: false }

  if (state.exists) {
    // Stale (different plugin root or changed content), an unrecognized
    // leftover, or -- always -- a pre-fix symlink: replace wholesale rather
    // than merging into it or trusting a symlink's target as good enough,
    // the same way a stale settings.json container is never partially
    // reused. `rm` on a path that is itself a symlink removes the link,
    // never the tree it points at.
    await rm(modCopyPath, { recursive: true, force: true })
  }
  try {
    await writeModSkillsCopy(pluginRoot, modCopyPath, plan)
  } catch (error) {
    return { changed: false, reason: 'copy-failed', detail: `could not copy the skills mod (${String(error?.message ?? error)})` }
  }
  await writeModCopyMarker(markerPath, source, plan.digest)
  return { changed: true }
}

async function uninstallModCopy (pluginRoot, modCopyPath, markerPath) {
  const source = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const state = await modCopyState(modCopyPath, markerPath, source, null)
  if (!state.exists) {
    await rm(markerPath, { force: true })
    return { changed: false }
  }
  if (!state.ours) {
    // Not ours (or not pointing at this plugin root): leave it alone rather
    // than guessing whose it is -- the same care uninstallHookEntry takes
    // with a container it did not create.
    return { changed: false, skipped: true }
  }
  await rm(modCopyPath, { recursive: true, force: true })
  await rm(markerPath, { force: true })
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

function modCopyPathFor (target) {
  return join(skillsDirFor(PLATFORM, target), 'orca-jev-mod-skills')
}

async function install (pluginRoot) {
  const { node, specs } = hookSpecs(pluginRoot)
  const discovery = await discoverTargets()
  const stored = (await readInstallState()) ?? {}
  const states = targetStates(stored)

  const perTarget = []
  let nodeVerified = node.verified
  for (const target of discovery.targets) {
    const settingsPath = settingsPathFor(PLATFORM, target)
    const state = isRecord(states[target.id]) ? states[target.id] : {}
    migrateLegacyPreToolUseFlags(state)
    try {
      const rawBefore = await readFile(settingsPath, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return '{}\n'
        throw error
      })
      await backupSettingsOnce(backupPathFor(target), rawBefore)

      const settings = await readSettings(settingsPath)
      const hookChanged = installHookEntry(settings, specs[0].event, specs[0].matcher, specs[0].marker, specs[0].entry, state)
      const postChanged = installHookEntry(settings, specs[1].event, specs[1].matcher, specs[1].marker, specs[1].entry, state)
      const deniedChanged = installHookEntry(settings, specs[2].event, specs[2].matcher, specs[2].marker, specs[2].entry, state)
      const postFailureChanged = installHookEntry(settings, specs[3].event, specs[3].matcher, specs[3].marker, specs[3].entry, state)
      const agentPreChanged = installHookEntry(settings, specs[4].event, specs[4].matcher, specs[4].marker, specs[4].entry, state)
      const agentPostChanged = installHookEntry(settings, specs[5].event, specs[5].matcher, specs[5].marker, specs[5].entry, state)
      const agentPostFailureChanged = installHookEntry(settings, specs[6].event, specs[6].matcher, specs[6].marker, specs[6].entry, state)
      const envChanged = installEnvVar(settings, state)
      await writeSettingsAtomic(settingsPath, settings)
      states[target.id] = state

      const modCopyPath = modCopyPathFor(target)
      const modResult = await installModCopy(pluginRoot, modCopyPath, modCopyMarkerPathFor(modCopyPath))
      perTarget.push({
        id: target.id,
        label: target.label,
        orcaManaged: target.orcaManaged,
        ok: true,
        changes: {
          hook: hookChanged,
          outcomeHook: postChanged || deniedChanged || postFailureChanged,
          agentModelHook: agentPreChanged || agentPostChanged || agentPostFailureChanged,
          env: envChanged,
          modCopy: modResult.changed
        },
        // modCopyWarning stays the stable machine-readable reason code exactly
        // as it always has -- panels key off it and must not break.
        // modCopyDetail carries the underlying diagnosis (e.g. the real
        // ERR_ACCESS_DENIED text) alongside it, so a failure is no longer
        // just "copy-failed" with no way to tell a permission denial from a
        // missing source apart.
        modCopyWarning: modResult.reason ?? null,
        modCopyDetail: modResult.detail ?? null
      })
    } catch (error) {
      // One unwritable target (a permission problem, a settings.json
      // someone is editing) must not abandon the others half-installed.
      perTarget.push({ id: target.id, label: target.label, orcaManaged: target.orcaManaged, ok: false, detail: String(error?.message ?? error).slice(0, 300) })
    }
  }
  await writeInstallState({ version: 3, targets: states, installedAt: stored.installedAt ?? new Date().toISOString() })

  const failed = perTarget.filter((t) => !t.ok)
  const orcaTargets = perTarget.filter((t) => t.orcaManaged && t.ok).length
  // A target only actually got the mod when it was writable AND its copy
  // did not report a warning -- `ok` alone says the hook/env install
  // succeeded, which is a real result on its own but must never be read as
  // "the mod landed everywhere": an unwritable target, or one whose copy
  // failed under an `ok` target, both mean the mod is not on disk there.
  const modCopyLanded = perTarget.filter((t) => t.ok && !t.modCopyWarning).length
  return {
    ok: failed.length < perTarget.length,
    targets: perTarget,
    orcaAccountsInstalled: orcaTargets,
    // How many of the discovered targets actually got the skills-mod copy
    // on disk versus how many did not (whether the target itself failed, or
    // the target was writable but the copy itself failed) -- see
    // modCopyWarning/modCopyDetail on each target for why a failed one did.
    modCopyTargets: { landed: modCopyLanded, failed: perTarget.length - modCopyLanded },
    // Where the Orca accounts were looked for, and whether Orca itself said
    // so -- `convention` means we guessed a standard install path, which is
    // right on a normal machine but cannot tell two Orca installs apart.
    orcaUserData: { path: discovery.userData.path, source: discovery.userData.source, accountsDir: discovery.accountsDir, found: discovery.accountsFound, reason: discovery.reason },
    changes: {
      hook: perTarget.some((t) => t.ok && t.changes.hook),
      outcomeHook: perTarget.some((t) => t.ok && t.changes.outcomeHook),
      agentModelHook: perTarget.some((t) => t.ok && t.changes.agentModelHook),
      env: perTarget.some((t) => t.ok && t.changes.env),
      modCopy: perTarget.some((t) => t.ok && t.changes.modCopy)
    },
    modCopyWarning: perTarget.find((t) => t.ok && t.modCopyWarning)?.modCopyWarning ?? null,
    failures: failed,
    nodeCommandVerified: nodeVerified
  }
}

/** The safe fallback per-event bookkeeping used when a target has no
 *  install-state record at all: every "existed before" flag defaults to
 *  true, so an absent record only ever under-cleans (see the note above
 *  `uninstall`'s own state fallback). `groupExistedBefore` covers every
 *  non-`Bash` matcher this installer manages (today: `Agent`) the same way. */
function defaultEventState () {
  return { arrayExistedBefore: true, bashGroupExistedBefore: true, groupExistedBefore: { Agent: true } }
}

async function uninstall (pluginRoot) {
  const { specs } = hookSpecs(pluginRoot)
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
      hooksObjectExistedBefore: true,
      events: { PreToolUse: defaultEventState(), PostToolUse: defaultEventState(), PermissionDenied: defaultEventState(), PostToolUseFailure: defaultEventState() }
    }
    migrateLegacyPreToolUseFlags(state)
    try {
      const settings = await readSettings(settingsPath)
      const hookChanged = uninstallHookEntry(settings, specs[0].event, specs[0].matcher, specs[0].marker, state)
      const postChanged = uninstallHookEntry(settings, specs[1].event, specs[1].matcher, specs[1].marker, state)
      const deniedChanged = uninstallHookEntry(settings, specs[2].event, specs[2].matcher, specs[2].marker, state)
      const postFailureChanged = uninstallHookEntry(settings, specs[3].event, specs[3].matcher, specs[3].marker, state)
      const agentPreChanged = uninstallHookEntry(settings, specs[4].event, specs[4].matcher, specs[4].marker, state)
      const agentPostChanged = uninstallHookEntry(settings, specs[5].event, specs[5].matcher, specs[5].marker, state)
      const agentPostFailureChanged = uninstallHookEntry(settings, specs[6].event, specs[6].matcher, specs[6].marker, state)
      const envChanged = uninstallEnvVar(settings, state)
      await writeSettingsAtomic(settingsPath, settings)
      const modCopyPath = modCopyPathFor(target)
      const modResult = await uninstallModCopy(pluginRoot, modCopyPath, modCopyMarkerPathFor(modCopyPath))
      await rm(backupPathFor(target), { force: true })
      perTarget.push({
        id: target.id, label: target.label, orcaManaged: target.orcaManaged, ok: true,
        changes: {
          hook: hookChanged,
          outcomeHook: postChanged || deniedChanged || postFailureChanged,
          agentModelHook: agentPreChanged || agentPostChanged || agentPostFailureChanged,
          env: envChanged,
          modCopy: modResult.changed
        },
        modCopyWarning: modResult.skipped ? 'foreign-mod-copy' : null
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
      outcomeHook: perTarget.some((t) => t.ok && t.changes.outcomeHook),
      agentModelHook: perTarget.some((t) => t.ok && t.changes.agentModelHook),
      env: perTarget.some((t) => t.ok && t.changes.env),
      modCopy: perTarget.some((t) => t.ok && t.changes.modCopy)
    },
    modCopyWarning: perTarget.find((t) => t.ok && t.modCopyWarning)?.modCopyWarning ?? null,
    failures: perTarget.filter((t) => !t.ok)
  }
}

/** Read-only lookup of `event`'s own `matcher` group, or undefined when the
 *  event has no hooks array, or no such group, at all. */
function findGroup (settings, event, matcher) {
  return isRecord(settings.hooks) && Array.isArray(settings.hooks[event])
    ? settings.hooks[event].find((g) => isRecord(g) && g.matcher === matcher)
    : undefined
}

function findMarkedHook (group, marker) {
  return group && Array.isArray(group.hooks) ? group.hooks.find((h) => isRecord(h) && h.statusMessage === marker) : undefined
}

async function status (pluginRoot) {
  const { specs } = hookSpecs(pluginRoot)
  const [gateSpec, postSpec, deniedSpec, postFailureSpec, agentPreSpec, agentPostSpec, agentPostFailureSpec] = specs
  const modSource = join(pluginRoot, 'adapters', 'claude', 'mod-skills')
  const discovery = await discoverTargets()
  // Best-effort: an unreadable pluginRoot (a missing package.json, a
  // missing source hooks.json) must not fail status entirely -- every
  // target's modCopy just reads as not current (digest stays null, so
  // modCopyState's own current check can never pass), the same "absent
  // digest never lies about freshness" rule installModCopy relies on.
  const modPlan = await planModSkillsCopy(pluginRoot).catch(() => null)

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
    const ownGateHook = findMarkedHook(findGroup(settings, gateSpec.event, gateSpec.matcher), gateSpec.marker)
    const ownPostHook = findMarkedHook(findGroup(settings, postSpec.event, postSpec.matcher), postSpec.marker)
    const ownDeniedHook = findMarkedHook(findGroup(settings, deniedSpec.event, deniedSpec.matcher), deniedSpec.marker)
    const ownPostFailureHook = findMarkedHook(findGroup(settings, postFailureSpec.event, postFailureSpec.matcher), postFailureSpec.marker)
    const ownAgentPreHook = findMarkedHook(findGroup(settings, agentPreSpec.event, agentPreSpec.matcher), agentPreSpec.marker)
    const ownAgentPostHook = findMarkedHook(findGroup(settings, agentPostSpec.event, agentPostSpec.matcher), agentPostSpec.marker)
    const ownAgentPostFailureHook = findMarkedHook(findGroup(settings, agentPostFailureSpec.event, agentPostFailureSpec.matcher), agentPostFailureSpec.marker)
    const modCopyPath = modCopyPathFor(target)
    const modCopy = await modCopyState(modCopyPath, modCopyMarkerPathFor(modCopyPath), modSource, modPlan?.digest ?? null).catch(() => ({ exists: false, ours: false, current: false, hasManifest: false }))
    perTarget.push({
      id: target.id,
      label: target.label,
      orcaManaged: target.orcaManaged,
      settingsPath,
      readError,
      hook: { installed: ownGateHook !== undefined, pathMatches: ownGateHook !== undefined && Array.isArray(ownGateHook.args) && ownGateHook.args.includes(gateSpec.path) },
      outcomeHook: {
        installed: ownPostHook !== undefined && ownDeniedHook !== undefined && ownPostFailureHook !== undefined,
        pathMatches: ownPostHook !== undefined && Array.isArray(ownPostHook.args) && ownPostHook.args.includes(postSpec.path) &&
          ownDeniedHook !== undefined && Array.isArray(ownDeniedHook.args) && ownDeniedHook.args.includes(deniedSpec.path) &&
          ownPostFailureHook !== undefined && Array.isArray(ownPostFailureHook.args) && ownPostFailureHook.args.includes(postFailureSpec.path)
      },
      // The Agent-matcher hooks (agent-model.ts): asks Jev which model a
      // subagent task needs (PreToolUse) and records which model it
      // actually ran on (PostToolUse + PostToolUseFailure) -- same
      // "installed only once every half is in place" rule as outcomeHook.
      agentModelHook: {
        installed: ownAgentPreHook !== undefined && ownAgentPostHook !== undefined && ownAgentPostFailureHook !== undefined,
        pathMatches: ownAgentPreHook !== undefined && Array.isArray(ownAgentPreHook.args) && ownAgentPreHook.args.includes(agentPreSpec.path) &&
          ownAgentPostHook !== undefined && Array.isArray(ownAgentPostHook.args) && ownAgentPostHook.args.includes(agentPostSpec.path) &&
          ownAgentPostFailureHook !== undefined && Array.isArray(ownAgentPostFailureHook.args) && ownAgentPostFailureHook.args.includes(agentPostFailureSpec.path)
      },
      env: { installed: isRecord(settings.env) && settings.env[ENV_VAR_NAME] === ENV_VAR_VALUE },
      // `installed` keeps its old meaning (this exact plugin root's copy is
      // in place, AND current for it -- JEVADV-43: `current` now also
      // requires the marker's digest to match today's source, and the
      // manifest to actually be present, so a copy that merely sits at the
      // same path forever no longer reads as installed once its content
      // goes stale); `exists` is finer-grained -- a stale copy from an
      // older plugin root still exists (and still loads for Claude Code)
      // even though it is not "installed" in the sense above. `hasManifest`
      // is `false` whenever the copy lacks `.claude-plugin/plugin.json` --
      // the exact gap that kept this mod from ever loading -- independent
      // of whether the rest of it happens to be current. The config
      // panel's skills-mod line (see odd/tasks/production-honesty-pass.md
      // P6) reads `exists`, not `installed`, because a stale-but-present
      // copy can still have produced real measurements worth reporting.
      modCopy: { installed: modCopy.current, exists: modCopy.exists, hasManifest: modCopy.hasManifest }
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
    outcomeHook: {
      installed: perTarget.every((t) => t.outcomeHook.installed),
      installedCount: perTarget.filter((t) => t.outcomeHook.installed).length,
      totalCount: perTarget.length,
      orcaPanesCovered: orcaTargets.length > 0 && orcaTargets.every((t) => t.outcomeHook.installed),
      orcaPaneCount: orcaTargets.length
    },
    agentModelHook: {
      installed: perTarget.every((t) => t.agentModelHook.installed),
      installedCount: perTarget.filter((t) => t.agentModelHook.installed).length,
      totalCount: perTarget.length,
      orcaPanesCovered: orcaTargets.length > 0 && orcaTargets.every((t) => t.agentModelHook.installed),
      orcaPaneCount: orcaTargets.length
    },
    env: { installed: perTarget.every((t) => t.env.installed), name: ENV_VAR_NAME },
    modCopy: {
      installed: perTarget.every((t) => t.modCopy.installed),
      exists: perTarget.some((t) => t.modCopy.exists),
      hasManifest: perTarget.some((t) => t.modCopy.hasManifest)
    },
    orcaUserData: { path: discovery.userData.path, source: discovery.userData.source, accountsDir: discovery.accountsDir, found: discovery.accountsFound, reason: discovery.reason },
    statePath: STATE_PATH
  }
}

async function main () {
  const mode = process.argv[2]
  const pluginRoot = process.argv[3]
  let result
  try {
    if (STATE_DIR_RESOLUTION_ERROR) throw STATE_DIR_RESOLUTION_ERROR
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

// Runs `main()` only when this file is the actual entrypoint (`node
// install-claude-integration.mjs <mode> <pluginRoot>`, exactly how every
// existing test already invokes it via execFileSync) -- never when another
// module imports it for its own named exports (planModSkillsCopy,
// writeModSkillsCopy), which the validate test does directly, with no
// subprocess and no argv of its own.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
