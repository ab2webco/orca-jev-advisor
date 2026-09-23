/**
 * decide — do I do this, do I not, or do I ask you?
 *
 * The order matters, and it's the difference between serving and getting in
 * the way:
 *
 *   1. Did the team already decide this? -> the policy applies and it either
 *                                            runs or gets blocked, without
 *                                            bothering anyone.
 *   2. If no policy covers it -> the risk gets judged, and only then can
 *                                 something reach the human.
 *
 * Asking purely by risk, with no policies, sends things to review that the
 * team already settled months ago. Measured: "comment @dependabot recreate"
 * comes out `pregunta` by risk and `actua` as soon as the covering rule exists.
 *
 * Every action that falls into step 2 is also a policy gap: the list of gaps
 * printed at the end is the list of rules still worth writing.
 *
 * Usage:
 *   node tools/decide.ts --policies policies.json "action 1" "action 2"
 *   node tools/decide.ts --policies policies.json --json "action"
 *   node tools/decide.ts "action"            # no policies: risk only, warns
 *
 * Context (changes the verdict, always pass it):
 *   ASK_OR_ACT_CONTEXT="client repo, shared main, release in 3 weeks"
 *
 * Node 24 runs this directly. No build, no dependencies.
 *
 * The decision logic (two stages: policy first, risk after) and the Jev
 * client live in src/core/ -- shared with the Claude Code adapter
 * (adapters/claude/gate-bash.ts) and the Orca plugin (adapters/orca/). This
 * file is only the command-line interface: it builds the context, calls the
 * two stages in order, and prints.
 */
import { buildDestinationRiskQuestions, buildDestinationState, buildPolicyQuestions, interpretDestinationPolicy, interpretDestinationRisk } from '../src/core/decisions.ts'
import type { DestinationDecision, Policy } from '../src/core/decisions.ts'
import { callJev } from '../src/core/jev.ts'
import { translateReason } from '../src/core/i18n.ts'
import { DESTINATION_CATALOG } from '../src/core/i18n_destination.ts'
import { loadPolicies } from '../src/core/policies.ts'
import { resolveApiKey } from '../src/core/secrets.ts'

// This CLI's own output is English (see the project-wide English migration),
// so `rationale` -- locale-agnostic in decisions.ts, see i18n.ts -- is
// resolved to English here at the edge, regardless of any panel/hook locale
// preference recorded elsewhere.
const CLI_LOCALE = 'en'

function renderRationale(decision: DestinationDecision): string {
  return decision.rationale.map((reason) => translateReason(DESTINATION_CATALOG, CLI_LOCALE, reason)).join(' · ')
}

async function decide(apiKey: string, action: string, policies: readonly Policy[], context: string): Promise<DestinationDecision> {
  if (policies.length > 0) {
    const policyResponse = await callJev(apiKey, buildDestinationState(action, context, policies), buildPolicyQuestions(policies))
    const fromPolicy = interpretDestinationPolicy(action, policies, policyResponse.answers)
    if (fromPolicy !== null) return fromPolicy
  }
  const riskResponse = await callJev(apiKey, buildDestinationState(action, context), buildDestinationRiskQuestions())
  return interpretDestinationRisk(action, riskResponse.answers)
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + '…' : value + ' '.repeat(width - value.length)
}

const MARK: Record<DestinationDecision['outcome'], string> = { actua: '✓ DO IT   ', no_hagas: "✗ DON'T   ", pregunta: '! ASK     ' }

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const policiesIndex = argv.indexOf('--policies')
  const policiesPath = policiesIndex === -1 ? null : argv[policiesIndex + 1] ?? null
  const actions = argv.filter((a, i) => a !== '--json' && a !== '--policies' && i !== policiesIndex + 1)

  if (actions.length === 0) {
    console.error('Usage: node decide.ts [--policies <file.json>] [--json] "action 1" "action 2" ...')
    process.exitCode = 1
    return
  }

  const policies = policiesPath === null ? [] : await loadPolicies(policiesPath)
  const apiKey = await resolveApiKey()
  if (apiKey === null) {
    console.error('No TYPESAFE_API_KEY in the environment or in ~/.config/orca-supervisor/env')
    process.exitCode = 1
    return
  }
  const context = process.env['ASK_OR_ACT_CONTEXT'] ?? 'Software project in active development.'
  const decisions = await Promise.all(actions.map((action) => decide(apiKey, action, policies, context)))

  if (asJson) {
    const printable = decisions.map((d) => ({ ...d, rationale: renderRationale(d) }))
    console.log(JSON.stringify({ context, policyCount: policies.length, decisions: printable }, null, 2))
    return
  }

  console.log(`Context: ${context}`)
  console.log(policies.length === 0 ? 'No policies: risk alone is judged, so more of this will land in your inbox than it needs to.\n' : `Policies loaded: ${policies.length}\n`)
  for (const d of decisions) {
    console.log(`${MARK[d.outcome]}  ${pad(d.action, 54)} ${d.source}`)
    console.log(`             ${renderRationale(d)}`)
  }

  const act = decisions.filter((d) => d.outcome === 'actua').length
  const blocked = decisions.filter((d) => d.outcome === 'no_hagas').length
  const ask = decisions.filter((d) => d.outcome === 'pregunta').length
  console.log(`\n${act} done · ${blocked} blocked by rule · ${ask} land on you`)

  const gaps = decisions.filter((d) => d.isPolicyGap)
  if (gaps.length > 0) {
    console.log(`\nNo rule covers these — each one is a policy worth writing:`)
    for (const g of gaps) console.log(`  - ${g.action}`)
  }
}

await main()
