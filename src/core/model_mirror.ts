// ---------------------------------------------------------------------------
// The worker's mirror of the model catalog, for the Agent PreToolUse/
// PostToolUse hooks (adapters/claude/agent-model.ts).
//
// Same reason gate-bash.ts reads a catalog/policies mirror instead of the
// live catalog (see src/core/gate_catalog_mirror.ts's module note): a
// hook is a plain Node process Claude Code spawns per Agent call, with no
// channel into Orca's own `storage`, so the worker (slice 6) writes this
// file out where the hook can just read it -- `<configDir>/models-catalog.json`
// (MODELS_MIRROR_FILE).
//
// `ready` is NOT recomputed here from the raw measurement log: the worker
// already knows it (summarizeModelMeasurements().readiness.ready, from
// model_measurement.ts, reusing mod-skills' own activation metric) and
// writes the already-decided boolean into this same file. Recomputing it
// per Agent call would mean parsing the whole JSONL log on the hot path of
// every subagent spawn -- exactly the cost gate-bash.ts's own mirror
// avoids for the command gate.
//
// Fails toward measurement, same discipline as every other mirror read in
// this project: a missing file (passed in as `null`), an unreadable one, or
// one that fails the shape checks below all read as `{ active: false,
// ready: false, models: [] }` -- never a crash, and never a value that
// could accidentally let active mode fire on bad data. `active`/`ready`
// only read `true` for the literal boolean `true`; anything else (a
// truthy string, a number, undefined) reads `false` on purpose, because a
// mis-typed value is closer to "nobody turned this on" than to "on".
//
// Pure, like the rest of src/core: no I/O, no clock. The caller (the hook)
// does the actual file read and hands the parsed JSON in as `value`.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { parseModelCatalog, type ModelEntry } from "./model_catalog.ts";

export const MODELS_MIRROR_FILE = "models-catalog.json";

export interface ModelsMirror {
  readonly active: boolean;
  readonly ready: boolean;
  readonly models: readonly ModelEntry[];
}

/**
 * `value` is whatever `JSON.parse` produced from the mirror file, or `null`
 * when the file itself is missing or unreadable -- both fail toward
 * measurement identically, since a missing file and a file that says
 * `{ active: false }` mean the same thing to a subagent about to run.
 */
export function parseModelsMirror(value: unknown): ModelsMirror {
  if (!isRecord(value)) return { active: false, ready: false, models: [] };
  return {
    active: value.active === true,
    ready: value.ready === true,
    models: parseModelCatalog(value.models),
  };
}
