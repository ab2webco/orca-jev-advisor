#!/usr/bin/env node
/**
 * read-model-measurements.mjs — sidecar that reads and summarizes
 * model-reclassifications.jsonl (adapters/claude/agent-model.ts's own
 * append log, src/core/model_measurement.ts's MODEL_MEASUREMENT_FILE),
 * which lives under ~/.cache/orca-supervisor/, outside this worker's own
 * permission sandbox -- same reason read-measurements.mjs's own two logs go
 * through a clean child instead of a direct read from main.mjs (see that
 * script's module note).
 *
 * Unlike read-measurements.mjs, this sidecar also needs the person's model
 * catalog: summarizeModelMeasurements (src/core/model_measurement.ts)
 * compares each decision's `requestedModel` against a RANKED catalog entry
 * to compute `compared`/`up`/`down`/`agree`, and the catalog lives in
 * `storage`, which this out-of-process script cannot read either. The
 * worker (models-worker.mjs's publishModelMeasurements) pipes it over
 * stdin as a plain JSON array, parsed here with the SAME tolerant row
 * parser (model_catalog.ts's parseModelCatalog) a stored catalog is always
 * read with elsewhere in this plugin -- a malformed row costs only that
 * row, never the whole catalog, exactly like every other reader of it.
 *
 * Usage: node read-model-measurements.mjs < catalog.json
 * Always prints exactly one JSON line to stdout: `{ok: true, summary}` or
 * `{ok: false, reason, detail}`. Never console.log/console.error -- any
 * stray output on stdout would corrupt the parent's JSON.parse of it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'
import { parseModelCatalog } from '../../src/core/model_catalog.ts'
import { MODEL_MEASUREMENT_FILE, parseModelRecord, summarizeModelMeasurements } from '../../src/core/model_measurement.ts'

const CACHE_DIR = resolveCacheDir(normalizePlatform(process.platform), {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
})
const LOG_PATH = join(CACHE_DIR, MODEL_MEASUREMENT_FILE)

async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reads the log a line at a time, tolerantly: a blank line or one that
 * fails parseModelRecord's own shape checks (src/core/model_measurement.ts)
 * is skipped, never thrown on -- same discipline as read-measurements.mjs's
 * own readJsonl. A missing file (nothing has ever been recorded) reads as
 * no records at all, not an error.
 */
async function readRecords () {
  let text
  try {
    text = await readFile(LOG_PATH, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    const record = parseModelRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}

async function main () {
  let result
  try {
    const raw = (await readStdin()).trim()
    const parsedCatalog = raw.length > 0 ? JSON.parse(raw) : []
    const catalog = parseModelCatalog(parsedCatalog)
    const records = await readRecords()
    const summary = summarizeModelMeasurements(records, catalog)
    result = { ok: true, summary }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
