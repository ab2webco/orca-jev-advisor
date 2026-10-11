#!/usr/bin/env node
// feature-modules T0: what each feature module costs today (hook spawns, Jev
// calls, worker wakeups), from this machine's own logs. Read-only: it never
// calls Jev and never writes. Prints counts and timings only, never
// transcript content.
//
// Usage (also `npm run measure-module-cost -- <args>`):
//
//   node --experimental-strip-types scripts/measure-module-cost.mjs [--days N | --since ISO] [--until ISO] [--transcripts DIR] [--audit-dir DIR]
//
// `--since` pins the window start and wins over `--days`; `--until` pins its end (default: now).
//
// Sources:
//   - the plugin's cache dir (src/core/paths.ts): gate decisions, mod-skills
//     and mod-tools measurements, router, steward and verify-done decisions,
//     model reclassifications;
//   - Claude Code transcripts (default `~/.claude/projects`, symlinks followed):
//     tool calls, person prompts, completed turns, our hook timings;
//   - every settings.json Claude Code reads (home and each Orca account): the
//     hooks this plugin installed;
//   - Orca's plugin audit log (`<userData>/plugins-data/audit.log*`): the
//     worker's storage writes.
// The logic lives in src/core/module_cost.ts and is unit-tested there.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { STEWARD_DECISIONS_FILE_PATTERN } from '../src/core/context_steward.ts'
import { VERIFY_DONE_DECISIONS_FILE_PATTERN } from '../src/core/verify_done.ts'
import { ROUTER_DECISIONS_FILE_PATTERN } from '../src/core/jev_health_usage.ts'
import { gateDecisionFilesToRead, measurementFilesToRead, modelMeasurementFilesToRead } from '../src/core/measurement_files.ts'
import { auditSetsByKey, buildModuleCostReport, finishTranscriptTally, formatModuleCostReport, newTranscriptTally, ourHooksFromSettings, tallyTranscriptLine } from '../src/core/module_cost.ts'
import { claudeAccountsDir, resolveOrcaUserDataDir } from '../src/core/orca_accounts.ts'
import { normalizePlatform, resolveCacheDir } from '../src/core/paths.ts'

