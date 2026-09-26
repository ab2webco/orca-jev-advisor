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
 */
import type { EngineInterface, Register } from 'claude-code'
import { callJev } from '../../../../src/core/jev.ts'
import { resolveOrcaContext } from '../../../../src/core/orca_context.ts'
import type { OrcaContext } from '../../../../src/core/orca_context.ts'
import { listSkillInventory, stripSkillFrontmatter } from '../../../../src/core/skill_inventory.ts'
import type { SkillSummary } from '../../../../src/core/skill_inventory.ts'
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
import { buildDecisionRecord, buildObservationRecord, serializeRecord } from '../../../../src/core/skill_measurement.ts'
import { shouldSamplePrompt } from '../../../../src/core/mod_skills_sampling.ts'
import { listToolInventory } from '../../../../src/core/tool_inventory.ts'
import type { ToolSummary } from '../../../../src/core/tool_inventory.ts'
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
import { translate } from '../../../../src/core/i18n.ts'
import type { Locale } from '../../../../src/core/i18n.ts'
import { MOD_SKILLS_CATALOG } from '../../../../src/core/i18n_mod_skills.ts'
import type { ModSkillsKey } from '../../../../src/core/i18n_mod_skills.ts'
import { TOOLS_CATALOG } from '../../../../src/core/i18n_tools.ts'
import type { ToolsKey } from '../../../../src/core/i18n_tools.ts'
import { appendMeasurement, appendToolMeasurement, makeJevFetch, makeJevSleep, makeProcessRun, makeSkillFs, makeToolLister, measurementDecisionsToday, resolveApiKey, resolveHomeDir, resolveLocale, resolveModSkillsReadiness, resolveModSkillsSamplingConfig, resolveModSkillsSwitches, toolMeasurementDecisionsToday } from './runtime.ts'
import type { ModSkillsReadiness } from '../../../../src/core/mod_skills_readiness.ts'

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

export default ((on, options) => {
  const text = (key: string, fallback: string): string => (typeof options[key] === 'string' ? (options[key] as string) : fallback)
  const number = (key: string, fallback: number): number => (typeof options[key] === 'number' ? (options[key] as number) : fallback)
  const flag = (key: string, fallback: boolean): boolean => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)

  // Off by default: see the feature document's acceptance criteria --
  // active mode does not turn on until a week of measurement-mode data
  // exists to set these thresholds from.
  //
  // `options.active`/`options.activeTools` only ever carry a value once a
  // manifest declares `userConfig` (see claude-code.d.ts's own note on
  // `options`) -- nothing in this repo does, so `options` is always `{}`
  // and these two were permanently unreachable (T10,
  // odd/tasks/panel-worker-wakeup.md). `resolveActiveMode`/
  // `resolveActiveToolMode` below add a second, actually-reachable source:
  // the plugin's own config file (src/core/mod_skills_config.ts), read
  // once per session and cached in `modSkillsSwitchesCache`. `options`
  // still wins whenever it genuinely carries a boolean, so nothing
  // regresses the day `userConfig` starts being populated for real.
  const optionActive = typeof options.active === 'boolean' ? (options.active as boolean) : null
  const optionActiveTools = typeof options.activeTools === 'boolean' ? (options.activeTools as boolean) : null
  let modSkillsSwitchesCache: { active: boolean; activeTools: boolean } | null = null

  const resolveActiveMode = async ($: EngineInterface): Promise<boolean> => {
    if (optionActive !== null) return optionActive
    if (modSkillsSwitchesCache === null) modSkillsSwitchesCache = await resolveModSkillsSwitches($)
    return modSkillsSwitchesCache.active
  }
  const resolveActiveToolMode = async ($: EngineInterface): Promise<boolean> => {
    if (optionActiveTools !== null) return optionActiveTools
    if (modSkillsSwitchesCache === null) modSkillsSwitchesCache = await resolveModSkillsSwitches($)
    return modSkillsSwitchesCache.activeTools
  }

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

  // The activation metric (src/core/mod_skills_readiness.ts), fetched at
  // most once per session/process and reused after -- computing it folds
  // the whole measurement log (resolveModSkillsReadiness), so this is the
  // same "cache once, cheap after" shape as inventoryCache/orcaContextCache
  // above. `readinessFetched` (rather than a null check alone) exists
  // because a resolved-but-unavailable readiness (no resolvable home, an
  // unreadable log) is itself `null` -- a legitimate cached answer, not "not
  // fetched yet".
  let readinessFetched = false
  let readinessCache: ModSkillsReadiness | null = null
  const resolveReadiness = async ($: EngineInterface): Promise<ModSkillsReadiness | null> => {
    if (!readinessFetched) {
      readinessCache = await resolveModSkillsReadiness($)
      readinessFetched = true
    }
    return readinessCache
  }

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
    const samplingConfig = await resolveModSkillsSamplingConfig($)
    const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
    const promptsSampledToday = Math.max(await measurementDecisionsToday($, today), await toolMeasurementDecisionsToday($, today))
    const sampled = shouldSamplePrompt(samplingConfig, promptsSampledToday, Math.random())

    // Skill selection and tool selection each run in their own isolated
    // closure: a failure or timeout in one must never touch the other, and
    // neither may throw out of this hook (both fail open on their own).
    // Each resolves to the context block to inject (active mode only, and
    // only once a decision was actually reached) and the status text to
    // show (shown in both modes, same as before this mod suggested tools
    // too -- absent whenever the branch never reached a decision).
    const skillOutcome = await (async (): Promise<{ block: string | null; status: string | null }> => {
      try {
        const activeMode = await resolveActiveMode($)

        // An unsampled measurement-mode prompt does nothing at all: no Jev
        // call, no record, exactly like today's missing-API-key branch
        // below.
        if (!activeMode && !sampled) return { block: null, status: null }

        if (inventoryCache === null) {
          const cwd = await $.session.cwd()
          const home = await resolveHomeDir($)
          inventoryCache = await listSkillInventory(makeSkillFs($), {
            projectSkillsDir: `${cwd}/.claude/skills`,
            userSkillsDir: home ? `${home}/.claude/skills` : null,
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
        const readiness = await resolveReadiness($)
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
        const activeToolMode = await resolveActiveToolMode($)

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
    if (statusParts.length > 0) $.ui.status(statusParts.join(' · '))

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
}) satisfies Register
