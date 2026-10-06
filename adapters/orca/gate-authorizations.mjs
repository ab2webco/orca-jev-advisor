#!/usr/bin/env node
/**
 * gate-authorizations.mjs -- sidecar that lists and forgets the gate's
 * remembered delivery authorizations (0.6.28 T4).
 *
 * adapters/claude/gate-bash.ts remembers, per repository, the delivery
 * classes the agent confirmed after an advice (src/core/gate_authorizations.ts),
 * in <cacheDir>/gate-authorizations.json. The model cannot write that file
 * (it is one of the gate's own files), so a person forgets an authorization
 * from the config panel, through the worker, through this script -- the
 * worker's own sandbox cannot write the cache dir, so main.mjs spawns this
 * with exactly that grant.
 *
 * Usage: node gate-authorizations.mjs <read|forget>
 *   read    answers `{ ok: true, value: { repos } }`, the live rows of
 *           authorizationRows. A missing or corrupt store lists nothing.
 *   forget  reads `{ repo, cls }` from stdin (`cls` null: every class of
 *           that repository), forgets it through forgetAuthorization, writes
 *           the store atomically (temp file + rename) and answers the rows
 *           left. A malformed request answers `invalid-request` and writes
 *           nothing.
 *
 * Always prints exactly one JSON line to stdout and nothing else.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'
import { AUTHORIZATIONS_FILE, authorizationRows, forgetAuthorization, isDeliveryClass, parseAuthorizations } from '../../src/core/gate_authorizations.ts'
import { guardedMkdir as mkdir, guardedRename as rename, guardedWriteFile as writeFile } from '../../src/core/guarded_fs.ts'

async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** The store, or the empty one when the file is missing or unreadable as JSON. */
async function readStore (path) {
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    raw = null
  }
  return parseAuthorizations(raw)
}

async function writeAtomic (path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, path)
}

/** `{ repo, cls }` from the worker, or null when it is not one. */
function parseForgetRequest (text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (typeof value.repo !== 'string' || value.repo.length === 0) return null
  if (value.cls === null || value.cls === undefined) return { repo: value.repo, cls: undefined }
  return typeof value.cls === 'string' && isDeliveryClass(value.cls) ? { repo: value.repo, cls: value.cls } : null
}

async function main () {
  const mode = process.argv[2]
  let result
  try {
    const path = join(resolveCacheDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgCacheHome: process.env.XDG_CACHE_HOME }), AUTHORIZATIONS_FILE)
    if (mode === 'read') {
      result = { ok: true, value: { repos: authorizationRows(await readStore(path), Date.now()) } }
    } else if (mode === 'forget') {
      const request = parseForgetRequest(await readStdin())
      if (request === null) {
        result = { ok: false, reason: 'invalid-request', detail: 'expected { repo, cls } with a known class or null.' }
      } else {
        const next = forgetAuthorization(await readStore(path), request.repo, request.cls)
        await writeAtomic(path, next)
        result = { ok: true, value: { repos: authorizationRows(next, Date.now()) } }
      }
    } else {
      result = { ok: false, reason: 'unknown-mode', detail: `unrecognized mode: ${String(mode).slice(0, 60)}` }
    }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
