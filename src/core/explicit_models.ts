// 0.6.7 T7: "Models fixed by an agent definition: judge them | keep them".
//
// A subagent's model can be fixed before the router sees it: by the Agent
// call's own `model`, or by the agent definition it runs. "judge" (the
// default) lets the router lower it under the same guards as any other
// decision (model_router_subagent.ts's decideSubagent), and only in the
// account's `active` router mode; "keep" never lowers it.
//
// The config panel's Models tab stores `{ mode }` under the `explicitModels`
// storage key; the worker mirrors it to `<configDir>/explicit-models.json`
// through write-secret-mirror.mjs, and the hooks module reads that file --
// the same channel as the other panel settings. Every reader goes through
// parseExplicitModels, so they can never disagree.
//
// Pure: no fs, no network.

export type ExplicitModelsMode = 'judge' | 'keep'

export const EXPLICIT_MODELS_CONFIG_KEY = 'explicitModels'

/** The mirror's file name inside the config dir -- one constant for the writer (write-secret-mirror.mjs) and the reader (the hooks module). */
export const EXPLICIT_MODELS_MIRROR_FILE = 'explicit-models.json'

/** Only a stored `{ mode: "keep" }` keeps; anything else, a missing or malformed value included, is "judge", the default. */
export function parseExplicitModels (json: unknown): ExplicitModelsMode {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'judge'
  return (json as Record<string, unknown>).mode === 'keep' ? 'keep' : 'judge'
}
