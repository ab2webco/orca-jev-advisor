// ---------------------------------------------------------------------------
// Which models the running Claude Code engine can run.
//
// A model released after an engine was built may need a newer one (Haiku 5.5
// needs Claude Code 2.1.293 or later). The router must never send a session
// to a model its engine cannot run, so every model with such a floor has ONE
// entry in ENGINE_REQUIREMENTS: add a line for the next model, nothing else.
//
// An engine version that is unknown or unreadable supports every model.
// Refusing a model on a guess would silently downgrade everyone whose
// version could not be read; the decision row says the version was unknown
// instead (model_router_accounts.ts), so it stays visible.
//
// A development build (`2.1.280-dev.20260920...`) is compared on its semantic
// core, the release it is built from.
//
// Pure: the mod reads `$.session.version()` and writes the record below; the
// settings.json Agent hook, which gets no version in its input, reads it.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";

export interface EngineRequirement {
  /** The oldest Claude Code version, `major.minor.patch`, that can run the model. */
  readonly minVersion: string;
  /** The model an older engine keeps instead, tried before moving up the ladder; absent = none. */
  readonly fallback?: string;
}

export const ENGINE_REQUIREMENTS: Readonly<Record<string, EngineRequirement>> = {
  "claude-haiku-5-5": { minVersion: "2.1.293", fallback: "claude-haiku-4-5-20251001" },
};

export type EngineVersionCore = readonly [number, number, number];

/** `2.1.296`, `v2.1.296` and `2.1.280-dev.20260920.t101500.sha1a2b3c4` → their major, minor and patch; null for anything else. */
export function parseEngineVersion(version: string): EngineVersionCore | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: EngineVersionCore, minimum: EngineVersionCore): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = version[i] as number;
    const b = minimum[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

function requirementOf(modelId: string): EngineRequirement | undefined {
  const bracket = modelId.indexOf("[");
  return ENGINE_REQUIREMENTS[bracket === -1 ? modelId : modelId.slice(0, bracket)];
}

/** Whether a model has a floor at all. */
export function hasEngineRequirement(modelId: string): boolean {
  return requirementOf(modelId) !== undefined;
}

/** Whether an engine at `version` can run `modelId`: false only for a known version below the model's floor. */
export function engineSupports(modelId: string, version: string | null | undefined): boolean {
  const requirement = requirementOf(modelId);
  if (requirement === undefined || version === null || version === undefined) return true;
  const have = parseEngineVersion(version);
  const need = parseEngineVersion(requirement.minVersion);
  return have === null || need === null || atLeast(have, need);
}

/** The model an engine too old for `modelId` keeps instead, or null. */
export function engineFallbackFor(modelId: string): string | null {
  return requirementOf(modelId)?.fallback ?? null;
}

// ---------------------------------------------------------------------------
// The record the mod leaves for the hook
// ---------------------------------------------------------------------------

/** In the plugin's cache directory, next to the other files the Agent hook already reads. */
export const ENGINE_VERSION_FILE = "engine-version.json";

export interface EngineVersionRecord {
  readonly version: string;
  readonly base?: string;
  readonly at: string;
}

/** What `$.session.version()` answers, as far as this file reads it. */
export interface EngineVersionSource {
  readonly version: string;
  readonly base?: string;
}

export function engineVersionRecord(source: EngineVersionSource, atIso: string): EngineVersionRecord {
  return { version: source.version, ...(source.base === undefined ? {} : { base: source.base }), at: atIso };
}

/** The engine version a record holds, or null for anything else (a missing, old or malformed file is "unknown"). */
export function parseEngineVersionRecord(value: unknown): string | null {
  return isRecord(value) && typeof value.version === "string" && value.version.length > 0 ? value.version : null;
}
