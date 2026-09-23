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
 *   2. whether the action, as described, complies with that policy (noul)
 *
 * Covered and compliant  -> do it, cite the policy.
 * Covered and violating  -> do not do it, and say which rule it breaks.
 * Not covered            -> fall back to judging risk: this is a real gap in
 *                           the policy, and it is worth naming as such.
 *
 * Usage:
 *   node tools/policy-gate.ts --policies policies.json "accion 1" "accion 2"
 *   node tools/policy-gate.ts --policies policies.json --json "accion"
 *
 * Node 24 runs this directly. No build, no dependencies.
 *
 * The policy question shapes and the coverage/compliance gates are byte
 * identical to tools/decide.ts's policy stage (this file predates that
 * split), so both now share one implementation: src/core/decisions.ts's
 * buildPolicyQuestions + interpretDestinationPolicy. This file's own job
 * is only the CLI: it also reads the raw 'cobertura'/'cumple' answers
 * directly (via src/core/jev.ts's accessors) to print the confidence/
 * compliance columns this tool has always shown.
 */
import { NO_POLICY_ID } from '../src/core/policies.ts'
import { buildDestinationState, buildPolicyQuestions, interpretDestinationPolicy } from '../src/core/decisions.ts'
import type { DestinationDecision, Policy } from '../src/core/decisions.ts'
import { callJev, getChoiceAnswer, getNoulAnswer } from '../src/core/jev.ts'
import { loadPolicies } from '../src/core/policies.ts'
import { resolveApiKey } from '../src/core/secrets.ts'

type Result = {
  readonly action: string
  readonly policyId: string
  readonly policyConfidence: number
  readonly complies: number
  readonly outcome: DestinationDecision['outcome']
  readonly rationale: string
}

async function evaluate(apiKey: string, action: string, policies: readonly Policy[], context: string): Promise<Result> {
  const response = await callJev(apiKey, buildDestinationState(action, context, policies), buildPolicyQuestions(policies))
  const coverage = getChoiceAnswer(response.answers, 'cobertura')
  const complies = getNoulAnswer(response.answers, 'cumple')

  const decision = interpretDestinationPolicy(action, policies, response.answers)
  if (decision === null) {
    return {
      action,
      policyId: NO_POLICY_ID,
      policyConfidence: coverage?.confidence ?? 0,
      complies: complies?.noul ?? 0,
      outcome: 'pregunta',
      rationale:
        coverage === null || coverage.choice === NO_POLICY_ID
          ? 'No hay politica que cubra esto: es un hueco en las reglas del equipo, no una duda del modelo.'
          : `No esta claro que politica aplica (confianza ${coverage.confidence.toFixed(2)}).`,
    }
  }

  return {
    action,
    policyId: decision.policyId ?? NO_POLICY_ID,
    policyConfidence: coverage?.confidence ?? 0,
    complies: complies?.noul ?? 0,
    outcome: decision.outcome,
    rationale: decision.rationale,
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + '…' : value + ' '.repeat(width - value.length)
}

const MARK: Record<DestinationDecision['outcome'], string> = { actua: '✓ ACTUA   ', no_hagas: '✗ NO HAGAS', pregunta: '! PREGUNTA' }

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const policiesIndex = argv.indexOf('--policies')
  if (policiesIndex === -1 || argv[policiesIndex + 1] === undefined) {
    console.error('Uso: node policy-gate.ts --policies <archivo.json> [--json] "accion 1" "accion 2" ...')
    process.exitCode = 1
    return
  }
  const policies = await loadPolicies(argv[policiesIndex + 1] as string)
  const actions = argv.filter((a, i) => a !== '--json' && a !== '--policies' && i !== policiesIndex + 1)

  if (actions.length === 0) {
    console.error('No se recibio ninguna accion.')
    process.exitCode = 1
    return
  }

  const apiKey = await resolveApiKey()
  if (apiKey === null) {
    console.error('No hay TYPESAFE_API_KEY en el entorno ni en ~/.config/orca-supervisor/env')
    process.exitCode = 1
    return
  }
  const context = process.env['ASK_OR_ACT_CONTEXT'] ?? 'Proyecto de software en desarrollo activo.'
  const results = await Promise.all(actions.map((action) => evaluate(apiKey, action, policies, context)))

  if (asJson) {
    console.log(JSON.stringify({ context, policies, results }, null, 2))
    return
  }

  console.log(`Contexto: ${context}`)
  console.log(`Politicas cargadas: ${policies.length}\n`)
  for (const r of results) {
    console.log(`${MARK[r.outcome]}  ${pad(r.action, 50)} ${pad(r.policyId, 22)} cumple ${r.complies.toFixed(2)}`)
    console.log(`             ${r.rationale}`)
  }
  const act = results.filter((r) => r.outcome === 'actua').length
  const blocked = results.filter((r) => r.outcome === 'no_hagas').length
  const ask = results.filter((r) => r.outcome === 'pregunta').length
  console.log(`\n${act} resueltas por politica · ${blocked} bloqueadas por politica · ${ask} te llegan a ti`)
  const gaps = results.filter((r) => r.policyId === NO_POLICY_ID)
  if (gaps.length > 0) {
    console.log(`\nHuecos de politica que vale la pena escribir:`)
    for (const g of gaps) console.log(`  - ${g.action}`)
  }
}

await main()
