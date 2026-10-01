/**
 * mod-skills — lets Jev pick the skill, instead of the model reading all
 * of their descriptions on every prompt.
 *
 * The problem and the two-stage shape are TypeSafe's own skill-suggestion
 * cookbook, already built once as `jev-skill-suggestion`. This is a
 * second, narrower implementation for exactly one reason (see the feature
 * document, odd/tasks/mod-skills.md, "Why our own, not a third party's"): it can weigh
 * in the Orca worktree, project and branch a session is running in, which
 * a third-party mod has no way to see. Everything else -- the Jev client,
 * the question shapes, the guards -- comes from src/core, shared with the
 * CLI tools and adapters/claude/gate-bash.ts. Nothing here forks it.
 *
 * Two hooks:
 *   prompt.attachment on `skill_listing` -- observes the engine's listing;
 *     withholds it (`{ text: null }`) for the main conversation ONLY on a
 *     turn where `prompt.submit` (below), which always runs first, already
 *     settled on injecting a skill in its place -- read from
 *     `pendingListingWithheld`, the same "set once below, read once and
 *     reset here" shape `pendingMeasurementId` already uses for
 *     `skill.prompt`. Active mode with nothing picked, a failed SKILL.md
 *     read, or measurement mode all leave the flag false, so the model
 *     always gets either the real listing or a replacement, never neither
 *     (JEVADV-4: this used to key off active mode alone, so a shortfall in
 *     either of those left the model with nothing for that turn).
 *   prompt.submit -- one shared sampling roll per prompt (below) gates
 *     BOTH paths' own measurement-mode Jev calls; the two Jev stages then
 *     run for every real prompt of the main conversation that clears it
 *     (prompt.submit never fires for a subagent's own prompt): stage 1
 *     ranks every installed skill and gates on whether a skill is needed
 *     at all; stage 2 re-reads the top few with the opening of their
 *     SKILL.md and asks one atomic `fits` per candidate. Measurement mode
 *     records what Jev would have chosen and changes nothing else. Active
 *     mode additionally withholds the listing and injects the winner's
 *     SKILL.md as context the model reads -- but only once that
 *     SKILL.md was actually read successfully (see `pendingListingWithheld`
 *     above).
 *
 * skill.prompt is hooked purely to observe: whether the skill the model
 * actually loaded (typed, through the Skill tool, or preloaded into a
 * subagent -- this event does not tell those apart) was the one Jev would
 * have suggested. This is measurement mode's other half: the calibration
 * data is only useful once both sides of a prompt are on record.
 *
 * Fails open, always: any error, timeout or missing key leaves the prompt
 * exactly as it was. The two Jev calls never withhold anything by
 * themselves -- only active mode's own withhold/inject step does, and
 * only once a decision was actually reached AND its SKILL.md was read.
 *
 * Tool selection follows the exact same shape, one level down: instead of
 * "which skill", it decides "which tool should the model reach for on this
 * turn" -- src/core/tool_inventory.ts, src/core/tool_decisions.ts and
 * src/core/tool_measurement.ts mirror the skill modules above one for one.
 * It runs from the same `prompt.submit` hook (its own try/catch, so a
 * failure in one never touches the other), shares the same per-prompt
 * sampling roll as the skill path (JEVADV-4: this path used to call Jev on
 * every real prompt with no sampling at all, unlike the skill path), and
 * observes what the model actually called through a new `tool.call` hook,
 * the tool equivalent of `skill.prompt`. Measurement mode is the default
 * here too and changes nothing observable; active mode
 * (`options.activeTools`, off by default) injects the winner as advice in
 * a `<tool_relevance>` block -- it never blocks, rewrites or removes a
 * tool call, and fails open the same way. There is no listing to withhold
 * for tools, so this path never touches `pendingListingWithheld`.
 *
 * JEVADV-43 -- mod-skills had never actually loaded on any machine: the
 * engine only follows `$` into a function DECLARED AT THE TOP OF THIS SAME
 * FILE, never across an import, so every function that receives `$` lives
 * here now, as a top-level `function` declaration, even the ones that used
 * to live in ./runtime.ts (still imported below for the plain, `$`-free
 * helpers it kept: computeHomePaths, parseEnvFile, and their types). The
 * engine also requires a NAMED `export function register(on, options)`,
 * never a default export -- see this file's own export below -- and
 * `resolveActiveMode`/`resolveActiveToolMode` used to be closures declared
 * INSIDE register, which is exactly the "not at the top of the file" shape
 * the engine refuses; they are top-level functions now too, taking their
 * cache explicitly instead of closing over it.
 */
import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, Frozen, Next, On, PluginOptions, Register, SessionCompactResult, StreamHookBody, StreamNext, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { JevRequestError, callJev } from '../../../../src/core/jev.ts'
import { resolveOrcaContext } from '../../../../src/core/orca_context.ts'
import type { OrcaContext, ProcessRun, RunResult } from '../../../../src/core/orca_context.ts'
import { modSkillsProjectName } from '../../../../src/core/project_name.ts'
import { listSkillInventory, stripSkillFrontmatter } from '../../../../src/core/skill_inventory.ts'
import type { SkillFs, SkillFsEntry, SkillFsStat, SkillSummary } from '../../../../src/core/skill_inventory.ts'
import { measurementFileName, measurementFilesToRead, measurementLegacyFileName, type MeasurementLog } from '../../../../src/core/measurement_files.ts'
import {
  DEFAULT_FITS_THRESHOLD,
  DEFAULT_GATE_THRESHOLD,
  buildFitQuestions,
  buildFitState,
  buildWideQuestions,
  buildWideState,
  decideSkill,
  interpretFit,
  interpretWide,
  listingCharsFor,
  shortlistOf,
} from '../../../../src/core/skill_decisions.ts'
import type { FitResult, SkillCandidate, SkillCandidateDetail, WideResult } from '../../../../src/core/skill_decisions.ts'
import { buildDecisionRecord, buildObservationRecord, computeComparableStats, serializeRecord } from '../../../../src/core/skill_measurement.ts'
import { shouldSamplePrompt } from '../../../../src/core/mod_skills_sampling.ts'
import { listToolInventory } from '../../../../src/core/tool_inventory.ts'
import type { ToolLister, ToolSummary } from '../../../../src/core/tool_inventory.ts'
import {
  DEFAULT_FITS_THRESHOLD as TOOL_DEFAULT_FITS_THRESHOLD,
  DEFAULT_GATE_THRESHOLD as TOOL_DEFAULT_GATE_THRESHOLD,
  buildFitQuestions as buildToolFitQuestions,
  buildFitState as buildToolFitState,
  buildWideQuestions as buildToolWideQuestions,
  buildWideState as buildToolWideState,
  decideTool,
  interpretFit as interpretToolFit,
  interpretWide as interpretToolWide,
  listingCharsFor as toolListingCharsFor,
  mergeWide as mergeToolWide,
  shortlistOf as toolShortlistOf,
  wideBatches as toolWideBatches,
} from '../../../../src/core/tool_decisions.ts'
import type { FitResult as ToolFitResult, ToolCandidate, ToolCandidateDetail, WideResult as ToolWideResult } from '../../../../src/core/tool_decisions.ts'
import { buildDecisionRecord as buildToolDecisionRecord, buildObservationRecord as buildToolObservationRecord, serializeRecord as serializeToolRecord } from '../../../../src/core/tool_measurement.ts'
import { DEFAULT_LOCALE, parseLocaleFile, translate } from '../../../../src/core/i18n.ts'
import type { Locale } from '../../../../src/core/i18n.ts'
import { MOD_SKILLS_CATALOG } from '../../../../src/core/i18n_mod_skills.ts'
import type { ModSkillsKey } from '../../../../src/core/i18n_mod_skills.ts'
import { TOOLS_CATALOG } from '../../../../src/core/i18n_tools.ts'
import type { ToolsKey } from '../../../../src/core/i18n_tools.ts'
import { DEFAULT_MOD_SKILLS_SWITCHES, parseModSkillsConfig } from '../../../../src/core/mod_skills_config.ts'
import type { ModSkillsSwitches } from '../../../../src/core/mod_skills_config.ts'
import { DEFAULT_MOD_SKILLS_SAMPLING_CONFIG, parseModSkillsSamplingConfig } from '../../../../src/core/mod_skills_sampling.ts'
import type { ModSkillsSamplingConfig } from '../../../../src/core/mod_skills_sampling.ts'
import { DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS, evaluateModSkillsReadiness } from '../../../../src/core/mod_skills_readiness.ts'
import type { ModSkillsReadiness } from '../../../../src/core/mod_skills_readiness.ts'
import type { JevFetch, JevFetchResponse, JevSleep } from '../../../../src/core/jev.ts'
import { computeHomePaths, orcaCliCommandFor, parseEnvFile, resolveUserSkillsDir } from './runtime.ts'
import type { ModHomePaths } from './runtime.ts'
import { parseQuota } from '../../../../src/core/consumption.ts'
import { parseModelsMirror } from '../../../../src/core/model_mirror.ts'
import { contextWindowOfModel, parseVaultEnv, resolveAccountTiers, tierOfModel } from '../../../../src/core/model_router_accounts.ts'
import type { ResolvedTiers, RouterTier } from '../../../../src/core/model_router_accounts.ts'
import { buildTierQuestions, buildTierState, decideStart, interpretTier, routerDecisionFileName, routerDecisionRecord, toRouterEffort } from '../../../../src/core/model_router_decide.ts'
import type { RouterDecision, TierJudgment } from '../../../../src/core/model_router_decide.ts'
import { parseRouterMode, routerEffortFromSettings, routerEffortPersonTiers, workKindModeFromSettings } from '../../../../src/core/model_router_mode.ts'
import { holdEffort, stepPhase, toolFailed, withLastFailed, withStep } from '../../../../src/core/step_phase.ts'
import type { PhaseTurn } from '../../../../src/core/step_phase.ts'
import { interpretWorkKind, keywordWorkKind, kindStepEffort, readWorkTierEffort, withWorkKindQuestion } from '../../../../src/core/work_kind.ts'
import type { WorkKindJudgment, WorkKindMode, WorkKindRecord } from '../../../../src/core/work_kind.ts'
import { EFFORT_WINDOW_MS, effortOutputMedians, isRecentTurnUsageFile } from '../../../../src/core/model_router_effort.ts'
import type { RouterMode } from '../../../../src/core/model_router_mode.ts'
import { keptWhy, routerPersonStatusText, routerStatusText, routerWarmStatusText } from '../../../../src/core/model_router_status.ts'
import { composeStatusLine, skillStatusPart, toolStatusPart } from '../../../../src/core/status_line.ts'
import { parseRunningSubagents, reconcileRunning, subagentEffortSource, subagentModelLabel, subagentWhy, subagentsStatusPart } from '../../../../src/core/subagent_status.ts'
import { EXPLICIT_MODELS_MIRROR_FILE, parseExplicitModels } from '../../../../src/core/explicit_models.ts'
import { agentDefinitionEffort, agentDefinitionModel, declaredEffort } from '../../../../src/core/agent_definition.ts'
import { claudeCodeDefaultEffort, effortSourceOf, settingsEffortFor, uncachedShare } from '../../../../src/core/effort_source.ts'
import type { EffortSource } from '../../../../src/core/effort_source.ts'
import type { AgentDefinitionFile } from '../../../../src/core/agent_definition.ts'
import type { ExplicitModelsMode } from '../../../../src/core/explicit_models.ts'
import type { ListedAgent, RunningSubagent, SubagentEffortSource, SubagentWhy } from '../../../../src/core/subagent_status.ts'
import { subagentBand } from '../../../../src/core/subagent_band.ts'
import type { KeptDecision } from '../../../../src/core/model_router_status.ts'
import { decideEngineTurn, decideStage, isNewPrompt, lastPromptKey, medianOf, quotaPressureOf, summarizePreviousTurn, summarizeSinceLastPrompt } from '../../../../src/core/model_router_stage.ts'
import type { ActivityMessage, LiveRateLimit, EffortOutputs, SessionUsage, StageDecision, StageDecisionInput } from '../../../../src/core/model_router_stage.ts'
import type { DestinationKind, QuotaBand, QuotaSource, SessionEffort, TierEffort, TierEffortMap, TurnActivity } from '../../../../src/core/model_router_decide.ts'
import { resolveRouterDestination } from '../../../../src/core/model_router_destination.ts'
import type { RouterDestination } from '../../../../src/core/model_router_destination.ts'
import { decideSubagent, subagentStepEffort } from '../../../../src/core/model_router_subagent.ts'
import type { SubagentDecision } from '../../../../src/core/model_router_subagent.ts'
import { isPersonPromptOrigin } from '../../../../src/core/model_router_origin.ts'
import type { RouterPromptOrigin, RouterSessionStats, RouterSticky, StewardState } from '../types/index.d.ts'
import { buildStewardQuestions, buildStewardState, collectStewardFacts, decideSteward, interpretSteward, softTierFires, stewardClearHint, stewardDecisionFileName, stewardDecisionRecord, stewardGate, stewardInstructions, stewardStatusPart, summarizeStewardActivity } from '../../../../src/core/context_steward.ts'
import type { StewardDecision, StewardJudgment, StewardMode, StewardNotApplied, StewardTier } from '../../../../src/core/context_steward.ts'
import { stewardFromSettings } from '../../../../src/core/model_router_mode.ts'

const DEFAULT_BUDGET_MS = 800
const DEFAULT_SHORTLIST = 3
const DEFAULT_EXCERPT_CHARS = 700

// Stage 1's short description keeps the wide-stage payload light across a
// large inventory (an MCP-heavy session can easily carry a few hundred
// tools); stage 2 reads the winner's full, untruncated description, hence
// the two different caps.
const DEFAULT_TOOL_SHORTLIST = 3
const DEFAULT_TOOL_SHORT_CHARS = 160
const DEFAULT_TOOL_FULL_CHARS = 2000

// =============================================================================
// $-taking functions -- every one of these is declared at the TOP LEVEL of
// THIS file, per the engine's own rule (see the module doc above). They used
// to live in ./runtime.ts; only the plain, `$`-free helpers stayed there.
// Nothing below decides anything specific to skills or tools -- it is
// exactly the glue ./runtime.ts's own module doc used to describe.
// =============================================================================

async function resolveHomePaths($: EngineInterface): Promise<ModHomePaths | null> {
  const [home, userProfile, appData, localAppData, xdgConfigHome, xdgCacheHome] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('APPDATA'),
    $.env.get('LOCALAPPDATA'),
    $.env.get('XDG_CONFIG_HOME'),
    $.env.get('XDG_CACHE_HOME'),
  ])
  return computeHomePaths({ home, userProfile, appData, localAppData, xdgConfigHome, xdgCacheHome })
}

/** The Orca CLI's name here: `orca-ide` on Linux, where a bare `orca` is usually the screen reader. See runtime.ts's orcaCliCommandFor. */
async function resolveOrcaCli($: EngineInterface): Promise<string> {
  const [home, userProfile, orcaCliCommand] = await Promise.all([$.env.get('HOME'), $.env.get('USERPROFILE'), $.env.get('ORCA_CLI_COMMAND')])
  return orcaCliCommandFor({ home, userProfile, orcaCliCommand })
}

