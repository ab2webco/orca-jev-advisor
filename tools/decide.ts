/**
 * decide — ¿esto lo hago, no lo hago, o te lo pregunto?
 *
 * El orden importa y es la diferencia entre servir y estorbar:
 *
 *   1. ¿Ya lo decidió el equipo?  -> se aplica la política y se ejecuta o se
 *                                    bloquea, sin molestar a nadie.
 *   2. Si ninguna política lo cubre -> se juzga el riesgo, y solo entonces
 *                                    puede llegarle algo al humano.
 *
 * Preguntar solo por riesgo, sin políticas, manda a revisión cosas que el
 * equipo ya resolvió hace meses. Medido: "comentar @dependabot recreate" sale
 * `pregunta` por riesgo y `actúa` en cuanto existe la regla que lo cubre.
 *
 * Cada acción que cae en el paso 2 es además un hueco de política: la lista de
 * huecos que imprime al final es la lista de reglas que faltan por escribir.
 *
 * Uso:
 *   node tools/decide.ts --policies policies.json "accion 1" "accion 2"
 *   node tools/decide.ts --policies policies.json --json "accion"
 *   node tools/decide.ts "accion"            # sin políticas: solo riesgo, avisa
 *
 * Contexto (cambia el veredicto, pásalo siempre):
 *   ASK_OR_ACT_CONTEXT="repo de cliente, main compartida, release en 3 semanas"
 *
 * Node 24 lo ejecuta directo. Sin build, sin dependencias.
 *
 * La logica de decision (dos etapas: politica primero, riesgo despues) y el
 * cliente de Jev viven en src/core/ -- compartidos con el adaptador de
 * Claude Code (adapters/claude/gate-bash.ts) y el plugin de Orca
 * (adapters/orca/). Este archivo es solo la interfaz de linea de comandos:
 * arma el contexto, llama a las dos etapas en orden, e imprime.
 */
import { buildDestinationRiskQuestions, buildDestinationState, buildPolicyQuestions, interpretDestinationPolicy, interpretDestinationRisk } from '../src/core/decisions.ts'
import type { DestinationDecision, Policy } from '../src/core/decisions.ts'
import { callJev } from '../src/core/jev.ts'
import { loadPolicies } from '../src/core/policies.ts'
import { resolveApiKey } from '../src/core/secrets.ts'

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

const MARK: Record<DestinationDecision['outcome'], string> = { actua: '✓ ACTUA   ', no_hagas: '✗ NO HAGAS', pregunta: '! PREGUNTA' }

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const policiesIndex = argv.indexOf('--policies')
  const policiesPath = policiesIndex === -1 ? null : argv[policiesIndex + 1] ?? null
  const actions = argv.filter((a, i) => a !== '--json' && a !== '--policies' && i !== policiesIndex + 1)

  if (actions.length === 0) {
    console.error('Uso: node decide.ts [--policies <archivo.json>] [--json] "accion 1" "accion 2" ...')
    process.exitCode = 1
    return
  }

  const policies = policiesPath === null ? [] : await loadPolicies(policiesPath)
  const apiKey = await resolveApiKey()
  if (apiKey === null) {
    console.error('No hay TYPESAFE_API_KEY en el entorno ni en ~/.config/orca-supervisor/env')
    process.exitCode = 1
    return
  }
  const context = process.env['ASK_OR_ACT_CONTEXT'] ?? 'Proyecto de software en desarrollo activo.'
  const decisions = await Promise.all(actions.map((action) => decide(apiKey, action, policies, context)))

  if (asJson) {
    console.log(JSON.stringify({ context, policyCount: policies.length, decisions }, null, 2))
    return
  }

  console.log(`Contexto: ${context}`)
  console.log(policies.length === 0 ? 'Sin politicas: solo se juzga riesgo, asi que llegara mas a tu bandeja de lo necesario.\n' : `Politicas cargadas: ${policies.length}\n`)
  for (const d of decisions) {
    console.log(`${MARK[d.outcome]}  ${pad(d.action, 54)} ${d.source}`)
    console.log(`             ${d.rationale}`)
  }

  const act = decisions.filter((d) => d.outcome === 'actua').length
  const blocked = decisions.filter((d) => d.outcome === 'no_hagas').length
  const ask = decisions.filter((d) => d.outcome === 'pregunta').length
  console.log(`\n${act} hechas · ${blocked} bloqueadas por regla · ${ask} te llegan a ti`)

  const gaps = decisions.filter((d) => d.isPolicyGap)
  if (gaps.length > 0) {
    console.log(`\nSin regla que las cubra — cada una es una politica que vale la pena escribir:`)
    for (const g of gaps) console.log(`  - ${g.action}`)
  }
}

await main()
