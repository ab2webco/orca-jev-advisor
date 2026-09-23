/**
 * mod-skills — the glue between Claude Code's `$` and this mod's pure
 * `src/core` logic. Nothing here decides anything; it only adapts.
 *
 * Kept separate from index.ts so the hook bodies read as orchestration,
 * not plumbing.
 */
import type { EngineInterface, PluginOptions } from 'claude-code'
import type { JevFetch, JevFetchResponse, JevSleep } from '../../../../src/core/jev.ts'
import { DEFAULT_LOCALE, parseLocaleFile } from '../../../../src/core/i18n.ts'
import type { Locale } from '../../../../src/core/i18n.ts'
import type { ProcessRun, RunResult } from '../../../../src/core/orca_context.ts'
import type { SkillFs, SkillFsEntry } from '../../../../src/core/skill_inventory.ts'
import type { ToolLister } from '../../../../src/core/tool_inventory.ts'

// ---------------------------------------------------------------------------
// Home/config/cache directories, without node:os or node:path -- neither
// exists in a hooks module's sandbox ("no DOM, no Node"), so this cannot
// import src/core/paths.ts (it uses node:path) the way the Node-based
// adapters do. `HOME` does not exist on Windows (`USERPROFILE` does); a
// forward slash works as a path separator on Windows too, so no
// platform-specific join is needed for the plain string concatenation
// below -- only the `.config`/`.cache` vs `%APPDATA%`/`%LOCALAPPDATA%`/XDG
// directory convention actually differs.
//
// `computeHomePaths` is the pure half (env in, paths out, no `$`), kept
// separate from `resolveHomePaths` so it is unit-testable the same way
// src/core/paths.ts is -- see ../runtime.test.ts, which drives it with
// win32 and linux (XDG_* both set and unset) shapes directly, something
// impossible while every branch here read `$.env.get(...)` itself.
// ---------------------------------------------------------------------------

interface ModHomePaths {
  readonly home: string;
  readonly configDir: string;
  readonly cacheDir: string;
}

export interface ModPathEnv {
  readonly home?: string;
  readonly userProfile?: string;
  readonly appData?: string;
  readonly localAppData?: string;
  /**
   * `$XDG_CONFIG_HOME` / `$XDG_CACHE_HOME`, when set. This environment has
   * no direct platform noun (see the `isWindows` heuristic below), so
   * unlike src/core/paths.ts -- which honors these only on `linux`, never
   * `darwin` -- this honors them on every non-Windows environment reaching
   * this branch. The alternative was silently ignoring them everywhere
   * this sandbox runs, which is the exact Linux gap this project is
   * closing; a macOS developer who has not set XDG_CONFIG_HOME (the common
   * case) sees no change at all.
   */
  readonly xdgConfigHome?: string;
  readonly xdgCacheHome?: string;
}

export function computeHomePaths(env: ModPathEnv): ModHomePaths | null {
  const home = env.home && env.home.length > 0 ? env.home : env.userProfile && env.userProfile.length > 0 ? env.userProfile : null
  if (!home) return null

  // `%APPDATA%` is a Windows-only convention; its presence (or HOME's
  // absence with USERPROFILE set) is the signal, since this environment
  // exposes no direct platform noun.
  const isWindows = (env.appData !== undefined && env.appData.length > 0) || (!(env.home && env.home.length > 0) && env.userProfile !== undefined && env.userProfile.length > 0)

  if (isWindows) {
    const configBase = env.appData && env.appData.length > 0 ? env.appData : `${home}/AppData/Roaming`
    const cacheBase = env.localAppData && env.localAppData.length > 0 ? env.localAppData : `${home}/AppData/Local`
    return { home, configDir: `${configBase}/orca-supervisor`, cacheDir: `${cacheBase}/orca-supervisor/Cache` }
  }
  // XDG on Linux only, matching src/core/paths.ts. The two must agree or the
  // gate and this mod look for the API key in different places and one of
  // them silently finds nothing -- which is exactly what happened on a macOS
  // machine with XDG_CONFIG_HOME set, because this function honoured it and
  // paths.ts deliberately does not.
  //
  // This sandbox exposes no platform noun, so the home directory's own shape
  // is the signal: macOS puts users under /Users, Linux under /home. It is a
  // convention rather than a guarantee, and it errs toward macOS -- an
  // unrecognised layout ignores XDG, which is the behaviour that matches
  // paths.ts everywhere except Linux.
  const isLinux = home.startsWith('/home/') || home === '/root'
  const configBase = isLinux && env.xdgConfigHome && env.xdgConfigHome.length > 0 ? env.xdgConfigHome : `${home}/.config`
  const cacheBase = isLinux && env.xdgCacheHome && env.xdgCacheHome.length > 0 ? env.xdgCacheHome : `${home}/.cache`
  return { home, configDir: `${configBase}/orca-supervisor`, cacheDir: `${cacheBase}/orca-supervisor` }
}

async function resolveHomePaths($: EngineInterface): Promise<ModHomePaths | null> {
  const [home, userProfile, appData, localAppData, xdgConfigHome, xdgCacheHome] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('APPDATA'),
    $.env.get('LOCALAPPDATA'),
    $.env.get('XDG_CONFIG_HOME'),
    $.env.get('XDG_CACHE_HOME'),
  ])
  return computeHomePaths({ home, userProfile, appData, localAppData, xdgConfigHome, xdgCacheHome })
}