/** The home directory alone, for building a `~/.claude/...` path -- Claude Code's own convention, unrelated to this plugin's `.config`/`.cache` choice. */
export async function resolveHomeDir($: EngineInterface): Promise<string | null> {
  const paths = await resolveHomePaths($)
  return paths?.home ?? null
}

// ---------------------------------------------------------------------------
// Locale: the config panel's own choice, mirrored as plain text next to the
// API key's fallback file (see src/core/i18n.ts for why this is not Orca's
// own `contributes.languagePacks`). A mod's `$.fs` reads any absolute path
// -- unlike the Orca worker, a hooks module carries no permission sandbox
// of its own here -- so this reads the file directly, no sidecar needed.
// ---------------------------------------------------------------------------

export async function resolveLocale($: EngineInterface): Promise<Locale> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return DEFAULT_LOCALE
    const path = `${paths.configDir}/locale`
    if (!(await $.fs.exists(path))) return DEFAULT_LOCALE
    return parseLocaleFile(await $.fs.read(path))
  } catch {
    return DEFAULT_LOCALE
  }
}

// ---------------------------------------------------------------------------
// mod-skills' own `active`/`activeTools` switches -- see
// src/core/mod_skills_config.ts's module note (T10,
// odd/tasks/panel-worker-wakeup.md). Read from
// `<configDir>/mod-skills-config.json`, the same self-contained way
// resolveLocale reads the locale file above: no node:fs/node:path, best-
// effort, and off on any missing file, unreachable home, malformed JSON, or
// unexpected failure. `register` below only falls back to this when
// `options` (Claude Code's own `userConfig` channel) does not actually
// carry a boolean for the field in question -- see resolveActiveMode/
// resolveActiveToolMode.
// ---------------------------------------------------------------------------

export async function resolveModSkillsSwitches($: EngineInterface): Promise<ModSkillsSwitches> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return DEFAULT_MOD_SKILLS_SWITCHES
    const path = `${paths.configDir}/mod-skills-config.json`
    if (!(await $.fs.exists(path))) return DEFAULT_MOD_SKILLS_SWITCHES
    return parseModSkillsConfig(await $.fs.read(path))
  } catch {
    return DEFAULT_MOD_SKILLS_SWITCHES
  }
}

// ---------------------------------------------------------------------------
// mod-skills' own sampling switch (src/core/mod_skills_sampling.ts) --
// measurement mode's two Jev calls per prompt, sampled rather than spent on
// every prompt of every session indefinitely. Read from
// `<configDir>/mod-skills-sampling-config.json`, the same self-contained way
// resolveModSkillsSwitches reads mod-skills-config.json: best-effort, and
// falls back to DEFAULT_MOD_SKILLS_SAMPLING_CONFIG (sampling ON at a
// reduced rate, never the old unsampled behaviour) on any missing file,
// unreachable home, malformed JSON, or unexpected failure.
// ---------------------------------------------------------------------------

export async function resolveModSkillsSamplingConfig($: EngineInterface): Promise<ModSkillsSamplingConfig> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return DEFAULT_MOD_SKILLS_SAMPLING_CONFIG
    const path = `${paths.configDir}/mod-skills-sampling-config.json`
    if (!(await $.fs.exists(path))) return DEFAULT_MOD_SKILLS_SAMPLING_CONFIG
    return parseModSkillsSamplingConfig(await $.fs.read(path))
  } catch {
    return DEFAULT_MOD_SKILLS_SAMPLING_CONFIG
  }
}

/**
 * How many measurement-mode decisions one of this mod's own logs
 * (`<fileName>` under the cache dir, see appendMeasurement/
 * appendToolMeasurement below) already holds for `today` (UTC date, e.g.
 * "2026-09-24"), so a sampling config's daily cap means "today", not
 * "ever" -- same date-prefix technique as gate-bash.ts's own
 * samplesQueuedToday over the AB-benchmark queue. Only `mode:
 * "measurement"` decisions count: active mode never goes through the
 * sampling gate this feeds. Best-effort: an unreadable or missing log, or a
 * hand-edited/malformed line, reads as 0 (or is skipped) and never blocks a
 * prompt.
 *
 * Shared by measurementDecisionsToday (skills) and
 * toolMeasurementDecisionsToday (tools, JEVADV-4): the two logs are
 * counted the same tolerant way, only the file name differs.
 */
async function measurementDecisionsTodayIn($: EngineInterface, log: MeasurementLog, today: string): Promise<number> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return 0
    let count = 0
    for (const line of await readMeasurementLines($, paths.cacheDir, log, today)) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      const record = parsed as Record<string, unknown>
      if (record.type === 'decision' && record.mode === 'measurement' && typeof record.at === 'string' && record.at.startsWith(today)) count += 1
    }
    return count
  } catch {
    return 0
  }
}

/**
 * Every line of `log`'s files under `cacheDir` (see
 * src/core/measurement_files.ts), or with `day` only that day's hours plus
 * the legacy file -- which is skipped once it was last written before `day`,
 * so a finished 4 MiB legacy file is not re-read on every prompt forever. A
 * cache dir the engine cannot list reads as the legacy file alone.
 */
async function readMeasurementLines($: EngineInterface, cacheDir: string, log: MeasurementLog, day?: string): Promise<string[]> {
  const legacy = measurementLegacyFileName(log)
  let names: string[]
  try {
    names = (await $.fs.list(cacheDir)).filter((entry) => entry.kind === 'file').map((entry) => entry.name)
  } catch {
    names = [legacy]
  }
  const lines: string[] = []
  for (const name of measurementFilesToRead(log, names, day)) {
    const path = `${cacheDir}/${name}`
    if (!(await $.fs.exists(path))) continue
    if (name === legacy && day !== undefined && (await lastWrittenDay($, path)) < day) continue
    lines.push(...(await $.fs.read(path)).split('\n'))
  }
  return lines
}

/** The UTC day `path` was last written, or `"9999-12-31"` (never skip it) when the engine cannot say. */
async function lastWrittenDay($: EngineInterface, path: string): Promise<string> {
  try {
    return new Date((await $.fs.stat(path)).mtimeMs).toISOString().slice(0, 10)
  } catch {
    return '9999-12-31'
  }
}

/** `measurementDecisionsTodayIn` over the skill-selection log (mod-skills-measurements.jsonl). */
export async function measurementDecisionsToday($: EngineInterface, today: string): Promise<number> {
  return measurementDecisionsTodayIn($, 'mod-skills', today)
}

/**
 * `measurementDecisionsTodayIn` over the tool-selection log
 * (mod-tools-measurements.jsonl) -- JEVADV-4's own sampling for the
 * tool-relevance path, which had none before: see index.ts's shared
 * sampling decision, computed once per prompt from
 * `Math.max(measurementDecisionsToday, toolMeasurementDecisionsToday)` so
 * one path being in active mode (and so never writing `mode:
 * "measurement"` rows of its own) never starves the other path's daily cap
 * of a real count.
 */
export async function toolMeasurementDecisionsToday($: EngineInterface, today: string): Promise<number> {
  return measurementDecisionsTodayIn($, 'mod-tools', today)
}

// ---------------------------------------------------------------------------
// mod-skills' own readiness check (src/core/mod_skills_readiness.ts) --
// JEVADV-4: active mode no longer silently runs "below readiness" with no
// trace of it. This reads the skill-selection measurement log in full (the
// same file measurementDecisionsToday reads a slice of already) and folds
// it with computeComparableStats (src/core/skill_measurement.ts, the pure
// half of aggregateModSkills' own decision/observation join -- that
// aggregator is Node-only and cannot be imported here). Best-effort: an
// unreachable home or an unreadable log reads as null ("not recorded this
// turn"), never a thrown error; a log that exists but is merely thin or
// empty is a real, well-defined "not-enough-samples" verdict, not a
// failure.
// ---------------------------------------------------------------------------

export async function resolveModSkillsReadiness($: EngineInterface): Promise<ModSkillsReadiness | null> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return null
    const rows: unknown[] = []
    for (const line of await readMeasurementLines($, paths.cacheDir, 'mod-skills')) {
      if (line.length === 0) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        continue
      }
    }
    return evaluateModSkillsReadiness(computeComparableStats(rows), DEFAULT_MOD_SKILLS_READINESS_THRESHOLDS)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Jev transport: $.http.fetch and $.clock.sleep, adapted to jev.ts's shapes
// ---------------------------------------------------------------------------
//
// $.http.fetch's HttpResponse.text is already a resolved string (not a
// method) and HttpInit takes no `signal` -- so cancellation is best-effort
// here: callJev still races the request against its own budget through
// the injected sleep, which is what actually bounds the wait regardless of
// whether the underlying transport can be aborted.

export function makeJevFetch($: EngineInterface): JevFetch {
  return async (url, init) => {
    const response = await $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body })
    const result: JevFetchResponse = { ok: response.ok, status: response.status, text: () => Promise.resolve(response.text) }
    return result
  }
}

export function makeJevSleep($: EngineInterface): JevSleep {
  return (ms) => $.clock.sleep(ms)
}

// ---------------------------------------------------------------------------
// Skill filesystem: $.fs, adapted to SkillFs
// ---------------------------------------------------------------------------

export function makeSkillFs($: EngineInterface): SkillFs {
  return {
    exists: (path) => $.fs.exists(path),
    list: async (path): Promise<readonly SkillFsEntry[]> => await $.fs.list(path),
    read: (path) => $.fs.read(path),
    stat: async (path): Promise<SkillFsStat> => {
      const stat = await $.fs.stat(path)
      return { kind: stat.kind }
    },
  }
}

// ---------------------------------------------------------------------------
// Tool inventory: $.tool.list, adapted to ToolLister
// ---------------------------------------------------------------------------

export function makeToolLister($: EngineInterface): ToolLister {
  return () => $.tool.list()
}

// ---------------------------------------------------------------------------
// Orca context: $.process.run, adapted to ProcessRun, with its own short
// budget so a hung or missing `orca` binary can never hold up a prompt --
// resolveOrcaContext's own try/catch turns this timeout into the cwd-only
// fallback, same as a missing binary would.
// ---------------------------------------------------------------------------

const ORCA_PROCESS_BUDGET_MS = 300

export function makeProcessRun($: EngineInterface): ProcessRun {
  return async (argv): Promise<RunResult> => {
    const result = await Promise.race([
      $.process.run(argv),
      $.clock.sleep(ORCA_PROCESS_BUDGET_MS).then((): never => {
        throw new Error(`${argv[0]} didn't respond within ${ORCA_PROCESS_BUDGET_MS}ms`)
      }),
    ])
    return { exitCode: result.exitCode, stdout: result.stdout }
  }
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------
//
// src/core/secrets.ts cannot be imported here: it reads node:fs/promises,
// node:os and node:path, none of which exist in a hooks module's
// environment ("no DOM, no Node"). Its precedence is reproduced instead,
// narrowed to what this environment actually has: the plugin's own option
// (there is no `$.secrets` noun on this `$` to prefer over it), then
// $.env.get (the process environment gate-bash.ts and the CLI tools also
// read TYPESAFE_API_KEY from), then the same dev-only fallback file, read
// through $.fs instead of node:fs.
//
// `$.env.get` is called with the LITERAL `'TYPESAFE_API_KEY'` rather than a
// variable (JEVADV-43): the engine's own static analysis reports which env
// vars a module reads, and it reads that name off the literal at the call
// site, not by tracing a constant's value -- a variable here left this read
// unrecognised. parseEnvFile (./runtime.ts) keeps its own equivalent
// constant purely for the .env-file line scan, which never touches `$`.

export async function resolveApiKey($: EngineInterface, options: PluginOptions): Promise<string | null> {
  const fromOptions = options.typesafeApiKey
  if (typeof fromOptions === 'string' && fromOptions.trim().length > 0) return fromOptions.trim()

  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()

  const paths = await resolveHomePaths($)
  if (!paths) return null
  const path = `${paths.configDir}/env`
  try {
    if (!(await $.fs.exists(path))) return null
    return parseEnvFile(await $.fs.read(path))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Measurement logs: append-only JSONL under the user's cache dir
// ---------------------------------------------------------------------------

async function appendToFile($: EngineInterface, path: string, line: string): Promise<void> {
  const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, existing + line)
}

/** Appends one skill-selection record to the hour `at` falls in (src/core/measurement_files.ts). */
export async function appendMeasurement($: EngineInterface, at: string, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/${measurementFileName('mod-skills', at)}`, line)
  } catch {
    // Measurement is best-effort and must never block or fail a prompt.
  }
}

/** Same shape as `appendMeasurement`, in its own files, for tool-selection records (src/core/tool_measurement.ts). */
export async function appendToolMeasurement($: EngineInterface, at: string, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/${measurementFileName('mod-tools', at)}`, line)
  } catch {
    // Measurement is best-effort and must never block or fail a prompt.
  }
}

// ---------------------------------------------------------------------------
// turn.step usage recording (JEV-060 slice 1) -- a pass-through hook that
// records per-step token usage under the cache dir. No prompt text or
// content is ever recorded here, only usage numbers/metadata.
//
// $.fs has no append: appendToFile above always reads the whole file then
// rewrites it, the same shape appendMeasurement/appendToolMeasurement use.
// Those fire once per prompt; turn.step fires once per model step, so an
// ever-growing single file would mean re-reading and rewriting a multi-MB
// log on every step -- and $.fs.read/write both reject outright above 4 MiB,
// so a single growing file would silently stop recording well before any
// line-count rotation ever ran. Instead, each hour gets its own small file
// (`turn-usage-YYYY-MM-DDTHH.jsonl`, ~200 lines/~50 KB at typical volume):
// an append only ever rewrites the current hour's file, never an older one.
// The worker (T4) aggregates the hourly files into its summary and prunes
// ones older than 8 days; this hook does no rotation of its own.
// ---------------------------------------------------------------------------

/** The account uuid embedded in `CLAUDE_CONFIG_DIR` (`.../claude-accounts/<uuid>/auth`), or `"home"` when it is absent or does not match -- see src/core/orca_accounts.ts for the same convention on the Node side. Pure: no `$`, so it stays reusable by anything that already has the env value in hand. */
function accountFromConfigDir(claudeConfigDir: string | undefined): string {
  if (claudeConfigDir === undefined) return 'home'
  const match = /claude-accounts[\/]([^\/]+)[\/]auth/.exec(claudeConfigDir)
  return match?.[1] ?? 'home'
}

/** `accountFromConfigDir` wired to the live env -- the literal `'CLAUDE_CONFIG_DIR'` at the call site, same convention as every other `$.env.get` read in this file. */
async function resolveAccountId($: EngineInterface): Promise<string> {
  const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return accountFromConfigDir(claudeConfigDir)
}

/** `turn-usage-YYYY-MM-DDTHH.jsonl` for the hour `atIso` (an ISO instant) falls in -- pure, so it is reusable by the worker-side aggregator without `$`. */
function turnUsageFileName(atIso: string): string {
  return `turn-usage-${atIso.slice(0, 13)}.jsonl`
}

