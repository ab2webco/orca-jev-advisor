/**
 * log-files.mjs — the JSONL reading, hourly-file listing and row guards
 * shared by the read-only sidecars in this directory (JEVADV-63, A3).
 *
 * Extracted verbatim from read-consumption.mjs (readJsonl, listHourlyFiles,
 * readJsonlRows, toTurnUsageRecord, the two hourly file-name patterns) and
 * read-measurements.mjs (toGateDecisionRecord), because read-activity.mjs
 * needs exactly the same listing and exactly the same guards -- a second copy
 * of a row guard is how this directory has already silently dropped real
 * rows three times (see toGateDecisionRecord's own note below). Those two
 * sidecars end in a top-level `await main()`, so importing from them
 * directly would run them; this module has no side effects on import.
 *
 * Only reading lives here. Pruning (`rm`) stays in read-consumption.mjs,
 * the one sidecar granted `--allow-fs-write` on the cache dir.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalCommandFamily } from '../../src/core/gate_measurement.ts'
import { GATE_DECISIONS_APPEND_FAILURES_FILE, gateDecisionFilesToRead, parseAppendFailures } from '../../src/core/measurement_files.ts'

export const TURN_USAGE_FILE_PATTERN = /^turn-usage-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/
// JEV-060 slice 2 (§8, T9): the router's own decision log, same hourly
// naming and same 8-day retention as turn-usage above -- listed, read and
// pruned through the same generic helpers, just a different pattern.
export const MODEL_ROUTER_DECISIONS_FILE_PATTERN = /^model-router-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/

export function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Same tolerant reader as read-measurements.mjs's own readJsonl -- a
 *  missing file reads as no rows, never an error; a corrupt line is
 *  skipped and counted, never thrown on. */
