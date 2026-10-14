// ---------------------------------------------------------------------------
// The mod's status line (0.6.2 E8): one "jev" at the start, then one part
// per feature, each saying plainly whether it APPLIED something or only
// MEASURED. A line of "jev · skill: … · jev · sin herramienta · jev ·
// modelo: …" read as static and hid which parts change nothing.
//
// Pure: the hooks module passes the locale and each part's outcome.
// ---------------------------------------------------------------------------

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MOD_SKILLS_CATALOG } from "./i18n_mod_skills.ts";
import { TOOLS_CATALOG } from "./i18n_tools.ts";

/**
 * applied: its advice was injected this turn. measuring: measurement mode,
 * nothing changed. unchanged: active mode, but nothing was injected (no
 * pick, or the pick could not be delivered).
 */
export type PartOutcome = "applied" | "measuring" | "unchanged";

export function composeStatusLine(parts: readonly (string | null)[]): string | null {
  const shown = parts.filter((part): part is string => part !== null && part.length > 0);
  return shown.length === 0 ? null : ["jev", ...shown].join(" · ");
}

/** Null when nothing was picked: a part that changed nothing says nothing (0.11.1), so the parts that did fit a narrow pane. */
export function skillStatusPart(locale: Locale, name: string | null, outcome: PartOutcome): string | null {
  if (name === null) return null;
  const key = outcome === "applied" ? "status.skill.applied" : outcome === "measuring" ? "status.skill.measuring" : "status.skill";
  return translate(MOD_SKILLS_CATALOG, locale, key, { name });
}

/** Null when nothing was picked, as skillStatusPart. */
export function toolStatusPart(locale: Locale, name: string | null, outcome: PartOutcome): string | null {
  if (name === null) return null;
  const key = outcome === "applied" ? "status.tool.applied" : outcome === "measuring" ? "status.tool.measuring" : "status.tool";
  return translate(TOOLS_CATALOG, locale, key, { name });
}
