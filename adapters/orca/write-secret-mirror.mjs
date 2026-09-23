#!/usr/bin/env node
/**
 * write-secret-mirror.mjs — sidecar for orca-jev-advisor's secret mirror.
 *
 * The plugin worker keeps the TypeSafe key in Orca's `secrets` store, but
 * the CLI tools and adapters/claude/gate-bash.ts (plain Node processes
 * outside the plugin worker) cannot read `secrets` -- it is
 * `secrets.json.enc`, encrypted with Electron's `safeStorage`, and they
 * are not Electron. Those already read `~/.config/orca-supervisor/env`
 * (src/core/secrets.ts) as their own fallback, so the worker mirrors the
 * secret there whenever it changes.
 *
 * It cannot do that write itself: the worker's own permission sandbox
 * only allows reading its plugin root (measured, not assumed -- see
 * main.mjs's mirrorSecretToEnvFile). This script runs as a clean child of
 * that worker instead, spawned by main.mjs's `sidecarEnv` (a plain
 * `execFile` env with `NODE_OPTIONS` deleted -- no `/usr/bin/env`, so it
 * works the same way on Windows, unlike the wrapper this project used
 * before), where the sandbox does not apply.
 *
 * Usage: node write-secret-mirror.mjs <save|clear|read>
 *   save   reads the new key from stdin (never argv, never logged), and
 *          atomically (temp file + rename) writes or replaces its
 *          TYPESAFE_API_KEY= line in the mirror file, mode 0600. Other
 *          lines already in the file are kept.
 *   clear  removes the TYPESAFE_API_KEY= line; deletes the file entirely
 *          if nothing else is left in it.
 *   read   reports the mirror's current TYPESAFE_API_KEY value (or null),
 *          for main.mjs's doctor check that it still matches `secrets`.
 *
 * Always prints exactly one JSON line to stdout and nothing else -- no
 * console.error, no stray output that would corrupt the parent's parse.
 * `save` and `clear` answer `{ok:true}` or `{ok:false, reason, detail}`;
 * `read` answers `{ok:true, value}` or the same failure shape. The key
 * itself is never written to stderr, to a log, or to any field but
 * `value` on `read` -- and that leaves this process only over the pipe
 * its own parent already owns.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizePlatform, resolveConfigDir } from '../../src/core/paths.ts'

// `os.homedir()` already resolves HOME vs USERPROFILE correctly per
// platform; resolveConfigDir only decides the `.config` vs `%APPDATA%`
// convention on top of it (see src/core/paths.ts).
const CONFIG_DIR = resolveConfigDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA })
const MIRROR_PATH = join(CONFIG_DIR, 'env')
const ENV_VAR_NAME = 'TYPESAFE_API_KEY'
// The config panel's message-language choice, mirrored the same way as the
// key -- but never sensitive, so it crosses via argv (not stdin) and is
// its own small plain-text file, never mixed into the key's. Read directly
// by adapters/claude/gate-bash.ts and adapters/claude/mod-skills, which
// have no channel into Orca's own `storage` (see src/core/i18n.ts).
const LOCALE_PATH = join(CONFIG_DIR, 'locale')

async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function isKeyLine (line) {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return false
  const separator = trimmed.indexOf('=')
  if (separator === -1) return false
  return trimmed.slice(0, separator).trim() === ENV_VAR_NAME
}

function stripMatchingQuotes (value) {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value
}

/** Same shape src/core/secrets.ts's parseEnvFile reads, for the `read` check to compare against. */
function extractKey (content) {
  for (const line of content.split('\n')) {
    if (!isKeyLine(line)) continue
    const value = stripMatchingQuotes(line.trim().slice(line.trim().indexOf('=') + 1).trim())
    return value.length > 0 ? value : null
  }
  return null
}

async function readExisting () {
  try {
    return await readFile(MIRROR_PATH, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic (content, path = MIRROR_PATH) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    // POSIX mode bits; Windows has no such permission model (it approximates
    // via the read-only attribute instead) -- attempted, never fatal if it
    // cannot apply. statMirror() below reports whatever `fs.stat` actually
    // measures afterward, on every platform, rather than assuming 0600 held.
    await chmod(tempPath, 0o600)
  } catch {
    // Best-effort; the write itself already succeeded.
  }
  await rename(tempPath, path)
}

async function save (key) {
  if (key.length === 0) return { ok: false, reason: 'clave-vacia', detail: 'stdin no traía una clave.' }

  const existing = await readExisting()
  const lines = existing !== null ? existing.split('\n') : []
  let replaced = false
  const next = lines.map((line) => {
    if (!isKeyLine(line)) return line
    replaced = true
    return `${ENV_VAR_NAME}=${key}`
  })
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
    next.push(`${ENV_VAR_NAME}=${key}`)
  }
  await writeAtomic(`${next.join('\n')}\n`)
  return { ok: true }
}

async function clear () {
  const existing = await readExisting()
  if (existing === null) return { ok: true }

  const remaining = existing.split('\n').filter((line) => !isKeyLine(line))
  const hasOtherContent = remaining.some((line) => line.trim().length > 0)
  if (!hasOtherContent) {
    await rm(MIRROR_PATH, { force: true })
    return { ok: true }
  }
  await writeAtomic(`${remaining.join('\n').replace(/\n+$/, '')}\n`)
  return { ok: true }
}

async function read () {
  const existing = await readExisting()
  return { ok: true, value: existing !== null ? extractKey(existing) : null }
}

/** Existence and permissions only -- never the key, not even indirectly
 *  (no line count, no size): what the config panel's disclosure needs and
 *  nothing a screenshot of it could leak. */
async function statMirror () {
  // `platform` lets the panel caption the permission correctly: POSIX mode
  // bits mean something concrete on macOS/Linux; on Windows `fs.stat`'s
  // `mode` is an approximation (there is no POSIX permission model there),
  // so the panel says that plainly instead of implying "0600" holds.
  try {
    const info = await stat(MIRROR_PATH)
    return { ok: true, exists: true, mode: (info.mode & 0o777).toString(8), platform: process.platform, path: MIRROR_PATH }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, mode: null, platform: process.platform, path: MIRROR_PATH }
    throw error
  }
}

async function localeSave (value) {
  const locale = String(value ?? '').trim()
  if (locale !== 'es' && locale !== 'en') return { ok: false, reason: 'locale-invalida', detail: `locale no reconocida: ${locale.slice(0, 20)}` }
  await writeAtomic(`${locale}\n`, LOCALE_PATH)
  return { ok: true }
}

async function localeRead () {
  try {
    const content = (await readFile(LOCALE_PATH, 'utf8')).trim()
    return { ok: true, value: content === 'en' ? 'en' : 'es' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, value: null }
    throw error
  }
}

async function main () {
  const mode = process.argv[2]
  let result
  try {
    if (mode === 'save') {
      result = await save((await readStdin()).trim())
    } else if (mode === 'locale-save') {
      result = await localeSave(process.argv[3])
    } else if (mode === 'locale-read') {
      result = await localeRead()
    } else if (mode === 'clear') {
      result = await clear()
    } else if (mode === 'read') {
      result = await read()
    } else if (mode === 'stat') {
      result = await statMirror()
    } else {
      result = { ok: false, reason: 'modo-desconocido', detail: `modo no reconocido: ${String(mode).slice(0, 60)}` }
    }
  } catch (error) {
    result = { ok: false, reason: 'excepcion', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
