// Minimal i18n: a locale type, a lookup-by-key-with-interpolation helper,
// and where the resolved locale lives on disk.
//
// Verified before building this (not assumed): Orca's own
// `contributes.languagePacks` (src/shared/plugins/plugin-content-pack-
// contributions.ts, PluginLanguagePackRegistry, I18nProvider.tsx in
// orca-oss) lets a plugin ship a whole ALTERNATE UI LOCALE for Orca
// itself -- it becomes a selectable value of Orca's own `uiLanguage`
// setting, and i18next only loads it once the user picks it as their
// system-wide UI language. It is not a per-plugin facility that follows
// whatever language the user already has Orca set to: nothing in the
// worker's host methods (`settings.get` is scoped to THIS plugin's own
// config, never the app's global settings) or in the panel shell
// (plugin-panel-shell.ts injects no `lang`/locale token) tells a plugin
// what Orca's current UI language is. Using `languagePacks` here would
// mean asking the user to switch their WHOLE Orca interface to "Jev
// Advisor (Spanish)" just to read one plugin's panel -- not what either
// this plugin or the user wants.
//
// So this plugin carries its own small, explicit locale instead: chosen
// once from the config panel (`localeRequest`/`localeStatus`, same
// request/status pattern as the secret and the Claude integration), kept
// in the plugin's own `storage`, and mirrored as plain text to
// `~/.config/orca-supervisor/locale` for the two consumers that run
// OUTSIDE Orca and cannot reach `storage` at all: adapters/claude/
// gate-bash.ts and adapters/claude/mod-skills. Neither is sensitive
// (`"es"` or `"en"`), so unlike the API key it never needs to cross only
// over stdin -- reading and writing it as a plain file is enough.

export type Locale = "es" | "en";

export const DEFAULT_LOCALE: Locale = "es";

export function isLocale(value: unknown): value is Locale {
  return value === "es" || value === "en";
}

/** Parses the plain-text contents of the locale file. Anything not exactly "es" or "en" reads as the default. */
export function parseLocaleFile(content: string): Locale {
  const trimmed = content.trim();
  return isLocale(trimmed) ? trimmed : DEFAULT_LOCALE;
}

export type Catalog<Key extends string> = Record<Locale, Record<Key, string>>;

/**
 * Looks up `key` in `locale`'s half of the catalog, falling back to
 * `DEFAULT_LOCALE` if that specific entry is somehow missing (it never is,
 * for a catalog written with both locales' keys kept in sync by
 * construction -- this is a last-resort guard, not a normal path).
 * `{{name}}` placeholders in the template are replaced from `params`; a
 * placeholder with no matching param is left as the empty string rather
 * than throwing, since a rendering gap should never crash the surface
 * that would show the user why it's rendering wrong.
 */
export function translate<Key extends string>(catalog: Catalog<Key>, locale: Locale, key: Key, params?: Readonly<Record<string, string>>): string {
  const template = catalog[locale][key] ?? catalog[DEFAULT_LOCALE][key];
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params[name] ?? "");
}

/**
 * A catalog key plus the params it needs, carried through pure decision
 * code (src/core/decisions.ts) instead of an already-localized string. This
 * is what keeps a decision function locale-agnostic while still making a
 * literal, un-cataloged string impossible to compile in its place: the
 * function returns `LocalizedReason<SomeKey>[]`, so `reasons.push("texto")`
 * fails type-checking the moment `SomeKey` does not include `"texto"`.
 * Resolved to text only at the edge (a hook, a CLI, a panel) with
 * `translateReason`.
 */
export interface LocalizedReason<Key extends string> {
  readonly key: Key;
  readonly params?: Readonly<Record<string, string>>;
}

/** Resolves one `LocalizedReason` through `translate`. */
export function translateReason<Key extends string>(catalog: Catalog<Key>, locale: Locale, reason: LocalizedReason<Key>): string {
  return translate(catalog, locale, reason.key, reason.params);
}
