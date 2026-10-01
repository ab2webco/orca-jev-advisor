#!/usr/bin/env node
/**
 * read-measurements.mjs — sidecar that reads and aggregates the three
 * append-only JSONL logs none of which the plugin worker can reach
 * directly (all live under ~/.cache/orca-supervisor/, outside the
 * worker's own permission sandbox -- same reason every other cross-
 * boundary read in this plugin goes through a clean child):
 *
 *   gate-decisions.jsonl          adapters/claude/gate-bash.ts
 *                                 (src/core/gate_measurement.ts)
 *   mod-skills-measurements.jsonl adapters/claude/mod-skills
 *                                 (src/core/skill_measurement.ts)
 *   gate-approvals.jsonl          adapters/claude/gate-bash.ts (pending half)
 *                                 adapters/claude/gate-outcome.ts (outcome half)
 *                                 (src/core/approval_record.ts)
 *   ab-benchmark-results.jsonl    adapters/cli/ab_benchmark_cli.ts
 *                                 (src/core/ab_benchmark.ts, src/core/ab_report.ts)
 *   human-queue.jsonl             adapters/claude/gate-bash.ts, queue mode
 *                                 (src/core/human_queue.ts) -- the board's
 *                                 "Waiting for you" list, gate.waiting
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
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'
import { foldGateDecisions, summarizeGateTally } from '../../src/core/gate_stats.ts'
import { addGateDecisions, gateHealthOf } from '../../src/core/gate_decision_totals.ts'
import { canonicalCommandFamily } from '../../src/core/gate_measurement.ts'
import { ceilingEvidence, summarizeApprovals } from '../../src/core/approval_record.ts'
import { foldAbResults } from '../../src/core/ab_report.ts'
import { DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS, evaluateModSkillsReadiness } from '../../src/core/mod_skills_readiness.ts'
import { modSkillsProjectName } from '../../src/core/project_name.ts'
import { guardGateDecisionRows, readGateAppendFailures, readGateDecisionLog } from './log-files.mjs'
import { HUMAN_QUEUE_FILE, parseHumanQueue, waitingItems } from '../../src/core/human_queue.ts'
import { measurementFilesToRead } from '../../src/core/measurement_files.ts'

const CACHE_DIR = resolveCacheDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgCacheHome: process.env.XDG_CACHE_HOME })
const APPROVALS_LOG_PATH = join(CACHE_DIR, 'gate-approvals.jsonl')
const AB_BENCHMARK_LOG_PATH = join(CACHE_DIR, 'ab-benchmark-results.jsonl')
const HUMAN_QUEUE_PATH = join(CACHE_DIR, HUMAN_QUEUE_FILE)

/** The board shows at most this many waiting items; the rest are counted, not listed. */
const WAITING_LIST_LIMIT = 20

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

// toGateDecisionRecord lives in ./log-files.mjs (JEVADV-63, A3), behind
// guardGateDecisionRows: shared with read-activity.mjs and the fold, so the
// readers of the gate log can never drift onto two different guards.

