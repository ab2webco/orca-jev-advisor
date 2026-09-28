#!/usr/bin/env node
/**
 * read-consumption.mjs — sidecar that aggregates the hourly turn-usage
 * records T1's hook writes (`turn-usage-YYYY-MM-DDTHH.jsonl`, one file per
 * hour under `~/.cache/orca-supervisor/`, outside this worker's own
 * permission sandbox — same reason read-measurements.mjs's own logs go
 * through a clean child, see that file's header), reads T2's quota.json
 * mirror (`~/.config/orca-supervisor/quota.json`) and the global CLAUDE.md
 * / `.claude.json` (`~/.claude/CLAUDE.md`, `~/.claude.json`), and folds all
 * three with src/core/consumption.ts's pure functions into the one summary
 * the board's consumption card renders.
 *
 * UNLIKE read-measurements.mjs/read-model-measurements.mjs, this script
 * also WRITES: after reading every `turn-usage-*.jsonl` file, it deletes
 * any whose hour bucket is more than 8 days old (JEV-060 slice 1's own
 * decision gap — see odd/tasks/jev-060-consumption.md). Pruning lives
 * here, not in the hook (hooks/index.ts's own header explains why: the
 * hook only ever appends to its OWN hour's file and does no rotation of
 * its own) and not as a separate sidecar, because the prune needs the
 * exact same directory listing this aggregation already reads — a second
 * scan would just repeat the same walk. main.mjs grants this script
 * `--allow-fs-write` on the cache dir specifically for this, a permission
 * none of the other read-only sidecars in this directory need.
 *
 * Usage: node read-consumption.mjs
 * Always prints exactly one JSON line to stdout: `{ok: true, usage, quota,
 * recommendations, modelRouter}` or `{ok: false, reason, detail}`. A
 * missing quota.json, missing CLAUDE.md, or missing .claude.json each
 * degrade their own section gracefully (parsed as if empty/absent) rather
 * than failing the script. `modelRouter` (JEV-060 slice 2, §8) is `null`
 * when no `model-router-decisions-*.jsonl` file exists at all, else
 * `summarizeRouterDecisions`'s own summary over the last 24h, read and
 * pruned the same way as turn-usage. `steward` is the same for the context
 * steward's `context-steward-decisions-*.jsonl` (summarizeStewardDecisions,
 * odd/tasks/jev-context-steward.md): null until a file exists.
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'
import { homeConfigTarget } from '../../src/core/orca_accounts.ts'
import {
  aggregateTurnUsage,
  claudeMdSizeTrigger,
  longSessionTrigger,
  mcpServerCountTrigger,
  parseQuota,
  subagentShareTrigger,
} from '../../src/core/consumption.ts'
import { summarizeRouterDecisions } from '../../src/core/model_router_summary.ts'
import {
  listHourlyFiles,
  MODEL_ROUTER_DECISIONS_FILE_PATTERN,
  readJsonlRows,
  toTurnUsageRecord,
  TURN_USAGE_FILE_PATTERN,
} from './log-files.mjs'
import { STEWARD_DECISIONS_FILE_PATTERN, summarizeStewardDecisions } from '../../src/core/context_steward.ts'

const PLATFORM = normalizePlatform(process.platform)
const HOME = homedir()
const HOME_PATHS = {
  home: HOME,
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
}
const CACHE_DIR = resolveCacheDir(PLATFORM, HOME_PATHS)
const CONFIG_DIR = resolveConfigDir(PLATFORM, HOME_PATHS)
// homeConfigTarget (src/core/orca_accounts.ts) is the same function
// main.mjs's own CLAUDE_HOME_DIR constant calls -- ~/.claude. The global
// `.claude.json` is NOT inside that directory (it is a sibling file,
// `~/.claude.json`, per adapters/claude/mod-skills/claude-code.d.ts's own
// note that "(~/.claude.json) are not settings and are never read" by the
// engine), so it is joined onto HOME directly, not onto CLAUDE_HOME_DIR.
const CLAUDE_HOME_DIR = homeConfigTarget(PLATFORM, HOME).configDir
const QUOTA_PATH = join(CONFIG_DIR, 'quota.json')
const CLAUDE_MD_PATH = join(CLAUDE_HOME_DIR, 'CLAUDE.md')
const CLAUDE_JSON_PATH = join(HOME, '.claude.json')

const MODEL_ROUTER_WINDOW_MS = 24 * 60 * 60 * 1000
const PRUNE_AFTER_MS = 8 * 24 * 60 * 60 * 1000

/**
 * Deletes every listed file whose own hour bucket is more than 8 days
 * before `nowMs` -- a file whose bucket could not be parsed is left alone
 * rather than guessed at. A delete failure (permission, already gone) is
 * swallowed per file: pruning is best-effort cleanup, never a reason to
 * fail the whole read.
 */