/** Appends one usage line to the current hour's own `turn-usage-*.jsonl` file under the cache dir -- same append-then-best-effort shape appendMeasurement uses, but scoped to one hour so an append never touches an older file. */
async function appendTurnUsage($: EngineInterface, atIso: string, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/${turnUsageFileName(atIso)}`, line)
  } catch {
    // Recording is best-effort and must never block or fail a turn.
  }
}

/** Builds and appends this step's usage line. Never touches `e` beyond reading it, and never throws (appendTurnUsage already swallows its own errors; a `$.clock.now()` rejection here is the only other failure mode, left to the caller's own try/catch). `project`: JEVADV-63, the session's own resolved project name (or null when not yet known this session) -- read from the caller's cached OrcaContext, never re-resolved here. */
async function recordTurnUsage($: EngineInterface, e: Frozen<TurnStepInput>, r: TurnStepResult, project: string | null, effortLog: Record<string, unknown> = {}): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  const account = await resolveAccountId($)
  const line = JSON.stringify({
    at,
    agent: e.agentId === undefined ? 'main' : 'subagent',
    // 0.6.16 T1: the ids a router decision row carries, so the two join.
    sessionId: await readSessionId($),
    turnId: e.turnId,
    index: e.index,
    agentId: e.agentId ?? null,
    model: r.usage?.model ?? e.model,
    effort: e.effort ?? null,
    input: r.usage?.input_tokens ?? null,
    output: r.usage?.output_tokens ?? null,
    cacheRead: r.usage?.cache_read_input_tokens ?? null,
    cacheWrite: r.usage?.cache_creation_input_tokens ?? null,
    stopReason: r.stopReason,
    account,
    project,
    ...effortLog,
  })
  await appendTurnUsage($, at, `${line}\n`)
}

/**
 * 0.6.8 T7: the Models tab's "Models fixed by an agent definition", from
 * the worker's explicit-models.json mirror. Missing or unreadable reads as
 * "judge", the setting's default (parseExplicitModels).
 */
async function readExplicitModels($: EngineInterface): Promise<ExplicitModelsMode> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return parseExplicitModels(null)
    return parseExplicitModels(await readJsonFile($, `${paths.configDir}/${EXPLICIT_MODELS_MIRROR_FILE}`))
  } catch {
    return parseExplicitModels(null)
  }
}

/**
 * 0.6.8 T7: the model the definition of `subagentType` fixes, read from the
 * project's own `.claude/agents` first, then the account's (CLAUDE_CONFIG_DIR,
 * else `~/.claude`). null when none fixes one. 0.6.16 T3: with the effort it
 * declares, from the same lookup. Fails open to nulls.
 */
async function readAgentDefinition($: EngineInterface, subagentType: string, cwd: string): Promise<{ model: string | null; effort: SessionEffort | null }> {
  try {
    const files = await readAgentDefinitionFiles($, cwd)
    return { model: agentDefinitionModel(files, subagentType), effort: declaredEffort(agentDefinitionEffort(files, subagentType)) }
  } catch {
    return { model: null, effort: null }
  }
}

/** The agent definitions a subagent type may come from: the project's own `.claude/agents` first, then the account's. */
async function readAgentDefinitionFiles($: EngineInterface, cwd: string): Promise<AgentDefinitionFile[]> {
  const paths = await resolveHomePaths($)
  const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const accountDir = claudeConfigDir !== undefined && claudeConfigDir.length > 0 ? claudeConfigDir : paths ? `${paths.home}/.claude` : null
  const dirs = [`${cwd}/.claude/agents`, ...(accountDir === null ? [] : [`${accountDir}/agents`])]
  const files: AgentDefinitionFile[] = []
  for (const dir of dirs) {
    if (!(await $.fs.exists(dir))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
      try {
        files.push({ file: entry.name, text: await $.fs.read(`${dir}/${entry.name}`) })
      } catch {
        // An unreadable definition fixes nothing.
      }
    }
  }
  return files
}

/** One loop's (the main one's, or a subagent's) effort as its steps were sent, for the measure-only effort log. */
interface EffortLoop {
  readonly lastSent: SessionEffort | null
  readonly frontmatter: SessionEffort | null
  readonly settings: SessionEffort | null
}

function effortLevel(value: unknown): SessionEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : null
}

/**
 * 0.6.15 T4c (odd/research/effort-per-task.md §4): measure only. What the
 * turn-usage line adds about the effort: where the effort sent came from
 * (src/core/effort_source.ts), the effort the router would choose, whether a
 * subagent's model was fixed, and, on the first step after the effort
 * changed, how much of the prompt missed the cache. The definition and the
 * settings are read at a loop's first step and when its effort changes.
 * Never changes the step.
 */
async function effortLogFields($: EngineInterface, e: Frozen<TurnStepInput>, input: TurnStepInput | Frozen<TurnStepInput>, r: TurnStepResult, loops: Map<string, EffortLoop>, running: Map<string, RunningSubagent>, targets: Map<string, SubagentEffortTarget>): Promise<Record<string, unknown>> {
  const key = e.agentId ?? 'main'
  const sent = input.effort ?? null
  const loop = loops.get(key)
  const changed = loop !== undefined && loop.lastSent !== sent
  const agent = e.agentId === undefined ? undefined : running.get(e.agentId)
  const fresh = loop === undefined || changed
  const frontmatter = !fresh ? (loop?.frontmatter ?? null) : agent === undefined ? null : effortLevel(agentDefinitionEffort(await readAgentDefinitionFiles($, await $.session.cwd()), agent.type))
  const settings = !fresh ? (loop?.settings ?? null) : settingsEffortFor(await readVaultSettings($), e.model)
  loops.set(key, { lastSent: sent, frontmatter, settings })
  const source: EffortSource = effortSourceOf({ carried: e.effort ?? null, sent, env: effortLevel(await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')), frontmatter, settings, modelDefault: claudeCodeDefaultEffort(e.model) })
  const sticky = e.agentId === undefined ? (await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })).value : undefined
  const routerEffort = e.agentId === undefined ? (sticky?.effort ?? null) : (targets.get(e.agentId)?.effort ?? null)
  const share = changed ? uncachedShare({ input: r.usage?.input_tokens ?? null, cacheRead: r.usage?.cache_read_input_tokens ?? null, cacheWrite: r.usage?.cache_creation_input_tokens ?? null }) : undefined
  // 0.6.16 T4: with the effort before the change and the prompt's size, so a miss can be weighed.
  const change = !changed ? {} : { prevEffort: loop?.lastSent ?? null, promptTokens: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0) }
  return { effortSource: source, routerEffort, modelFixed: agent === undefined ? null : agent.why === 'explicit', effortChanged: changed, ...(share === undefined ? {} : { uncachedShare: share }), ...change }
}

/** The main loop's turn so far, for the measure-only phase log (0.6.16 T4); a subagent's steps are not held. */
interface PhaseHolder {
  turn: PhaseTurn | null
}

/**
 * 0.6.16 T4 (odd/research/phase-effort.md §6 B): measure only. A main step's
 * phase (src/core/step_phase.ts), the previous step's, the EXEC run it
 * follows and the effort the would-be hold rule sends. The hook cannot see
 * Claude Code's `perTurnEffort`, so it is not logged; the row's
 * `sessionId`/`turnId`/`index` and usage join it to the transcript, which
 * carries it. Never changes the step.
 */
function phaseLogFields(e: Frozen<TurnStepInput>, input: TurnStepInput | Frozen<TurnStepInput>, r: TurnStepResult, holder: PhaseHolder): Record<string, unknown> {
  if (e.agentId !== undefined) return {}
  const turn: PhaseTurn = holder.turn !== null && holder.turn.turnId === e.turnId ? holder.turn : { turnId: e.turnId, steps: [] }
  const hold = holdEffort(turn, input.effort ?? null, input.model)
  const phase = stepPhase(r.toolUses, r.stopReason)
  holder.turn = withStep(turn, phase)
  return { phase, prevPhase: turn.steps.at(-1)?.phase ?? null, execRun: hold.execRun, holdEffort: hold.effort }
}

/**
 * 0.6.14 T1: the subagents running now, in the order they started. The Map
 * is this load's; `$.state` (`runningSubagents`) keeps a copy so a plugin
 * reload in the same session does not forget them. `hydrated` reads that
 * copy back once per load, before anything is written over it; `writes`
 * chains the writes, each one the whole set as it is when it runs, so an
 * older snapshot never lands after a newer one.
 */
interface RunningSet {
  readonly agents: Map<string, RunningSubagent>
  hydrated: Promise<void> | null
  writes: Promise<void>
}

/** Reads the kept copy back into this load's set, once. What this load already recorded wins, after the kept ones (they started earlier). Fails open: nothing kept, nothing added. */
function hydrateRunning($: EngineInterface, set: RunningSet): Promise<void> {
  set.hydrated ??= (async () => {
    try {
      const stored = parseRunningSubagents((await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'runningSubagents' })).value)
      const fresh = [...set.agents.values()]
      set.agents.clear()
      for (const agent of [...stored, ...fresh]) set.agents.set(agent.id, agent)
    } catch {
      // Nothing kept: this load's own records stand.
    }
  })()
  return set.hydrated
}

/** Writes the set to `$.state`, after any write already queued. Best-effort. */
function persistRunning($: EngineInterface, set: RunningSet): Promise<void> {
  set.writes = set.writes.then(async () => {
    try {
      await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'runningSubagents' }, { agents: [...set.agents.values()].map((agent) => ({ ...agent })) })
    } catch {
      // A lost copy only costs a reload's memory, never the spawn or the step.
    }
  })
  return set.writes
}

/** `$.agent.list()` as the fields the running set reads; null when the host has none or it fails. */
async function listAgents($: EngineInterface): Promise<ListedAgent[] | null> {
  try {
    return (await $.agent.list()).map((agent) => ({ id: agent.id, type: agent.type, description: agent.description, status: agent.status }))
  } catch {
    return null
  }
}

/**
 * 0.6.8 T6: the status-line part for the subagents running now. First
 * drops, through `$.agent.list()`, any subagent that ended without its
 * turn.complete reaching this module (killed, failed): one the host lists
 * as not running, or no longer lists at all -- never `keep`, the one just
 * started. Fails open: no list, no pruning. 0.6.14 T1: an agent the host
 * runs that nothing recorded (it started before this plugin loaded) is
 * counted too, as "no data"; the pruned set is kept in `$.state`.
 */
async function runningSubagentsStatus($: EngineInterface, running: RunningSet, keep: string | null): Promise<string | null> {
  await hydrateRunning($, running)
  const { kept, shown } = reconcileRunning([...running.agents.values()], await listAgents($), keep)
  if (kept.length !== running.agents.size) for (const id of [...running.agents.keys()]) if (!kept.some((agent) => agent.id === id)) running.agents.delete(id)
  await persistRunning($, running)
  return subagentsStatusPart(await resolveLocale($), shown)
}

/** 0.6.14 T1: the effort a subagent's step was sent with, onto its record (only when it changed); 0.6.15 T4b: and where it came from. Best-effort. */
async function noteSubagentEffort($: EngineInterface, running: RunningSet, agentId: string, effort: SessionEffort | null, effortSource: SubagentEffortSource): Promise<void> {
  await hydrateRunning($, running)
  const agent = running.agents.get(agentId)
  if (agent === undefined || (agent.effort === effort && agent.effortSource === effortSource)) return
  running.agents.set(agentId, { ...agent, effort, effortSource })
  await persistRunning($, running)
}

// ---------------------------------------------------------------------------
// Model router (JEV-060 slice 2, odd/tasks/jev-060-router.md): Jev picks the
// model and effort a session needs, where switching costs nothing -- a cold
// context. The prompt cache is per model AND per effort (§2), so a switch
// inside a warm conversation re-writes the whole context; that is why the
// decision is made once at session start (point A) and then kept STICKY on
// every later main-loop step, in `$.state` (it survives a hot reload; a
// module variable would not).
//
// Mode (`options.routerMode`, the manifest's userConfig picker, §7):
//   off      -- nothing runs;
//   measure  -- decide, log, show "would use:", change nothing (default);
//   active   -- apply the decision.
// Fails open like every other path here: any error leaves the step as it was.
// ---------------------------------------------------------------------------

const ROUTER_BUDGET_MS = 800

/** A JSON file through `$.fs`, or null when missing, unreadable or malformed. */
async function readJsonFile($: EngineInterface, path: string): Promise<unknown> {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

/**
 * This account's tier → model map (§5): the vault settings.json `env`
 * (`<CLAUDE_CONFIG_DIR>/settings.json`, or `~/.claude/settings.json` with no
 * vault), with the live process env filling what the vault does not set;
 * the worker's models-catalog.json and quota.json mirrors. The same
 * settings.json carries the person's per-tier effort (0.6.2 E3), in the
 * router options the config panel writes.
 */
async function readVaultSettings($: EngineInterface): Promise<unknown> {
  const paths = await resolveHomePaths($)
  const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const vaultDir = claudeConfigDir !== undefined && claudeConfigDir.length > 0 ? claudeConfigDir : paths ? `${paths.home}/.claude` : null
  return vaultDir === null ? null : readJsonFile($, `${vaultDir}/settings.json`)
}

/**
 * The 5-hour and 7-day windows Claude Code hands its status line, live for
 * this session's account (`$.session.usage().rateLimits`). Empty when the
 * session has no reading yet (before its first API response, off a
 * subscription) or the call fails: the router then falls back to the mirror.
 */
async function readLiveRateLimits($: EngineInterface): Promise<readonly LiveRateLimit[]> {
  try {
    const usage = await $.session.usage()
    return usage.rateLimits.map((window) => ({ kind: window.kind, percentUsed: window.percentUsed, ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) }))
  } catch {
    return []
  }
}

async function resolveRouterAccount($: EngineInterface, account: string): Promise<{ tiers: ResolvedTiers; band: QuotaBand; quotaSource: QuotaSource; tierEffort: TierEffortMap; personTiers: ReadonlySet<RouterTier>; workKindMode: WorkKindMode }> {
  const paths = await resolveHomePaths($)
  const vaultSettings = await readVaultSettings($)
  const vaultEnv = vaultSettings === null ? {} : parseVaultEnv(vaultSettings)
  const [baseUrl, opusModel, sonnetModel, haikuModel, mainModel] = await Promise.all([
    $.env.get('ANTHROPIC_BASE_URL'),
    $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    $.env.get('ANTHROPIC_MODEL'),
  ])
  const processEnv: Record<string, string> = {}
  const pairs: readonly (readonly [string, string | undefined])[] = [
    ['ANTHROPIC_BASE_URL', baseUrl],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', opusModel],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', sonnetModel],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', haikuModel],
    ['ANTHROPIC_MODEL', mainModel],
  ]
  for (const [key, value] of pairs) if (value !== undefined && value.length > 0) processEnv[key] = value
  const catalog = paths ? parseModelsMirror(await readJsonFile($, `${paths.configDir}/models-catalog.json`)).models : []
  const quotaFile = paths ? parseQuota(await readJsonFile($, `${paths.configDir}/quota.json`)) : { accounts: [], checkedAt: null }
  const quota = quotaFile.accounts.find((row) => row.id === account) ?? null
  const tiers = resolveAccountTiers({ env: { ...processEnv, ...vaultEnv }, catalog, quota })
  const pressure = quotaPressureOf({ live: await readLiveRateLimits($), mirror: quota, mirrorCheckedAt: quotaFile.checkedAt, nowMs: await $.clock.now() })
  return { tiers, band: pressure.band, quotaSource: pressure.source, tierEffort: routerEffortFromSettings(vaultSettings), personTiers: routerEffortPersonTiers(vaultSettings), workKindMode: workKindModeFromSettings(vaultSettings) }
}

/**
 * 0.6.2 E2: the median output per main step at each effort on `model`, from
 * this account's own hourly turn-usage files of the last 7 days (what
 * recordTurnUsage wrote). null on any failure: the saving is unknown, so
 * the effort is not lowered.
 */
async function loadEffortOutputs($: EngineInterface, account: string, model: string): Promise<EffortOutputs | null> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return null
    const sinceMs = (await $.clock.now()) - EFFORT_WINDOW_MS
    const lines: string[] = []
    for (const entry of await $.fs.list(paths.cacheDir)) {
      if (entry.kind !== 'file' || !isRecentTurnUsageFile(entry.name, sinceMs)) continue
      lines.push(...(await $.fs.read(`${paths.cacheDir}/${entry.name}`)).split('\n'))
    }
    return effortOutputMedians(lines, { account, model, sinceMs })
  } catch {
    return null
  }
}

/** Appends one decision line to the current hour's `model-router-decisions-*.jsonl`, best-effort. */
async function appendRouterDecision($: EngineInterface, atIso: string, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/${routerDecisionFileName(atIso)}`, line)
  } catch {
    // Logging is best-effort and must never block or fail a turn.
  }
}

