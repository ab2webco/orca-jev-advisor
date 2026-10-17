// Multi-provider P7 (odd/tasks/multi-provider.md): the board's "Who decides"
// card -- answers by provider, doubt escalations, failovers, Clef's
// confident errors and neurons against the free allowance, for the board's
// global window. board.html has no module graph, so its pure helper is read
// from the panel's own source and evaluated here; real-DOM coverage is in
// scripts/panels.spec.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { extractFunction } from './panel_html_copies.mjs'

const boardHtml = readFileSync(new URL('./board.html', import.meta.url), 'utf8')
const providerFacts = new Function(`${extractFunction(boardHtml, 'providerFacts')}; return providerFacts`)()

function catalogBlock (locale) {
  const start = boardHtml.indexOf(`        ${locale}: {`)
  return boardHtml.slice(start, boardHtml.indexOf('\n        }', start))
}

const escalations = (over) => ({ doubt: 0, failure: 0, 'rate-limit': 0, budget: 0, unsupported: 0, policy: 0, unconfigured: 0, ...over })
const window = (providers, neurons = { spent: 0, calls: 0 }) => ({ providers, neurons })
const budget = (spent, exhausted = false) => ({ today: { spent, calls: 1, exhausted }, allowance: 10000, stop: 9000 })

test('a Jev-only window with no spend today shows no card', () => {
  const facts = providerFacts(window({ tagged: 0, answeredBy: { jev: 0, clef: 0 }, escalations: escalations({}), clefUnanswered: 0, shadow: { agree: 0, disagree: 0 } }), budget(0))
  assert.equal(facts.visible, false)
  assert.equal(providerFacts({}, null).visible, false, 'an older reading without the fields shows nothing')
})

test('the figures: answers, doubt, failovers by reason, unanswered, confident errors, neurons', () => {
  const facts = providerFacts(window({
    tagged: 30,
    answeredBy: { jev: 8, clef: 20 },
    escalations: escalations({ doubt: 5, failure: 1, 'rate-limit': 1, budget: 1, unsupported: 0, policy: 2 }),
    clefUnanswered: 2,
    shadow: { agree: 3, disagree: 1 }
  }, { spent: 210.4, calls: 20 }), budget(4500))
  assert.equal(facts.visible, true)
  assert.equal(facts.clef, 20)
  assert.equal(facts.jev, 8)
  assert.equal(facts.doubt, 5)
  assert.equal(facts.failovers, 3)
  assert.equal(facts.policy, 2)
  assert.equal(facts.unanswered, 2)
  assert.equal(facts.shadowTotal, 4)
  assert.equal(facts.confidentErrors, 1)
  assert.equal(facts.windowNeurons, 210.4)
  assert.equal(facts.todaySpent, 4500)
  assert.equal(facts.todayShare, 45)
  assert.equal(facts.clefOff, false)
})

test('Clef is off for the day once the stop is reached or Cloudflare said the allowance is spent', () => {
  const tagged = { tagged: 1, answeredBy: { jev: 1, clef: 0 }, escalations: escalations({ budget: 1 }), clefUnanswered: 0, shadow: { agree: 0, disagree: 0 } }
  assert.equal(providerFacts(window(tagged), budget(9000)).clefOff, true)
  assert.equal(providerFacts(window(tagged), budget(10, true)).clefOff, true)
  assert.equal(providerFacts(window(tagged), budget(8999)).clefOff, false)
  // Spend today with no tagged decision in the window still shows the card.
  assert.equal(providerFacts(window({ ...tagged, tagged: 0 }), budget(5)).visible, true)
})

test('the card and every string it uses exist, in both languages', () => {
  assert.match(boardHtml, /<section class="card wide" id="card-providers"/)
  const keys = ['providers.heading', 'providers.answered', 'providers.clef', 'providers.jev', 'providers.doubt', 'providers.failovers',
    'providers.policy', 'providers.unanswered', 'providers.shadow', 'providers.shadowNone', 'providers.windowNeurons', 'providers.today', 'providers.off']
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of keys) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
})

// C3 (odd/tasks/clef-decides-policies.md): the latest decisions name the
// provider that answered, and the policy line says what a policy escalation
// now means.
test('a recent decision Clef answered reads clef; Jev or an untagged row reads jev; the rest as before', () => {
  const recentSourceKey = new Function(`${extractFunction(boardHtml, 'recentSourceKey')}; return recentSourceKey`)()
  assert.equal(recentSourceKey({ source: 'jev', provider: 'clef' }), 'stats.recentClef')
  assert.equal(recentSourceKey({ source: 'jev', provider: 'jev' }), 'stats.recentJev')
  assert.equal(recentSourceKey({ source: 'jev' }), 'stats.recentJev')
  assert.equal(recentSourceKey({ source: 'cache' }), 'stats.recentCached')
  assert.equal(recentSourceKey({ source: 'local-rule' }), 'stats.recentLocalRule')
  assert.equal(recentSourceKey({ source: 'none', provider: 'clef' }), 'stats.recentNone')
  assert.equal(recentSourceKey({ source: 'mystery' }), null)
  for (const locale of ['es', 'en']) assert.ok(catalogBlock(locale).includes("'stats.recentClef': 'clef'"), locale)
})