async function pruneOldHourlyFiles (files, nowMs) {
  const cutoffMs = nowMs - PRUNE_AFTER_MS
  await Promise.all(
    files
      .filter((file) => file.hourMs !== null && file.hourMs < cutoffMs)
      .map((file) => rm(file.path, { force: true }).catch(() => {}))
  )
}

/** quota.json, tolerantly parsed -- a missing or unparseable file degrades
 *  to parseQuota(null)'s own honest empty shape, same "no mirror has run
 *  yet" tolerance write-secret-mirror.mjs's quota-save mode's own reader
 *  side needs. */
async function readQuota () {
  try {
    const text = await readFile(QUOTA_PATH, 'utf8')
    return parseQuota(JSON.parse(text))
  } catch {
    return parseQuota(null)
  }
}

/** The global CLAUDE.md's byte length, or `null` when it does not exist --
 *  fed straight to claudeMdSizeTrigger, which is itself tolerant of `null`.
 *  Byte length, not character length: the brief's own bytes/4 estimate
 *  assumes bytes, and stat() reports exactly that without reading the
 *  file's content at all. */
async function claudeMdByteLength () {
  try {
    const info = await stat(CLAUDE_MD_PATH)
    return info.size
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** The global `.claude.json`, already JSON.parse'd, or `null` on a missing
 *  or unparseable file -- fed straight to mcpServerCountTrigger, which is
 *  itself tolerant of `null`. */
async function readClaudeJson () {
  try {
    const text = await readFile(CLAUDE_JSON_PATH, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function main () {
  let result
  try {
    const now = Date.now()
    const files = await listHourlyFiles(CACHE_DIR, TURN_USAGE_FILE_PATTERN)
    const decisionFiles = await listHourlyFiles(CACHE_DIR, MODEL_ROUTER_DECISIONS_FILE_PATTERN)
    const { rows, corrupt } = await readJsonlRows(files)
    const { rows: decisionRows } = await readJsonlRows(decisionFiles)
    const stewardFiles = await listHourlyFiles(CACHE_DIR, STEWARD_DECISIONS_FILE_PATTERN)
    const { rows: stewardRows } = await readJsonlRows(stewardFiles)
    // Pruning runs after reading, using the same listings -- a file that
    // gets deleted mid-run still contributed its rows to this cycle's
    // aggregation, exactly as if it had been read moments before turning 8
    // days old.
    await pruneOldHourlyFiles(files, now)
    await pruneOldHourlyFiles(decisionFiles, now)
    await pruneOldHourlyFiles(stewardFiles, now)

    const turnUsageRecords = []
    let malformed = 0
    for (const row of rows) {
      const record = toTurnUsageRecord(row)
      if (record === null) malformed += 1
      else turnUsageRecords.push(record)
    }

    const aggregation = aggregateTurnUsage(turnUsageRecords, now)
    const usage = { ...aggregation, corruptLines: corrupt + malformed }

    const quota = await readQuota()

    const [claudeMdBytes, claudeJson] = await Promise.all([claudeMdByteLength(), readClaudeJson()])
    const recommendations = {}
    const claudeMdSize = claudeMdSizeTrigger(claudeMdBytes)
    if (claudeMdSize !== null) recommendations.claudeMdSize = claudeMdSize
    // MCP server count carries no brief-specified threshold (see
    // src/core/consumption.ts's own doc on mcpServerCountTrigger) -- it
    // always has real data (0 is an honest count, never "no data yet"), so
    // it is never conditionally omitted the way the three threshold
    // triggers below are.
    recommendations.mcpServerCount = mcpServerCountTrigger(claudeJson)
    const longSession = longSessionTrigger(aggregation.last24h.avgMainStepContextReread)
    if (longSession !== null) recommendations.longSession = longSession
    const subagentShare = subagentShareTrigger(aggregation.last24h.subagentShare)
    if (subagentShare !== null) recommendations.subagentShare = subagentShare

    // null when no model-router-decisions-*.jsonl file exists at all (the
    // router has never run, or is `off`) -- an honest "nothing to show"
    // distinct from a summary that ran and found zero decisions (JEV-060
    // slice 2, §8, T9). `rows` (the raw turn-usage rows, before
    // toTurnUsageRecord) is exactly what summarizeRouterDecisions' own
    // usageRows parameter expects: it parses `agent`/`at`/`account`/`model`
    // itself.
    const modelRouter = decisionFiles.length === 0
      ? null
      : summarizeRouterDecisions(decisionRows, rows, now, MODEL_ROUTER_WINDOW_MS)

    const steward = stewardFiles.length === 0 ? null : summarizeStewardDecisions(stewardRows, now, MODEL_ROUTER_WINDOW_MS)

    result = { ok: true, usage, quota, recommendations, modelRouter, steward }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
