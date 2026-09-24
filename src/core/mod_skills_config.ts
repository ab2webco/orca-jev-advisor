// The pure half of mod-skills' `active`/`activeTools` switches.
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

export interface ModSkillsSwitches {
  readonly active: boolean;
  readonly activeTools: boolean;
}

// Off by default at every layer: turning either switch on today would mean
// a threshold nobody measured yet (see the feature document's T10 entry and
// its consequenceCeiling precedent, T7) -- a week of measurement-mode data
// has to exist first.
export const DEFAULT_MOD_SKILLS_SWITCHES: ModSkillsSwitches = { active: false, activeTools: false };

/**
 * Parses `<configDir>/mod-skills-config.json`'s content. Never throws: a
 * missing file (pass `""`), malformed JSON, a non-object payload, or a
 * field of the wrong type all fall back to `DEFAULT_MOD_SKILLS_SWITCHES`
 * for the affected field -- one field being wrong-typed never invalidates
 * the other.
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
  const activeTools = typeof record.activeTools === "boolean" ? record.activeTools : false;
  return { active, activeTools };
}
