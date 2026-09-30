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

import { ROUTER_TIERS } from "./model_router_accounts.ts";
import type { RouterTier } from "./model_router_accounts.ts";
import { EFFORT_LEVELS, TIER_EFFORT } from "./model_router_decide.ts";
import type { TierEffort, TierEffortMap } from "./model_router_decide.ts";
import { MAX_STEWARD_THRESHOLD, MIN_STEWARD_THRESHOLD, STEWARD_MODES, STEWARD_SOFT_MODES, parseStewardMode, parseStewardSoftMode, parseStewardThreshold } from "./context_steward.ts";
import type { StewardMode, StewardSoftMode } from "./context_steward.ts";
import { parseWorkKindMode } from "./work_kind.ts";
import type { WorkKindMode } from "./work_kind.ts";

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
  const mode = routerOption(settings, "routerMode");
  return mode === undefined ? DEFAULT_ROUTER_MODE : parseRouterMode(mode);
}

/**
 * One router option from an account's settings.json: the installed plugin's
 * own key first (it is the one the running router reads), then the bare
 * name, then any other source's leftover. undefined when none sets it.
 */
function routerOption(settings: unknown, name: string): unknown {
  if (!isObject(settings) || !isObject(settings.pluginConfigs)) return undefined;
  const configs = settings.pluginConfigs;
  const keys = Object.keys(configs).filter((key) => key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`));
  const rank = (key: string): number => (key === ROUTER_SETTINGS_KEY ? 0 : key === PLUGIN_NAME ? 1 : 2);
  for (const key of [...keys].sort((a, b) => rank(a) - rank(b))) {
    const config = configs[key];
    if (isObject(config) && isObject(config.options) && config.options[name] !== undefined) return config.options[name];
  }
  return undefined;
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

// ---------------------------------------------------------------------------
// 0.6.2 E3: the effort each tier asks for, per account, in the same router
// options (`routerEffort: { complex: "xhigh" }`). Only what differs from
// TIER_EFFORT is stored, so a tier the person never touched follows the
// default.
// ---------------------------------------------------------------------------

function isTierEffort(value: unknown): value is TierEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** TIER_EFFORT with every valid per-tier override applied; an invalid value, tier or shape is ignored. */
export function parseTierEffort(value: unknown): TierEffortMap {
  const map: Record<string, TierEffort> = { ...TIER_EFFORT };
  if (isObject(value)) for (const tier of ROUTER_TIERS) if (isTierEffort(value[tier])) map[tier] = value[tier];
  return map as TierEffortMap;
}

/**
 * A per-tier effort as a writer receives it: an object whose every key is a
 * tier and every value an effort, applied over the defaults. null for
 * anything else -- a writer rejects, never guesses.
 */
export function parseTierEffortStrict(value: unknown): TierEffortMap | null {
  if (!isObject(value)) return null;
  for (const [tier, effort] of Object.entries(value)) {
    if (!(ROUTER_TIERS as readonly string[]).includes(tier) || !isTierEffort(effort)) return null;
  }
  return parseTierEffort(value);
}

export function routerEffortFromSettings(settings: unknown): TierEffortMap {
  return parseTierEffort(routerOption(settings, "routerEffort"));
}

/** Only the tiers whose effort differs from the default; empty when none does. */
function effortOverrides(map: TierEffortMap): Record<string, TierEffort> {
  const overrides: Record<string, TierEffort> = {};
  for (const tier of ROUTER_TIERS) if (map[tier] !== TIER_EFFORT[tier]) overrides[tier] = map[tier];
  return overrides;
}

/**
 * What writing `map` into a settings.json whose text is `raw` (null: no file
 * yet) should do: the same contract as planRouterModeWrite -- nothing when
 * the installed key already holds it, a non-object file refused, every other
 * key and the file's indent kept. Back to the defaults removes the option.
 */
export function planRouterEffortWrite(raw: string | null, map: TierEffortMap): RouterModeWritePlan {
  let parsed: unknown = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "refuse", reason: "unparseable" };
    }
    if (!isObject(parsed)) return { kind: "refuse", reason: "not-an-object" };
  }
  const base = isObject(parsed) ? parsed : {};
  const wanted = effortOverrides(map);
  const configs = isObject(base.pluginConfigs) ? base.pluginConfigs : {};
  const own = isObject(configs[ROUTER_SETTINGS_KEY]) ? (configs[ROUTER_SETTINGS_KEY] as Record<string, unknown>) : {};
  const options = isObject(own.options) ? own.options : {};
  const stored = options.routerEffort;
  const { routerEffort: _dropped, ...rest } = options;
  void _dropped;
  const withoutOwn = { ...base, pluginConfigs: { ...configs, [ROUTER_SETTINGS_KEY]: { ...own, options: rest } } };
  // Back to the defaults removes the option, unless another plugin key would
  // then win (a leftover `orca-jev-mod-skills` or `@source` entry): then an
  // explicit empty map keeps the defaults in force (review nit 7).
  const strayWins = effortOverrides(routerEffortFromSettings(withoutOwn));
  const desired = Object.keys(wanted).length > 0 ? wanted : Object.keys(strayWins).length > 0 ? {} : undefined;
  // Stored exactly as it would be written (tier order): no write. Anything
  // else, stray invalid values included, is rewritten clean.
  if (JSON.stringify(stored) === JSON.stringify(desired)) return { kind: "unchanged" };
  const next = desired === undefined ? withoutOwn : { ...base, pluginConfigs: { ...configs, [ROUTER_SETTINGS_KEY]: { ...own, options: { ...rest, routerEffort: desired } } } };
  if (raw === null) return { kind: "write", text: `${JSON.stringify(next, null, 2)}\n` };
  const text = JSON.stringify(next, null, detectIndent(raw));
  return { kind: "write", text: raw.endsWith("\n") ? `${text}\n` : text };
}

// ---------------------------------------------------------------------------
// The context steward (odd/tasks/jev-context-steward.md): its mode and
// threshold, per account, in the same router options (`stewardMode`,
// `stewardThreshold`). Both are always stored together.
// ---------------------------------------------------------------------------

export interface StewardSettings {
  readonly mode: StewardMode;
  readonly threshold: number;
  /** 0.6.15 T4: the 400k soft tier's own switch (`stewardSoftMode`), measure by default. */
  readonly softMode: StewardSoftMode;
}

/** What a writer stores: `softMode` absent leaves the stored switch as it is. */
export interface StewardSettingsWrite {
  readonly mode: StewardMode;
  readonly threshold: number;
  readonly softMode?: StewardSoftMode;
}

export function stewardFromSettings(settings: unknown): StewardSettings {
  return {
    mode: parseStewardMode(routerOption(settings, "stewardMode")),
    threshold: parseStewardThreshold(routerOption(settings, "stewardThreshold")),
    softMode: parseStewardSoftMode(routerOption(settings, "stewardSoftMode")),
  };
}

/** The steward settings as a writer receives them: a known mode, a threshold within range and, when given, a known soft-tier switch, or null -- a writer rejects, never guesses. */
export function parseStewardSettingsStrict(value: unknown): StewardSettingsWrite | null {
  if (!isObject(value)) return null;
  const { mode, threshold, softMode } = value;
  if (typeof mode !== "string" || !(STEWARD_MODES as readonly string[]).includes(mode)) return null;
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < MIN_STEWARD_THRESHOLD || threshold > MAX_STEWARD_THRESHOLD) return null;
  if (softMode === undefined) return { mode: mode as StewardMode, threshold };
  if (typeof softMode !== "string" || !(STEWARD_SOFT_MODES as readonly string[]).includes(softMode)) return null;
  return { mode: mode as StewardMode, threshold, softMode: softMode as StewardSoftMode };
}

/** What writing `steward` into a settings.json whose text is `raw` (null: no file yet) should do: the same contract as planRouterModeWrite. */
export function planStewardWrite(raw: string | null, steward: StewardSettingsWrite): RouterModeWritePlan {
  let parsed: unknown = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "refuse", reason: "unparseable" };
    }
    if (!isObject(parsed)) return { kind: "refuse", reason: "not-an-object" };
  }
  const base = isObject(parsed) ? parsed : {};
  const configs = isObject(base.pluginConfigs) ? base.pluginConfigs : {};
  const own = isObject(configs[ROUTER_SETTINGS_KEY]) ? (configs[ROUTER_SETTINGS_KEY] as Record<string, unknown>) : {};
  const options = isObject(own.options) ? own.options : {};
  const softUnchanged = steward.softMode === undefined || options.stewardSoftMode === steward.softMode;
  if (options.stewardMode === steward.mode && options.stewardThreshold === steward.threshold && softUnchanged) return { kind: "unchanged" };
  const soft = steward.softMode === undefined ? {} : { stewardSoftMode: steward.softMode };
  const next = { ...base, pluginConfigs: { ...configs, [ROUTER_SETTINGS_KEY]: { ...own, options: { ...options, stewardMode: steward.mode, stewardThreshold: steward.threshold, ...soft } } } };
  if (raw === null) return { kind: "write", text: `${JSON.stringify(next, null, 2)}\n` };
  const text = JSON.stringify(next, null, detectIndent(raw));
  return { kind: "write", text: raw.endsWith("\n") ? `${text}\n` : text };
}

// ---------------------------------------------------------------------------
// 0.6.16 T2: the work kind at subagent spawn (src/core/work_kind.ts) has its
// own switch, per account, in the same router options (`workKindMode`).
// ---------------------------------------------------------------------------

export function workKindModeFromSettings(settings: unknown): WorkKindMode {
  return parseWorkKindMode(routerOption(settings, "workKindMode"));
}

/** What writing `mode` into a settings.json whose text is `raw` (null: no file yet) should do: the same contract as planRouterModeWrite. */
export function planWorkKindWrite(raw: string | null, mode: WorkKindMode): RouterModeWritePlan {
  let parsed: unknown = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "refuse", reason: "unparseable" };
    }
    if (!isObject(parsed)) return { kind: "refuse", reason: "not-an-object" };
  }
  const base = isObject(parsed) ? parsed : {};
  const configs = isObject(base.pluginConfigs) ? base.pluginConfigs : {};
  const own = isObject(configs[ROUTER_SETTINGS_KEY]) ? (configs[ROUTER_SETTINGS_KEY] as Record<string, unknown>) : {};
  const options = isObject(own.options) ? own.options : {};
  if (options.workKindMode === mode) return { kind: "unchanged" };
  const next = { ...base, pluginConfigs: { ...configs, [ROUTER_SETTINGS_KEY]: { ...own, options: { ...options, workKindMode: mode } } } };
  if (raw === null) return { kind: "write", text: `${JSON.stringify(next, null, 2)}\n` };
  const text = JSON.stringify(next, null, detectIndent(raw));
  return { kind: "write", text: raw.endsWith("\n") ? `${text}\n` : text };
}

/** 0.6.16 T1: the tiers whose effort the person stored (a valid `routerEffort` value), as opposed to the defaults. */
export function routerEffortPersonTiers(settings: unknown): ReadonlySet<RouterTier> {
  const stored = routerOption(settings, "routerEffort");
  const tiers = new Set<RouterTier>();
  if (isObject(stored)) for (const tier of ROUTER_TIERS) if (isTierEffort(stored[tier])) tiers.add(tier);
  return tiers;
}
