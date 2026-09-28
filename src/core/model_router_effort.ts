// ---------------------------------------------------------------------------
// Model router 0.6.2 E2: how much output each effort really costs on a
// model, from this account's own `turn-usage-*.jsonl` (one line per step,
// written by the hooks module). Lowering the effort only pays when the
// saving is measured, never assumed.
//
// Pure: the hooks module lists and reads the files.
// ---------------------------------------------------------------------------

import { baseModelId } from "./model_router_accounts.ts";
import { EFFORT_LEVELS } from "./model_router_decide.ts";
import type { TierEffort } from "./model_router_decide.ts";
import { medianOf } from "./model_router_stage.ts";
import type { EffortOutputs } from "./model_router_stage.ts";

/** Real main steps an effort needs before its median counts. */
export const EFFORT_MIN_STEPS = 20;

/** How far back the medians look. */
export const EFFORT_WINDOW_MS = 7 * 24 * 3_600_000;

const TURN_USAGE_FILE = /^turn-usage-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** An hourly turn-usage file whose hour ends after `sinceMs`. */
export function isRecentTurnUsageFile(name: string, sinceMs: number): boolean {
  const match = TURN_USAGE_FILE.exec(name);
  if (match === null) return false;
  const hourStart = Date.parse(`${match[1]}:00:00.000Z`);
  return Number.isFinite(hourStart) && hourStart + 3_600_000 > sinceMs;
}

export interface EffortOutputFilter {
  readonly account: string;
  /** The session's model; a `[1m]` suffix names the same one. */
  readonly model: string;
  readonly sinceMs: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTierEffort(value: unknown): value is TierEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The median `output` per MAIN step at each named effort, for this account
 * and base model since `sinceMs`. An effort with fewer than
 * EFFORT_MIN_STEPS such steps is left out: its saving is unknown.
 */
export function effortOutputMedians(lines: readonly string[], filter: EffortOutputFilter): EffortOutputs {
  const model = baseModelId(filter.model);
  const outputs = new Map<TierEffort, number[]>();
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(row) || row.agent !== "main" || row.account !== filter.account) continue;
    if (typeof row.model !== "string" || baseModelId(row.model) !== model) continue;
    if (!isTierEffort(row.effort) || typeof row.output !== "number" || !Number.isFinite(row.output)) continue;
    const at = typeof row.at === "string" ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at) || at < filter.sinceMs) continue;
    const list = outputs.get(row.effort) ?? [];
    list.push(row.output);
    outputs.set(row.effort, list);
  }
  const medians: Partial<Record<TierEffort, number>> = {};
  for (const effort of EFFORT_LEVELS) {
    const list = outputs.get(effort);
    const median = list !== undefined && list.length >= EFFORT_MIN_STEPS ? medianOf(list) : null;
    if (median !== null) medians[effort] = median;
  }
  return medians;
}
