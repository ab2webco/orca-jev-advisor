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
 *     in active mode, withholds it (`{ text: null }`) for the main
 *     conversation only. In measurement mode (the default) it is a no-op:
 *     `next(e)` unchanged, so the listing is never touched.
 *   prompt.submit -- the two Jev stages run for every real prompt of the
 *     main conversation (prompt.submit never fires for a subagent's own
 *     prompt): stage 1 ranks every installed skill and gates on whether a
 *     skill is needed at all; stage 2 re-reads the top few with the
 *     opening of their SKILL.md and asks one atomic `fits` per candidate.
 *     Measurement mode records what Jev would have chosen and changes
 *     nothing else. Active mode additionally withholds the listing and
 *     injects the winner's SKILL.md as context the model reads.
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
 * only once a decision was actually reached.
 */
import type { Register } from 'claude-code'
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
import { translate } from '../../../../src/core/i18n.ts'
import type { Locale } from '../../../../src/core/i18n.ts'
import { MOD_SKILLS_CATALOG } from '../../../../src/core/i18n_mod_skills.ts'
import type { ModSkillsKey } from '../../../../src/core/i18n_mod_skills.ts'
import { appendMeasurement, makeJevFetch, makeJevSleep, makeProcessRun, makeSkillFs, resolveApiKey, resolveHomeDir, resolveLocale } from './runtime.ts'

const DEFAULT_BUDGET_MS = 800
const DEFAULT_SHORTLIST = 3
const DEFAULT_EXCERPT_CHARS = 700

export default ((on, options) => {
  const text = (key: string, fallback: string): string => (typeof options[key] === 'string' ? (options[key] as string) : fallback)
  const number = (key: string, fallback: number): number => (typeof options[key] === 'number' ? (options[key] as number) : fallback)
  const flag = (key: string, fallback: boolean): boolean => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback)

  // Off by default: see the feature document's acceptance criteria --
  // active mode does not turn on until a week of measurement-mode data
  // exists to set these thresholds from.
  const activeMode = flag('active', false)
  const budgetMs = number('budgetMs', DEFAULT_BUDGET_MS)
  const gateThreshold = number('gateThreshold', DEFAULT_GATE_THRESHOLD)
  const fitsThreshold = number('fitsThreshold', DEFAULT_FITS_THRESHOLD)
  const shortlistSize = Math.max(1, Math.round(number('shortlist', DEFAULT_SHORTLIST)))
  const excerptChars = Math.max(0, Math.round(number('excerptChars', DEFAULT_EXCERPT_CHARS)))

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

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    // Measurement mode changes nothing observable, ever -- including this
    // attachment. Active mode only withholds for the main conversation:
    // a subagent's own listing is left alone, since nothing here suggests
    // for a subagent (prompt.submit never fires for one).
    if (!activeMode || e.agentId !== undefined) return next(e)
    return { text: null }
  })

  on('prompt.submit', async ($, e, next) => {
    const prompt = e.text.trim()
    // Nothing to route for an empty prompt or a typed slash command --
    // the latter already names its own skill.
    if (prompt.length === 0 || prompt.startsWith('/')) return next(e)

    try {
      if (inventoryCache === null) {
        const cwd = await $.session.cwd()
        const home = await resolveHomeDir($)
        inventoryCache = await listSkillInventory(makeSkillFs($), {
          projectSkillsDir: `${cwd}/.claude/skills`,
          userSkillsDir: home ? `${home}/.claude/skills` : null,
        })
      }
      const inventory = inventoryCache
      if (inventory.length === 0) return next(e)

      if (orcaContextCache === null) {
        orcaContextCache = await resolveOrcaContext(makeProcessRun($), await $.session.cwd())
      }
      const orcaContext = orcaContextCache
      const orcaState = { worktree: orcaContext.worktree, proyecto: orcaContext.proyecto, rama: orcaContext.rama }

      if (localeCache === null) localeCache = await resolveLocale($)
      const locale = localeCache
      const t = (key: ModSkillsKey, params?: Readonly<Record<string, string>>): string => translate(MOD_SKILLS_CATALOG, locale, key, params)

      const apiKey = await resolveApiKey($, options)
      if (apiKey === null) return next(e)

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

      const measurementId = crypto.randomUUID()
      const at = new Date(await $.clock.now()).toISOString()
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
            wide: wide === null ? null : { ranked: wide.ranked, gate: wide.gate, needsSkill: wide.needsSkill },
            fit: fit === null ? null : { winner: fit.winner, fits: fit.fits },
            decision: { name: decision.name, reason: decision.reason },
            latencyMs: { wide: wideLatencyMs, fit: fitLatencyMs },
          }),
        ),
      )
      pendingMeasurementId = measurementId

      $.ui.status(decision.name ? t('status.skill', { name: decision.name }) : t('status.noSkill'))

      // Measurement mode stops here: nothing observable changes. Active
      // mode injects the winner's own SKILL.md so it loads even where the
      // engine's listing would not have offered it.
      if (!activeMode || decision.name === null) return next(e)
      const winner = inventory.find((skill) => skill.name === decision.name)
      if (!winner) return next(e)

      let block: string
      try {
        const markdown = stripSkillFrontmatter(await $.fs.read(winner.path)).trim()
        block = [
          '<skill_relevance>',
          t('relevance.intro', { name: winner.name }),
          t('relevance.instructions'),
          `<skill name="${winner.name}">`,
          markdown,
          '</skill>',
          '</skill_relevance>',
        ].join('\n')
      } catch {
        return next(e)
      }
      return next({ ...e, context: [...(e.context ?? []), block] })
    } catch {
      // Fail open, always: any unexpected error leaves the prompt exactly
      // as it was, with no partial measurement or injection.
      return next(e)
    }
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
}) satisfies Register
