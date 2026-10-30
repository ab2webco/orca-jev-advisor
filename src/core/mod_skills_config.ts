// The pure half of mod-skills' `active`/`toolsMode` switches (`toolsMode`
// replaced the `activeTools` boolean, which is still read: see
// parseModSkillsConfig and odd/tasks/tool-selection-off.md).
//
// See odd/tasks/panel-worker-wakeup.md, T10: adapters/claude/mod-skills's
// two switches read `options.active`/`options.activeTools`, populated only
// from a manifest's `userConfig` (adapters/claude/mod-skills/claude-code.d.ts).
// Nothing in this repo declares `userConfig` -- the mod installs as a plain
// skill directory with no plugin manifest at all -- so `options` is always
// `{}` and both switches were permanently unreachable.
//
// This file replaces "unreachable" with the same plain-file mirror this
// plugin already uses for its locale choice (src/core/i18n.ts's
// parseLocaleFile / DEFAULT_LOCALE): the Orca worker writes
// `<configDir>/mod-skills-config.json` (adapters/orca/write-secret-mirror.mjs,
// through the panel's request/poll channel in adapters/orca/main.mjs), and
// the hooks sandbox reads it directly (adapters/claude/mod-skills/hooks/
// runtime.ts's resolveModSkillsSwitches) -- no node:fs/node:path import
// needed here, this module only ever sees a string already read by someone
// else.
//
// Reading is best-effort everywhere it is used: a missing file, malformed
// JSON, or a wrong-typed field all fall back to off, exactly like every
// other best-effort read in this plugin (parseLocaleFile, parseEnvFile).
// `options` (Claude Code's own `userConfig` channel) still takes precedence
// over this file whenever it actually carries a boolean -- see
// hooks/index.ts's resolveActiveMode/resolveActiveToolMode -- so nothing
// regresses if `options` ever starts being populated for real.

import type { FeatureMode } from "./feature_modules.ts";

/**
 * Tool selection's own three-way mode (odd/tasks/tool-selection-off.md, T1),
 * the same `off | measure | active` scale every other per-feature mode uses
 * (feature_modules.ts's FeatureMode). `off` is the only one with no Jev call:
 * `measure` asks Jev and records, `active` also injects the advice.
 */
export type ToolsMode = FeatureMode;

export const TOOLS_MODES: readonly ToolsMode[] = ["off", "measure", "active"];

export interface ModSkillsSwitches {
  readonly active: boolean;
  readonly toolsMode: ToolsMode;
}

// Skills stay off (measurement) by default: turning that switch on would
// mean a threshold nobody measured yet (see the feature document's T10 entry
// and its consequenceCeiling precedent, T7). Tools default to `off`
// outright: a week of measurement (odd/qa/native-runtime-verification.md,
// 2026-10-28) found the advised tool matched the first tool used 27.2% of
// the time, against 69.2% for always guessing Bash.
export const DEFAULT_MOD_SKILLS_SWITCHES: ModSkillsSwitches = { active: false, toolsMode: "off" };

/** One of the three tool modes, or null for anything else (a wrong type, an unknown word). */
export function parseToolsMode(value: unknown): ToolsMode | null {
  return TOOLS_MODES.find((mode) => mode === value) ?? null;
}

/**
 * The legacy boolean switch (`activeTools`, in the file or in Claude Code's
 * `options`) on the three-way scale: `true` is `active` and `false` is
 * `measure`, so an explicit past choice is kept. Anything but a boolean is
 * null: no choice was made.
 */
export function toolsModeFromSwitch(value: unknown): ToolsMode | null {
  return typeof value === "boolean" ? (value ? "active" : "measure") : null;
}

/**
 * Parses `<configDir>/mod-skills-config.json`'s content. Never throws: a
 * missing file (pass `""`), malformed JSON, a non-object payload, or a
 * field of the wrong type all fall back to `DEFAULT_MOD_SKILLS_SWITCHES`
 * for the affected field -- one field being wrong-typed never invalidates
 * the other. `toolsMode` is read first; when it is absent or not one of the
 * three modes, a legacy `activeTools` boolean decides, and with neither the
 * mode is `off`.
 */
export function parseModSkillsConfig(content: string): ModSkillsSwitches {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return DEFAULT_MOD_SKILLS_SWITCHES;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_MOD_SKILLS_SWITCHES;

  const record = parsed as Record<string, unknown>;
  const active = typeof record.active === "boolean" ? record.active : false;
  const toolsMode = parseToolsMode(record.toolsMode) ?? toolsModeFromSwitch(record.activeTools) ?? DEFAULT_MOD_SKILLS_SWITCHES.toolsMode;
  return { active, toolsMode };
}