async function aggregateGate () {
  // 0.6.17 T4: the hourly files and the legacy single file, in order.
  // 0.6.21 T1: after the totals of the files already folded, which every
  // figure below continues -- a fold never moves one of them.
  const { rows, corrupt, totals } = await readGateDecisionLog(CACHE_DIR)
  const { records: decisions, malformed } = guardGateDecisionRows(rows)
  const combined = addGateDecisions(totals, { records: decisions, corruptLines: corrupt, malformedRows: malformed, jevRecordsForAb: 0 })

  // summarizeGateTally (src/core/gate_stats.ts) is the pure, unit-tested
  // fold; this function's own job is only I/O plus the "recent" slice,
  // which is not a summary statistic -- it is the last few actual records,
  // kept readable (project/family/source/verdict/latency), never the raw `id`.
  const summary = summarizeGateTally(combined.all)
  const { pending, outcomes } = await readApprovalRecords()
  const now = Date.now()

  return {
    ...summary,
    windows: buildGateWindows(combined, summary, decisions, pending, outcomes, now),
    // 0.6.17 T4: records the gate could not write, so a log that stopped
    // growing is never read as a quiet gate.
    health: { ...gateHealthOf(combined), appendFailures: await readGateAppendFailures(CACHE_DIR) },
    corruptLines: combined.corruptLines + combined.malformedRows,
    cacheHitRate: summary.totalDecisions > 0 ? summary.bySource.cache / summary.totalDecisions : null,
    recent: [...combined.recent].reverse(),
    notRunByCommandFamily: await aggregateNotRunByCommandFamily(),
    ...(await aggregateWaiting(now)),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
/** The board's interventions table stops here; everything past it is one "rest" row. */
const INTERVENTION_ROWS = 15

/** Milliseconds for an ISO timestamp, or null when it does not parse -- a
 *  record with an unreadable time still counts in `all`, but no time-bounded
 *  window can honestly claim it. */
function atMs (iso) {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function isAtOrAfter (iso, sinceMs) {
  const ms = atMs(iso)
  return ms !== null && ms >= sinceMs
}

/** summarizeApprovals per family, keyed by the family each pending record
 *  already carries -- same fold as aggregateNotRunByCommandFamily. */
function notRunPerFamily (pending, outcomes, now) {
  const byFamily = new Map()
  for (const record of pending) {
    const forFamily = byFamily.get(record.commandFamily) ?? []
    forFamily.push(record)
    byFamily.set(record.commandFamily, forFamily)
  }
  const notRun = new Map()
  for (const [family, familyPending] of byFamily) {
    notRun.set(family, summarizeApprovals(familyPending, outcomes, now).notRun)
  }
  return notRun
}

/**
 * The board's "where does it intervene" table. Only families that were ever
 * asked about or blocked take a row: a family the gate always allowed is
 * noise there however often it ran (91 families on the author's log, 61 of
 * them 100% allowed, and sorting by total buried `terraform` at 17 asks out
 * of 18 under `grep` at 216 and none). Rows past INTERVENTION_ROWS fold into
 * `rest`; the always-allowed families fold into `quiet`. `rest` is null, not
 * a zero row, when nothing was left over. A family that only appears in the
 * approvals log (no decision in this window) takes no row: notRun is a
 * column of a decision row, never a row of its own.
 */
function interventionsTable (summary, pending, outcomes, now) {
  const notRun = notRunPerFamily(pending, outcomes, now)
  const intervening = summary.byCommandFamily
    .filter((f) => f.interventions > 0)
    .map((f) => ({
      commandFamily: f.commandFamily,
      total: f.total,
      ask: f.byVerdict.ask,
      deny: f.byVerdict.deny,
      notRun: notRun.get(f.commandFamily) ?? 0,
    }))
    // Ties broken by total, then by name, so the same log always renders
    // the same table.
    .sort((a, b) => (b.ask + b.deny) - (a.ask + a.deny) || b.total - a.total || a.commandFamily.localeCompare(b.commandFamily))
  const leftover = intervening.slice(INTERVENTION_ROWS)
  const quietFamilies = summary.byCommandFamily.filter((f) => f.interventions === 0)
  return {
    rows: intervening.slice(0, INTERVENTION_ROWS),
    rest: leftover.length === 0
      ? null
      : leftover.reduce((acc, row) => ({
        families: acc.families + 1,
        total: acc.total + row.total,
        ask: acc.ask + row.ask,
        deny: acc.deny + row.deny,
        notRun: acc.notRun + row.notRun,
      }), { families: 0, total: 0, ask: 0, deny: 0, notRun: 0 }),
    quiet: { families: quietFamilies.length, total: quietFamilies.reduce((sum, f) => sum + f.total, 0) },
  }
}

function approvalsSummary (pending, outcomes, now) {
  const summary = summarizeApprovals(pending, outcomes, now)
  return {
    asked: summary.asked,
    approved: summary.approved,
    rejected: summary.rejected,
    notRun: summary.notRun,
    awaiting: summary.awaiting,
    ceiling: ceilingEvidence(summary.labelled),
  }
}

function gateWindow (fields, summary, pending, outcomes, now) {
  return {
    ...fields,
    totalDecisions: summary.totalDecisions,
    byVerdict: summary.byVerdict,
    bySource: summary.bySource,
    jevLatency: summary.jevLatency,
    interventions: interventionsTable(summary, pending, outcomes, now),
    approvals: approvalsSummary(pending, outcomes, now),
  }
}

/**
 * odd/tasks/panel-interventions-and-mod-copy.md T10 -- the same aggregate for
 * each window the board lets a person pick. A time window cannot separate
 * rule semantics across releases (five pipe-to-shell asks from before the
 * deny tier existed look like the deny tier failing), which is why `version`
 * exists: it counts only the records the current build wrote -- the build
 * that wrote the most recent stamped record (records carry no version until
 * the writer stamps one, see gate_measurement.ts, so it can honestly be
 * null). Pending asks carry no build, so its approvals are bounded by the
 * first decision that build wrote -- `since` says exactly which bound was
 * applied.
 *
 * 0.6.21 T1: `combined` is the totals continued with the live `decisions`
 * (src/core/gate_decision_totals.ts): "all" and "version" read it; the day
 * and week windows read only the live decisions, because a folded file is
 * more than 8 days old.
 */
function buildGateWindows (combined, allSummary, decisions, pending, outcomes, now) {
  const timeWindow = (key, spanMs) => {
    const sinceMs = now - spanMs
    return gateWindow(
      { key, available: true, pluginVersion: null, since: new Date(sinceMs).toISOString() },
      foldGateDecisions(decisions.filter((d) => isAtOrAfter(d.at, sinceMs))),
      pending.filter((p) => isAtOrAfter(p.at, sinceMs)),
      outcomes, now)
  }

  const version = combined.latestStamped === null ? null : combined.latestStamped.pluginVersion
  const ofVersion = version === null ? undefined : combined.byVersion.find(([name]) => name === version)?.[1]
  let versionWindow
  if (version === null || ofVersion === undefined) {
    versionWindow = gateWindow({ key: 'version', available: false, pluginVersion: null, since: null }, foldGateDecisions([]), [], outcomes, now)
  } else {
    const firstMs = ofVersion.firstAtMs
    versionWindow = gateWindow(
      { key: 'version', available: true, pluginVersion: version, since: firstMs === null ? null : new Date(firstMs).toISOString() },
      summarizeGateTally(ofVersion.tally),
      firstMs === null ? [] : pending.filter((p) => isAtOrAfter(p.at, firstMs)),
      outcomes, now)
  }

  return {
    version: versionWindow,
    day: timeWindow('day', DAY_MS),
    week: timeWindow('week', 7 * DAY_MS),
    all: gateWindow({ key: 'all', available: true, pluginVersion: null, since: null }, allSummary, pending, outcomes, now),
  }
}

/**
 * odd/tasks/panel-interventions-and-mod-copy.md T4 -- a per-family notRun
 * count, sitting on the `gate` aggregate as a sibling to `byCommandFamily`
 * rather than merged into it: this comes from gate-approvals.jsonl, a much
 * smaller population (only the asks the gate actually stopped for) than
 * gate-decisions.jsonl (every decision). Each PendingApprovalRecord already
 * carries its own `commandFamily`, stamped by the same commandFamily()
 * function gate-decisions.jsonl's records use, so the two logs already
 * share one taxonomy -- this is a group-by on an already-labelled field,
 * never an invented cross-log join, and a pending record with no family
 * is impossible: toPendingApprovalRecord already requires the string.
 */
/**
 * 0.6.8 T5: what queue mode set aside for a person and nobody has come back
 * for yet (src/core/human_queue.ts's waitingItems). Only what the board
 * shows crosses: the hashed session key stays here. `waitingTotal` counts
 * past the listed WAITING_LIST_LIMIT so a long queue is never understated.
 */
async function aggregateWaiting (now) {
  let raw = ''
  try {
    raw = await readFile(HUMAN_QUEUE_PATH, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const waiting = waitingItems(parseHumanQueue(raw), now)
  return {
    waiting: waiting.slice(0, WAITING_LIST_LIMIT).map((item) => ({ id: item.id, at: item.at, project: item.project, policyId: item.policyId, command: item.command })),
    waitingTotal: waiting.length,
  }
}

async function aggregateNotRunByCommandFamily () {
  const { pending, outcomes } = await readApprovalRecords()
  // notRunPerFamily reuses summarizeApprovals (src/core/approval_record.ts),
  // the same tested fold aggregateApprovals() uses for the plugin-wide
  // total, so the TTL and outcome-join logic can never drift between them.
  return [...notRunPerFamily(pending, outcomes, Date.now()).entries()]
    .map(([commandFamily, notRun]) => ({ commandFamily, notRun }))
    .sort((a, b) => b.notRun - a.notRun)
}

/** The skill-selection log across the legacy single file and its hourly files (src/core/measurement_files.ts). */
async function readModSkillsRows () {
  let names
  try {
    names = await readdir(CACHE_DIR)
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], corrupt: 0 }
    throw error
  }
  const rows = []
  let corrupt = 0
  for (const name of measurementFilesToRead('mod-skills', names)) {
    const file = await readJsonl(join(CACHE_DIR, name))
    rows.push(...file.rows)
    corrupt += file.corrupt
  }
  return { rows, corrupt }
}

async function aggregateModSkills () {
  const { rows, corrupt } = await readModSkillsRows()
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
  // odd/tasks/production-honesty-pass.md P6: the config panel's skills-mod
  // line needs to say "recording N prompts since <date>, most recently
  // <date>" -- read straight from the decisions actually recorded, never
  // from file order (a malformed line elsewhere in the file must not shift
  // which decision counts as first or last).
  let firstAt = null
  let lastAt = null

  for (const d of decisions) {
    const project = modSkillsProjectName(d.orcaContext) ?? '(unknown)'
    byProject[project] = (byProject[project] || 0) + 1

    if (typeof d.at === 'string' && !Number.isNaN(Date.parse(d.at))) {
      if (firstAt === null || d.at < firstAt) firstAt = d.at
      if (lastAt === null || d.at > lastAt) lastAt = d.at
    }

    if (isRecord(d.decision) && typeof d.decision.name === 'string') suggested += 1

    // board.html's own copy for this stat is "Listing characters not sent"
    // -- only a decision that actually withheld the listing (JEVADV-4's own
    // `listingWithheld: true`) counts. A record written before that field
    // existed has no way to say either way; the documented choice is to
    // keep counting it, exactly as every record was counted before this
    // field existed at all, rather than silently dropping older history.
    const countsAsNotSent = d.listingWithheld === undefined || d.listingWithheld === true
    if (countsAsNotSent && typeof d.listingChars === 'number' && Number.isFinite(d.listingChars)) {
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

  const matchRate = comparable > 0 ? matched / comparable : null
  // The activation metric mod-skills' own module note promised but never
  // stated as code ("active mode does not turn on until a week of
  // measurement-mode data exists to set these thresholds from") -- see
  // src/core/mod_skills_readiness.ts. Carries the thresholds it was judged
  // against alongside the verdict, so a panel can render "N more samples
  // needed" without duplicating the constants.
  const readiness = {
    ...evaluateModSkillsReadiness({ comparableCount: comparable, matchRate }, DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS),
    thresholds: DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS,
  }

  return {
    totalDecisions: decisions.length,
    totalObservations: observations.length,
    firstAt,
    lastAt,
    corruptLines: corrupt,
    suggestedCount: suggested,
    comparableCount: comparable,
    matchedCount: matched,
    matchRate,
    listingCharsTotal: listingCharsCount > 0 ? listingCharsSum : null,
    listingCharsAvgPerPrompt: listingCharsCount > 0 ? listingCharsSum / listingCharsCount : null,
    listingCharsSampleCount: listingCharsCount,
    wideLatencyMeanMs: mean(wideLatencies),
    fitLatencyMeanMs: mean(fitLatencies),
    byProject: topByCount(byProject, 10),
    readiness,
  }
}

/**
 * Guards a raw parsed JSONL row into a PendingApprovalRecord (see
 * src/core/approval_record.ts), for the same reason toGateDecisionRecord()
 * does: a hand-edited or half-written line on disk is `unknown` regardless
 * of what gate-bash.ts's own writer promises. A row missing or mistyping a
 * required field is dropped (counted as corrupt) rather than fed to the
 * join with a guessed default.
 */
function toPendingApprovalRecord (row) {
  if (
    typeof row.toolUseId !== 'string' ||
    typeof row.at !== 'string' ||
    (row.project !== null && typeof row.project !== 'string') ||
    (row.destinationId !== null && typeof row.destinationId !== 'string') ||
    typeof row.commandFamily !== 'string' ||
    (row.shape !== null && typeof row.shape !== 'string') ||
    (row.reversible !== null && typeof row.reversible !== 'number') ||
    (row.external !== null && typeof row.external !== 'number') ||
    (row.consequence !== null && typeof row.consequence !== 'number') ||
    typeof row.ceiling !== 'number'
  ) {
    return null
  }
  return {
    type: 'gate-pending',
    toolUseId: row.toolUseId,
    at: row.at,
    project: row.project,
    destinationId: row.destinationId,
    // Stamped at write time: a log that spans a family rename reads as one family.
    commandFamily: canonicalCommandFamily(row.commandFamily),
    shape: row.shape,
    reversible: row.reversible,
    external: row.external,
    consequence: row.consequence,
    ceiling: row.ceiling,
  }
}

/** Same guard as {@link toPendingApprovalRecord}, for the outcome half gate-outcome.ts appends to the same file. */
function toApprovalOutcomeRecord (row) {
  if (
    typeof row.toolUseId !== 'string' ||
    typeof row.at !== 'string' ||
    (row.outcome !== 'approved' && row.outcome !== 'rejected')
  ) {
    return null
  }
  return { type: 'gate-outcome', toolUseId: row.toolUseId, at: row.at, outcome: row.outcome }
}

/**
 * Guards and joins gate-approvals.jsonl's raw rows into the pending/outcome
 * halves both aggregateApprovals() (plugin-wide) and
 * aggregateNotRunByCommandFamily() (per-family) fold with
 * src/core/approval_record.ts's summarizeApprovals(). Pulled out so both
 * call sites read and guard the same file the same way instead of drifting.
 */
async function readApprovalRecords () {
  const { rows, corrupt } = await readJsonl(APPROVALS_LOG_PATH)
  const pending = []
  const outcomes = []
  let malformed = 0
  for (const row of rows) {
    if (row.type === 'gate-pending') {
      const record = toPendingApprovalRecord(row)
      if (record === null) malformed += 1
      else pending.push(record)
    } else if (row.type === 'gate-outcome') {
      const record = toApprovalOutcomeRecord(row)
      if (record === null) malformed += 1
      else outcomes.push(record)
    }
  }
  return { pending, outcomes, corruptLines: corrupt + malformed }
}

/**
 * Joins the pending and outcome halves that live in the same file
 * (gate-bash.ts and gate-outcome.ts both append to gate-approvals.jsonl)
 * with the pure fold in src/core/approval_record.ts, then asks that same
 * module what the labelled decisions say the ceiling should be. Nothing
 * here invents a threshold: ceilingEvidence() itself returns null rather
 * than a number whenever approvals and rejections overlap or one side has
 * no evidence yet, and this function passes that null straight through.
 */
async function aggregateApprovals () {
  const { pending, outcomes, corruptLines } = await readApprovalRecords()

  // odd/tasks/production-honesty-pass.md P7: `notRun` was `unresolved`.
  // See src/core/approval_record.ts's own doc comment on
  // ApprovalSummary.notRun -- classified, not known: most of these are a
  // command the gate denied outright (which can never receive an outcome),
  // but a crashed session after a real run leaves the same trace, so this is
  // never folded into `ceiling`'s evidence either way.
  return { ...approvalsSummary(pending, outcomes, Date.now()), corruptLines }
}

/**
 * Guards a raw parsed JSONL row into the exact AbComparisonResult shape
 * foldAbResults() expects (see src/core/ab_benchmark.ts), same discipline
 * as toGateDecisionRecord() above: a hand-edited or half-written line on
 * disk is `unknown` regardless of what ab_benchmark_cli.ts's own writer
 * promises. A row missing or mistyping a required field -- including
 * inside the nested `jev`/`bigModel` objects -- is dropped (counted as
 * corrupt) rather than fed to the fold with a guessed default.
 */
function toAbComparisonResult (row) {
  if (
    typeof row.id !== 'string' ||
    typeof row.at !== 'string' ||
    typeof row.commandFamily !== 'string' ||
    (row.destinationKind !== null && typeof row.destinationKind !== 'string') ||
    (row.agree !== null && typeof row.agree !== 'boolean')
  ) {
    return null
  }

  const jev = row.jev
  if (
    !isRecord(jev) ||
    (jev.verdict !== 'allow' && jev.verdict !== 'ask') ||
    typeof jev.latencyMs !== 'number' ||
    typeof jev.inputTokens !== 'number' ||
    typeof jev.outputTokens !== 'number'
  ) {
    return null
  }

  const bigModel = row.bigModel
  if (
    !isRecord(bigModel) ||
    (bigModel.verdict !== 'allow' && bigModel.verdict !== 'ask' && bigModel.verdict !== 'deny' && bigModel.verdict !== null) ||
    (bigModel.latencyMs !== null && typeof bigModel.latencyMs !== 'number') ||
    (bigModel.inputTokens !== null && typeof bigModel.inputTokens !== 'number') ||
    (bigModel.outputTokens !== null && typeof bigModel.outputTokens !== 'number') ||
    (bigModel.cacheCreationInputTokens !== null && typeof bigModel.cacheCreationInputTokens !== 'number') ||
    (bigModel.cacheReadInputTokens !== null && typeof bigModel.cacheReadInputTokens !== 'number') ||
    (bigModel.modelId !== null && typeof bigModel.modelId !== 'string') ||
    (bigModel.failureReason !== null &&
      bigModel.failureReason !== 'cli_not_found' &&
      bigModel.failureReason !== 'cli_error' &&
      bigModel.failureReason !== 'unparseable_envelope' &&
      bigModel.failureReason !== 'unparseable_verdict')
  ) {
    return null
  }

  return {
    id: row.id,
    at: row.at,
    // Stamped at write time: a log that spans a family rename reads as one family.
    commandFamily: canonicalCommandFamily(row.commandFamily),
    destinationKind: row.destinationKind,
    jev: {
      verdict: jev.verdict,
      latencyMs: jev.latencyMs,
      inputTokens: jev.inputTokens,
      outputTokens: jev.outputTokens,
    },
    bigModel: {
      verdict: bigModel.verdict,
      latencyMs: bigModel.latencyMs,
      inputTokens: bigModel.inputTokens,
      outputTokens: bigModel.outputTokens,
      cacheCreationInputTokens: bigModel.cacheCreationInputTokens,
      cacheReadInputTokens: bigModel.cacheReadInputTokens,
      modelId: bigModel.modelId,
      failureReason: bigModel.failureReason,
    },
    agree: row.agree,
  }
}

/**
 * Reads and folds ab-benchmark-results.jsonl (see src/core/ab_report.ts's
 * own module note for why this fold is separate from ab_benchmark.ts's
 * own buildReport()). A missing file yields the empty summary, the same
 * way readJsonl() already returns `{rows: [], corrupt: 0}` on ENOENT --
 * never treated as an error, since the A/B benchmark may simply never
 * have been run yet.
 */
async function aggregateAbBenchmark () {
  const { rows, corrupt } = await readJsonl(AB_BENCHMARK_LOG_PATH)
  const results = []
  let malformed = 0
  for (const row of rows) {
    const result = toAbComparisonResult(row)
    if (result === null) malformed += 1
    else results.push(result)
  }

  const summary = foldAbResults(results)
  return { ...summary, corruptLines: corrupt + malformed }
}

async function main () {
  let result
  try {
    const [gate, modSkills, approvals, abBenchmark] = await Promise.all([
      aggregateGate(),
      aggregateModSkills(),
      aggregateApprovals(),
      aggregateAbBenchmark(),
    ])
    result = { ok: true, gate, modSkills, approvals, abBenchmark }
  } catch (error) {
    result = { ok: false, reason: 'excepcion', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
