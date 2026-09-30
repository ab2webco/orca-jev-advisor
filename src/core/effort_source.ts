// 0.6.15 T4c (odd/research/effort-per-task.md §4): measure-only effort
// logging. Nothing here changes which effort a step is sent with; it names
// where that effort came from, the way Claude Code resolves it
// (https://code.claude.com/docs/en/model-config): `CLAUDE_CODE_EFFORT_LEVEL`,
// `--effort` or `/effort` first, then settings (`modelSettings` per model, or
// a top-level `effortLevel`, which does not count for Opus 5.5), then the
// model's default (medium on Opus 5.5 and Sonnet 5.5, high elsewhere); a
// subagent's frontmatter `effort` overrides the session's level, never the
// environment's. A hook sees the step's effort, the environment and the
// settings file, never `/effort` or `--effort`: a level none of those explain
// is the session's.
//
// Pure: the hooks module reads the step, the environment and the files.

import { isRecord } from "../guards.ts";
import { baseModelId } from "./model_router_accounts.ts";
import type { SessionEffort } from "./model_router_decide.ts";

export type EffortSource = "plugin" | "env" | "frontmatter" | "settings" | "default" | "session" | "none";

const MEDIUM_BY_DEFAULT: readonly string[] = ["claude-opus-5-5", "claude-sonnet-5-5"];
const NO_EFFORT: readonly string[] = ["claude-haiku-4-5"];

/** Claude Code's own default effort for a model, or null for one that takes none. */
export function claudeCodeDefaultEffort(modelId: string): SessionEffort | null {
  const id = baseModelId(modelId);
  if (NO_EFFORT.some((prefix) => id === prefix || id.startsWith(`${prefix}-`))) return null;
  return MEDIUM_BY_DEFAULT.includes(id) ? "medium" : "high";
}

function levelOf(value: unknown): SessionEffort | null {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : null;
}

/** The effort a settings.json sets for `modelId`: its `modelSettings` entry, else a top-level `effortLevel` (never for Opus 5.5). */
export function settingsEffortFor(settings: unknown, modelId: string): SessionEffort | null {
  if (!isRecord(settings)) return null;
  const id = baseModelId(modelId);
  const perModel = isRecord(settings.modelSettings) ? settings.modelSettings : null;
  const entry = perModel === null ? null : (perModel[modelId] ?? perModel[id]);
  const own = isRecord(entry) ? levelOf(entry.effortLevel) : null;
  if (own !== null) return own;
  return id === "claude-opus-5-5" ? null : levelOf(settings.effortLevel);
}

export interface EffortSourceInput {
  /** What the engine put on the step. */
  readonly carried: SessionEffort | null;
  /** What the step is sent with. */
  readonly sent: SessionEffort | null;
  readonly env: SessionEffort | null;
  readonly frontmatter: SessionEffort | null;
  readonly settings: SessionEffort | null;
  readonly modelDefault: SessionEffort | null;
}

/** Where the effort a step is sent with came from (see the notes above). */
export function effortSourceOf(input: EffortSourceInput): EffortSource {
  const { carried, sent } = input;
  if (sent === null) return "none";
  if (carried !== sent) return "plugin";
  if (input.env === sent) return "env";
  if (input.frontmatter === sent) return "frontmatter";
  if (input.settings === sent) return "settings";
  if (input.modelDefault === sent) return "default";
  return "session";
}

/** The share of a step's prompt not read from cache (input and cache writes over the whole prompt), or null for an empty one. */
export function uncachedShare(usage: { readonly input: number | null; readonly cacheRead: number | null; readonly cacheWrite: number | null }): number | null {
  const uncached = (usage.input ?? 0) + (usage.cacheWrite ?? 0);
  const total = uncached + (usage.cacheRead ?? 0);
  return total === 0 ? null : Math.round((uncached / total) * 1000) / 1000;
}