test('the policy line says Clef saw a possible policy hit and Jev answered', () => {
  assert.ok(catalogBlock('es').includes("'providers.policy': 'Clef vio que podía aplicar una política, así que respondió Jev: {{n}}.'"))
  assert.ok(catalogBlock('en').includes("'providers.policy': 'Clef saw a possible policy hit, so Jev answered: {{n}}.'"))
  assert.doesNotMatch(boardHtml, /directo a Jev|straight to Jev/)
})

// C3b: the sources bar puts each provider's decisions under its own name.
const sourceFacts = new Function(`${extractFunction(boardHtml, 'sourceFacts')}; return sourceFacts`)()

test('the sources bar: a Jev-only window is what it always was', () => {
  const facts = sourceFacts({ bySource: { jev: 40, cache: 10, 'local-rule': 5, none: 2 }, jevLatency: { medianMs: 820 } })
  assert.deepEqual(facts, { jev: 40, clef: 0, cache: 10, localRule: 5, noneJev: 2, noneClef: 0, jevMedianMs: 820, clefMedianMs: null })
  assert.deepEqual(sourceFacts({}), { jev: 0, clef: 0, cache: 0, localRule: 0, noneJev: 0, noneClef: 0, jevMedianMs: null, clefMedianMs: null })
})

test('the sources bar: Clef answers and Clef failures leave Jev\'s figures, each with its own median', () => {
  const w = {
    bySource: { jev: 100, cache: 4, 'local-rule': 3, none: 5 },
    jevLatency: { sampleCount: 30, medianMs: 600 },
    clefLatency: { sampleCount: 70, medianMs: 380 },
    providers: { tagged: 105, answeredBy: { jev: 30, clef: 70 }, escalations: escalations({ doubt: 10 }), clefUnanswered: 3, shadow: { agree: 0, disagree: 0 } }
  }
  const facts = sourceFacts(w)
  assert.equal(facts.jev, 30)
  assert.equal(facts.clef, 70)
  assert.equal(facts.noneJev, 2)
  assert.equal(facts.noneClef, 3)
  // SF1: jevLatency holds only Jev's rows now, so its median is Jev's own.
  assert.equal(facts.jevMedianMs, 600)
  assert.equal(facts.clefMedianMs, 380)
  // Counts never go negative on an inconsistent reading.
  const odd = sourceFacts({ bySource: { jev: 1, none: 0 }, providers: { answeredBy: { clef: 5 }, clefUnanswered: 2 } })
  assert.equal(odd.jev, 0)
  assert.equal(odd.clef, 1)
  assert.equal(odd.noneClef, 0)
})

test('SF1: the status latency chips: Jev\'s as before, and Clef\'s beside it when Clef answered', () => {
  const statusLatency = new Function(`${extractFunction(boardHtml, 'statusLatency')}; return statusLatency`)()
  assert.deepEqual(statusLatency({ jevLatency: { sampleCount: 4, medianMs: 500, p95Ms: 900 } }), [{ key: 'status.latency', p50: 500, p95: 900 }])
  assert.deepEqual(statusLatency({}), [{ key: 'status.latencyNone' }])
  assert.deepEqual(statusLatency({ jevLatency: { sampleCount: 4, medianMs: 500, p95Ms: 900 }, clefLatency: { sampleCount: 7, medianMs: 300, p95Ms: 700 } }),
    [{ key: 'status.latency', p50: 500, p95: 900 }, { key: 'status.latencyClef', p50: 300, p95: 700 }])
  assert.deepEqual(statusLatency({ jevLatency: { sampleCount: 0 }, clefLatency: { sampleCount: 7, medianMs: 300, p95Ms: 700 } }),
    [{ key: 'status.latencyNone' }, { key: 'status.latencyClef', p50: 300, p95: 700 }])
  assert.ok(catalogBlock('es').includes("'status.latencyClef': 'Clef en esta ventana: p50 {{p50}} ms · p95 {{p95}} ms'"))
  assert.ok(catalogBlock('en').includes("'status.latencyClef': 'Clef in this window: p50 {{p50}} ms · p95 {{p95}} ms'"))
  assert.ok(catalogBlock('es').includes("'gate.source.clefMedian': 'Clef (con red, mediana {{ms}} ms)'"))
  assert.ok(catalogBlock('en').includes("'gate.source.clefMedian': 'Clef (network, median {{ms}} ms)'"))
})

test('the sources bar labels exist in both languages', () => {
  assert.ok(catalogBlock('es').includes("'gate.source.clef': 'Clef (con red)'"))
  assert.ok(catalogBlock('en').includes("'gate.source.clef': 'Clef (network)'"))
  assert.ok(catalogBlock('es').includes("'gate.source.noneClef': 'Nadie: Clef no contestó'"))
  assert.ok(catalogBlock('en').includes("'gate.source.noneClef': 'Nobody: Clef did not answer'"))
  assert.ok(catalogBlock('es').includes("'load.unjudgedClef': '{{n}} comando(s) pasaron sin juicio: se le preguntó a Clef y no contestó."))
  assert.ok(catalogBlock('en').includes("'load.unjudgedClef': '{{n}} command(s) passed unjudged: Clef was asked and did not answer."))
})