/**
 * The destination guard's input for `cwd` (gap G6): the Bash gate's own
 * `catalog.json` / `policies.json` mirrors, matched on the cwd and then on
 * its linked worktree's main checkout (the gate's own fallback, resolved
 * here through git since the hooks module has no Node filesystem calls).
 * Any failure is "unknown", which never holds the floor on its own.
 */
async function resolveSessionDestination($: EngineInterface, cwd: string): Promise<RouterDestination> {
  const unknown: RouterDestination = { destinationKind: null, destinationId: null, policyHit: false, status: 'unknown' }
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return unknown
    const catalog = await readJsonFile($, `${paths.configDir}/catalog.json`)
    const policies = await readJsonFile($, `${paths.configDir}/policies.json`)
    const candidates = [cwd]
    try {
      const commonDir = await makeProcessRun($)(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      const dir = commonDir.exitCode === 0 ? commonDir.stdout.trim() : ''
      if (dir.endsWith('/.git')) candidates.push(dir.slice(0, -'/.git'.length))
    } catch {
      // No git, or git too slow: the cwd alone is matched.
    }
    return resolveRouterDestination({ catalog, policies, candidates })
  } catch {
    return unknown
  }
}

/** Jev's tier judgment for this turn's prompt, or null on any failure (no key, timeout, malformed answer). */
async function askTierJudgment($: EngineInterface, options: PluginOptions, promptText: string, activity: TurnActivity | null, band: QuotaBand, destinationKind: DestinationKind | null): Promise<TierJudgment | null> {
  return (await askTierAndKind($, options, promptText, activity, band, destinationKind, false)).tier
}

/** The tier judgment and, 0.6.16 T2, at a spawn (`withKind`) the work kind: both from the one Jev call; nulls on any failure. */
async function askTierAndKind($: EngineInterface, options: PluginOptions, promptText: string, activity: TurnActivity | null, band: QuotaBand, destinationKind: DestinationKind | null, withKind: boolean): Promise<{ tier: TierJudgment | null; kind: WorkKindJudgment | null }> {
  try {
    const apiKey = await resolveApiKey($, options)
    if (apiKey === null) return { tier: null, kind: null }
    const state = buildTierState({ promptText, activity, destinationKind, quotaBand: band })
    const questions = withKind ? withWorkKindQuestion(buildTierQuestions()) : buildTierQuestions()
    const response = await callJev(apiKey, state, questions, { budgetMs: ROUTER_BUDGET_MS, fetchImpl: makeJevFetch($), sleepImpl: makeJevSleep($) })
    return { tier: interpretTier(response.answers), kind: withKind ? interpretWorkKind(response.answers) : null }
  } catch {
    return { tier: null, kind: null }
  }
}

function stickyEffort(effort: TurnStepInput['effort']): RouterSticky['effort'] {
  return effort === undefined ? null : effort
}

/** `e` with `model`/`effort` replaced; an effort of null is left out of the request altogether (Haiku, a gateway). */
function withModel(e: Frozen<TurnStepInput>, model: string, effort: RouterSticky['effort']): TurnStepInput {
  const { effort: _dropped, ...rest } = e
  void _dropped
  return effort === null ? { ...rest, model } : { ...rest, model, effort }
}

/** The status-line text for a decision, or null when there is nothing to say (Jev failed). A kept model says why (keptWhy). */
function routerStatusFor(decision: Pick<RouterDecision, 'tier' | 'model' | 'effort'> & KeptDecision, tiers: ResolvedTiers, mode: 'measure' | 'active', locale: Locale): string | null {
  if (decision.tier === null) return null
  const tier = tierOfModel(tiers, decision.model)
  const label = tier === null ? decision.model : tiers[tier].label
  const effort = typeof decision.effort === 'string' ? toRouterEffort(decision.effort) : null
  return routerStatusText(locale, mode, { label, effort, tier: decision.tier, kept: keptWhy(decision) })
}

/** Real prompts in the transcript: user messages with text and no tool results. */
function isRealPrompt(message: ActivityMessage): boolean {
  return message.role === 'user' && message.text.trim().length > 0 && (message.toolResults === undefined || message.toolResults.length === 0)
}

/**
 * What a step carries under the sticky choice: rewritten only in ACTIVE
 * mode (review finding 3 -- a sticky value written in active mode survives
 * the reload into measure mode, and measure must change nothing) and only
 * while the session still runs the model the router took over from.
 */
function stickyStepInput(e: Frozen<TurnStepInput>, sticky: RouterSticky | undefined, mode: RouterMode): TurnStepInput | Frozen<TurnStepInput> {
  if (sticky === undefined || mode !== 'active' || !sticky.rewrite) return e
  if (e.model !== sticky.configuredModel || stickyEffort(e.effort) !== sticky.configuredEffort) return e
  return withModel(e, sticky.model, sticky.effort)
}

interface RoutedStep {
  readonly input: TurnStepInput | Frozen<TurnStepInput>
  /** New status-line text; null leaves the status line as it is. */
  readonly status: string | null
}

const EMPTY_STATS: RouterSessionStats = { turnId: null, turnSteps: 0, stepsPerTurn: [], lastContext: null, outputTotal: 0, outputSteps: 0 }

/** The last real prompt of the transcript (a user message with text and no tool results). */
function lastPromptText(messages: readonly ActivityMessage[]): string {
  const found = [...messages].reverse().find(isRealPrompt)
  return found?.text ?? ''
}

/** This session's usage for break-even, or null before any step recorded one. Counts the turn in progress as completed: it is, once a new turn starts. */
function sessionUsageOf(stats: RouterSessionStats): SessionUsage | null {
  if (stats.lastContext === null || stats.outputSteps === 0) return null
  const turns = stats.turnId === null ? stats.stepsPerTurn : [...stats.stepsPerTurn, stats.turnSteps]
  return { contextTokens: stats.lastContext, avgOutput: stats.outputTotal / stats.outputSteps, medianStepsPerTurn: medianOf(turns) }
}

/**
 * The router's part of one MAIN-loop step (§3): point A on a fresh
 * session's first step, point C on the first step of every later turn, the
 * sticky choice on every other step, adoption of the session's own model
 * on a warm session or after the person switched.
 */
async function routeMainStep($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', options: PluginOptions, project: string | null): Promise<RoutedStep> {
  const stickyRead = await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })
  const sticky = stickyRead.value
  // JEV-061: `prompt.submit` stamps this before every turn; a missing stamp
  // (the module reloaded mid-turn and lost `$.state`, or an older engine
  // build with no `prompt.submit`) keeps today's behaviour -- treated as a
  // person's own prompt, exactly as if this gate did not exist.
  const originRead = await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerPromptOrigin' })
  const originKind = originRead.value?.kind ?? null
  const personAuthored = originKind === null || isPersonPromptOrigin(originKind)

  const adopt = async (lastPrompt: RouterSticky['lastPrompt']): Promise<RoutedStep> => {
    const own: RouterSticky = { model: e.model, effort: stickyEffort(e.effort), rewrite: false, configuredModel: e.model, configuredEffort: stickyEffort(e.effort), tier: null, pendingLower: null, stats: EMPTY_STATS, lastPrompt }
    await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, own)
    return { input: e, status: null }
  }

  if (sticky !== undefined) {
    // The person (or the engine's fallback) moved the session off the
    // model the router took over from: their choice wins from here on.
    if (e.model !== sticky.configuredModel || stickyEffort(e.effort) !== sticky.configuredEffort) {
      // The status line says so, rather than showing the router's older
      // decision (review nit 10).
      const adopted = await adopt(sticky.lastPrompt)
      const { tiers } = await resolveRouterAccount($, await resolveAccountId($))
      const tier = tierOfModel(tiers, e.model)
      return { ...adopted, status: routerPersonStatusText(await resolveLocale($), mode, tier === null ? e.model : tiers[tier].label) }
    }
    if (e.index !== 0 || sticky.stats.turnId === e.turnId) return { input: stickyStepInput(e, sticky, mode), status: null }
    // A new turn: point C only when a new real prompt started it (review
    // finding 4), keyed on the prompt's identity so /compact cannot hide
    // one (N3), AND that prompt is a person's own (JEV-061) -- a
    // notification's different text would otherwise read as a new prompt
    // too, since `$.session.messages()` carries no origin. Either way, a
    // turn the engine (or a notification) started asks Jev nothing, but
    // its local guards still hold the floor (N2); `sticky.lastPrompt` is
    // left untouched by that path, so the NEXT person prompt is still
    // compared against the last one Jev actually decided on (N3).
    //
    // The two "no Jev" cases read different activity, though: the engine
    // truly starting a turn with NO new message (a subagent finished) means
    // the transcript's last real prompt is still the person's own, so
    // "since it" (summarizeSinceLastPrompt) is the current turn's own work.
    // A notification, in contrast, IS a new message -- it becomes the
    // transcript's own "last real prompt" the same generic, origin-blind
    // way the person's would, so the failure or sensitive work it should
    // hold the floor over is the turn BEFORE it (summarizePreviousTurn,
    // the same window routeStage would read for a genuine new prompt).
    const turnMessages = await $.session.messages()
    const promptKey = lastPromptKey(turnMessages)
    if (!isNewPrompt(sticky.lastPrompt, promptKey)) return routeEngineTurn($, e, mode, sticky, lastPromptText(turnMessages), summarizeSinceLastPrompt(turnMessages), originKind, project)
    if (!personAuthored) return routeEngineTurn($, e, mode, sticky, lastPromptText(turnMessages), summarizePreviousTurn(turnMessages), originKind, project)
    return routeStage($, e, mode, options, sticky, turnMessages, promptKey, originKind, project)
  }

  const messages = await $.session.messages()
  const promptKey = lastPromptKey(messages)
  // Warm: the mode was switched on mid-session or the module reloaded
  // without its state. Adopt, change nothing (§3); from here only point C.
  // The status line says the model was kept and why (0.6.2 E8).
  if (e.index !== 0 || messages.some((message) => message.role === 'assistant')) {
    const adopted = await adopt(promptKey)
    const { tiers } = await resolveRouterAccount($, await resolveAccountId($))
    const tier = tierOfModel(tiers, e.model)
    return { ...adopted, status: routerWarmStatusText(await resolveLocale($), mode, tier === null ? e.model : tiers[tier].label) }
  }
  // Point A: the very first prompt of a fresh session is not a person's own
  // (JEV-061) -- keep the session's configured model and decide once a
  // person's own prompt actually arrives, the same "adopt now, decide
  // later" shape the warm-session branch above already uses.
  if (!personAuthored) return adopt(promptKey)

  const promptText = lastPromptText(messages)
  const account = await resolveAccountId($)
  const { tiers, band, quotaSource, tierEffort } = await resolveRouterAccount($, account)
  const destination = await resolveSessionDestination($, await $.session.cwd())
  const jev = await askTierJudgment($, options, promptText, null, band, destination.destinationKind)
  const decision = decideStart({
    tierEffort,
    tiers,
    jev,
    configuredModel: e.model,
    configuredEffort: stickyEffort(e.effort),
    guards: { text: promptText, activity: null, confidence: jev?.confidence ?? null },
    band,
  })
  const applied = mode === 'active' && decision.changed
  const at = new Date(await $.clock.now()).toISOString()
  await appendRouterDecision($, at, `${JSON.stringify(routerDecisionRecord({ at, account, point: 'start', decision, applied, quotaBand: band, quotaSource, origin: originKind, project, sessionId: await readSessionId($), turnId: e.turnId }))}\n`)

  const own = { configuredModel: e.model, configuredEffort: stickyEffort(e.effort), pendingLower: null, stats: EMPTY_STATS, lastPrompt: promptKey }
  const next: RouterSticky = decision.changed
    ? { ...own, model: decision.model, effort: decision.effort, rewrite: applied, tier: decision.tier }
    : { ...own, model: e.model, effort: stickyEffort(e.effort), rewrite: false, tier: decision.tier }
  await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, next)

  const status = routerStatusFor(decision, tiers, mode, await resolveLocale($))
  return { input: stickyStepInput(e, next, mode), status }
}

/** Point C (§6.4): the first step of a later turn. Asks Jev about the new prompt with the previous turn's activity, and moves the sticky model only as decideStage allows. */
/**
 * A turn with no Jev call (N2: the engine started it by itself; JEV-061: its
 * latest prompt is not a person's own): the local guards over `activity`
 * alone. When the sticky model is below the session's own and that work
 * failed or touches a sensitive topic, the session's own model and effort
 * come back. The caller picks which window `text`/`activity` come from --
 * see routeMainStep's own note on the two cases reading a different one.
 */
