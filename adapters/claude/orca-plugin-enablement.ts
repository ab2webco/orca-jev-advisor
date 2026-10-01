/**
 * Whether Orca has this plugin switched off, shared by the Bash gate
 * (gate-bash.ts) and the file tools' guard (gate-files.ts).
 *
 * The gate is a Claude Code hook, so nothing about it stopped when the plugin
 * was disabled in Orca: it kept judging every command, and kept interrupting,
 * with the plugin visibly off. It consults Orca's own `disabledPlugins` now.
 *
 * That file holds the whole profile and runs to megabytes, so parsing it on
 * every command would cost more than the judgement does. The answer is cached
 * against the file's size and mtime -- a stat, measured at a fifth of a
 * millisecond -- and only re-read when Orca has actually written to it.
 *
 * Every failure answers false and leaves the gate running. A plugin that
 * silently stops protecting because a file moved is worse than one that keeps
 * asking after being switched off: the second at least announces itself to
 * the person it annoys.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCA_USER_DATA_ENV, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { activeProfileId, isPluginDisabled, profileDataPath } from '../../src/core/orca_enablement.ts'
import type { SupportedPlatform } from '../../src/core/paths.ts'

/** Orca's user data directory for this HOME, as Orca itself resolves it. */
export function orcaUserDataPath(platform: SupportedPlatform, home: string): string {
  return resolveOrcaUserDataDir(platform, {
    home,
    appDataDir: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    orcaUserDataPath: process.env[ORCA_USER_DATA_ENV],
  }).path
}

export function pluginDisabledInOrca(platform: SupportedPlatform, home: string, enablementCachePath: string): boolean {
  try {
    const userData = orcaUserDataPath(platform, home)
    const profileId = activeProfileId(JSON.parse(readFileSync(join(userData, 'orca-profile-index.json'), 'utf8')))
    if (profileId === null) return false
    const dataPath = profileDataPath(platform, userData, profileId)
    const stat = statSync(dataPath)
    const stamp = `${stat.size}:${stat.mtimeMs}`

    try {
      const cached: unknown = JSON.parse(readFileSync(enablementCachePath, 'utf8'))
      if (typeof cached === 'object' && cached !== null) {
        const record = cached as Record<string, unknown>
        if (record['stamp'] === stamp && typeof record['disabled'] === 'boolean') return record['disabled']
      }
    } catch {
      // No usable cache yet; fall through and read the file once.
    }

    const disabled = isPluginDisabled(JSON.parse(readFileSync(dataPath, 'utf8')))
    try {
      mkdirSync(dirname(enablementCachePath), { recursive: true })
      writeFileSync(enablementCachePath, JSON.stringify({ stamp, disabled }))
    } catch {
      // A cache that cannot be written only costs the next command a re-read.
    }
    return disabled
  } catch {
    return false
  }
}
