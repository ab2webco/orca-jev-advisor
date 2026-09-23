#!/usr/bin/env node
/**
 * read-measurements.mjs — sidecar that reads and aggregates the two
 * append-only JSONL logs neither of which the plugin worker can reach
 * directly (both live under ~/.cache/orca-supervisor/, outside the
 * worker's own permission sandbox -- same reason every other cross-
 * boundary read in this plugin goes through a clean child):
 *
 *   gate-decisions.jsonl          adapters/claude/gate-bash.ts
 *                                 (src/core/gate_measurement.ts)
 *   mod-skills-measurements.jsonl adapters/claude/mod-skills
 *                                 (src/core/skill_measurement.ts)
 *
 * Aggregation happens here, not in the worker or the panel: these files
 * can grow over a week of real use, and shipping every raw line across
 * the IPC/storage boundary just to sum them in the browser-sandboxed
 * panel would be wasteful. Only the summary crosses.
 *
 * Every number here comes from counting or averaging entries actually
 * read from these two files. Nothing here estimates a saved dollar, a
 * saved token, or how long a deliberation "would have taken" -- those
 * are not measured anywhere in this codebase and this script does not
 * invent them. The only thing sized directly is `listingChars`, which
 * the skill mod computed and recorded for real (the exact character
 * count of the roster it would have sent), never estimated here.
 *
 * Usage: node read-measurements.mjs
 * Always prints exactly one JSON line to stdout: `{ok: true, gate, modSkills}`
 * or `{ok: false, reason, detail}`.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'
import { foldGateDecisions } from '../../src/core/gate_stats.ts'

const CACHE_DIR = resolveCacheDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA })
const GATE_LOG_PATH = join(CACHE_DIR, 'gate-decisions.jsonl')
const MOD_SKILLS_LOG_PATH = join(CACHE_DIR, 'mod-skills-measurements.jsonl')

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a JSONL file into parsed rows, skipping (not throwing on) any line
 *  that is missing, empty, or not valid JSON -- one corrupt line must never
 *  take down the whole panel. Returns `{rows, corrupt}` so the caller can
 *  disclose how many lines were unreadable, if any. */
async function readJsonl (path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], corrupt: 0 }
    throw error
  }
  const rows = []
  let corrupt = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isRecord(parsed)) rows.push(parsed)
      else corrupt += 1
    } catch {
      corrupt += 1
    }
  }
  return { rows, corrupt }
}

function mean (values) {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function topByCount (counts, limit) {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

/**
 * Guards a raw parsed JSONL row into the exact shape foldGateDecisions()
 * expects, since a hand-edited or half-written line on disk is `unknown`
 * to this reader regardless of what gate_measurement.ts's own writer
 * promises. A row missing or mistyping a required field is dropped
 * (counted as corrupt) rather than fed to the fold with a guessed default
 * -- a wrong guess here would silently distort every count downstream.
 */
function toGateDecisionRecord (row) {
  if (
    typeof row.id !== 'string' ||
    typeof row.at !== 'string' ||
    (row.project !== null && typeof row.project !== 'string') ||
    typeof row.commandFamily !== 'string' ||
    (row.source !== 'local-rule' && row.source !== 'cache' && row.source !== 'jev') ||
    (row.verdict !== 'allow' && row.verdict !== 'ask' && row.verdict !== 'deny') ||
    (row.latencyMs !== null && typeof row.latencyMs !== 'number')
  ) {
    return null
  }
  return {
    type: 'gate-decision',
    id: row.id,
    at: row.at,
    project: row.project,
    commandFamily: row.commandFamily,
    source: row.source,
    verdict: row.verdict,
    latencyMs: row.latencyMs,
  }
}

async function aggregateGate () {
  const { rows, corrupt } = await readJsonl(GATE_LOG_PATH)
  const candidates = rows.filter((r) => r.type === 'gate-decision')
  const decisions = []
  let malformed = 0
  for (const candidate of candidates) {
    const record = toGateDecisionRecord(candidate)
    if (record === null) malformed += 1
    else decisions.push(record)
  }

  // foldGateDecisions (src/core/gate_stats.ts) is the pure, unit-tested
  // fold; this function's own job is only I/O plus the "recent" slice,
  // which stays here because it is not a summary statistic -- it is the
  // last few actual records, kept readable (project/family/source/
  // verdict/latency), never the raw `id`.
  const summary = foldGateDecisions(decisions)

  return {
    ...summary,
    corruptLines: corrupt + malformed,
    cacheHitRate: summary.totalDecisions > 0 ? summary.bySource.cache / summary.totalDecisions : null,
    recent: decisions
      .slice(-10)
      .reverse()
      .map((d) => ({
        at: d.at,
        project: d.project,
        commandFamily: d.commandFamily,
        source: d.source,
        verdict: d.verdict,
        latencyMs: d.latencyMs,
      })),
  }
}

async function aggregateModSkills () {
  const { rows, corrupt } = await readJsonl(MOD_SKILLS_LOG_PATH)
  const decisions = rows.filter((r) => r.type === 'decision')
  const observations = rows.filter((r) => r.type === 'observation')
  const observationById = new Map(observations.map((o) => [o.id, o]))

  const byProject = {}
  let suggested = 0
  let matched = 0
  let comparable = 0
  let listingCharsSum = 0
  let listingCharsCount = 0
  const wideLatencies = []
  const fitLatencies = []

  for (const d of decisions) {
    const project = isRecord(d.orcaContext) && typeof d.orcaContext.proyecto === 'string' && d.orcaContext.proyecto.length > 0
      ? d.orcaContext.proyecto
      : '(unknown)'
    byProject[project] = (byProject[project] || 0) + 1

    if (isRecord(d.decision) && typeof d.decision.name === 'string') suggested += 1

    if (typeof d.listingChars === 'number' && Number.isFinite(d.listingChars)) {
      listingCharsSum += d.listingChars
      listingCharsCount += 1
    }

    if (isRecord(d.latencyMs)) {
      if (typeof d.latencyMs.wide === 'number') wideLatencies.push(d.latencyMs.wide)
      if (typeof d.latencyMs.fit === 'number') fitLatencies.push(d.latencyMs.fit)
    }

    // Measurement-mode accuracy: only comparable once an observation for
    // this same prompt id has actually arrived (the model may never load
    // any skill, in which case there is nothing yet to compare against).
    if (d.mode === 'measurement') {
      const observation = observationById.get(d.id)
      if (observation) {
        comparable += 1
        const suggestedName = isRecord(d.decision) ? d.decision.name : null
        if (suggestedName !== null && suggestedName === observation.skill) matched += 1
      }
    }
  }

  return {
    totalDecisions: decisions.length,
    totalObservations: observations.length,
    corruptLines: corrupt,
    suggestedCount: suggested,
    comparableCount: comparable,
    matchedCount: matched,
    matchRate: comparable > 0 ? matched / comparable : null,
    listingCharsTotal: listingCharsCount > 0 ? listingCharsSum : null,
    listingCharsAvgPerPrompt: listingCharsCount > 0 ? listingCharsSum / listingCharsCount : null,
    listingCharsSampleCount: listingCharsCount,
    wideLatencyMeanMs: mean(wideLatencies),
    fitLatencyMeanMs: mean(fitLatencies),
    byProject: topByCount(byProject, 10),
  }
}

async function main () {
  let result
  try {
    const [gate, modSkills] = await Promise.all([aggregateGate(), aggregateModSkills()])
    result = { ok: true, gate, modSkills }
  } catch (error) {
    result = { ok: false, reason: 'excepcion', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