async function routeEngineTurn($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', sticky: RouterSticky, text: string, activity: TurnActivity | null, originKind: string | null, project: string | null): Promise<RoutedStep> {
  const account = await resolveAccountId($)
  const { tiers, band, quotaSource } = await resolveRouterAccount($, account)
  const decision = decideEngineTurn({
    tiers,
    currentModel: sticky.model,
    configuredModel: sticky.configuredModel,
    configuredEffort: sticky.configuredEffort,
    text,
    activity,
  })
  if (decision === null) return { input: stickyStepInput(e, sticky, mode), status: null }
  const at = new Date(await $.clock.now()).toISOString()
  await appendRouterDecision($, at, `${JSON.stringify(routerDecisionRecord({ at, account, point: 'stage', decision, applied: mode === 'active', quotaBand: band, quotaSource, origin: originKind, project, sessionId: await readSessionId($), turnId: e.turnId }))}\n`)
  const next: RouterSticky = { ...sticky, model: decision.model, effort: decision.effort, rewrite: false, pendingLower: null }
  await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, next)
  return { input: stickyStepInput(e, next, mode), status: null }
}

async function routeStage($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', options: PluginOptions, sticky: RouterSticky, messages: readonly ActivityMessage[], promptKey: RouterSticky['lastPrompt'], originKind: string | null, project: string | null): Promise<RoutedStep> {
  const promptText = lastPromptText(messages)
  const activity = summarizePreviousTurn(messages)
  const account = await resolveAccountId($)
  const { tiers, band, quotaSource, tierEffort } = await resolveRouterAccount($, account)
  const destination = await resolveSessionDestination($, await $.session.cwd())
  const jev = await askTierJudgment($, options, promptText, activity, band, destination.destinationKind)
  const stageInput: StageDecisionInput = {
    tiers,
    tierEffort,
    jev,
    currentModel: sticky.model,
    currentEffort: sticky.effort,
    configuredModel: sticky.configuredModel,
    configuredEffort: sticky.configuredEffort,
    guards: { text: promptText, activity, confidence: jev?.confidence ?? null },
    band,
    pending: sticky.pendingLower,
    usage: sessionUsageOf(sticky.stats),
  }
  let decision: StageDecision = decideStage(stageInput)
  // The account's real output medians are read only when an effort
  // lowering has come this far (0.6.2 E2): no file is read otherwise.
  if (decision.reason === 'effort-unknown-savings') {
    const effortOutput = await loadEffortOutputs($, account, sticky.model)
    if (effortOutput !== null) decision = decideStage({ ...stageInput, effortOutput })
  }
  const applied = mode === 'active' && decision.changed
  const at = new Date(await $.clock.now()).toISOString()
  const record = routerDecisionRecord({ at, account, point: 'stage', decision, applied, quotaBand: band, quotaSource, breakEven: decision.breakEven, origin: originKind, effort: decision.effortTarget, project, sessionId: await readSessionId($), turnId: e.turnId })
  await appendRouterDecision($, at, `${JSON.stringify(record)}\n`)

  const next: RouterSticky = decision.changed
    ? {
        ...sticky,
        model: decision.model,
        effort: decision.effort,
        rewrite: mode === 'active' && (decision.model !== sticky.configuredModel || decision.effort !== sticky.configuredEffort),
        tier: decision.tier ?? sticky.tier,
        pendingLower: null,
        lastPrompt: promptKey,
      }
    : { ...sticky, pendingLower: decision.pending, lastPrompt: promptKey }
  await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, next)

  const shown = { tier: decision.tier, model: next.model, effort: next.effort, effortTarget: decision.effortTarget, reason: decision.reason, guard: decision.guard, changed: decision.changed, proposed: decision.proposed }
  const status = decision.tier === null ? null : routerStatusFor(shown, tiers, mode, await resolveLocale($))
  return { input: stickyStepInput(e, next, mode), status }
}

/** After each main step: this session's usage for break-even (§6.4), kept in the sticky state. Best-effort. */
async function recordRouterStats($: EngineInterface, e: Frozen<TurnStepInput>, r: TurnStepResult): Promise<void> {
  const read = await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })
  const sticky = read.value
  if (sticky === undefined) return
  const stats = sticky.stats
  const newTurn = stats.turnId !== e.turnId
  const stepsPerTurn = newTurn && stats.turnId !== null ? [...stats.stepsPerTurn, stats.turnSteps].slice(-20) : stats.stepsPerTurn
  const usage = r.usage
  const context = usage === null ? null : usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + usage.output_tokens
  const next: RouterSessionStats = {
    turnId: e.turnId,
    turnSteps: newTurn ? 1 : Math.max(stats.turnSteps, e.index + 1),
    stepsPerTurn,
    lastContext: context ?? stats.lastContext,
    outputTotal: stats.outputTotal + (usage?.output_tokens ?? 0),
    outputSteps: stats.outputSteps + (usage === null ? 0 : 1),
  }
  await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, { ...sticky, stats: next })
}

/**
 * `agent.spawn` -- point B (§3, T8). A subagent starts cold, so its model
 * is chosen for free: Jev reads the task the parent gave it. A fork keeps
 * the parent's model by definition (its `model` is ignored), so it is left
 * alone. Measure mode logs; active mode sets a full model id. Fails open.
 *
 * JEV-061 slice 2: a subagent's FIRST step is the other place a switch is
 * free -- but it inherits the parent's own effort, clamped to what its
 * model supports, never the tier's own (a standard-work subagent on Sonnet
 * ran every step at the parent's `xhigh`, clamped to `high`). The target
 * effort is decided here, once, active mode only, only with no explicit
 * `model` from the parent (that is intent) and no guard holding at spawn;
 * `subagentEffortTarget` remembers it by the started subagent's own
 * `agentId` (`AgentSpawnResult`, set once `next` resolves) for `turn.step`
 * (below) to apply -- unguarded, the tier's effort wins outright, up or
 * down; guarded, it may only rise (0.6.3 F0, `subagentStepEffort`,
 * src/core) -- and never touches a person's own `max` or numeric budget.
 *
 * 0.6.3 (JEVADV-63 R1): the `point: 'subagent'` decision line's `effort`
 * field is NOT written here. At spawn time the inherited effort the first
 * `turn.step` will actually see is not yet known, so writing it here could
 * diverge from what that step sends (a guard preserving a higher inherited
 * value than the tier's target, for one). What's decided here (account,
 * tier/model decision, quota band, project) is carried in
 * `subagentEffortTarget` to `handleTurnStep`, which appends the one
 * `point: 'subagent'` log line, with the effort it actually computed and
 * sent, on that subagent's first (`index === 0`) step.
 */
/** What `routeSubagent` decided for a subagent, carried to `handleTurnStep`: the step-effort target and whether a guard held (`subagentStepEffort`, src/core), whether an effort rewrite even applies, and everything the deferred `point: 'subagent'` router-decision log line needs to be written once, at that subagent's first step. */
interface SubagentEffortTarget {
  readonly effort: TierEffort | null
  readonly guarded: boolean
  /** 0.6.16 T3: the effort the agent's definition declares, a floor the step never goes below; null when it declares none. */
  readonly declared: SessionEffort | null
  /** 0.6.16 T2: the work kind (Jev's, else the keywords'), the keywords' own as a cross-check, the switch, and what its guards read; kept in memory only, never logged as text. */
  readonly workKindMode: WorkKindMode
  readonly kind: WorkKindJudgment | null
  readonly keywordKind: WorkKindJudgment['kind'] | null
  readonly text: string
  readonly destinationKind: DestinationKind | null
  readonly effortEligible: boolean
  readonly logged: boolean
  readonly account: string
  readonly decision: SubagentDecision
  readonly applied: boolean
  readonly quotaBand: QuotaBand
  readonly quotaSource: QuotaSource
  readonly project: string | null
}

async function routeSubagent($: EngineInterface, e: Frozen<AgentSpawnInput>, next: Next<'agent.spawn'>, mode: RouterMode, options: PluginOptions, subagentEffortTarget: Map<string, SubagentEffortTarget>, project: string | null, runningSubagents: Map<string, RunningSubagent>): Promise<AgentSpawnResult> {
  // 0.6.8 T6: every started subagent is remembered with the model it runs
  // and why, for the status line -- in every mode, a fork and a failure
  // included. Visibility only: this never changes what is spawned.
  // 0.6.14 T1: with what it is and does (its type and description), and in
  // measure mode the model the router would have given it; its effort
  // comes with its first step (noteSubagentEffort).
  const explicitModelGiven = e.model !== undefined && e.model !== 'inherit'
  let wouldUse: string | null = null
  const remember = (result: AgentSpawnResult, tiers: ResolvedTiers | null, why: SubagentWhy): void => {
    if ('agentId' in result && result.agentId !== undefined) {
      runningSubagents.set(result.agentId, { id: result.agentId, type: e.subagentType, description: e.description, label: subagentModelLabel(result.model ?? e.parentModel, tiers), effort: null, effortSource: null, why, wouldUse })
    }
  }
  if (mode === 'off' || e.fork) {
    const result = await next(e)
    remember(result, null, explicitModelGiven && !e.fork ? 'explicit' : 'inherited')
    return result
  }
  let input: AgentSpawnInput | Frozen<AgentSpawnInput> = e
  let pending: Omit<SubagentEffortTarget, 'logged'> | null = null
  let labelTiers: ResolvedTiers | null = null
  let why: SubagentWhy = explicitModelGiven ? 'explicit' : 'inherited'
  try {
    // 0.6.8 T7: a model the agent definition fixes counts as fixed too; the
    // spawn input only carries the Agent call's own.
    const cwd = e.cwd ?? (await $.session.cwd())
    const definition = await readAgentDefinition($, e.subagentType, cwd)
    const fixedModel = explicitModelGiven ? (e.model as string) : definition.model
    const modelFixed = fixedModel !== null
    if (modelFixed) why = 'explicit'
    const account = await resolveAccountId($)
    const { tiers, band, quotaSource, tierEffort, personTiers, workKindMode } = await resolveRouterAccount($, account)
    labelTiers = tiers
    const text = `${e.description}\n${e.prompt}`
    const destination = await resolveSessionDestination($, cwd)
    // 0.6.16 T2: the work kind is one more question in this same call.
    const judged = await askTierAndKind($, options, text, null, band, destination.destinationKind, workKindMode !== 'off')
    const jev = judged.tier
    const keywordKind = workKindMode === 'off' ? null : keywordWorkKind(e.description)
    const kind: WorkKindJudgment | null = workKindMode === 'off' ? null : (judged.kind ?? (keywordKind === null ? null : { kind: keywordKind, confidence: null, source: 'keywords' }))
    const decision = decideSubagent({
      tiers,
      jev,
      parentModel: e.parentModel,
      explicitModel: fixedModel ?? undefined,
      guards: { text, activity: null, confidence: jev?.confidence ?? null },
      band,
      // 0.6.8 T7: a model the spawn already fixed is judged unless the
      // person chose to keep them (the Models tab); only applied below in
      // active mode, like every other router decision.
      explicitModels: await readExplicitModels($),
      destinationKind: destination.destinationKind,
    })
    // A guard no longer makes the effort ineligible: it only stops it from
    // falling (0.6.2 F0, review finding 2).
    const guarded = decision.guard !== null
    const effortEligible = mode === 'active' && !modelFixed && decision.tier !== null
    // 0.6.16 T1: the router's own low only on confident read or execute work, with the switch active.
    const targetEffort = effortEligible && decision.tier !== null ? (tiers[decision.tier].supportsEffort ? readWorkTierEffort(decision.tier, tierEffort[decision.tier], personTiers.has(decision.tier), workKindMode === 'active' ? kind : null) : null) : null
    const applied = mode === 'active' && decision.changed
    pending = { effort: targetEffort, guarded, declared: definition.effort, workKindMode, kind, keywordKind, text, destinationKind: destination.destinationKind, effortEligible, account, decision, applied, quotaBand: band, quotaSource, project }
    why = subagentWhy({ decision, applied, explicit: modelFixed })
    if (mode === 'measure' && decision.changed) wouldUse = subagentModelLabel(decision.model, tiers)
    if (applied) input = { ...e, model: decision.model }
  } catch {
    input = e
    pending = null
  }
  const result = await next(input)
  if (pending !== null && 'agentId' in result && result.agentId !== undefined) subagentEffortTarget.set(result.agentId, { ...pending, logged: false })
  remember(result, labelTiers, why)
  return result
}

/**
 * `turn.step` -- the router (main loop only, when not off) rewrites
 * `model`/`effort` going down; a subagent's own steps (JEV-061 slice 2) get
 * only the effort `routeSubagent` decided for them at spawn, applied on
 * every step of that agent (`subagentEffortTarget`, keyed by `agentId`) --
 * unguarded it applies outright (both directions), guarded it only ever
 * rises (0.6.3 F0). Everything else streams through unchanged
 * (`yield* next(...)`), and this step's usage is recorded once the
 * response is whole. Every half fails open: a routing failure sends the
 * step as it was, a recording failure is swallowed.
 *
 * 0.6.3 (JEVADV-63 R1): a subagent's own `point: 'subagent'` router-decision
 * log line is written here, once, on that subagent's first (`index === 0`)
 * step -- not at spawn (`routeSubagent`) -- so its `effort` field always
 * matches what this step actually computed and sent, never the raw
 * pre-computed target (a guard can hold a higher inherited value than the
 * tier's own target, which spawn time never sees).
 */
