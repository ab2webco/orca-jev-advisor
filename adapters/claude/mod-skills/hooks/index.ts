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
import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, Frozen, Next, On, PluginOptions, Register, StreamHookBody, StreamNext, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { callJev } from '../../../../src/core/jev.ts'
import { resolveOrcaContext } from '../../../../src/core/orca_context.ts'
import type { OrcaContext, ProcessRun, RunResult } from '../../../../src/core/orca_context.ts'
import { listSkillInventory, stripSkillFrontmatter } from '../../../../src/core/skill_inventory.ts'
import type { SkillFs, SkillFsEntry, SkillFsStat, SkillSummary } from '../../../../src/core/skill_inventory.ts'
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
  shortlistOf as toolShortlistOf,
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
import { computeHomePaths, parseEnvFile, resolveUserSkillsDir } from './runtime.ts'
import type { ModHomePaths } from './runtime.ts'
import { parseQuota } from '../../../../src/core/consumption.ts'
import { parseModelsMirror } from '../../../../src/core/model_mirror.ts'
import { parseVaultEnv, resolveAccountTiers, tierOfModel } from '../../../../src/core/model_router_accounts.ts'
import type { ResolvedTiers } from '../../../../src/core/model_router_accounts.ts'
import { buildTierQuestions, buildTierState, decideStart, interpretTier, routerDecisionFileName, routerDecisionRecord, toRouterEffort } from '../../../../src/core/model_router_decide.ts'
import type { RouterDecision, TierJudgment } from '../../../../src/core/model_router_decide.ts'
import { parseRouterMode } from '../../../../src/core/model_router_mode.ts'
import type { RouterMode } from '../../../../src/core/model_router_mode.ts'
import { routerStatusText } from '../../../../src/core/model_router_status.ts'
import { decideEngineTurn, decideStage, isNewPrompt, lastPromptKey, medianOf, quotaBandOf, summarizePreviousTurn, summarizeSinceLastPrompt } from '../../../../src/core/model_router_stage.ts'
import type { ActivityMessage, SessionUsage, StageDecision } from '../../../../src/core/model_router_stage.ts'
import type { DestinationKind, QuotaBand, TurnActivity } from '../../../../src/core/model_router_decide.ts'
import { resolveRouterDestination } from '../../../../src/core/model_router_destination.ts'
import type { RouterDestination } from '../../../../src/core/model_router_destination.ts'
import { decideSubagent } from '../../../../src/core/model_router_subagent.ts'
import type { RouterSessionStats, RouterSticky } from '../types/index.d.ts'

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
async function measurementDecisionsTodayIn($: EngineInterface, fileName: string, today: string): Promise<number> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return 0
    const path = `${paths.cacheDir}/${fileName}`
    if (!(await $.fs.exists(path))) return 0
    const content = await $.fs.read(path)
    let count = 0
    for (const line of content.split('\n')) {
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

/** `measurementDecisionsTodayIn` over the skill-selection log (mod-skills-measurements.jsonl). */
export async function measurementDecisionsToday($: EngineInterface, today: string): Promise<number> {
  return measurementDecisionsTodayIn($, 'mod-skills-measurements.jsonl', today)
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
  return measurementDecisionsTodayIn($, 'mod-tools-measurements.jsonl', today)
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
    const path = `${paths.cacheDir}/mod-skills-measurements.jsonl`
    const rows: unknown[] = []
    if (await $.fs.exists(path)) {
      const content = await $.fs.read(path)
      for (const line of content.split('\n')) {
        if (line.length === 0) continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          continue
        }
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

export async function appendMeasurement($: EngineInterface, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/mod-skills-measurements.jsonl`, line)
  } catch {
    // Measurement is best-effort and must never block or fail a prompt.
  }
}

/** Same shape as `appendMeasurement`, in its own file, for tool-selection records (src/core/tool_measurement.ts). */
export async function appendToolMeasurement($: EngineInterface, line: string): Promise<void> {
  try {
    const paths = await resolveHomePaths($)
    if (!paths) return
    await appendToFile($, `${paths.cacheDir}/mod-tools-measurements.jsonl`, line)
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

/** Builds and appends this step's usage line. Never touches `e` beyond reading it, and never throws (appendTurnUsage already swallows its own errors; a `$.clock.now()` rejection here is the only other failure mode, left to the caller's own try/catch). */
async function recordTurnUsage($: EngineInterface, e: Frozen<TurnStepInput>, r: TurnStepResult): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  const account = await resolveAccountId($)
  const line = JSON.stringify({
    at,
    agent: e.agentId === undefined ? 'main' : 'subagent',
    model: r.usage?.model ?? e.model,
    effort: e.effort ?? null,
    input: r.usage?.input_tokens ?? null,
    output: r.usage?.output_tokens ?? null,
    cacheRead: r.usage?.cache_read_input_tokens ?? null,
    cacheWrite: r.usage?.cache_creation_input_tokens ?? null,
    stopReason: r.stopReason,
    account,
  })
  await appendTurnUsage($, at, `${line}\n`)
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
 * the worker's models-catalog.json and quota.json mirrors.
 */
async function resolveRouterAccount($: EngineInterface, account: string): Promise<{ tiers: ResolvedTiers; band: QuotaBand }> {
  const paths = await resolveHomePaths($)
  const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const vaultDir = claudeConfigDir !== undefined && claudeConfigDir.length > 0 ? claudeConfigDir : paths ? `${paths.home}/.claude` : null
  const vaultEnv = vaultDir === null ? {} : parseVaultEnv(await readJsonFile($, `${vaultDir}/settings.json`))
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
  return { tiers, band: quotaBandOf(quota, quotaFile.checkedAt, await $.clock.now()) }
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
  try {
    const apiKey = await resolveApiKey($, options)
    if (apiKey === null) return null
    const state = buildTierState({ promptText, activity, destinationKind, quotaBand: band })
    const response = await callJev(apiKey, state, buildTierQuestions(), { budgetMs: ROUTER_BUDGET_MS, fetchImpl: makeJevFetch($), sleepImpl: makeJevSleep($) })
    return interpretTier(response.answers)
  } catch {
    return null
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

/** The status-line text for a decision, or null when there is nothing to say (Jev failed). */
function routerStatusFor(decision: Pick<RouterDecision, 'tier' | 'model' | 'effort'>, tiers: ResolvedTiers, mode: 'measure' | 'active', locale: Locale): string | null {
  if (decision.tier === null) return null
  const tier = tierOfModel(tiers, decision.model)
  const label = tier === null ? decision.model : tiers[tier].label
  const effort = typeof decision.effort === 'string' ? toRouterEffort(decision.effort) : null
  return routerStatusText(locale, mode, { label, effort, tier: decision.tier })
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
async function routeMainStep($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', options: PluginOptions): Promise<RoutedStep> {
  const stickyRead = await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })
  const sticky = stickyRead.value
  const adopt = async (lastPrompt: RouterSticky['lastPrompt']): Promise<RoutedStep> => {
    const own: RouterSticky = { model: e.model, effort: stickyEffort(e.effort), rewrite: false, configuredModel: e.model, configuredEffort: stickyEffort(e.effort), tier: null, pendingLower: null, stats: EMPTY_STATS, lastPrompt }
    await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, own)
    return { input: e, status: null }
  }

  if (sticky !== undefined) {
    // The person (or the engine's fallback) moved the session off the
    // model the router took over from: their choice wins from here on.
    if (e.model !== sticky.configuredModel || stickyEffort(e.effort) !== sticky.configuredEffort) return adopt(sticky.lastPrompt)
    if (e.index !== 0 || sticky.stats.turnId === e.turnId) return { input: stickyStepInput(e, sticky, mode), status: null }
    // A new turn: point C only when a new real prompt started it (review
    // finding 4), keyed on the prompt's identity so /compact cannot hide
    // one (N3). A turn the engine started by itself asks Jev nothing, but
    // its local guards still hold the floor (N2).
    const turnMessages = await $.session.messages()
    const promptKey = lastPromptKey(turnMessages)
    if (!isNewPrompt(sticky.lastPrompt, promptKey)) return routeEngineTurn($, e, mode, sticky, turnMessages)
    return routeStage($, e, mode, options, sticky, turnMessages, promptKey)
  }

  const messages = await $.session.messages()
  const promptKey = lastPromptKey(messages)
  // Warm: the mode was switched on mid-session or the module reloaded
  // without its state. Adopt, change nothing (§3); from here only point C.
  if (e.index !== 0 || messages.some((message) => message.role === 'assistant')) return adopt(promptKey)

  const promptText = lastPromptText(messages)
  const account = await resolveAccountId($)
  const { tiers, band } = await resolveRouterAccount($, account)
  const destination = await resolveSessionDestination($, await $.session.cwd())
  const jev = await askTierJudgment($, options, promptText, null, band, destination.destinationKind)
  const decision = decideStart({
    tiers,
    jev,
    configuredModel: e.model,
    configuredEffort: stickyEffort(e.effort),
    guards: { destinationKind: destination.destinationKind, policyHit: destination.policyHit, text: promptText, activity: null, confidence: jev?.confidence ?? null },
    band,
  })
  const applied = mode === 'active' && decision.changed
  const at = new Date(await $.clock.now()).toISOString()
  await appendRouterDecision($, at, `${JSON.stringify(routerDecisionRecord({ at, account, point: 'start', decision, applied, quotaBand: band }))}\n`)

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
 * A turn the engine started by itself (no new real prompt, N2): no Jev
 * call, but the local guards over the work since the last prompt. When the
 * sticky model is below the session's own and that work failed or touches
 * a sensitive topic, the session's own model and effort come back.
 */
async function routeEngineTurn($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', sticky: RouterSticky, messages: readonly ActivityMessage[]): Promise<RoutedStep> {
  const account = await resolveAccountId($)
  const { tiers, band } = await resolveRouterAccount($, account)
  const decision = decideEngineTurn({
    tiers,
    currentModel: sticky.model,
    configuredModel: sticky.configuredModel,
    configuredEffort: sticky.configuredEffort,
    text: lastPromptText(messages),
    activity: summarizeSinceLastPrompt(messages),
  })
  if (decision === null) return { input: stickyStepInput(e, sticky, mode), status: null }
  const at = new Date(await $.clock.now()).toISOString()
  await appendRouterDecision($, at, `${JSON.stringify(routerDecisionRecord({ at, account, point: 'stage', decision, applied: mode === 'active', quotaBand: band }))}\n`)
  const next: RouterSticky = { ...sticky, model: decision.model, effort: decision.effort, rewrite: false, pendingLower: null }
  await $.state.set({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' }, next)
  return { input: stickyStepInput(e, next, mode), status: null }
}

async function routeStage($: EngineInterface, e: Frozen<TurnStepInput>, mode: 'measure' | 'active', options: PluginOptions, sticky: RouterSticky, messages: readonly ActivityMessage[], promptKey: RouterSticky['lastPrompt']): Promise<RoutedStep> {
  const promptText = lastPromptText(messages)
  const activity = summarizePreviousTurn(messages)
  const account = await resolveAccountId($)
  const { tiers, band } = await resolveRouterAccount($, account)
  const destination = await resolveSessionDestination($, await $.session.cwd())
  const jev = await askTierJudgment($, options, promptText, activity, band, destination.destinationKind)
  const decision: StageDecision = decideStage({
    tiers,
    jev,
    currentModel: sticky.model,
    currentEffort: sticky.effort,
    configuredModel: sticky.configuredModel,
    configuredEffort: sticky.configuredEffort,
    guards: { destinationKind: destination.destinationKind, policyHit: destination.policyHit, text: promptText, activity, confidence: jev?.confidence ?? null },
    band,
    pending: sticky.pendingLower,
    usage: sessionUsageOf(sticky.stats),
  })
  const applied = mode === 'active' && decision.changed
  const at = new Date(await $.clock.now()).toISOString()
  await appendRouterDecision($, at, `${JSON.stringify(routerDecisionRecord({ at, account, point: 'stage', decision, applied, quotaBand: band, breakEven: decision.breakEven }))}\n`)

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

  const status = decision.tier === null ? null : routerStatusFor({ tier: decision.tier, model: next.model, effort: next.effort }, tiers, mode, await resolveLocale($))
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
 */
async function routeSubagent($: EngineInterface, e: Frozen<AgentSpawnInput>, next: Next<'agent.spawn'>, mode: RouterMode, options: PluginOptions): Promise<AgentSpawnResult> {
  if (mode === 'off' || e.fork) return next(e)
  let input: AgentSpawnInput | Frozen<AgentSpawnInput> = e
  try {
    const account = await resolveAccountId($)
    const { tiers, band } = await resolveRouterAccount($, account)
    const text = `${e.description}\n${e.prompt}`
    const destination = await resolveSessionDestination($, e.cwd ?? (await $.session.cwd()))
    const jev = await askTierJudgment($, options, text, null, band, destination.destinationKind)
    const decision = decideSubagent({
      tiers,
      jev,
      parentModel: e.parentModel,
      explicitModel: e.model,
      guards: { destinationKind: destination.destinationKind, policyHit: destination.policyHit, text, activity: null, confidence: jev?.confidence ?? null },
      band,
    })
    const applied = mode === 'active' && decision.changed
    const at = new Date(await $.clock.now()).toISOString()
    const record = routerDecisionRecord({ at, account, point: 'subagent', decision: { ...decision, effort: null }, applied, quotaBand: band })
    await appendRouterDecision($, at, `${JSON.stringify(record)}\n`)
    if (applied) input = { ...e, model: decision.model }
  } catch {
    input = e
  }
  return next(input)
}

/**
 * `turn.step` -- the router (main loop only, when not off) rewrites
 * `model`/`effort` going down; everything else streams through unchanged
 * (`yield* next(...)`), and this step's usage is recorded once the response
 * is whole. Both halves fail open: a routing failure sends the step as it
 * was, a recording failure is swallowed.
 */
async function* handleTurnStep($: EngineInterface, e: Frozen<TurnStepInput>, next: StreamNext<'turn.step'>, mode: RouterMode, options: PluginOptions, showRouterStatus: (text: string) => void): StreamHookBody<TurnStepChunk, TurnStepResult> {
  let input: TurnStepInput | Frozen<TurnStepInput> = e
  if (mode !== 'off' && e.agentId === undefined) {
    let held: RouterSticky | undefined
    try {
      held = (await $.state.get({ plugin: 'orca-jev-mod-skills', key: 'routerSticky' })).value
      const routed = await routeMainStep($, e, mode, options)
      input = routed.input
      if (routed.status !== null) showRouterStatus(routed.status)
    } catch {
      // A routing failure keeps the sticky choice rather than flipping this
      // one step to the session's model and back (two cache rewrites for
      // one failure, review finding 12).
      input = stickyStepInput(e, held, mode)
    }
  }
  const r = yield* next(input)
  try {
    await recordTurnUsage($, input, r)
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
          orcaContextCache = await resolveOrcaContext(makeProcessRun($), await $.session.cwd())
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
        const status = decision.name ? t('status.skill', { name: decision.name }) : t('status.noSkill')

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

        return { block, status }
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
          orcaContextCache = await resolveOrcaContext(makeProcessRun($), await $.session.cwd())
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
        let wide: ToolWideResult | null = null
        try {
          const response = await callJev(apiKey, buildToolWideState(prompt, candidates, orcaState), buildToolWideQuestions(candidates), { budgetMs: toolBudgetMs, fetchImpl, sleepImpl })
          wide = interpretToolWide(response.answers, toolGateThreshold)
        } catch {
          wide = null
        }
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

        const decision = decideTool(wide, fit, fitAttempted, toolFitsThreshold)

        const measurementId = crypto.randomUUID()
        const at = new Date(await $.clock.now()).toISOString()
        await appendToolMeasurement(
          $,
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

        const status = decision.name ? t('status.tool', { name: decision.name }) : t('status.noTool')

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
    const shown = [promptStatusText, routerStatusText].filter((part): part is string => part !== null)
    if (shown.length > 0) $.ui.status(shown.join(' · '))

    const extraContext = [skillOutcome.block, toolOutcome.block].filter((block): block is string => block !== null)
    if (extraContext.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extraContext] })
  })

  on('skill.prompt', async ($, e, next) => {
    if (pendingMeasurementId !== null) {
      const id = pendingMeasurementId
      pendingMeasurementId = null
      const at = new Date(await $.clock.now()).toISOString()
      await appendMeasurement($, serializeRecord(buildObservationRecord(id, e.skill, at)))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const showRouterStatus = (text: string): void => {
      routerStatusText = text
      $.ui.status([promptStatusText, routerStatusText].filter((part): part is string => part !== null).join(' · '))
    }
    return yield* handleTurnStep($, e, next, routerMode, options, showRouterStatus)
  })

  on('agent.spawn', async ($, e, next) => routeSubagent($, e, next, routerMode, options))

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
        await appendToolMeasurement($, serializeToolRecord(buildToolObservationRecord(id, e.tool, at)))
      } catch {
        // Measurement is best-effort and must never block or fail a call.
      }
    }
    return next(e)
  })
}

// A type-level check, never executed: `register`'s own signature must keep
// matching `Register` exactly (the engine's declared shape), so a future
// edit that drifts from it fails typecheck here instead of failing silently
// inside the engine.
const _registerMatchesContract: Register = register
void _registerMatchesContract