export async function readJsonl (path) {
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

/**
 * Every hourly-file name in `cacheDir` matching `pattern` (turn-usage or
 * model-router-decisions), with its own hour bucket already parsed to
 * milliseconds -- `hourMs: null` for a name that matches the pattern but
 * whose captured date somehow fails to parse, so pruning never deletes a
 * file it could not confidently date. A missing cache dir (ENOENT --
 * nothing has ever been recorded) reads as no files. Shared by both file
 * families: same naming convention, same retention (JEV-060 slice 2, T9).
 */
export async function listHourlyFiles (cacheDir, pattern) {
  let entries
  try {
    entries = await readdir(cacheDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const name of entries) {
    const match = pattern.exec(name)
    if (!match) continue
    const hourMs = Date.parse(`${match[1]}:00:00.000Z`)
    files.push({ name, path: join(cacheDir, name), hourMs: Number.isNaN(hourMs) ? null : hourMs })
  }
  return files
}

/**
 * 0.6.17 T4 (JEVADV-92): every gate decision row, from the single file
 * written before 0.6.17 and every hourly file since (gateDecisionFilesToRead:
 * legacy first, then the hours in order), so the readers keep the whole
 * history across the upgrade. Not pruned: the board's windows reach back
 * to the first decision. A missing cache dir reads as no rows.
 */
export async function readGateDecisionLog (cacheDir) {
  let names
  try {
    names = await readdir(cacheDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], corrupt: 0 }
    throw error
  }
  return readJsonlRows(gateDecisionFilesToRead(names).map((name) => ({ path: join(cacheDir, name) })))
}

/** How many gate decisions the gate could not write (0.6.17 T4); `{count: 0, lastAt: null}` when none, or when the counter cannot be read. */
export async function readGateAppendFailures (cacheDir) {
  try {
    return parseAppendFailures(JSON.parse(await readFile(join(cacheDir, GATE_DECISIONS_APPEND_FAILURES_FILE), 'utf8')))
  } catch {
    return parseAppendFailures(null)
  }
}

export async function readJsonlRows (files) {
  const results = await Promise.all(files.map((file) => readJsonl(file.path)))
  const rows = []
  let corrupt = 0
  for (const result of results) {
    corrupt += result.corrupt
    rows.push(...result.rows)
  }
  return { rows, corrupt }
}

/**
 * Guards a raw parsed JSONL row into the exact TurnUsageRecord shape
 * aggregateTurnUsage() expects (src/core/consumption.ts) -- same
 * discipline as toGateDecisionRecord below: a hand-edited or half-written
 * line on disk is `unknown` regardless of what hooks/index.ts's own writer
 * (recordTurnUsage) promises. A row missing or mistyping a required field
 * is dropped (counted as corrupt) rather than fed to the fold with a
 * guessed default.
 */
export function toTurnUsageRecord (row) {
  if (
    typeof row.at !== 'string' ||
    (row.agent !== 'main' && row.agent !== 'subagent') ||
    typeof row.model !== 'string' ||
    (row.effort !== null && typeof row.effort !== 'string') ||
    (row.input !== null && typeof row.input !== 'number') ||
    (row.output !== null && typeof row.output !== 'number') ||
    (row.cacheRead !== null && typeof row.cacheRead !== 'number') ||
    (row.cacheWrite !== null && typeof row.cacheWrite !== 'number') ||
    typeof row.stopReason !== 'string' ||
    typeof row.account !== 'string'
  ) {
    return null
  }
  return {
    at: row.at,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    stopReason: row.stopReason,
    account: row.account,
    // JEVADV-63: absent on every record recordTurnUsage wrote before this
    // field existed, and on any row a hand edit mistypes -- never thrown
    // on, always the honest "not known" null.
    project: typeof row.project === 'string' ? row.project : null,
  }
}

/**
 * Guards a raw parsed JSONL row into the exact shape foldGateDecisions()
 * expects, since a hand-edited or half-written line on disk is `unknown`
 * to this reader regardless of what gate_measurement.ts's own writer
 * promises. A row missing or mistyping a required field is dropped
 * (counted as corrupt) rather than fed to the fold with a guessed default
 * -- a wrong guess here would silently distort every count downstream.
 */
export function toGateDecisionRecord (row) {
  if (
    typeof row.id !== 'string' ||
    typeof row.at !== 'string' ||
    (row.project !== null && typeof row.project !== 'string') ||
    typeof row.commandFamily !== 'string' ||
    // 'none' is a real GateSource (src/core/gate_measurement.ts): Jev was
    // asked but never answered, so the command failed open unjudged. This
    // check used to omit it, which meant every 'none' row -- exactly the
    // rows the 0.4.0 fail-open fix writes -- was silently discarded as
    // malformed. The fold never saw them, so the board's "passed unjudged"
    // count could only ever render zero: a working feature, hidden by a
    // guard that never learned about it. Third time a silent drop in this
    // file has hidden something that was actually working; check the other
    // guards in this file before trusting any of their omissions again.
    (row.source !== 'local-rule' && row.source !== 'cache' && row.source !== 'jev' && row.source !== 'none') ||
    // 'advise' (the advise-model release, src/core/gate_measurement.ts): the
    // risk stage (or a local rule whose switch is off) refuses the CODING
    // MODEL and hands it a reason, rather than asking a person -- same
    // silent-drop mistake as 'none' above if this guard forgets it.
    (row.verdict !== 'allow' && row.verdict !== 'ask' && row.verdict !== 'deny' && row.verdict !== 'advise') ||
    (row.latencyMs !== null && typeof row.latencyMs !== 'number') ||
    // Optional ON READ, not on write (see gate_measurement.ts's own doc on
    // GateDecisionRecord.pluginVersion): absent entirely is a record from
    // before this field existed and must be kept, never dropped and never
    // counted as corrupt. Present but not a string is malformed, same
    // discipline as every other field here.
    (row.pluginVersion !== undefined && typeof row.pluginVersion !== 'string')
  ) {
    return null
  }
  return {
    type: 'gate-decision',
    id: row.id,
    at: row.at,
    project: row.project,
    // Stamped at write time: a log that spans a family rename reads as one family.
    commandFamily: canonicalCommandFamily(row.commandFamily),
    source: row.source,
    verdict: row.verdict,
    latencyMs: row.latencyMs,
    // Conditional spread, not `pluginVersion: row.pluginVersion`: this
    // record must be indistinguishable from a legacy record parsed off
    // disk where the key never existed at all, same reasoning as
    // buildGateDecisionRecord in gate_measurement.ts.
    ...(row.pluginVersion !== undefined ? { pluginVersion: row.pluginVersion } : {}),
  }
}
