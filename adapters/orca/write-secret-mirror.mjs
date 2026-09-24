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
 * Usage: node write-secret-mirror.mjs <save|clear|read|catalog-save|policies-save>
 *   save   reads the new key from stdin (never argv, never logged), and
 *          atomically (temp file + rename) writes or replaces its
 *          TYPESAFE_API_KEY= line in the mirror file, mode 0600. Other
 *          lines already in the file are kept.
 *   clear  removes the TYPESAFE_API_KEY= line; deletes the file entirely
 *          if nothing else is left in it.
 *   read   reports the mirror's current TYPESAFE_API_KEY value (or null),
 *          for main.mjs's doctor check that it still matches `secrets`.
 *   catalog-save   reads the destination catalog as JSON from stdin and
 *          atomically writes it, pretty-printed, to catalog.json in the
 *          config dir. Not secret (the config panel already shows it in
 *          the clear), so it gets ordinary file permissions -- no forced
 *          0600 -- for adapters/claude/gate-bash.ts to read directly.
 *   policies-save  same as catalog-save, but for the team policies array,
 *          written to policies.json.
 *   mod-skills-config-save  reads `{active, activeTools}` as JSON from
 *          stdin and atomically writes it, normalized through the same pure
 *          parser adapters/claude/mod-skills reads back with
 *          (src/core/mod_skills_config.ts's parseModSkillsConfig -- a
 *          wrong-typed or missing field is written as `false`, never
 *          passed through raw), to mod-skills-config.json. Not secret.
 *   mod-skills-config-read  reports the mirror's current `{active,
 *          activeTools}` (both `false` when the file has never been
 *          written), for main.mjs's publishModSkillsStatus.
 *   deny-tier-config-save  reads `{denyRmRf, denyDropTable,
 *          denyTerraformDestroy}` as JSON from stdin and atomically writes
 *          it, normalized through the same pure parser adapters/claude/
 *          gate-bash.ts reads back with (src/core/deny_tier_config.ts's
 *          parseDenyTierConfig -- a wrong-typed or missing field is written
 *          as `true`, the fail-CLOSED opposite of mod-skills-config-save's
 *          `false`), to deny-tier-config.json. Not secret.
 *   deny-tier-config-read  reports the mirror's current `{denyRmRf,
 *          denyDropTable, denyTerraformDestroy}` (all `true` when the file
 *          has never been written or fails to parse), for main.mjs's
 *          publishDenyTierStatus.
 *
 * Always prints exactly one JSON line to stdout and nothing else -- no
 * console.error, no stray output that would corrupt the parent's parse.
 * `save`, `clear`, `catalog-save` and `policies-save` answer `{ok:true}`
 * or `{ok:false, reason, detail}`; `read` answers `{ok:true, value}` or
 * the same failure shape. The key itself is never written to stderr, to
 * a log, or to any field but `value` on `read` -- and that leaves this
 * process only over the pipe its own parent already owns.
 */
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizePlatform, resolveConfigDir } from '../../src/core/paths.ts'
import { parseModSkillsConfig } from '../../src/core/mod_skills_config.ts'
import { parseDenyTierConfig } from '../../src/core/deny_tier_config.ts'
// Guarded stand-ins for the mutating fs/promises calls this file makes --
// see guarded_fs.ts's module doc for why every write in this script goes
// through them instead of node:fs/promises's own mkdir/writeFile/rename/rm/chmod.
import {
  guardedChmod as chmod,
  guardedMkdir as mkdir,
  guardedRename as rename,
  guardedRm as rm,
  guardedWriteFile as writeFile
} from '../../src/core/guarded_fs.ts'

// `os.homedir()` already resolves HOME vs USERPROFILE correctly per
// platform; resolveConfigDir only decides the `.config`/`%APPDATA%`/XDG
// convention on top of it (see src/core/paths.ts).
const CONFIG_DIR = resolveConfigDir(normalizePlatform(process.platform), { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA, xdgConfigHome: process.env.XDG_CONFIG_HOME })
const MIRROR_PATH = join(CONFIG_DIR, 'env')
const ENV_VAR_NAME = 'TYPESAFE_API_KEY'
// The config panel's message-language choice, mirrored the same way as the
// key -- but never sensitive, so it crosses via argv (not stdin) and is
// its own small plain-text file, never mixed into the key's. Read directly
// by adapters/claude/gate-bash.ts and adapters/claude/mod-skills, which
// have no channel into Orca's own `storage` (see src/core/i18n.ts).
const LOCALE_PATH = join(CONFIG_DIR, 'locale')
// Destination catalog and team policies -- mirrored the same way as the
// key and the locale, but neither is sensitive: the config panel already
// shows both in the clear, so they get the platform's ordinary file
// permissions (see writeAtomic's `mode` parameter) instead of 0600.
// adapters/claude/gate-bash.ts reads these two files directly.
const CATALOG_PATH = join(CONFIG_DIR, 'catalog.json')
const POLICIES_PATH = join(CONFIG_DIR, 'policies.json')
// mod-skills' `active`/`activeTools` switches -- see
// src/core/mod_skills_config.ts's module note (T10,
// odd/tasks/panel-worker-wakeup.md). Neither is sensitive, so it gets
// ordinary file permissions like the catalog/policies files above, not the
// key's forced 0600.
const MOD_SKILLS_CONFIG_PATH = join(CONFIG_DIR, 'mod-skills-config.json')
// The three deny-tier switches -- see src/core/deny_tier_config.ts's module
// note. Not sensitive, same ordinary file permissions as the switches
// above; the fail-CLOSED default lives in the parser, not in this file's
// permission mode.
const DENY_TIER_CONFIG_PATH = join(CONFIG_DIR, 'deny-tier-config.json')

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

/**
 * Atomic temp-file-plus-rename write, shared by every mirror file this
 * script owns. `mode` defaults to 0600 so the key and locale mirrors are
 * byte-for-byte unchanged from before this function took a third
 * parameter. Passing `null` opts a caller out of the forced mode entirely
 * -- no explicit `mode` on `writeFile`, no follow-up `chmod` -- so the
 * file lands with whatever ordinary permissions the platform default
 * (`fs.writeFile`'s own default, minus umask on POSIX) gives it. Used by
 * catalog-save/policies-save, since neither file is secret.
 *
 * `path` has NO default -- every caller must name its destination
 * explicitly. It used to default to MIRROR_PATH, which is exactly the
 * shape of bug this project can no longer afford: a caller that forgets to
 * pass a path landed silently on the real one instead of failing to
 * typecheck/call. See src/core/write_guard.ts's module doc for why.
 */
async function writeAtomic (content, path, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  const hasMode = typeof mode === 'number'
  await writeFile(tempPath, content, hasMode ? { encoding: 'utf8', mode } : { encoding: 'utf8' })
  if (hasMode) {
    try {
      // POSIX mode bits; Windows has no such permission model (it approximates
      // via the read-only attribute instead) -- attempted, never fatal if it
      // cannot apply. statMirror() below reports whatever `fs.stat` actually
      // measures afterward, on every platform, rather than assuming the mode held.
      await chmod(tempPath, mode)
    } catch {
      // Best-effort; the write itself already succeeded.
    }
  }
  await rename(tempPath, path)
}

async function save (key) {
  if (key.length === 0) return { ok: false, reason: 'empty-key', detail: 'stdin carried no key.' }

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
  await writeAtomic(`${next.join('\n')}\n`, MIRROR_PATH)
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
  await writeAtomic(`${remaining.join('\n').replace(/\n+$/, '')}\n`, MIRROR_PATH)
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
  if (locale !== 'es' && locale !== 'en') return { ok: false, reason: 'invalid-locale', detail: `unrecognized locale: ${locale.slice(0, 20)}` }
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

/** Parses the JSON payload piped over stdin, or reports why it couldn't. */
function parseJsonPayload (raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, reason: 'invalid-json', detail: String(error?.message ?? error).slice(0, 200) }
  }
}

/** Writes the destination catalog JSON, pretty-printed (this mirrors a
 *  promise made to the user that the file is inspectable, not opaque),
 *  with the platform's ordinary permissions -- not secret, so no forced mode. */
async function catalogSave (raw) {
  const parsed = parseJsonPayload(raw)
  if (!parsed.ok) return parsed
  await writeAtomic(`${JSON.stringify(parsed.value, null, 2)}\n`, CATALOG_PATH, null)
  return { ok: true }
}

/** Same as catalogSave, for the team policies array. */
async function policiesSave (raw) {
  const parsed = parseJsonPayload(raw)
  if (!parsed.ok) return parsed
  await writeAtomic(`${JSON.stringify(parsed.value, null, 2)}\n`, POLICIES_PATH, null)
  return { ok: true }
}

/** Normalizes the payload through the same pure parser the hooks sandbox
 *  reads back with, so what lands on disk is never a raw, unvalidated echo
 *  of whatever the panel sent -- a wrong-typed or missing field is written
 *  as `false`, exactly like a malformed file already reads as. */
async function modSkillsConfigSave (raw) {
  const normalized = parseModSkillsConfig(raw)
  await writeAtomic(`${JSON.stringify(normalized, null, 2)}\n`, MOD_SKILLS_CONFIG_PATH, null)
  return { ok: true }
}

/** Reports the mirror's current switches, both `false` when the file has
 *  never been written or is unreadable as JSON -- same best-effort contract
 *  as parseModSkillsConfig itself, never thrown. */
async function modSkillsConfigRead () {
  let content
  try {
    content = await readFile(MOD_SKILLS_CONFIG_PATH, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    content = ''
  }
  return { ok: true, value: parseModSkillsConfig(content) }
}

/** Normalizes the payload through the same pure parser gate-bash.ts reads
 *  back with, so what lands on disk is never a raw, unvalidated echo of
 *  whatever the panel sent -- a wrong-typed or missing field is written as
 *  `true` (still denying), the fail-CLOSED opposite of modSkillsConfigSave's
 *  `false`. */
async function denyTierConfigSave (raw) {
  const normalized = parseDenyTierConfig(raw)
  await writeAtomic(`${JSON.stringify(normalized, null, 2)}\n`, DENY_TIER_CONFIG_PATH, null)
  return { ok: true }
}

/** Reports the mirror's current switches, all three `true` when the file
 *  has never been written or is unreadable as JSON -- same fail-CLOSED
 *  contract as parseDenyTierConfig itself, never thrown. */
async function denyTierConfigRead () {
  let content
  try {
    content = await readFile(DENY_TIER_CONFIG_PATH, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    content = ''
  }
  return { ok: true, value: parseDenyTierConfig(content) }
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
    } else if (mode === 'catalog-save') {
      result = await catalogSave((await readStdin()).trim())
    } else if (mode === 'policies-save') {
      result = await policiesSave((await readStdin()).trim())
    } else if (mode === 'mod-skills-config-save') {
      result = await modSkillsConfigSave((await readStdin()).trim())
    } else if (mode === 'mod-skills-config-read') {
      result = await modSkillsConfigRead()
    } else if (mode === 'deny-tier-config-save') {
      result = await denyTierConfigSave((await readStdin()).trim())
    } else if (mode === 'deny-tier-config-read') {
      result = await denyTierConfigRead()
    } else {
      result = { ok: false, reason: 'unknown-mode', detail: `unrecognized mode: ${String(mode).slice(0, 60)}` }
    }
  } catch (error) {
    result = { ok: false, reason: 'exception', detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(result))
}

await main()