const PLUGIN_ACTOR = 'plugin:ab2web.orca-jev-advisor'
const HOUR_IN_NAME = /(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/

function parseArgs (argv) {
  const args = { days: 7, sinceMs: null, untilMs: null, transcripts: null, auditDir: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    if (flag === '--days') args.days = Number(value)
    else if (flag === '--since') args.sinceMs = Date.parse(value)
    else if (flag === '--until') args.untilMs = Date.parse(value)
    else if (flag === '--transcripts') args.transcripts = value
    else if (flag === '--audit-dir') args.auditDir = value
    else throw new Error(`unknown argument: ${flag}`)
    i += 1
  }
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days must be a positive number')
  if (args.sinceMs !== null && !Number.isFinite(args.sinceMs)) throw new Error('--since must be an ISO instant')
  if (args.untilMs !== null && !Number.isFinite(args.untilMs)) throw new Error('--until must be an ISO instant')
  return args
}

function listNames (dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readLines (path) {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
}

function readRows (dir, names) {
  const rows = []
  for (const name of names) {
    for (const line of readLines(join(dir, name))) {
      if (line.trim().length === 0) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // A corrupt line is skipped, never thrown on.
      }
    }
  }
  return rows
}

/** Hourly files whose hour can hold a row of the window (legacy single files always kept). */
function hoursFrom (names, sinceMs) {
  const sinceHour = new Date(sinceMs).toISOString().slice(0, 13)
  return names.filter((name) => {
    const match = HOUR_IN_NAME.exec(name)
    return match === null || match[1] >= sinceHour
  })
}

function walkJsonl (dir, sinceMs, out) {
  for (const name of listNames(dir)) {
    const path = join(dir, name)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (info.isDirectory()) walkJsonl(path, sinceMs, out)
    else if (name.endsWith('.jsonl') && info.mtimeMs >= sinceMs) out.push(path)
  }
  return out
}

const RELEVANT = ['"tool_use"', '"tool_result"', 'turn_duration', 'orca-jev-advisor:', '"type":"user"']

function main () {
  const args = parseArgs(process.argv.slice(2))
  const platform = normalizePlatform(process.platform)
  const home = homedir()
  const untilMs = args.untilMs ?? Date.now()
  const sinceMs = args.sinceMs ?? untilMs - args.days * 24 * 60 * 60 * 1000
  const window = { sinceMs, untilMs }

  const cacheDir = resolveCacheDir(platform, { home, appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME, xdgCacheHome: process.env.XDG_CACHE_HOME })
  const names = listNames(cacheDir)
  const files = {
    gate: hoursFrom(gateDecisionFilesToRead(names), sinceMs),
    skills: hoursFrom(measurementFilesToRead('mod-skills', names), sinceMs),
    tools: hoursFrom(measurementFilesToRead('mod-tools', names), sinceMs),
    router: hoursFrom(names.filter((name) => ROUTER_DECISIONS_FILE_PATTERN.test(name)).sort(), sinceMs),
    models: hoursFrom(modelMeasurementFilesToRead(names), sinceMs),
    steward: hoursFrom(names.filter((name) => STEWARD_DECISIONS_FILE_PATTERN.test(name)).sort(), sinceMs),
    verifyDone: hoursFrom(names.filter((name) => VERIFY_DONE_DECISIONS_FILE_PATTERN.test(name)).sort(), sinceMs)
  }
  const rows = Object.fromEntries(Object.entries(files).map(([log, list]) => [log, readRows(cacheDir, list)]))

  const userData = resolveOrcaUserDataDir(platform, { home, appDataDir: process.env.APPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME, orcaUserDataPath: process.env.ORCA_USER_DATA_PATH }).path
  const accountsDir = claudeAccountsDir(platform, userData)
  const settingsPaths = [join(home, '.claude', 'settings.json'), ...listNames(accountsDir).map((id) => join(accountsDir, id, 'auth', 'settings.json'))]
  const hookSets = []
  for (const path of settingsPaths) {
    let settings = null
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    hookSets.push(ourHooksFromSettings(settings))
  }
  const hooks = hookSets.flat()
  const signatures = new Set(hookSets.map((set) => set.map((hook) => `${hook.event}:${hook.matcher}:${hook.script}`).sort().join(' ')))

  const transcriptsDir = args.transcripts ?? join(home, '.claude', 'projects')
  const transcriptFiles = walkJsonl(transcriptsDir, sinceMs, [])
  const tally = newTranscriptTally()
  for (const path of transcriptFiles) {
    for (const line of readLines(path)) {
      if (RELEVANT.some((marker) => line.includes(marker))) tallyTranscriptLine(tally, line, window)
    }
  }
  // The last turn of each session has no later prompt to close it.
  finishTranscriptTally(tally)

  const auditDir = args.auditDir ?? join(userData, 'plugins-data')
  const auditNames = listNames(auditDir).filter((name) => /^audit\.log(\.\d+)?$/.test(name)).sort().reverse()
  const audit = auditSetsByKey(auditNames.flatMap((name) => readLines(join(auditDir, name))), PLUGIN_ACTOR, window)

  const report = buildModuleCostReport({ window, tally, hooks, rows, audit })
  for (const line of formatModuleCostReport(report)) process.stdout.write(`${line}\n`)
  process.stdout.write('\nSources:\n')
  for (const [log, list] of Object.entries(files)) {
    const hours = list.map((name) => HOUR_IN_NAME.exec(name)?.[1]).filter(Boolean)
    process.stdout.write(`- ${log}: ${list.length} files, ${rows[log].length} rows read (${hours[0] ?? '-'} .. ${hours.at(-1) ?? '-'})\n`)
  }
  process.stdout.write(`- settings.json with our hooks: ${hookSets.filter((set) => set.length > 0).length} of ${settingsPaths.length}; ${signatures.size} distinct hook set(s), ${hookSets[0]?.length ?? 0} hooks each\n`)
  process.stdout.write(`- transcripts: ${transcriptFiles.length} files modified in the window\n`)
  process.stdout.write(`- audit log: ${auditNames.length} files\n`)
  const versions = [...new Set(rows.gate.filter((row) => typeof row?.at === 'string' && Date.parse(row.at) >= sinceMs).map((row) => row.pluginVersion).filter((v) => typeof v === 'string'))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  process.stdout.write(`- plugin versions in the gate log: ${versions.join(', ') || '-'}\n`)
}

main()
