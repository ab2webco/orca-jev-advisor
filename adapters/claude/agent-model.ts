#!/usr/bin/env node
/**
 * agent-model.ts — PreToolUse/PostToolUse/PostToolUseFailure hook on the
 * `Agent` tool: asks Jev which model (of the person's own catalog) a
 * subagent task needs, and -- only in active mode, only when ready and
 * confident, and only when the call would have been allowed anyway
 * (bypassPermissions; see src/core/model_decisions.ts) -- rewrites the
 * call to use it.
 *
 * This file is deliberately thin: everything that can be unit tested
 * without a subprocess, a real filesystem or a real clock lives in
 * agent-model-hook.ts's handleAgentModelHook, exactly the split
 * gate-bash.ts (a CLI) keeps with src/core/decisions.ts (pure logic). This
 * file only:
 *   - reads the hook payload off stdin,
 *   - resolves CONFIG_DIR/CACHE_DIR the same way gate-bash.ts does (same
 *     paths.ts functions, same HOME_PATHS shape),
 *   - passes straight through when Orca has this plugin switched off (same
 *     check gate-bash.ts uses, via src/core/orca_enablement.ts),
 *   - reads the worker's catalog mirror (src/core/model_mirror.ts) and the
 *     TypeSafe API key (src/core/secrets.ts),
 *   - calls handleAgentModelHook and appends its record, best-effort, to
 *     `<cacheDir>/model-reclassifications.jsonl`,
 *   - writes stdout when there is one.
 *
 * ALWAYS exits 0 -- same fail-open discipline as gate-bash.ts: a bug in
 * this hook, or in reaching Jev, must never be the reason an Agent call is
 * delayed or blocked.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ORCA_USER_DATA_ENV, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { activeProfileId, isPluginDisabled, profileDataPath } from '../../src/core/orca_enablement.ts'
import { callJev } from '../../src/core/jev.ts'
import { resolveApiKey } from '../../src/core/secrets.ts'
import { MODEL_MEASUREMENT_FILE, serializeModelRecord } from '../../src/core/model_measurement.ts'
import type { ModelMeasurementRecord } from '../../src/core/model_measurement.ts'
import { MODELS_MIRROR_FILE } from '../../src/core/model_mirror.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'
import { handleAgentModelHook } from './agent-model-hook.ts'

// Same resolution as gate-bash.ts's own CACHE_DIR/CONFIG_DIR -- see its
// module note: os.homedir() is already HOME-vs-USERPROFILE correct per
// platform, and resolveCacheDir/resolveConfigDir only decide the
// `.cache`/`.config` vs `%LOCALAPPDATA%`/`%APPDATA%` vs XDG convention on
// top of it.
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
const MIRROR_PATH = join(CONFIG_DIR, MODELS_MIRROR_FILE)
const LOG_PATH = join(CACHE_DIR, MODEL_MEASUREMENT_FILE)
// A cache file of this hook's own, distinct from gate-bash.ts's
// `gate-enablement.json` -- the same fact (is the plugin disabled in
// Orca?), read by two independent processes, so each keeps its own small
// cache rather than contending over one write.
const ENABLEMENT_CACHE_PATH = join(CACHE_DIR, 'agent-model-enablement.json')
// Same latency budget as gate-bash.ts's own Jev call (BUDGET_MS there):
// this hook sits in front of a subagent's whole run starting, not a single
// command, but the budget is about how long Jev itself is given to answer,
// which is the same tradeoff either way.
const BUDGET_MS = 1800

function readHookInput(): unknown {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Best-effort read of the worker's catalog mirror; missing or unreadable
 *  reads as `null`, which parseModelsMirror (src/core/model_mirror.ts)
 *  turns into the all-false, empty mirror -- failing toward measurement. */
function readMirror(): unknown {
  try {
    return JSON.parse(readFileSync(MIRROR_PATH, 'utf8'))
  } catch {
    return null
  }
}

/**
 * True when Orca has this plugin switched off -- see gate-bash.ts's own
 * `pluginDisabledInOrca` for the full rationale (this is the same check,
 * duplicated rather than imported because gate-bash.ts is a CLI entry
 * point, not a module other files import from). Every failure answers
 * false and leaves the hook running.
 */
function pluginDisabledInOrca(): boolean {
  try {
    const userData = resolveOrcaUserDataDir(PLATFORM, {
      home: HOME_PATHS.home,
      appDataDir: process.env.APPDATA,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      orcaUserDataPath: process.env[ORCA_USER_DATA_ENV]
    })
    const profileId = activeProfileId(JSON.parse(readFileSync(join(userData.path, 'orca-profile-index.json'), 'utf8')))
    if (profileId === null) return false
    const dataPath = profileDataPath(PLATFORM, userData.path, profileId)
    const stat = statSync(dataPath)
    const stamp = `${stat.size}:${stat.mtimeMs}`

    try {
      const cached: unknown = JSON.parse(readFileSync(ENABLEMENT_CACHE_PATH, 'utf8'))
      if (typeof cached === 'object' && cached !== null) {
        const record = cached as Record<string, unknown>
        if (record['stamp'] === stamp && typeof record['disabled'] === 'boolean') return record['disabled']
      }
    } catch {
      // No usable cache yet; fall through and read the file once.
    }

    const disabled = isPluginDisabled(JSON.parse(readFileSync(dataPath, 'utf8')))
    try {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(ENABLEMENT_CACHE_PATH, JSON.stringify({ stamp, disabled }))
    } catch {
      // A cache that cannot be written only costs the next call a re-read.
    }
    return disabled
  } catch {
    return false
  }
}

/** Appends one measurement record. Best-effort, same as gate-bash.ts's own
 *  appendGateRecord: a log that cannot be written is never a reason to
 *  block or delay an Agent call. */
function appendRecord(record: ModelMeasurementRecord): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    appendFileSync(LOG_PATH, serializeModelRecord(record), 'utf8')
  } catch {
    // Best-effort measurement; never blocks or delays anything.
  }
}

async function main(): Promise<void> {
  // Before anything else: if Orca has the plugin switched off, this hook
  // has no business judging or recording anything.
  if (pluginDisabledInOrca()) {
    process.exit(0)
  }

  const payload = readHookInput()
  const apiKey = await resolveApiKey()
  const mirror = readMirror()

  const result = await handleAgentModelHook(payload, {
    mirror,
    apiKey,
    askJev: (key, state, questions) => callJev(key, state, questions, { budgetMs: BUDGET_MS }),
    now: () => new Date(),
    clockMs: () => Date.now(),
  })

  if (result.record !== null) appendRecord(result.record)
  // A plain `process.stdout.write` followed immediately by `process.exit`
  // is not guaranteed to flush before the process dies when stdout is a
  // pipe (which is exactly what Claude Code hands this hook) -- and this
  // process cannot simply omit the exit and let Node drain the write queue
  // on its own, because callJev's losing timeout timer would then keep it
  // alive for up to BUDGET_MS after the real work is done. `writeSync`
  // blocks until the write completes, so the exit right after it can never
  // race a partially-flushed rewrite off to Claude Code. gate-bash.ts does
  // not need this: it returns from `emit()` and lets main() finish normally
  // instead of calling `process.exit` itself.
  if (result.stdout !== null) writeSync(1, result.stdout)
  process.exit(0)
}

// Last resort: anything main() did not already catch (resolveApiKey, the
// enablement read) still ends as a silent pass-through, never a failed hook.
await main().catch(() => process.exit(0))