/** The home directory alone, for building a `~/.claude/...` path -- Claude Code's own convention, unrelated to this plugin's `.config`/`.cache` choice. */
export async function resolveHomeDir($: EngineInterface): Promise<string | null> {
  const paths = await resolveHomePaths($)
  return paths?.home ?? null
}

// ---------------------------------------------------------------------------
// Locale: the config panel's own choice, mirrored as plain text next to the
// API key's fallback file (see src/core/i18n.ts for why this is not Orca's
// own `contributes.languagePacks`). A mod's `$.fs` reads any absolute path
// -- unlike the Orca worker, a hooks module carries no permission sandbox
// of its own here -- so this reads the file directly, no sidecar needed.
// ---------------------------------------------------------------------------

export async function resolveLocale($: EngineInterface): Promise<Locale> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return DEFAULT_LOCALE
    const path = `${paths.configDir}/locale`
    if (!(await $.fs.exists(path))) return DEFAULT_LOCALE
    return parseLocaleFile(await $.fs.read(path))
  } catch {
    return DEFAULT_LOCALE
  }
}

// ---------------------------------------------------------------------------
// Jev transport: $.http.fetch and $.clock.sleep, adapted to jev.ts's shapes
// ---------------------------------------------------------------------------
//
// $.http.fetch's HttpResponse.text is already a resolved string (not a
// method) and HttpInit takes no `signal` -- so cancellation is best-effort
// here: callJev still races the request against its own budget through
// the injected sleep, which is what actually bounds the wait regardless of
// whether the underlying transport can be aborted.

export function makeJevFetch($: EngineInterface): JevFetch {
  return async (url, init) => {
    const response = await $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body })
    const result: JevFetchResponse = { ok: response.ok, status: response.status, text: () => Promise.resolve(response.text) }
    return result
  }
}

export function makeJevSleep($: EngineInterface): JevSleep {
  return (ms) => $.clock.sleep(ms)
}

// ---------------------------------------------------------------------------
// Skill filesystem: $.fs, adapted to SkillFs
// ---------------------------------------------------------------------------

export function makeSkillFs($: EngineInterface): SkillFs {
  return {
    exists: (path) => $.fs.exists(path),
    list: async (path): Promise<readonly SkillFsEntry[]> => await $.fs.list(path),
    read: (path) => $.fs.read(path),
  }
}

// ---------------------------------------------------------------------------
// Tool inventory: $.tool.list, adapted to ToolLister
// ---------------------------------------------------------------------------

export function makeToolLister($: EngineInterface): ToolLister {
  return () => $.tool.list()
}

// ---------------------------------------------------------------------------
// Orca context: $.process.run, adapted to ProcessRun, with its own short
// budget so a hung or missing `orca` binary can never hold up a prompt --
// resolveOrcaContext's own try/catch turns this timeout into the cwd-only
// fallback, same as a missing binary would.
// ---------------------------------------------------------------------------

const ORCA_PROCESS_BUDGET_MS = 300

export function makeProcessRun($: EngineInterface): ProcessRun {
  return async (argv): Promise<RunResult> => {
    const result = await Promise.race([
      $.process.run(argv),
      $.clock.sleep(ORCA_PROCESS_BUDGET_MS).then((): never => {
        throw new Error(`${argv[0]} didn't respond within ${ORCA_PROCESS_BUDGET_MS}ms`)
      }),
    ])
    return { exitCode: result.exitCode, stdout: result.stdout }
  }
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------
//
// src/core/secrets.ts cannot be imported here: it reads node:fs/promises,
// node:os and node:path, none of which exist in a hooks module's
// environment ("no DOM, no Node"). Its precedence is reproduced instead,
// narrowed to what this environment actually has: the plugin's own option
// (there is no `$.secrets` noun on this `$` to prefer over it), then
// $.env.get (the process environment gate-bash.ts and the CLI tools also
// read TYPESAFE_API_KEY from), then the same dev-only fallback file, read
// through $.fs instead of node:fs.

const ENV_VAR_NAME = 'TYPESAFE_API_KEY'

function stripMatchingQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value
}

function parseEnvFile(content: string): string | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    if (key !== ENV_VAR_NAME) continue
    const value = stripMatchingQuotes(line.slice(separatorIndex + 1).trim())
    return value.length > 0 ? value : null
  }
  return null
}

export async function resolveApiKey($: EngineInterface, options: PluginOptions): Promise<string | null> {
  const fromOptions = options.typesafeApiKey
  if (typeof fromOptions === 'string' && fromOptions.trim().length > 0) return fromOptions.trim()

  const fromEnv = await $.env.get(ENV_VAR_NAME)
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()

  const paths = await resolveHomePaths($)
  if (!paths) return null
  const path = `${paths.configDir}/env`
  try {
    if (!(await $.fs.exists(path))) return null
    return parseEnvFile(await $.fs.read(path))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Measurement logs: append-only JSONL under the user's cache dir
// ---------------------------------------------------------------------------

async function appendToFile($: EngineInterface, path: string, line: string): Promise<void> {
  const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, existing + line)
}

export async function appendMeasurement($: EngineInterface, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/mod-skills-measurements.jsonl`, line)
  } catch {
    // Measurement is best-effort and must never block or fail a prompt.
  }
}

/** Same shape as `appendMeasurement`, in its own file, for tool-selection records (src/core/tool_measurement.ts). */
export async function appendToolMeasurement($: EngineInterface, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/mod-tools-measurements.jsonl`, line)
  } catch {
    // Measurement is best-effort and must never block or fail a prompt.
  }
}
