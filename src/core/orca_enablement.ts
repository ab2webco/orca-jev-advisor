// Whether Orca still has this plugin switched on.
//
// The command gate is a Claude Code hook: an entry in settings.json pointing
// at a file. Nothing about it is tied to Orca, so turning the plugin off in
// Orca's plugin list did exactly nothing -- the gate kept judging every
// command, and kept interrupting, with the plugin visibly disabled. It would
// have gone on doing that with Orca closed entirely.
//
// Orca already records the answer. `settings.disabledPlugins` in the active
// profile's data file is what its own activation policy reads, so the gate
// consults the same source of truth rather than inventing a signal. A
// teardown hook could not have done this job: the plugin worker is lazy and
// its teardown fires whenever the worker is reaped for idleness, so "torn
// down" means nothing about whether the user switched anything off.
//
// Pure on purpose, like the rest of src/core: reading files belongs to the
// caller, which also owns the cache that keeps this off the hot path.

import { isArrayOf, isRecord, isString } from "../guards.ts";
import type { SupportedPlatform } from "./paths.ts";
import { joinPath } from "./paths.ts";

/**
 * This plugin's id as Orca knows it: `<publisher>.<id>` from orca-plugin.json.
 *
 * Kept as a constant rather than read from the manifest because the gate runs
 * outside Orca with no reliable path back to it, and a test asserts the two
 * never drift apart.
 */
export const PLUGIN_ID = "ab2web.orca-jev-advisor";

/** The profile whose settings are in force, from Orca's profile index. */
export function activeProfileId(profileIndex: unknown): string | null {
  if (!isRecord(profileIndex)) return null;
  const id = profileIndex["activeProfileId"];
  return isString(id) && id.length > 0 ? id : null;
}

export function profileDataPath(platform: SupportedPlatform, orcaUserDataDir: string, profileId: string): string {
  return joinPath(platform, orcaUserDataDir, "profiles", profileId, "orca-data.json");
}

/**
 * True when Orca lists this plugin as disabled.
 *
 * Everything unreadable answers false, which keeps the gate running. That is
 * the deliberate direction: a plugin that silently stops protecting because a
 * file moved is worse than one that keeps asking after being switched off,
 * and the second failure is at least visible to the person it annoys.
 */
export function isPluginDisabled(orcaData: unknown, pluginId: string = PLUGIN_ID): boolean {
  if (!isRecord(orcaData)) return false;
  const settings = orcaData["settings"];
  if (!isRecord(settings)) return false;
  const disabled = settings["disabledPlugins"];
  if (!isArrayOf(disabled, isString)) return false;
  return disabled.includes(pluginId);
}
