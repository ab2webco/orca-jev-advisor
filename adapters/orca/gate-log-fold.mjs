/**
 * gate-log-fold.mjs — folds the gate's decision files older than 8 days into
 * the running totals (src/core/gate_decision_totals.ts) and deletes them
 * (0.6.21 T1, JEVADV-98). Run by read-consumption.mjs, the one sidecar with
 * write access to the cache dir, after it has printed its own summary; at
 * most once a day it looks for new files to fold, and every run finishes
 * deleting what an earlier run folded.
 *
 * Order, so that no decision is ever lost or counted twice:
 *   1. a lock file (`wx`), so two folds never start from the same totals;
 *   2. the totals, the decision files folded in read order (the legacy file
 *      first, then the hours), stopping at the first that is not old enough,
 *      so a folded file is always older than every file left;
 *   3. the totals written to a temporary file, synced, renamed over the old;
 *   4. only then, the folded files deleted.
 * A crash before 3 changes nothing. A crash between 3 and 4 leaves files the
 * totals already name in `files` (with their size and modification time):
 * readers skip them while they match, and the next run deletes them. A name
 * leaves `files` only on a run that finds the file already gone (long after
 * any reader that saw it has finished) or holding a new file.
 *
 * An unreadable totals file stops the fold (it is never replaced by fresh
 * totals, which would drop every decision it holds). The caller catches
 * every error: a fold failure never touches a reader or the gate.
 */
import { open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGateDecisionRecords } from '../../src/core/gate_measurement.ts'
import {
  addGateDecisions,
  GATE_DECISION_TOTALS_FILE,
  GATE_DECISION_TOTALS_LOCK_FILE,
  GATE_FOLD_INTERVAL_MS,
  gateHourFileFoldable,
  isFoldedFile,
  legacyGateFileFoldable,
} from '../../src/core/gate_decision_totals.ts'
import { GATE_DECISIONS_LEGACY_FILE, gateDecisionFilesToRead } from '../../src/core/measurement_files.ts'
import { guardGateDecisionRows, parseJsonlText, readGateDecisionTotalsFile } from './log-files.mjs'

/** A lock older than this was left by a fold that died; no fold takes more than seconds. */
const STALE_LOCK_MS = 10 * 60 * 1000

async function takeLock (path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      await handle.close()
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(path).catch(() => null)
      if (info !== null && Date.now() - info.mtimeMs < STALE_LOCK_MS) return false
      await rm(path, { force: true })
    }
  }
  return false
}

/** `totals` on disk for good: a synced temporary file renamed over the old one, then the directory synced where the platform allows it. */
async function writeTotals (cacheDir, totals) {
  const path = join(cacheDir, GATE_DECISION_TOTALS_FILE)
  const temporary = `${path}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(JSON.stringify(totals))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  try {
    const dir = await open(cacheDir, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch {
    // Not every platform syncs a directory; the rename itself is atomic.
  }
}

/** A file's size and modification time, or null when it is gone. */
async function seenAs (path) {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** The newest readable time of any row in a file, or null when none reads. */
function newestAtMs (rows) {
  let newest = null
  for (const row of rows) {
    const ms = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN
    if (!Number.isNaN(ms) && (newest === null || ms > newest)) newest = ms
  }
  return newest
}

/** What one decision file adds to the totals, read the way every reader reads it. */
function batchOf (text) {
  const { rows, corrupt } = parseJsonlText(text)
  const { records, malformed } = guardGateDecisionRows(rows)
  return {
    rows,
    batch: {
      records,
      corruptLines: corrupt,
      malformedRows: malformed,
      jevRecordsForAb: parseGateDecisionRecords(text).filter((record) => record.source === 'jev').length,
    },
  }
}

/**
 * One fold of the gate decision log in `cacheDir` at `nowMs`.
 * `options.remove(path)` deletes a file (tests stand in a failing one to
 * stop a fold between writing and deleting); `options.force` folds even
 * when the last look was less than a day ago.
 * Resolves `{status: 'ok', folded, deleted}`, `{status: 'locked'}` or
 * `{status: 'unreadable-totals'}`; rejects on an I/O error, before deleting
 * anything whose totals are not written.
 */
export async function foldGateDecisionLog (cacheDir, nowMs, options = {}) {
  const remove = options.remove ?? ((path) => rm(path))
  const lock = join(cacheDir, GATE_DECISION_TOTALS_LOCK_FILE)
  if (!(await takeLock(lock))) return { status: 'locked' }
  try {
    const current = await readGateDecisionTotalsFile(cacheDir)
    if (current.state === 'unreadable') return { status: 'unreadable-totals' }
    const names = await readdir(cacheDir)
    const seen = new Map()
    for (const name of gateDecisionFilesToRead(names)) seen.set(name, await seenAs(join(cacheDir, name)))

    // What an earlier run folded: delete what is still that file; forget a
    // name that is gone, or that now holds a new file (read as live).
    const kept = current.totals.files.filter((file) => {
      const now = seen.get(file.name)
      return now !== undefined && now !== null && isFoldedFile(current.totals, file.name, now)
    })
    for (const file of kept) await remove(join(cacheDir, file.name)).catch(() => {})
    let totals = { ...current.totals, files: kept }
    let changed = kept.length !== current.totals.files.length

    const checkedMs = current.totals.checkedAt === null ? Number.NaN : Date.parse(current.totals.checkedAt)
    const due = options.force === true || Number.isNaN(checkedMs) || nowMs - checkedMs >= GATE_FOLD_INTERVAL_MS
    const folded = []
    if (due) {
      // Everything due is folded as one batch, in read order: the legacy
      // file and the first hour files overlap in time (two builds wrote both
      // during the 0.6.17 upgrade), and the Jev failure streak is only exact
      // when its records are read together.
      const records = []
      const batch = { corruptLines: 0, malformedRows: 0, jevRecordsForAb: 0 }
      for (const [name, stats] of seen) {
        if (stats === null || isFoldedFile(totals, name, stats)) continue
        if (name !== GATE_DECISIONS_LEGACY_FILE && !gateHourFileFoldable(name, nowMs)) break
        let text
        try {
          text = await readFile(join(cacheDir, name), 'utf8')
        } catch (error) {
          if (error?.code === 'ENOENT') break
          throw error
        }
        const file = batchOf(text)
        if (name === GATE_DECISIONS_LEGACY_FILE && !legacyGateFileFoldable(newestAtMs(file.rows), nowMs)) break
        records.push(...file.batch.records)
        batch.corruptLines += file.batch.corruptLines
        batch.malformedRows += file.batch.malformedRows
        batch.jevRecordsForAb += file.batch.jevRecordsForAb
        folded.push({ name, size: stats.size, mtimeMs: stats.mtimeMs })
      }
      if (folded.length > 0) {
        totals = { ...addGateDecisions(totals, { ...batch, records }), files: [...totals.files, ...folded], foldedFiles: totals.foldedFiles + folded.length }
      }
      totals = { ...totals, checkedAt: new Date(nowMs).toISOString() }
      changed = true
    }
    if (changed) await writeTotals(cacheDir, totals)

    const deleted = []
    for (const { name } of folded) {
      try {
        await remove(join(cacheDir, name))
        deleted.push(name)
      } catch {
        // Still named in the totals: readers skip it, and the next run deletes it.
      }
    }
    return { status: 'ok', folded: folded.map(({ name }) => name), deleted }
  } finally {
    await rm(lock, { force: true }).catch(() => {})
  }
}
