/**
 * policy-gate — the missing half of ask-or-act.
 *
 * ask-or-act only knows how risky an action is, so a merge always looks
 * dangerous and the human gets asked anyway. That reduces bundling but not
 * volume. What actually removes a question is a standing decision the team
 * already made.
 *
 * This asks two things per action, in one call:
 *   1. which team policy covers it (choice over the policy list, or none)
 *   2. whether the action, as described, is the kind of thing that policy
 *      describes (noul, kind-neutral -- match or no match)
 *
 * The covering policy's own `kind` then decides what a match means:
 *   permite + match  -> do it, cite the policy.
 *   pregunta + match -> ask a human, cite the policy.
 *   prohibe + match  -> do not do it, and say which rule it breaks.
 *   no match / not covered -> fall back to judging risk: this is a real gap
 *                             in the policy, and it is worth naming as such.
 *
 * Usage:
 *   node tools/policy-gate.ts --policies policies.json "action 1" "action 2"
 *   node tools/policy-gate.ts --policies policies.json --json "action"
 *
 * Node 24 runs this directly. No build, no dependencies.
 *
 * The policy question shapes and the coverage/match gates are byte
 * identical to tools/decide.ts's policy stage (this file predates that
 * split), so both now share one implementation: src/core/decisions.ts's
 * buildPolicyQuestions + interpretDestinationPolicy. This file's own job
 * is only the CLI: it also reads the raw 'cobertura'/'es_del_tipo' answers
 * directly (via src/core/jev.ts's accessors) to print the confidence/
 * match columns this tool has always shown.
 */
import { NO_POLICY_ID } from '../src/core/policies.ts'
import { buildDestinationState, buildPolicyQuestions, interpretDestinationPolicy } from '../src/core/decisions.ts'
import type { DestinationDecision, Policy } from '../src/core/decisions.ts'
import { callJev, getChoiceAnswer, getNoulAnswer } from '../src/core/jev.ts'
import { translateReason } from '../src/core/i18n.ts'
import { DESTINATION_CATALOG } from '../src/core/i18n_destination.ts'
import { loadPolicies } from '../src/core/policies.ts'
import { resolveApiKey } from '../src/core/secrets.ts'

// This CLI's own output is English (see the project-wide English migration),
// so `rationale` -- locale-agnostic in decisions.ts, see i18n.ts -- is
// resolved to English here at the edge, regardless of any panel/hook locale
// preference recorded elsewhere.
const CLI_LOCALE = 'en'

type Result = {
  readonly action: string
  readonly policyId: string
  readonly policyConfidence: number
  readonly match: number
  readonly outcome: DestinationDecision['outcome']
  readonly rationale: string
}

async function evaluate(apiKey: string, action: string, policies: readonly Policy[], context: string): Promise<Result> {
  const response = await callJev(apiKey, buildDestinationState(action, context, policies), buildPolicyQuestions(policies))
  const coverage = getChoiceAnswer(response.answers, 'cobertura')
  const match = getNoulAnswer(response.answers, 'es_del_tipo')

  const decision = interpretDestinationPolicy(action, policies, response.answers)
  if (decision === null) {
    return {
      action,
      policyId: NO_POLICY_ID,
      policyConfidence: coverage?.confidence ?? 0,
      match: match?.noul ?? 0,
      outcome: 'pregunta',
      rationale:
        coverage === null || coverage.choice === NO_POLICY_ID
          ? "No policy covers this: it's a gap in the team's rules, not the model's doubt."
          : `It's not clear which policy applies (confidence ${coverage.confidence.toFixed(2)}) or it isn't the kind of thing the policy covers.`,
    }
  }

  return {
    action,
    policyId: decision.policyId ?? NO_POLICY_ID,
    policyConfidence: coverage?.confidence ?? 0,
    match: match?.noul ?? 0,
    outcome: decision.outcome,
    // decisions.ts keeps `rationale` locale-agnostic (see src/core/i18n.ts);
    // this CLI resolves it to English text at the edge, same as it always printed.
    rationale: decision.rationale.map((reason) => translateReason(DESTINATION_CATALOG, CLI_LOCALE, reason)).join(' · '),
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + '…' : value + ' '.repeat(width - value.length)
}

const MARK: Record<DestinationDecision['outcome'], string> = { actua: '✓ DO IT   ', no_hagas: "✗ DON'T   ", pregunta: '! ASK     ' }

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const policiesIndex = argv.indexOf('--policies')
  if (policiesIndex === -1 || argv[policiesIndex + 1] === undefined) {
    console.error('Usage: node policy-gate.ts --policies <file.json> [--json] "action 1" "action 2" ...')
    process.exitCode = 1
    return
  }
  const policies = await loadPolicies(argv[policiesIndex + 1] as string)
  const actions = argv.filter((a, i) => a !== '--json' && a !== '--policies' && i !== policiesIndex + 1)

  if (actions.length === 0) {
    console.error('No action was received.')
    process.exitCode = 1
    return
  }

  const apiKey = await resolveApiKey()
  if (apiKey === null) {
    console.error('No TYPESAFE_API_KEY in the environment or in ~/.config/orca-supervisor/env')
    process.exitCode = 1
    return
  }
  const context = process.env['ASK_OR_ACT_CONTEXT'] ?? 'Software project in active development.'
  const results = await Promise.all(actions.map((action) => evaluate(apiKey, action, policies, context)))

  if (asJson) {
    console.log(JSON.stringify({ context, policies, results }, null, 2))
    return
  }

  console.log(`Context: ${context}`)
  console.log(`Policies loaded: ${policies.length}\n`)
  for (const r of results) {
    console.log(`${MARK[r.outcome]}  ${pad(r.action, 50)} ${pad(r.policyId, 22)} match ${r.match.toFixed(2)}`)
    console.log(`             ${r.rationale}`)
  }
  const act = results.filter((r) => r.outcome === 'actua').length
  const blocked = results.filter((r) => r.outcome === 'no_hagas').length
  const ask = results.filter((r) => r.outcome === 'pregunta').length
  console.log(`\n${act} resolved by policy · ${blocked} blocked by policy · ${ask} land on you`)
  const gaps = results.filter((r) => r.policyId === NO_POLICY_ID)
  if (gaps.length > 0) {
    console.log(`\nPolicy gaps worth writing:`)
    for (const g of gaps) console.log(`  - ${g.action}`)
  }
}

await main()