async function* handleTurnStep($: EngineInterface, e: Frozen<TurnStepInput>, next: StreamNext<'turn.step'>, mode: RouterMode, options: PluginOptions, showRouterStatus: (text: string) => void, subagentEffortTarget: Map<string, SubagentEffortTarget>, project: string | null, noteEffort: (agentId: string, effort: SessionEffort | null, source: SubagentEffortSource) => Promise<void>, effortLog: (e: Frozen<TurnStepInput>, input: TurnStepInput | Frozen<TurnStepInput>, r: TurnStepResult) => Promise<Record<string, unknown>>): StreamHookBody<TurnStepChunk, TurnStepResult> {
  let input: TurnStepInput | Frozen<TurnStepInput> = e
  if (mode !== 'off' && e.agentId === undefined) {
    let held: RouterSticky | undefined
    try {
      held = (await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })).value
      const routed = await routeMainStep($, e, mode, options, project)
      input = routed.input
      if (routed.status !== null) showRouterStatus(routed.status)
    } catch {
      // A routing failure keeps the sticky choice rather than flipping this
      // one step to the session's model and back (two cache rewrites for
      // one failure, review finding 12).
      input = stickyStepInput(e, held, mode)
    }
  } else if (e.agentId !== undefined && subagentEffortTarget.has(e.agentId)) {
    const target = subagentEffortTarget.get(e.agentId)
    // null: no effort decision applies here (this record's own honest
    // "not eligible" state) -- not the effort the step happens to carry.
    let loggedEffort: SessionEffort | null = null
    let workKind: WorkKindRecord | null = null
    try {
      if (target !== undefined) {
        const tiered = target.effortEligible ? subagentStepEffort(target.effort, e.effort, target.guarded, target.declared) : e.effort
        // 0.6.16 T2: the work kind's effort, set from the step it would send; the same on every step of the run.
        const outcome = kindStepEffort({ kind: target.kind, model: e.model, effort: tiered, declared: target.declared, guard: target.decision.guard, text: target.text, destinationKind: target.destinationKind })
        const kindActs = target.workKindMode === 'active' && outcome.hold === null
        const sent = kindActs ? outcome.effort : tiered
        if (target.workKindMode !== 'off') {
          workKind = { mode: target.workKindMode, kind: target.kind?.kind ?? null, confidence: target.kind?.confidence ?? null, source: target.kind?.source ?? null, keywords: target.keywordKind, effort: outcome.hold === null ? (outcome.effort ?? null) : null, hold: outcome.hold, applied: kindActs && sent !== tiered }
        }
        if (target.effortEligible || kindActs) {
          loggedEffort = sent ?? null
          const { effort: _dropped, ...rest } = e
          void _dropped
          input = sent === undefined ? rest : { ...rest, effort: sent }
        }
      }
    } catch {
      input = e
    }
    if (target !== undefined && !target.logged && e.index === 0) {
      try {
        const at = new Date(await $.clock.now()).toISOString()
        const record = routerDecisionRecord({
          at,
          account: target.account,
          point: 'subagent',
          decision: { ...target.decision, effort: null },
          applied: target.applied,
          quotaBand: target.quotaBand,
          quotaSource: target.quotaSource,
          effort: loggedEffort,
          project: target.project,
          sessionId: await readSessionId($),
          turnId: e.turnId,
          agentId: e.agentId,
          workKind,
        })
        await appendRouterDecision($, at, `${JSON.stringify(record)}\n`)
      } catch {
        // Best-effort: a lost log line never affects the step itself.
      }
      subagentEffortTarget.set(e.agentId, { ...target, logged: true })
    }
  }
  if (e.agentId !== undefined) {
    // 0.6.14 T1: the effort this subagent step is actually sent with, for its row.
    try {
      // 0.6.15 T4b: with its source, read off this step: what the engine put on it against what is sent.
      await noteEffort(e.agentId, input.effort ?? null, subagentEffortSource(e.effort ?? null, input.effort ?? null, subagentEffortTarget.get(e.agentId)?.declared ?? null))
    } catch {
      // Visibility only: never a reason to hold the step.
    }
  }
  const r = yield* next(input)
  let effortFields: Record<string, unknown> = {}
  try {
    effortFields = await effortLog(e, input, r)
  } catch {
    // Measure-only: a lost field never affects the step or its usage line.
  }
  try {
    await recordTurnUsage($, input, r, project, effortFields)
  } catch {
    // Recording is best-effort and must never affect the turn.
  }
  if (mode !== 'off' && e.agentId === undefined) {
    try {
      await recordRouterStats($, e, r)
    } catch {
      // Best-effort: without stats a downgrade simply cannot pass break-even.
    }
  }
  return r
}

// ---------------------------------------------------------------------------
// Jev context steward (odd/tasks/jev-context-steward.md). Re-read context is
// most of what a long session costs. When a MAIN turn ends with an answer,
// `turn.complete` schedules `stewardAfterTurn` on a timer: `$.session.compact`
// rejects while a turn runs, and a timer outlives the hook's dispatch. The
// timer reads the context for free; at or above the account's threshold (or
// at the hard limit) it asks Jev once whether a task just closed, logs the
// decision, and in active mode compacts with instructions that keep the plan
// and the open work. Measure mode (the default) logs and shows what it would
// have done. A subagent is never compacted. Fails open: any error leaves the
// session as it was.
// ---------------------------------------------------------------------------

const STEWARD_BUDGET_MS = 3000
const STEWARD_DELAY_MS = 250
const STEWARD_RETRY_MS = 1000
const STEWARD_ATTEMPTS = 3
const EMPTY_STEWARD: StewardState = { personTurns: 0, lastCompactionTurn: null }

/** What the steward's timer reads from `register`'s own variables, built inside the hook that schedules it. */
interface StewardHost {
  /** The main turn running now, or null between turns. */
  readonly runningTurn: () => string | null
  /** Sets the steward's part of the status line; null clears it. */
  readonly show: (text: string | null) => void
}

/** One decision on its way to being logged, and, in active mode, applied. */
interface StewardPlan {
  readonly mode: 'measure' | 'active'
  readonly account: string
  readonly project: string
  readonly contextBefore: number
  readonly decision: StewardDecision
  readonly instructions: string
  readonly personTurns: number
  readonly locale: Locale
  /** 0.6.15 T4: what each log row also names (odd/research/steward-1m.md §6). */
  readonly verdict: StewardJudgment['verdict'] | null
  readonly sessionId: string | null
  readonly mainWindow: number | null
  readonly currentModel: string | null
  readonly wouldFire: StewardTier | null
}

/**
 * 0.6.15 T4: the session's MAIN model and the model this turn ran on. The
 * router keeps the session's own model when it takes over (configuredModel)
 * and, while it rewrites steps, the one it sends; without it, the engine's
 * main-loop model is both. The main model's window is what the hard limit is
 * measured against: a router step on a 200k model is not the session's.
 */
async function stewardModels($: EngineInterface): Promise<{ readonly mainModel: string | null; readonly currentModel: string | null }> {
  let own: string | null = null
  try {
    own = await $.session.model()
  } catch {
    own = null
  }
  try {
    const sticky = (await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })).value
    if (sticky !== undefined) return { mainModel: sticky.configuredModel, currentModel: sticky.rewrite ? sticky.model : sticky.configuredModel }
  } catch {
    // No router state: the engine's own model is the main one.
  }
  return { mainModel: own, currentModel: own }
}

async function readSessionId($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.id()
  } catch {
    return null
  }
}

async function readStewardState($: EngineInterface): Promise<StewardState> {
  const read = await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'steward' })
  return read.value ?? EMPTY_STEWARD
}

/** prompt.submit: one more person turn, for the cooldown. An empty prompt or a slash command is not one. Best-effort. */
async function countPersonTurn($: EngineInterface, originKind: string, text: string): Promise<void> {
  try {
    const prompt = text.trim()
    if (!isPersonPromptOrigin(originKind) || prompt.length === 0 || prompt.startsWith('/')) return
    const state = await readStewardState($)
    await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'steward' }, { ...state, personTurns: state.personTurns + 1 })
  } catch {
    // Without the count the cooldown reads fewer turns: it only compacts later.
  }
}

