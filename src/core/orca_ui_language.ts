// odd/tasks/release-0.5.1.md JEVADV-10 -- reading Orca's OWN language
// setting, not this plugin's `<html lang>`-derived guess.
//
// Orca stores its UI language in `settings.uiLanguage` inside
// `<userData>/orca-data.json` (see src/core/orca_accounts.ts for how
// `<userData>` itself is resolved). That value is one of:
//
//   - a concrete `"es"`/`"en"` (or a regional tag like `"es-CO"`) -- the
//     person explicitly chose a language inside Orca's own settings, and
//     that choice is authoritative for this plugin's own prompts too.
//   - `"system"` -- Orca follows the OS/Electron app locale instead of a
//     fixed choice. There is nothing concrete to read here; the caller
//     defers to whatever the panel's own `navigator.language` reports
//     (Electron's `app.getLocale()` and a Chromium renderer's
//     `navigator.language` are the same underlying value).
//   - missing entirely, or the file itself missing/unreadable/malformed --
//     same as `"system"`: defer, never invent a concrete answer.
//
// Pure: takes the raw file contents as a string, or `null` to mean "the
// file does not exist" (ENOENT) -- the only I/O this needs is a plain file
// read, done by adapters/orca/write-secret-mirror.mjs's
// orca-ui-language-read mode (main.mjs's own permission sandbox cannot read
// outside its plugin root, so that mode runs as a sidecar with a narrow
// `--allow-fs-read` grant for exactly this one file). Never throws: a
// missing file, a locked/unreadable one, and malformed JSON all defer the
// same way a genuinely absent setting does -- this function has no way to
// tell "I could not read this" apart from "this file has nothing to say",
// and both must fail toward the same safe default: never force `"en"`.

import { isRecord } from "../guards.ts";

/**
 * `raw` is the exact file contents read from disk, or `null` when the file
 * does not exist. Returns `"es"`/`"en"` only for a concrete, recognized
 * setting; `null` for everything else (`"system"`, missing key, missing
 * file, or anything that fails to parse as the expected shape) -- the
 * caller's cue to defer to another source rather than a forced default.
 */
export function parseOrcaUiLanguage(raw: string | null): "es" | "en" | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const settings = parsed.settings;
  if (!isRecord(settings)) return null;
  const uiLanguage = settings.uiLanguage;
  if (typeof uiLanguage !== "string") return null;

  const normalized = uiLanguage.trim().toLowerCase();
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}
