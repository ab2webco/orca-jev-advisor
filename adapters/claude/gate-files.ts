/**
 * The file tools' guard's decision (0.6.17 T2, JEVADV-90), loaded by
 * gate-files.mjs only for a path that may be one of the gate's own files.
 * The Bash gate refuses a command that writes one of the files the gate or
 * the model router decides from (src/core/gate_own_paths.ts), but it is
 * registered on Bash and Agent only, so Edit/Write/MultiEdit/NotebookEdit
 * could still rewrite them; this refuses exactly those paths.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gateOwnFileAt, gateOwnFiles } from '../../src/core/gate_own_paths.ts'
import type { Locale } from '../../src/core/i18n.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'
import { orcaUserDataPath, pluginDisabledInOrca } from './orca-plugin-enablement.ts'

const PLATFORM = normalizePlatform(process.platform)
const HOME_PATHS = {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
}

/** `path` with its symlinks resolved, as far as it exists. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

/** The refusal, in English for the model and in the person's locale for the line they see. */
async function refusal(file: string, configDir: string): Promise<string> {
  const { DEFAULT_LOCALE, parseLocaleFile, translate } = await import('../../src/core/i18n.ts')
  const { GATE_CATALOG } = await import('../../src/core/i18n_gate.ts')
  let locale: Locale = DEFAULT_LOCALE
  try {
    locale = parseLocaleFile(readFileSync(join(configDir, 'locale'), 'utf8'))
  } catch {
    // No locale mirror: the default.
  }
  const home = HOME_PATHS.home
  const shown = file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
  const why = translate(GATE_CATALOG, 'en', 'rule.ownConfig', { file: shown })
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: translate(GATE_CATALOG, 'en', 'ownFileEditDeny', { why }),
    },
    systemMessage: translate(GATE_CATALOG, locale, 'blockedLine', { segment: shown, rule: translate(GATE_CATALOG, locale, 'rule.ownConfig', { file: shown }) }),
  })
}

/** The hook's output for a write to `path` (absolute): a refusal for one of the gate's own files, null for any other or with the plugin switched off in Orca. */
export async function ownFileRefusal(path: string): Promise<string | null> {
  const configDir = resolveConfigDir(PLATFORM, HOME_PATHS)
  const cacheDir = resolveCacheDir(PLATFORM, HOME_PATHS)
  const own = gateOwnFiles({ configDir, cacheDir, orcaUserDataDir: orcaUserDataPath(PLATFORM, HOME_PATHS.home) }, canonicalPath)
  const file = gateOwnFileAt(path, own, canonicalPath)
  if (file === null) return null
  if (pluginDisabledInOrca(PLATFORM, HOME_PATHS.home, join(cacheDir, 'gate-enablement.json'))) return null
  return refusal(file, configDir)
}
