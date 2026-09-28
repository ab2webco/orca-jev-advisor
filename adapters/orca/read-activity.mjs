#!/usr/bin/env node
/**
 * read-activity.mjs — sidecar that folds the last 7 days of real activity,
 * per project, into the one summary the board's Activity tab renders
 * (JEVADV-63, A3). It reads, all under ~/.cache/orca-supervisor/ (outside
 * the worker's own permission sandbox -- same reason every other
 * cross-boundary read in this plugin goes through a clean child):
 *
 *   gate-decisions.jsonl                 the gate's verdicts (single file)
 *   turn-usage-YYYY-MM-DDTHH.jsonl       the hook's per-step usage (hourly)
 *   model-router-decisions-*.jsonl       the router's decisions (hourly)
 *
 * and hands the guarded rows to src/core/activity_by_project.ts's pure
 * aggregateActivityByProject.
 *
 * A separate sidecar rather than a fourth section of read-consumption.mjs
 * (odd/tasks/jev-063-activity.md, "Decisions"): gate-decisions.jsonl is a
 * different shape of file than the hourly logs, and folding it in would blur
 * that sidecar's single responsibility. Listing, reading and row guards are
 * shared through ./log-files.mjs, never reimplemented. This script is
 * read-only: it deletes nothing -- pruning the hourly files stays owned by
 * read-consumption.mjs, which runs on the same cadence, so two sidecars
 * never race on `rm`.
 *
 * Usage: node read-activity.mjs
 * Always prints exactly one JSON line to stdout: `{ok: true, projects,
 * corruptLines}` or `{ok: false, reason, detail}`.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'
import { aggregateActivityByProject } from '../../src/core/activity_by_project.ts'
import {
  listHourlyFiles,
  MODEL_ROUTER_DECISIONS_FILE_PATTERN,
  readJsonl,
  readJsonlRows,
  toGateDecisionRecord,
  toTurnUsageRecord,
  TURN_USAGE_FILE_PATTERN,
} from './log-files.mjs'

const CACHE_DIR = resolveCacheDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgCacheHome: process.env.XDG_CACHE_HOME })
const GATE_LOG_PATH = join(CACHE_DIR, 'gate-decisions.jsonl')

// The fold's window is 7 local calendar days, whose oldest day starts less
// than 7*24h before now; 8 days of hourly files (UTC-named) covers it with
// margin for any timezone offset. Same span read-consumption.mjs keeps on
// disk before pruning, so nothing inside the window is ever missing here.
const READ_WINDOW_MS = 8 * 24 * 60 * 60 * 1000

/** Only the hourly files whose bucket could still hold a row inside the
 *  window -- a file whose bucket failed to parse is read anyway (the fold
 *  windows each row by its own `at`), never guessed out. */
function withinReadWindow (files, nowMs) {
  const cutoffMs = nowMs - READ_WINDOW_MS
  return files.filter((file) => file.hourMs === null || file.hourMs >= cutoffMs)
}

/**
 * A router-decision row, guarded only as far as this fold reads it: `at`
 * must be a string, and `project` is normalized to `string | null` (absent
 * on every record written before JEVADV-63). Every other field is passed
 * through untouched, because summarizeRouterDecisions
 * (src/core/model_router_summary.ts) already parses its own rows tolerantly
 * -- a stricter guard here would drop rows that function would have counted.
 */
function toRouterDecisionRow (row) {
  if (typeof row.at !== 'string') return null
  return { ...row, project: typeof row.project === 'string' ? row.project : null }
}

function guardRows (rows, guard) {
  const records = []
  let malformed = 0
  for (const row of rows) {
    const record = guard(row)
    if (record === null) malformed += 1
    else records.push(record)
  }
  return { records, malformed }
}

async function main () {
  let result
  try {
    const now = Date.now()
    const [gateLog, usageFiles, decisionFiles] = await Promise.all([
      readJsonl(GATE_LOG_PATH),
      listHourlyFiles(CACHE_DIR, TURN_USAGE_FILE_PATTERN),
      listHourlyFiles(CACHE_DIR, MODEL_ROUTER_DECISIONS_FILE_PATTERN),
    ])
    const [usage, decisions] = await Promise.all([
      readJsonlRows(withinReadWindow(usageFiles, now)),
      readJsonlRows(withinReadWindow(decisionFiles, now)),
    ])

    // Same filter as read-measurements.mjs's aggregateGate: a row of some
    // other type in this file is not a gate decision, and not corrupt either.
    const gate = guardRows(gateLog.rows.filter((row) => row.type === 'gate-decision'), toGateDecisionRecord)
    const turnUsage = guardRows(usage.rows, toTurnUsageRecord)
    const routerDecisions = guardRows(decisions.rows, toRouterDecisionRow)

    const summary = aggregateActivityByProject(gate.records, turnUsage.records, routerDecisions.records, now)
    const corruptLines =
      gateLog.corrupt + gate.malformed +
      usage.corrupt + turnUsage.malformed +
      decisions.corrupt + routerDecisions.malformed

    result = { ok: true, ...summary, corruptLines }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
