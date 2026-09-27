// ---------------------------------------------------------------------------
// Model router mode (JEV-060 slice 2, odd/tasks/jev-060-router.md §7).
//
// The switch is Claude Code's own: a `userConfig` field on the mod-skills
// plugin manifest, which the config menu draws as a picker and stores in
// settings.json `pluginConfigs[<plugin>].options`. With CLAUDE_CONFIG_DIR
// set (every Orca account), that settings.json is the account vault's, so
// the switch is per account. The Orca config panel (T9) wraps this same
// setting; it never adds a second source of truth.
//
//   off      -- the router does nothing at all.
//   measure  -- decide, log, change nothing (the default).
//   active   -- opt-in: the decision is applied.
//
// Pure: no I/O.
// ---------------------------------------------------------------------------

export type RouterMode = "off" | "measure" | "active";

export const ROUTER_MODES: readonly RouterMode[] = ["off", "measure", "active"];

export const DEFAULT_ROUTER_MODE: RouterMode = "measure";

/** `options.routerMode` as `register` receives it; a value outside the three is unset, as the engine itself treats it. */
export function parseRouterMode(value: unknown): RouterMode {
  return typeof value === "string" && (ROUTER_MODES as readonly string[]).includes(value) ? (value as RouterMode) : DEFAULT_ROUTER_MODE;
}

export interface RouterModeUserConfigField {
  readonly type: "string";
  readonly title: string;
  readonly description: string;
  readonly options: readonly RouterMode[];
  readonly default: RouterMode;
}

/** The manifest's `userConfig` block for the router (§7). */
export const ROUTER_USER_CONFIG: { readonly routerMode: RouterModeUserConfigField } = {
  routerMode: {
    type: "string",
    title: "Jev model router",
    description:
      "Jev picks the model and effort each session needs. measure (default): decide and log, change nothing. active: apply the choice at session start and at stage changes. off: do nothing.",
    options: ROUTER_MODES,
    default: DEFAULT_ROUTER_MODE,
  },
};

const PLUGIN_NAME = "orca-jev-mod-skills";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The router mode an account's settings.json holds (already JSON.parse'd):
 * `pluginConfigs[<name>].options.routerMode`, where `<name>` is the plugin's
 * own name or `<name>@<source>` (a `--plugin-dir` plugin's key is
 * `<name>@inline`). For a process outside the hooks module -- the classic
 * Agent hook -- that cannot receive `options`.
 */
export function routerModeFromSettings(settings: unknown): RouterMode {
  if (!isObject(settings) || !isObject(settings.pluginConfigs)) return DEFAULT_ROUTER_MODE;
  // The installed plugin's own key first (it is the one the running router
  // reads), then the bare name, then any other source's leftover.
  const keys = Object.keys(settings.pluginConfigs).filter((key) => key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`));
  const rank = (key: string): number => (key === ROUTER_SETTINGS_KEY ? 0 : key === PLUGIN_NAME ? 1 : 2);
  for (const key of [...keys].sort((a, b) => rank(a) - rank(b))) {
    const config = settings.pluginConfigs[key];
    if (isObject(config) && isObject(config.options) && config.options.routerMode !== undefined) return parseRouterMode(config.options.routerMode);
  }
  return DEFAULT_ROUTER_MODE;
}

/**
 * The `pluginConfigs` key the INSTALLED plugin reads. Claude Code keys a
 * plugin's options by its source id: a plugin auto-loaded from a skills
 * folder (how install-claude-integration.mjs installs this one) is
 * `<name>@skills-dir` and reads that key only; a `--plugin-dir` plugin
 * (`<name>@inline`) reads `<name>` or `<name>@inline` (Claude Code 2.1.283's
 * own plugin loader). Only user, `--settings` and managed settings are
 * read, never a project's.
 */
export const ROUTER_SETTINGS_KEY = `${PLUGIN_NAME}@skills-dir`;

/** `settings` (a parsed settings.json, or anything) with the installed plugin's `routerMode` set; every other key kept. Never mutates its input. */
export function withRouterMode(settings: unknown, mode: RouterMode): Record<string, unknown> {
  const base = isObject(settings) ? settings : {};
  const configs = isObject(base.pluginConfigs) ? base.pluginConfigs : {};
  const own = isObject(configs[ROUTER_SETTINGS_KEY]) ? (configs[ROUTER_SETTINGS_KEY] as Record<string, unknown>) : {};
  const options = isObject(own.options) ? own.options : {};
  return { ...base, pluginConfigs: { ...configs, [ROUTER_SETTINGS_KEY]: { ...own, options: { ...options, routerMode: mode } } } };
}

export type RouterModeWritePlan =
  | { readonly kind: "write"; readonly text: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refuse"; readonly reason: "unparseable" | "not-an-object" };

/** The indent unit the person's file uses (a tab or N spaces), from its first indented line; 2 spaces when it has none. */
function detectIndent(raw: string): string | number {
  const match = /\n([ \t]+)\S/.exec(raw);
  if (match === null || match[1] === undefined) return 2;
  return match[1].startsWith("\t") ? "\t" : match[1].length;
}

/**
 * What writing `mode` into a settings.json whose current text is `raw`
 * (null: no file yet) should do. Claude Code and the person edit this file
 * too, so: nothing is written when the installed plugin's own key already
 * holds `mode`; a file that is not a JSON object is refused, never
 * overwritten; otherwise every other key is kept and the file keeps its
 * own indent and trailing newline, as far as JSON re-serialisation allows.
 * The caller still re-reads before replacing the file (a concurrent edit).
 */
export function planRouterModeWrite(raw: string | null, mode: RouterMode): RouterModeWritePlan {
  if (raw === null) return { kind: "write", text: `${JSON.stringify(withRouterMode({}, mode), null, 2)}\n` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "refuse", reason: "unparseable" };
  }
  if (!isObject(parsed)) return { kind: "refuse", reason: "not-an-object" };
  const configs = isObject(parsed.pluginConfigs) ? parsed.pluginConfigs : {};
  const own = configs[ROUTER_SETTINGS_KEY];
  if (isObject(own) && isObject(own.options) && own.options.routerMode === mode) return { kind: "unchanged" };
  const text = JSON.stringify(withRouterMode(parsed, mode), null, detectIndent(raw));
  return { kind: "write", text: raw.endsWith("\n") ? `${text}\n` : text };
}
