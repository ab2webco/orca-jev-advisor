/**
 * mod-skills — pure, `$`-free helpers shared by hooks/index.ts.
 *
 * Every function that takes the engine's `$` now lives in index.ts itself
 * (JEVADV-43): the engine only follows `$` into a function declared at the
 * TOP of the same file that receives it, never across an import, so a
 * function taking `$` could never safely live here while index.ts called
 * it with the real `$`. What remains here is exactly the opposite shape --
 * plain data in, plain data out, nothing that ever sees `$` -- which is
 * also why this file needs no `claude-code` import at all any more.
 *
 * Kept separate from index.ts purely for readability: these are the small
 * pieces index.ts's own `$`-taking functions lean on (path arithmetic,
 * quote-stripping, the `.env`-file line parser), not orchestration.
 */

// ---------------------------------------------------------------------------
// Home/config/cache directories, without node:os or node:path -- neither
// exists in a hooks module's sandbox ("no DOM, no Node"). `HOME` does not
// exist on Windows (`USERPROFILE` does); a forward slash works as a path
// separator on Windows too, so no platform-specific join is needed for the
// plain string concatenation below -- only the `.config`/`.cache` vs
// `%APPDATA%`/`%LOCALAPPDATA%`/XDG directory convention actually differs.
//
// `computeHomePaths` is the pure half (env in, paths out, no `$`), kept
// unit-testable the same way src/core/paths.ts is -- see ../runtime.test.ts,
// which drives it with win32 and linux (XDG_* both set and unset) shapes
// directly.
// ---------------------------------------------------------------------------

export interface ModHomePaths {
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

// ---------------------------------------------------------------------------
// API key env-file fallback parsing -- pure text in, value out. index.ts's
// own resolveApiKey reads `<configDir>/env` through `$.fs` and hands this
// module the resulting text; nothing here ever touches `$`.
// ---------------------------------------------------------------------------

/** The one key this dev-only fallback file ever looks for. Not `$`-reaching, so this stays a plain constant here rather than moving to index.ts with everything that calls `$.env.get` directly. */
const ENV_VAR_NAME = 'TYPESAFE_API_KEY'

function stripMatchingQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value
}

// ---------------------------------------------------------------------------
// User skills directory -- Claude Code's own user skills folder for a
// session is `$CLAUDE_CONFIG_DIR/skills` when that variable is set, not
// unconditionally `<home>/.claude/skills`. Every Orca-managed account sets
// CLAUDE_CONFIG_DIR (`<userData>/claude-accounts/<uuid>/auth`, see
// src/core/orca_accounts.ts), so the two folders only happen to coincide on
// a machine with a single, unmanaged Claude Code account -- reading
// `<home>/.claude/skills` unconditionally would list the WRONG account's
// skills for anyone else. Pure: env values in, path out, no `$`; index.ts's
// own inventory-cache branch calls this with `$.env.get('CLAUDE_CONFIG_DIR')`
// and resolveHomeDir($)'s result.
// ---------------------------------------------------------------------------

export interface UserSkillsDirEnv {
  readonly claudeConfigDir?: string | undefined;
  readonly home?: string | null;
}

export function resolveUserSkillsDir(env: UserSkillsDirEnv): string | null {
  if (env.claudeConfigDir && env.claudeConfigDir.length > 0) return `${env.claudeConfigDir}/skills`
  if (env.home && env.home.length > 0) return `${env.home}/.claude/skills`
  return null
}

export function parseEnvFile(content: string): string | null {
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