/** Appends one decision line to the current hour's `context-steward-decisions-*.jsonl`, best-effort. */
async function appendStewardDecision($: EngineInterface, atIso: string, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/${stewardDecisionFileName(atIso)}`, line)
  } catch {
    // Logging is best-effort and must never affect the session.
  }
}

/** Jev's verdict on the turn that just ended, or null on any failure. The state carries prompt excerpts and counts, never file contents. */
async function askStewardJudgment($: EngineInterface, options: PluginOptions, messages: readonly ActivityMessage[], contextTokens: number, turnsSinceCompaction: number | null): Promise<StewardJudgment | null> {
  try {
    const apiKey = await resolveApiKey($, options)
    if (apiKey === null) return null
    const prompts = messages.filter(isRealPrompt)
    const state = buildStewardState({
      lastPrompt: prompts.at(-1)?.text ?? '',
      previousPrompt: prompts.length >= 2 ? (prompts.at(-2)?.text ?? null) : null,
      activity: summarizeStewardActivity(messages),
      contextTokens,
      turnsSinceCompaction,
    })
    const response = await callJev(apiKey, state, buildStewardQuestions(), { budgetMs: STEWARD_BUDGET_MS, fetchImpl: makeJevFetch($), sleepImpl: makeJevSleep($) })
    return interpretSteward(response.answers)
  } catch {
    return null
  }
}

function baseName(path: string): string {
  return path.split('/').filter((part) => part.length > 0).at(-1) ?? ''
}

/** The timer `turn.complete` schedules: gate, Jev, decision; then a log (measure, or nothing to do) or a compaction (active). Never throws. */
async function stewardAfterTurn($: EngineInterface, options: PluginOptions, host: StewardHost): Promise<void> {
  try {
    const settings = stewardFromSettings(await readVaultSettings($))
    const mode: StewardMode = settings.mode
    if (mode === 'off') return
    const usage = await $.session.usage()
    const state = await readStewardState($)
    const turnsSinceCompaction = state.lastCompactionTurn === null ? null : state.personTurns - state.lastCompactionTurn
    const contextTokens = usage.context.tokens ?? null
    const models = await stewardModels($)
    const mainWindow = (models.mainModel === null ? null : contextWindowOfModel(models.mainModel)) ?? usage.context.window ?? null
    const gate = stewardGate({ mode, isSubagent: false, contextTokens, mainWindow, threshold: settings.threshold, turnsSinceCompaction })
    if (!gate.ask || contextTokens === null) return
    const messages = await $.session.messages()
    const jev = await askStewardJudgment($, options, messages, contextTokens, turnsSinceCompaction)
    const softActive = settings.softMode === 'active'
    const decision = decideSteward({ jev, hardLimit: gate.hardLimit, softLimit: gate.softLimit, softActive })
    // The soft tier ships measured: while its switch is on measure, a turn it
    // would have compacted is decided as before and logged as `wouldFire`.
    const wouldFire: StewardTier | null = !softActive && !decision.compact && softTierFires({ jev, softLimit: gate.softLimit }) ? 'soft-400k' : null
    const plan: StewardPlan = {
      mode,
      account: await resolveAccountId($),
      project: baseName(await $.session.root()),
      contextBefore: contextTokens,
      decision,
      instructions: decision.compact ? stewardInstructions(collectStewardFacts(messages)) : '',
      personTurns: state.personTurns,
      locale: await resolveLocale($),
      verdict: jev?.verdict ?? null,
      sessionId: await readSessionId($),
      mainWindow,
      currentModel: models.currentModel,
      wouldFire,
    }
    if (mode === 'active' && decision.compact) {
      await attemptStewardCompaction($, plan, 1, host)
      return
    }
    // Measure mode keeps the cooldown as if it had compacted, so its log
    // reads the cadence active mode would have.
    if (decision.compact) await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'steward' }, { ...(await readStewardState($)), lastCompactionTurn: state.personTurns })
    await finishSteward($, plan, false, null, decision.compact ? 'measure' : null, host)
  } catch {
    // The steward never affects the session on a failure.
  }
}

/** One compaction attempt; a rejection (a turn still winding down) is retried on a later timer, at most STEWARD_ATTEMPTS times, never under a new turn. */
async function attemptStewardCompaction($: EngineInterface, plan: StewardPlan, attempt: number, host: StewardHost): Promise<void> {
  try {
    if (host.runningTurn() !== null) {
      await finishSteward($, plan, false, null, 'turn-running', host)
      return
    }
    let result: SessionCompactResult | null = null
    let headless = false
    try {
      result = await $.session.compact({ instructions: plan.instructions })
    } catch (error) {
      // A -p / SDK session: the engine does not offer compaction between
      // turns there (seen live), so a retry can never succeed.
      headless = error instanceof Error && error.message.includes('headless')
      result = null
    }
    if (result === null) {
      if (!headless && attempt < STEWARD_ATTEMPTS && host.runningTurn() === null) {
        $.clock.after(STEWARD_RETRY_MS, () => attemptStewardCompaction($, plan, attempt + 1, host))
        return
      }
      await finishSteward($, plan, false, null, headless ? 'headless' : host.runningTurn() !== null ? 'turn-running' : 'rejected', host)
      return
    }
    if (result.skip !== undefined) {
      await finishSteward($, plan, false, null, 'skipped', host)
      return
    }
    await finishSteward($, plan, true, result.tokensAfter ?? null, null, host)
  } catch {
    // See stewardAfterTurn.
  }
}

/** The decision's log line, the cooldown mark when applied, the status line part and, on a topic change, the /clear suggestion. */
async function finishSteward($: EngineInterface, plan: StewardPlan, applied: boolean, contextAfter: number | null, notApplied: StewardNotApplied | null, host: StewardHost): Promise<void> {
  if (applied) await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'steward' }, { ...(await readStewardState($)), lastCompactionTurn: plan.personTurns })
  const at = new Date(await $.clock.now()).toISOString()
  const record = stewardDecisionRecord({
    at, account: plan.account, project: plan.project, mode: plan.mode, contextBefore: plan.contextBefore, decision: plan.decision, applied, contextAfter, notApplied,
    verdict: plan.verdict, sessionId: plan.sessionId, turnIndex: plan.personTurns, mainWindow: plan.mainWindow, currentModel: plan.currentModel, wouldFire: plan.wouldFire,
  })
  await appendStewardDecision($, at, `${JSON.stringify(record)}\n`)
  host.show(stewardStatusPart(plan.locale, { mode: plan.mode, decision: plan.decision.decision, applied, before: plan.contextBefore, after: contextAfter }))
  if (applied && plan.decision.suggestClear) $.ui.toast(stewardClearHint(plan.locale), { timeoutMs: 15000 })
}

// ---------------------------------------------------------------------------
// Active-mode switches -- hoisted out of `register` (JEVADV-43): the engine
// refuses `$` passed into a closure declared INSIDE register, only a
// top-level function. These take the option value already resolved from
// `options` (null when `options` did not carry a boolean) and a small
// mutable cache object explicitly, instead of closing over either -- the
// cache is still created once per `register` call (once per session/reload,
// exactly as before), just passed in rather than captured.
// ---------------------------------------------------------------------------

/** The per-session cache resolveActiveMode/resolveActiveToolMode share: `resolveModSkillsSwitches` reads the config file at most once per session, no matter how many prompts ask either question. `register` creates one fresh object per call (a fresh one on every reload, exactly like the module-level cache this replaces). */
interface ModSkillsSwitchesCache {
  value: ModSkillsSwitches | null;
}

async function resolveActiveMode($: EngineInterface, optionActive: boolean | null, cache: ModSkillsSwitchesCache): Promise<boolean> {
  if (optionActive !== null) return optionActive
  if (cache.value === null) cache.value = await resolveModSkillsSwitches($)
  return cache.value.active
}

async function resolveActiveToolMode($: EngineInterface, optionActiveTools: boolean | null, cache: ModSkillsSwitchesCache): Promise<boolean> {
  if (optionActiveTools !== null) return optionActiveTools
  if (cache.value === null) cache.value = await resolveModSkillsSwitches($)
  return cache.value.activeTools
}

// =============================================================================
// register -- a NAMED export (JEVADV-43: the engine requires exactly this
// shape, `export function register(on, options)`; a default export,
// `satisfies Register`, is not enough). Everything below is orchestration:
// which hooks exist, and in what order they call the functions above.
// =============================================================================

export function register(on: On, options: PluginOptions): void {
  const text = (key: string, fallback: string): string => (typeof options[key] === 'string' ? (options[key] as string) : fallback)
  const number = (key: string, fallback: number): number => (typeof options[key] === 'number' ? (options[key] as number) : fallback)
  const flag = (key: string, fallback: boolean): boolean => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)

  // Off by default: see the feature document's acceptance criteria --
  // active mode does not turn on until a week of measurement-mode data
  // exists to set these thresholds from.
  //
  // `options.active`/`options.activeTools` only ever carry a value once a
  // manifest declares `userConfig` (see claude-code.d.ts's own note on
  // `options`) -- the manifest install-claude-integration.mjs generates for
  // this plugin deliberately declares neither (T10,
  // odd/tasks/panel-worker-wakeup.md; its one declared field is the model
  // router's `routerMode`, JEV-060 slice 2), so these two are always absent
  // from `options` and unreachable through it by design, not by oversight: the
  // panel's own config file (src/core/mod_skills_config.ts, read by
  // resolveModSkillsSwitches above) is the actual source of truth, and
  // declaring `userConfig` for the same fields would let Claude Code's own
  // config menu silently disagree with it. `resolveActiveMode`/
  // `resolveActiveToolMode` above read that file once per session,
  // cached in `modSkillsSwitchesCache` below. `options` still wins
  // whenever it genuinely carries a boolean, so nothing regresses the day
  // this changes.
  const optionActive = typeof options.active === 'boolean' ? (options.active as boolean) : null
  const optionActiveTools = typeof options.activeTools === 'boolean' ? (options.activeTools as boolean) : null
  const modSkillsSwitchesCache: ModSkillsSwitchesCache = { value: null }
  const routerMode = parseRouterMode(options.routerMode)

  const budgetMs = number('budgetMs', DEFAULT_BUDGET_MS)
  const gateThreshold = number('gateThreshold', DEFAULT_GATE_THRESHOLD)
  const fitsThreshold = number('fitsThreshold', DEFAULT_FITS_THRESHOLD)
  const shortlistSize = Math.max(1, Math.round(number('shortlist', DEFAULT_SHORTLIST)))
  const excerptChars = Math.max(0, Math.round(number('excerptChars', DEFAULT_EXCERPT_CHARS)))

  // Tool selection's own options, independent of the skill ones above: a
  // separate switch (`activeTools`, off by default, same reasoning and same
  // resolveActiveToolMode fallback above), its own budget/thresholds, and
  // its own shortlist/description caps.
  const toolBudgetMs = number('toolBudgetMs', DEFAULT_BUDGET_MS)
  const toolGateThreshold = number('toolGateThreshold', TOOL_DEFAULT_GATE_THRESHOLD)
  const toolFitsThreshold = number('toolFitsThreshold', TOOL_DEFAULT_FITS_THRESHOLD)
  const toolShortlistSize = Math.max(1, Math.round(number('toolShortlist', DEFAULT_TOOL_SHORTLIST)))
  const toolShortChars = Math.max(0, Math.round(number('toolShortChars', DEFAULT_TOOL_SHORT_CHARS)))
  const toolFullChars = Math.max(0, Math.round(number('toolFullChars', DEFAULT_TOOL_FULL_CHARS)))

  // JEV-061 slice 2: the target effort `routeSubagent` (agent.spawn) decided
  // for a subagent, by its own `agentId`, for `handleTurnStep` (turn.step)
  // to apply on every one of that agent's steps. Process-lifetime only,
  // same class as `pendingMeasurementId` below -- a subagent's whole run
  // fits inside one process, unlike `routerSticky`, which must survive a
  // hot reload across a session that can run for hours.
  const subagentEffortTarget = new Map<string, SubagentEffortTarget>()
  // 0.6.15 T4c: each loop's last sent effort, for the measure-only effort log.
  const effortLoops = new Map<string, EffortLoop>()
  // 0.6.16 T4: the main loop's turn so far, for the measure-only phase log.
  const phaseHolder: PhaseHolder = { turn: null }

  // Cached per session/process, as the feature document asks for the
  // inventory: re-scanning the filesystem on every prompt would defeat
  // the point of taking the listing out of the model's way.
  let inventoryCache: readonly SkillSummary[] | null = null
  let orcaContextCache: OrcaContext | null = null
  let localeCache: Locale | null = null
  // The most recent prompt's measurement id, so a later skill.prompt can
  // be correlated with it. Cleared once used, so only the first skill
  // loaded after a prompt is attributed to it.
  let pendingMeasurementId: string | null = null

  // Same caching shape for tools: `$.tool.list()` is cheap (no filesystem
  // scan behind it), but caching still avoids one extra host round trip
  // per prompt, and keeps this mirroring the skill inventory above.
  let toolInventoryCache: readonly ToolSummary[] | null = null
  // The most recent prompt's tool-measurement id, so the next `tool.call`
  // in the MAIN loop (never a subagent's -- a delegated subagent's own
  // tool use isn't the model's answer to this prompt) can be correlated
  // with it. Cleared once used, so only the first tool called after a
  // prompt is attributed to it.
  let pendingToolMeasurementId: string | null = null

  // JEVADV-4: whether THIS turn's prompt.submit (below) actually injected a
  // skill in place of the engine's own listing -- the only thing
  // prompt.attachment (right below) may now withhold for. Reset at the top
  // of every prompt.submit and set true only once a skill's SKILL.md was
  // read successfully, so a turn that never gets that far (measurement
  // mode, an unsampled prompt, no skill needed, nothing fit, or a failed
  // read) always leaves this false and the real listing goes through.
  let pendingListingWithheld = false

  // The status line is one entry per plugin: the skill/tool path's text
  // (prompt.submit) and the router's (turn.step) are kept apart here and
  // always shown together, so neither erases the other.
  let promptStatusText: string | null = null
  let routerStatusText: string | null = null
  // The context steward's part, set by its timer after a turn ends.
  let stewardStatusText: string | null = null
  // 0.6.8 T6: the subagents running now (agent.spawn adds one, its own
  // turn.complete removes it) and their status-line part. 0.6.14 T1: kept
  // in `$.state` too, so a reload does not forget them (RunningSet).
  const runningSubagents: RunningSet = { agents: new Map<string, RunningSubagent>(), hydrated: null, writes: Promise.resolve() }
  let agentsStatusText: string | null = null
  const statusLine = (): string | null => composeStatusLine([promptStatusText, routerStatusText, agentsStatusText, stewardStatusText])
  // The main turn running now (turn.start → turn.complete), so the steward
  // never compacts under a turn that started after the one it judged.
  let activeTurnId: string | null = null

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    // A subagent's own listing is left alone, since nothing here suggests
    // for a subagent (prompt.submit never fires for one). For the main
    // conversation, withhold only when this exact turn's prompt.submit --
    // which always runs first and settles this flag before the request for
    // the same turn is assembled -- actually replaced the listing with a
    // skill. Read once and reset immediately: a prompt queued mid-turn
    // racing a second prompt.submit before this fires shares the same
    // accepted correlation risk pendingMeasurementId already does for
    // skill.prompt.
    if (e.agentId !== undefined) return next(e)
    const withhold = pendingListingWithheld
    pendingListingWithheld = false
    if (!withhold) return next(e)
    return { text: null }
  })

  on('prompt.submit', async ($, e, next) => {
    // JEV-061: stamp this submission's origin for the model router's point
    // A/C personhood gate (turn.step, below), BEFORE any early return --
    // an empty prompt or a slash command must still update it, since a
    // background task's notification could be either. `$.session.messages()`
    // rows carry no origin, so this is the only place that ever will.
    // Best-effort and never blocking: a write failure only means the
    // router falls back to today's behaviour (a missing stamp reads as a
    // person's own prompt, see routeMainStep).
    try {
      const origin: RouterPromptOrigin = { kind: e.origin.kind }
      await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerPromptOrigin' }, origin)
    } catch {
      // See above.
    }
    await countPersonTurn($, e.origin.kind, e.text)

    const prompt = e.text.trim()
    // Reset every turn, before anything below can set it: whatever exits
    // this handler early (an empty prompt, a slash command, no API key, an
    // unsampled measurement-mode prompt, a thrown error) must never leave a
    // stale `true` from an earlier turn for prompt.attachment to read.
    pendingListingWithheld = false

    // Nothing to route for an empty prompt or a typed slash command --
    // the latter already names its own skill (and, for tools, already
    // names its own action).
    if (prompt.length === 0 || prompt.startsWith('/')) return next(e)

    // Shared sampling roll (src/core/mod_skills_sampling.ts): ONE coin flip
    // per prompt, spent by whichever of the two closures below is actually
    // in measurement mode -- not two independent draws. Measurement mode's
    // Jev calls (rank every candidate + gate, then re-read the shortlist
    // with more detail) exist purely for calibration data -- see
    // src/core/mod_skills_readiness.ts for what "enough of that data" now
    // means -- and spending them on every prompt of every session,
    // indefinitely, is the bug this gate fixes for skills; JEVADV-4 gives
    // the tool path the exact same gate, since it had none at all before
    // this (every real prompt, unsampled, twice the calls skills already
    // capped). One shared roll rather than two keeps "how many Jev-call
    // pairs measurement mode spends today" one bounded, documented number
    // (at most 4: skill wide+fit, tool wide+fit) instead of two
    // uncorrelated budgets. `promptsSampledToday` reads the more active of
    // the two logs (`Math.max`): a path currently in ACTIVE mode writes
    // `mode: "active"` rows, which never count toward either log's
    // measurement-mode total, so reading only one log would silently
    // starve the other path's own daily cap the moment the switches
    // diverge (skill active, tool measurement, or the reverse). Active
    // mode's own decision is functionally load-bearing (it is what gets
    // injected) for whichever path runs it, so this roll never gates that
    // path at all -- only each closure's own measurement-mode branch below
    // consults `sampled`.
    // JEVADV-38 R3: the roll itself fails open, exactly like every Jev call
    // below it -- a rejected $.clock.now, config read or counter read must
    // never escape prompt.submit unhandled. `resolveModSkillsSamplingConfig`,
    // `measurementDecisionsToday` and `toolMeasurementDecisionsToday` already
    // catch their own errors, but `$.clock.now()` does not, so this used to
    // sit outside every closure's own try/catch with nothing to catch it.
    // "Not sampled" is the correct fallback either way: measurement mode
    // treats it exactly like a real unsampled prompt (no Jev call, no
    // record, listing delivered), and active mode is unaffected -- neither
    // closure's active-mode branch consults `sampled` at all.
    let sampled = false
    try {
      const samplingConfig = await resolveModSkillsSamplingConfig($)
      const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
      const promptsSampledToday = Math.max(await measurementDecisionsToday($, today), await toolMeasurementDecisionsToday($, today))
      sampled = shouldSamplePrompt(samplingConfig, promptsSampledToday, Math.random())
    } catch {
      sampled = false
    }

    // Skill selection and tool selection each run in their own isolated
    // closure: a failure or timeout in one must never touch the other, and
    // neither may throw out of this hook (both fail open on their own).
    // Each resolves to the context block to inject (active mode only, and
    // only once a decision was actually reached) and the status text to
    // show (shown in both modes, same as before this mod suggested tools
    // too -- absent whenever the branch never reached a decision).
    const skillOutcome = await (async (): Promise<{ block: string | null; status: string | null }> => {
      try {
        const activeMode = await resolveActiveMode($, optionActive, modSkillsSwitchesCache)

        // An unsampled measurement-mode prompt does nothing at all: no Jev
        // call, no record, exactly like today's missing-API-key branch
        // below.
        if (!activeMode && !sampled) return { block: null, status: null }

        if (inventoryCache === null) {
          const cwd = await $.session.cwd()
          const home = await resolveHomeDir($)
          // Claude Code's real user skills folder for THIS session is
          // `$CLAUDE_CONFIG_DIR/skills` when that variable is set (how
          // every Orca-managed account runs) -- see resolveUserSkillsDir's
          // own doc in runtime.ts for why `<home>/.claude/skills` alone is
          // wrong there.
          const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR')
          inventoryCache = await listSkillInventory(makeSkillFs($), {
            projectSkillsDir: `${cwd}/.claude/skills`,
            userSkillsDir: resolveUserSkillsDir({ claudeConfigDir, home }),
          })
        }
        const inventory = inventoryCache
        if (inventory.length === 0) return { block: null, status: null }

        if (orcaContextCache === null) {
          orcaContextCache = await resolveOrcaContext(makeProcessRun($), await $.session.cwd(), await resolveOrcaCli($))
        }
        const orcaContext = orcaContextCache
        const orcaState = { worktree: orcaContext.worktree, proyecto: orcaContext.proyecto, rama: orcaContext.rama }

        if (localeCache === null) localeCache = await resolveLocale($)
        const locale = localeCache
        const t = (key: ModSkillsKey, params?: Readonly<Record<string, string>>): string => translate(MOD_SKILLS_CATALOG, locale, key, params)

        const apiKey = await resolveApiKey($, options)
        if (apiKey === null) return { block: null, status: null }

        const fetchImpl = makeJevFetch($)
        const sleepImpl = makeJevSleep($)
        const candidates: SkillCandidate[] = inventory.map((skill) => ({ name: skill.name, description: skill.description }))

        const wideStartedAt = await $.clock.now()
        let wide: WideResult | null = null
        try {
          const response = await callJev(apiKey, buildWideState(prompt, candidates, orcaState), buildWideQuestions(candidates), { budgetMs, fetchImpl, sleepImpl })
          wide = interpretWide(response.answers, gateThreshold)
        } catch {
          wide = null
        }
        const wideLatencyMs = (await $.clock.now()) - wideStartedAt

        let fit: FitResult | null = null
        let fitAttempted = false
        let fitLatencyMs: number | null = null
        let shortlistDetail: SkillCandidateDetail[] = []
        if (wide !== null && wide.needsSkill && wide.ranked.length > 0) {
          const shortlist = shortlistOf(wide, candidates, shortlistSize)
          const byName = new Map(inventory.map((skill) => [skill.name, skill]))
          shortlistDetail = await Promise.all(
            shortlist.map(async (candidate): Promise<SkillCandidateDetail> => {
              const skill = byName.get(candidate.name)
              let excerpt = candidate.description
              if (skill) {
                try {
                  excerpt = stripSkillFrontmatter(await $.fs.read(skill.path)).trim().slice(0, excerptChars) || candidate.description
                } catch {
                  excerpt = candidate.description
                }
              }
              return { ...candidate, excerpt }
            }),
          )

          if (shortlistDetail.length > 0) {
            fitAttempted = true
            const fitStartedAt = await $.clock.now()
            try {
              const response = await callJev(apiKey, buildFitState(prompt, shortlistDetail, orcaState), buildFitQuestions(shortlistDetail), { budgetMs, fetchImpl, sleepImpl })
              fit = interpretFit(response.answers, shortlistDetail)
            } catch {
              fit = null
            }
            fitLatencyMs = (await $.clock.now()) - fitStartedAt
          }
        }

        const decision = decideSkill(wide, fit, fitAttempted, fitsThreshold)

        // JEVADV-4: the block is built BEFORE the measurement record below,
        // not after, so `listingWithheld` -- what the record says happened
        // -- and `pendingListingWithheld` -- what prompt.attachment
        // actually withholds for this same turn -- can never disagree.
        // Measurement mode never reaches this (block stays null): nothing
        // observable changes beyond the status line above. Active mode
        // injects the winner's own SKILL.md so it loads even where the
        // engine's listing would not have offered it -- but only once that
        // read actually succeeds; a missing winner or a failed read leaves
        // `block` null, exactly like measurement mode, so the listing is
        // never withheld for a skill that was never actually delivered.
        let block: string | null = null
        if (activeMode && decision.name !== null) {
          const winner = inventory.find((skill) => skill.name === decision.name)
          if (winner) {
            try {
              const markdown = stripSkillFrontmatter(await $.fs.read(winner.path)).trim()
              block = ['<skill_relevance>', t('relevance.intro', { name: winner.name }), t('relevance.instructions'), `<skill name="${winner.name}">`, markdown, '</skill>', '</skill_relevance>'].join('\n')
            } catch {
              block = null
            }
          }
        }
        const listingWithheld = block !== null

        const measurementId = crypto.randomUUID()
        const at = new Date(await $.clock.now()).toISOString()
        // JEVADV-38 R3: recomputed fresh for THIS decision, not cached once
        // per process. `resolveModSkillsReadiness` folds the whole
        // measurement log -- caching it across a session's prompts (the same
        // shape inventoryCache/orcaContextCache above use) reported a stale
        // session-start snapshot: a decision made mid-session never saw an
        // observation an earlier decision in the SAME session had already
        // turned comparable. This is the honest per-decision value; the
        // cost is one extra log read on a sampled/active decision, never on
        // every prompt.
        const readiness = await resolveModSkillsReadiness($)
        await appendMeasurement(
          $,
          at,
          serializeRecord(
            buildDecisionRecord({
              id: measurementId,
              at,
              mode: activeMode ? 'active' : 'measurement',
              prompt,
              orcaContext: orcaState,
              candidateCount: candidates.length,
              listingChars: listingCharsFor(candidates),
              listingWithheld,
              wide: wide === null ? null : { ranked: wide.ranked, gate: wide.gate, needsSkill: wide.needsSkill },
              fit: fit === null ? null : { winner: fit.winner, fits: fit.fits },
              decision: { name: decision.name, reason: decision.reason },
              latencyMs: { wide: wideLatencyMs, fit: fitLatencyMs },
              readiness,
            }),
          ),
        )
        pendingMeasurementId = measurementId
        pendingListingWithheld = listingWithheld

        // 0.6.2 E8: applied only when the winner's SKILL.md was injected.
        return { block, status: skillStatusPart(locale, decision.name, block !== null ? 'applied' : activeMode ? 'unchanged' : 'measuring') }
      } catch {
        // Fail open, always: any unexpected error leaves the prompt
        // exactly as it was, with no partial measurement or injection, and
        // nothing withheld (pendingListingWithheld was already reset to
        // false at the top of prompt.submit, and nothing here sets it).
        return { block: null, status: null }
      }
    })()

    const toolOutcome = await (async (): Promise<{ block: string | null; status: string | null }> => {
      try {
        const activeToolMode = await resolveActiveToolMode($, optionActiveTools, modSkillsSwitchesCache)

        // JEVADV-4: the same shared roll the skill closure consults above,
        // not a second independent one -- see its own comment for why. An
        // unsampled measurement-mode prompt does nothing at all here
        // either: no Jev call, no record.
        if (!activeToolMode && !sampled) return { block: null, status: null }

        if (toolInventoryCache === null) {
          toolInventoryCache = await listToolInventory(makeToolLister($))
        }
        const toolInventory = toolInventoryCache
        if (toolInventory.length === 0) return { block: null, status: null }

        if (orcaContextCache === null) {
          orcaContextCache = await resolveOrcaContext(makeProcessRun($), await $.session.cwd(), await resolveOrcaCli($))
        }
        const orcaContext = orcaContextCache
        const orcaState = { worktree: orcaContext.worktree, project: orcaContext.proyecto, branch: orcaContext.rama }

        if (localeCache === null) localeCache = await resolveLocale($)
        const locale = localeCache
        const t = (key: ToolsKey, params?: Readonly<Record<string, string>>): string => translate(TOOLS_CATALOG, locale, key, params)

        const apiKey = await resolveApiKey($, options)
        if (apiKey === null) return { block: null, status: null }

        const fetchImpl = makeJevFetch($)
        const sleepImpl = makeJevSleep($)
        // Stage 1 gets a short description per tool, so a large inventory
        // (dozens of MCP tools included) stays a light payload; stage 2
        // reads the shortlist's full, untruncated description instead.
        const candidates: ToolCandidate[] = toolInventory.map((tool) => ({
          name: tool.name,
          description: tool.description.length > toolShortChars ? `${tool.description.slice(0, toolShortChars).trimEnd()}...` : tool.description,
        }))

        const wideStartedAt = await $.clock.now()
        // Jev takes at most 255 options per choice (JEVADV-76), so a large
        // roster is asked in batches, side by side within the same budget.
        let wideStatus: number | null = null
        const batchResults = await Promise.all(
          toolWideBatches(candidates).map(async (batch, index): Promise<ToolWideResult | null> => {
            try {
              const response = await callJev(apiKey, buildToolWideState(prompt, batch, orcaState), buildToolWideQuestions(batch, { withGate: index === 0 }), { budgetMs: toolBudgetMs, fetchImpl, sleepImpl })
              return interpretToolWide(response.answers, toolGateThreshold)
            } catch (error) {
              if (error instanceof JevRequestError && error.status !== null) wideStatus ??= error.status
              return null
            }
          }),
        )
        const wide = mergeToolWide(batchResults)
        const wideLatencyMs = (await $.clock.now()) - wideStartedAt

        let fit: ToolFitResult | null = null
        let fitAttempted = false
        let fitLatencyMs: number | null = null
        if (wide !== null && wide.needsOneTool && wide.ranked.length > 0) {
          const shortlist = toolShortlistOf(wide, candidates, toolShortlistSize)
          const byName = new Map(toolInventory.map((tool) => [tool.name, tool]))
          const shortlistDetail: ToolCandidateDetail[] = shortlist.map((candidate) => {
            const tool = byName.get(candidate.name)
            const full = tool && tool.description.length > 0 ? tool.description : candidate.description
            return { ...candidate, fullDescription: full.slice(0, toolFullChars) }
          })

          if (shortlistDetail.length > 0) {
            fitAttempted = true
            const fitStartedAt = await $.clock.now()
            try {
              const response = await callJev(apiKey, buildToolFitState(prompt, shortlistDetail, orcaState), buildToolFitQuestions(shortlistDetail), { budgetMs: toolBudgetMs, fetchImpl, sleepImpl })
              fit = interpretToolFit(response.answers, shortlistDetail)
            } catch {
              fit = null
            }
            fitLatencyMs = (await $.clock.now()) - fitStartedAt
          }
        }

        const decision = decideTool(wide, fit, fitAttempted, toolFitsThreshold, wideStatus)

        const measurementId = crypto.randomUUID()
        const at = new Date(await $.clock.now()).toISOString()
        await appendToolMeasurement(
          $,
          at,
          serializeToolRecord(
            buildToolDecisionRecord({
              id: measurementId,
              at,
              mode: activeToolMode ? 'active' : 'measurement',
              prompt,
              orcaContext: orcaState,
              candidateCount: candidates.length,
              listingChars: toolListingCharsFor(candidates),
              wide: wide === null ? null : { ranked: wide.ranked, gate: wide.gate, needsOneTool: wide.needsOneTool },
              fit: fit === null ? null : { winner: fit.winner, fits: fit.fits },
              decision: { name: decision.name, reason: decision.reason },
              latencyMs: { wide: wideLatencyMs, fit: fitLatencyMs },
            }),
          ),
        )
        pendingToolMeasurementId = measurementId

        const outcome = !activeToolMode ? 'measuring' : decision.name === null ? 'unchanged' : 'applied'
        const status = toolStatusPart(locale, decision.name, outcome)

        // Measurement mode stops here: nothing observable changes beyond
        // the status line above. Active mode injects the winner as advice
        // only -- never the model's tool schema itself (the model already
        // has that), and it is worded so it is never mistaken for a
        // command: see i18n_tools.ts's `advice.instructions`.
        if (!activeToolMode || decision.name === null) return { block: null, status }
        const block = ['<tool_relevance>', t('advice.intro', { name: decision.name }), t('advice.instructions'), '</tool_relevance>'].join('\n')
        return { block, status }
      } catch {
        // Fail open, always: any unexpected error, timeout or missing key
        // leaves the prompt exactly as it was -- a tool call must never be
        // delayed or lost because Jev was slow or down.
        return { block: null, status: null }
      }
    })()

    const statusParts = [skillOutcome.status, toolOutcome.status].filter((part): part is string => part !== null)
    promptStatusText = statusParts.length > 0 ? statusParts.join(' · ') : null
    const line = statusLine()
    if (line !== null) $.ui.status(line)

    const extraContext = [skillOutcome.block, toolOutcome.block].filter((block): block is string => block !== null)
    if (extraContext.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extraContext] })
  })

  on('skill.prompt', async ($, e, next) => {
    if (pendingMeasurementId !== null) {
      const id = pendingMeasurementId
      pendingMeasurementId = null
      // 0.6.19 M8 (JEVADV-73): observing is best-effort. A clock read that
      // fails costs this one observation, never the skill's own load.
      try {
        const at = new Date(await $.clock.now()).toISOString()
        await appendMeasurement($, at, serializeRecord(buildObservationRecord(id, e.skill, at)))
      } catch {
        // Nothing recorded; the event still goes on below.
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const showRouterStatus = (text: string): void => {
      routerStatusText = text
      $.ui.status(statusLine() ?? text)
    }
    // JEVADV-63: read from the closure's own orcaContextCache (plain data,
    // not `$`) -- never a fresh resolveOrcaContext call per step. null when
    // no prompt has resolved it yet this session (an honest "not yet
    // known", not a bug).
    const project = modSkillsProjectName(orcaContextCache)
    const noteEffort = (agentId: string, effort: SessionEffort | null, source: SubagentEffortSource): Promise<void> => noteSubagentEffort($, runningSubagents, agentId, effort, source)
    return yield* handleTurnStep($, e, next, routerMode, options, showRouterStatus, subagentEffortTarget, project, noteEffort, async (step, input, r) => ({ ...(await effortLogFields($, step, input, r, effortLoops, runningSubagents.agents, subagentEffortTarget)), ...phaseLogFields(step, input, r, phaseHolder) }))
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await routeSubagent($, e, next, routerMode, options, subagentEffortTarget, modSkillsProjectName(orcaContextCache), runningSubagents.agents)
    if ('agentId' in result && result.agentId !== undefined) {
      try {
        agentsStatusText = await runningSubagentsStatus($, runningSubagents, result.agentId)
        $.ui.status(statusLine() ?? undefined)
      } catch {
        // The status line is never a reason to fail a spawn.
      }
    }
    return result
  })

  // 0.6.14 T2: one row per running subagent, above the prompt -- what it
  // is, what it is doing, its model, its effort and why. Drawn from the copy
  // in `$.state` (reading it subscribes this band, so every write of the
  // running set redraws it) against `$.agent.list()`, so the count is the
  // host's. Passes while nothing runs, while a survey holds the band, and
  // whenever a plugin beneath already drew one: never a second band over it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const beneath = await next(e)
    if (beneath.type !== 'engine') return beneath
    try {
      const stored = parseRunningSubagents((await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'runningSubagents' })).value)
      const { shown } = reconcileRunning(stored, await listAgents($), null)
      const band = subagentBand(await resolveLocale($), shown, e.props.bodyColumns)
      if (band === null) return beneath
      const { Box, Text } = $.ui.resolve(e)
      const rows = band.rows.map((row) => Text({ wrap: 'truncate-end', children: row.why.length > 0 ? [row.text, Text({ dimColor: true, children: row.why })] : row.text }))
      return Box({ flexDirection: 'column', children: [Text({ bold: true, wrap: 'truncate-end', children: band.heading }), ...rows] })
    } catch {
      return beneath
    }
  })

  // The context steward (stewardAfterTurn): a subagent's run raises no
  // turn.start, and its turn.complete carries an agentId, so both hooks see
  // the main conversation alone. The steward's work runs on a timer, once
  // this turn has ended, never inside it.
  on('turn.start', async ($, e, next) => {
    activeTurnId = e.turnId
    return next(e)
  })

  // 0.6.14 T1: a reload runs register again and raises session.start again;
  // the running set kept in `$.state` (and any agent the host runs that
  // nothing recorded) is shown at once, not at the next spawn.
  on('session.start', async ($, e, next) => {
    try {
      agentsStatusText = await runningSubagentsStatus($, runningSubagents, null)
      const line = statusLine()
      if (line !== null) $.ui.status(line)
    } catch {
      // The status line is never a reason to fail a start.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // 0.6.8 T6: a subagent's own answer ends it; the status line drops it.
    if (e.agentId !== undefined && runningSubagents.agents.delete(e.agentId)) {
      try {
        agentsStatusText = await runningSubagentsStatus($, runningSubagents, null)
        $.ui.status(statusLine() ?? undefined)
      } catch {
        // The status line is never a reason to fail a turn.
      }
    }
    if (e.agentId === undefined) {
      activeTurnId = null
      if (e.reason === 'answer') {
        const host: StewardHost = {
          runningTurn: () => activeTurnId,
          show: (text) => {
            stewardStatusText = text
            $.ui.status(statusLine() ?? undefined)
          },
        }
        try {
          $.clock.after(STEWARD_DELAY_MS, () => stewardAfterTurn($, options, host))
        } catch {
          // No timer, no steward: the turn ends as it would have.
        }
      }
    }
    return next(e)
  })

  // The tool-selection equivalent of `skill.prompt`: observes, purely for
  // measurement, which tool the model actually reached for first after a
  // prompt this mod already scored. Never denies, rewrites or delays the
  // call -- it only reads `e` and always calls `next(e)` unchanged, in
  // every branch, including on a logging failure.
  //
  // Restricted to the main loop (`e.agentId === undefined`): a delegated
  // subagent's own tool calls are its own business, not the model's direct
  // answer to this prompt, and firing on every one of them (subagents can
  // make many, immediately) would almost always swallow the correlation
  // before the main loop's own first tool call ever happened.
  on('tool.call', async ($, e, next) => {
    if (pendingToolMeasurementId !== null && e.agentId === undefined) {
      const id = pendingToolMeasurementId
      pendingToolMeasurementId = null
      try {
        const at = new Date(await $.clock.now()).toISOString()
        await appendToolMeasurement($, at, serializeToolRecord(buildToolObservationRecord(id, e.tool, at)))
      } catch {
        // Measurement is best-effort and must never block or fail a call.
      }
    }
    const result = await next(e)
    // 0.6.16 T4: a failed main-loop call marks its step for the measure-only hold rule.
    if (e.agentId === undefined && phaseHolder.turn !== null) {
      try {
        // The tool's arguments are on the event itself (`e.command` for Bash); there is no `e.input`.
        if (toolFailed(e.tool, e, result)) phaseHolder.turn = withLastFailed(phaseHolder.turn)
      } catch {
        // Measure-only: never a reason to touch the call.
      }
    }
    return result
  })
}

// A type-level check, never executed: `register`'s own signature must keep
// matching `Register` exactly (the engine's declared shape), so a future
// edit that drifts from it fails typecheck here instead of failing silently
// inside the engine.
const _registerMatchesContract: Register = register
void _registerMatchesContract
