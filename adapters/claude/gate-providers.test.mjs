// Multi-provider P4 (odd/tasks/multi-provider.md), end to end through the
// real gate hook: the provider mode the worker mirrors decides who is asked,
// and the decision row says who answered and why Jev did. The network is a
// scripted fetch (fixtures/system-one-fetch-preload.mjs); the Clef bodies
// are the real envelope shape from src/core/fixtures/clef.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { parseGateDecisionRecords } from '../../src/core/gate_measurement.ts'
import { neuronLedgerFileName, serializeNeuronLedgerEntry } from '../../src/core/neuron_budget.ts'
import { CONSEQUENCE_NOISE_MARGIN, GATE_CONSEQUENCE_CEILING } from '../../src/core/decisions.ts'
import { GATE_CATALOG } from '../../src/core/i18n_gate.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'gate-bash.ts')
const PRELOAD = join(__dirname, 'fixtures', 'system-one-fetch-preload.mjs')
const COMMAND = 'some-unmeasured-tool --flag'

const homes = []
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

function makeHome ({ settings, cloudflare = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orca-jev-gate-providers-test-'))
  homes.push(home)
  const config = join(home, '.config', 'orca-supervisor')
  mkdirSync(config, { recursive: true })
  if (settings !== undefined) writeFileSync(join(config, 'decision-provider.json'), JSON.stringify(settings))
  if (cloudflare) writeFileSync(join(config, 'env'), 'CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\n', { mode: 0o600 })
  return home
}

function answers (consequence) {
  return {
    reversible: { type: 'noul', noul: 0.9 },
    external: { type: 'noul', noul: 0.05 },
    consequence: { type: 'score', score: consequence, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' }, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, confidence: 0.9 }
  }
}
const clefBody = (consequence) => JSON.stringify({ result: { model: 'clef', answers: answers(consequence), usage: { input_tokens: 480, output_tokens: 0 } }, success: true, errors: [], messages: [] })
const jevBody = (consequence) => JSON.stringify({ model: 'jev-latest', answers: answers(consequence), usage: { input_tokens: 480, output_tokens: 10 } })
const LINE = GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN

function run (home, { script, apiKey = 'jev-key' }) {
  const logPath = join(home, 'fetch.log')
  const env = { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  delete env.CLAUDE_CODE_TMPDIR
  delete env.CLOUDFLARE_ACCOUNT_ID
  delete env.CLOUDFLARE_API_TOKEN
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  env.ORCA_USER_DATA_PATH = join(home, 'orca-userdata-does-not-exist')
  if (apiKey === null) delete env.TYPESAFE_API_KEY
  else env.TYPESAFE_API_KEY = apiKey
  env.SYSTEM_ONE_FETCH_SCRIPT = JSON.stringify(script)
  env.SYSTEM_ONE_FETCH_LOG = logPath
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--import', PRELOAD, SCRIPT_PATH], {
    env,
    input: JSON.stringify({ tool_input: { command: COMMAND }, cwd: home, tool_use_id: 'tool-providers' }),
    encoding: 'utf8'
  })
  const requests = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  const cache = join(home, '.cache', 'orca-supervisor')
  const rows = existsSync(cache)
    ? readdirSync(cache).filter((name) => name.startsWith('gate-decisions')).flatMap((name) => parseGateDecisionRecords(readFileSync(join(cache, name), 'utf8')))
    : []
  return { stdout, requests, rows, cache }
}

test('no settings file is Jev only: Jev is asked and the row carries no provider keys', () => {
  const home = makeHome({ cloudflare: true })
  const { requests, rows } = run(home, { script: { 'api.typesafe.ai': { status: 200, body: jevBody(0.2) }, 'api.cloudflare.com': { status: 200, body: clefBody(0.2) } } })
  assert.deepEqual(requests.map((r) => r.host), ['api.typesafe.ai'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'jev')
  assert.equal('provider' in rows[0], false)
  assert.equal('escalation' in rows[0], false)
})

test('both mode: a confident Clef answer decides, Jev is not asked, and the neurons are ledgered', () => {
  const home = makeHome({ settings: { mode: 'both', clefModel: 'clef' } })
  const { requests, rows, cache } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefBody(0.2) }, 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } } })
  const clefRequests = requests.filter((r) => r.host === 'api.cloudflare.com')
  assert.equal(clefRequests.length, 1)
  assert.equal(clefRequests[0].path, '/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef')
  assert.equal(clefRequests[0].body.model, 'clef')
  assert.deepEqual(Object.keys(clefRequests[0].body.questions.reversible.criteria), ['true'])
  // A shadow Jev call may be sampled; it never decides.
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'jev')
  assert.equal(rows[0].verdict, 'allow')
  assert.equal(rows[0].provider, 'clef')
  assert.equal('escalation' in rows[0], false)
  const ledger = readFileSync(join(cache, neuronLedgerFileName(new Date())), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].type, 'neurons')
  assert.ok(Math.abs(ledger[0].neurons - 480 * 21818 / 1e6) < 1e-9)
})

test('both mode: a Clef answer near the line is re-asked of Jev, and Jev decides', () => {
  const home = makeHome({ settings: { mode: 'both', clefModel: 'clef-flash' } })
  const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefBody(LINE + 0.05) }, 'api.typesafe.ai': { status: 200, body: jevBody(0.2) } } })
  assert.ok(requests.some((r) => r.host === 'api.typesafe.ai'))
  assert.equal(requests.find((r) => r.host === 'api.cloudflare.com').body.model, 'clef-flash')
  assert.equal(rows[0].provider, 'jev')
  assert.equal(rows[0].escalation, 'doubt')
  assert.equal(rows[0].verdict, 'allow')
})

test('both mode: a Clef failure escalates to Jev', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  const { rows } = run(home, { script: { 'api.cloudflare.com': { status: 503, body: '' }, 'api.typesafe.ai': { status: 200, body: jevBody(0.2) } } })
  assert.equal(rows[0].source, 'jev')
  assert.equal(rows[0].provider, 'jev')
  assert.equal(rows[0].escalation, 'failure')
})

test('both mode: a spent day skips Clef and says so', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  const cache = join(home, '.cache', 'orca-supervisor')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, neuronLedgerFileName(new Date())), serializeNeuronLedgerEntry({ type: 'neurons', at: new Date().toISOString(), model: 'clef', neurons: 9000 }))
  const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefBody(0.2) }, 'api.typesafe.ai': { status: 200, body: jevBody(0.2) } } })
  assert.deepEqual(requests.map((r) => r.host), ['api.typesafe.ai'])
  assert.equal(rows[0].escalation, 'budget')
})

test('both mode with no Jev key: Clef alone decides', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  const { requests, rows } = run(home, { apiKey: null, script: { 'api.cloudflare.com': { status: 200, body: clefBody(LINE + 0.05) } } })
  assert.deepEqual(requests.map((r) => r.host), ['api.cloudflare.com'])
  assert.equal(rows[0].provider, 'clef')
})

test('Clef mode: Jev is never asked, even with a key; a spent day fails open as a Clef budget failure', () => {
  const home = makeHome({ settings: { mode: 'clef' } })
  const cache = join(home, '.cache', 'orca-supervisor')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, neuronLedgerFileName(new Date())), serializeNeuronLedgerEntry({ type: 'allowance-exhausted', at: new Date().toISOString() }))
  const { requests, rows } = run(home, { script: { 'api.typesafe.ai': { status: 200, body: jevBody(0.2) } } })
  assert.equal(requests.length, 0)
  assert.equal(rows[0].source, 'none')
  assert.equal(rows[0].provider, 'clef')
  assert.equal(rows[0].failureClass, 'budget')
})

test('Clef mode with no Cloudflare credentials takes the no-key path and names Cloudflare', () => {
  const home = makeHome({ settings: { mode: 'clef' }, cloudflare: false })
  const { stdout, requests } = run(home, { script: {} })
  assert.equal(requests.length, 0)
  assert.ok(stdout.includes(GATE_CATALOG.en.noProviderKey) || stdout.includes(GATE_CATALOG.es.noProviderKey), stdout)
})

// C1 (odd/tasks/clef-decides-policies.md): with a command-scoped policy, Clef
// answers first in both mode, and its own policy answers decide whether Jev
// is asked: a non-none choice on violation or needs_person at 0.2 or more.
const POLICIES = [
  { id: 'never_rewrite_shared_history', rule: 'Never rewrite history that others share.', kind: 'prohibits', scope: 'command' },
  { id: 'client_always_asks', rule: 'Anything touching a client is confirmed with a human.', kind: 'requires_human', scope: 'command' }
]

function writePolicies (home) {
  writeFileSync(join(home, '.config', 'orca-supervisor', 'policies.json'), JSON.stringify(POLICIES))
}

const choice = (probabilities) => {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  return { type: 'choice', choice: top[0], probabilities, confidence: top[1] }
}
function policyAnswers (consequence, { violation = { none: 1 }, needsPerson = { none: 1 } } = {}) {
  return { ...answers(consequence), violation: choice(violation), needs_person: choice(needsPerson) }
}
const clefPolicyBody = (consequence, options) => JSON.stringify({ result: { model: 'clef', answers: policyAnswers(consequence, options), usage: { input_tokens: 480, output_tokens: 0 } }, success: true, errors: [], messages: [] })
const jevPolicyBody = (consequence) => JSON.stringify({ model: 'jev-latest', answers: policyAnswers(consequence), usage: { input_tokens: 480, output_tokens: 10 } })

test('both mode with a policy: Clef answers, and a clean policy answer leaves the decision to Clef', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  writePolicies(home)
  const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2, { violation: { none: 0.81, policy_1: 0.19 }, needsPerson: { none: 0.9, policy_2: 0.1 } }) }, 'api.typesafe.ai': { status: 200, body: jevPolicyBody(0.2) } } })
  const clefRequests = requests.filter((r) => r.host === 'api.cloudflare.com')
  assert.equal(clefRequests.length, 1)
  assert.ok('violation' in clefRequests[0].body.questions && 'needs_person' in clefRequests[0].body.questions)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provider, 'clef')
  assert.equal('escalation' in rows[0], false)
  assert.equal(rows[0].verdict, 'allow')
})

test('both mode with a policy: a Clef policy probability of 0.2 sends it to Jev, marked policy', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  writePolicies(home)
  const { requests, rows, cache } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2, { violation: { none: 0.8, policy_1: 0.2 } }) }, 'api.typesafe.ai': { status: 200, body: jevPolicyBody(0.2) } } })
  assert.ok(requests.some((r) => r.host === 'api.cloudflare.com'))
  assert.ok(requests.some((r) => r.host === 'api.typesafe.ai'))
  assert.equal(rows[0].provider, 'jev')
  assert.equal(rows[0].escalation, 'policy')
  // The Clef call that escalated still spent its neurons.
  const ledger = readFileSync(join(cache, neuronLedgerFileName(new Date())), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(ledger.length, 1)
})

test('both mode with a policy: a Clef failure still escalates as a failure', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  writePolicies(home)
  const { rows } = run(home, { script: { 'api.cloudflare.com': { status: 503, body: '' }, 'api.typesafe.ai': { status: 200, body: jevPolicyBody(0.2) } } })
  assert.equal(rows[0].provider, 'jev')
  assert.equal(rows[0].escalation, 'failure')
})

test('both mode with a policy: a spent day still goes straight to Jev as budget', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  writePolicies(home)
  const cache = join(home, '.cache', 'orca-supervisor')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, neuronLedgerFileName(new Date())), serializeNeuronLedgerEntry({ type: 'neurons', at: new Date().toISOString(), model: 'clef', neurons: 9000 }))
  const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2) }, 'api.typesafe.ai': { status: 200, body: jevPolicyBody(0.2) } } })
  assert.deepEqual(requests.map((r) => r.host), ['api.typesafe.ai'])
  assert.equal(rows[0].escalation, 'budget')
})

test('Jev-only mode with a policy: Jev alone is asked, the row carries no provider keys', () => {
  const home = makeHome({ settings: { mode: 'jev' } })
  writePolicies(home)
  const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2) }, 'api.typesafe.ai': { status: 200, body: jevPolicyBody(0.2) } } })
  assert.deepEqual(requests.map((r) => r.host), ['api.typesafe.ai'])
  assert.equal('provider' in rows[0], false)
})

// T1 (odd/tasks/gate-model-spend.md): a permits answer never changes the
// gate's verdict (decideGateAction lets it fall through to risk), so the gate
// stops paying for it: no coverage or same_kind question and no permits rule
// in the request, to Jev or to Clef. The neutral keys follow the list that
// was asked, so a violation still names the real prohibition.
const POLICIES_WITH_PERMITS = [
  { id: 'read_and_test', rule: 'Reading code and running tests happens without asking.', kind: 'permits', scope: 'command' },
  ...POLICIES
]

for (const mode of ['jev', 'both']) {
  test(`${mode} mode: a permits policy is not asked, and a violation still names the real prohibition`, () => {
    const home = makeHome({ settings: { mode } })
    writeFileSync(join(home, '.config', 'orca-supervisor', 'policies.json'), JSON.stringify(POLICIES_WITH_PERMITS))
    const violates = (body) => JSON.stringify({ ...body, answers: { ...policyAnswers(0.2), violation: choice({ policy_1: 0.95, none: 0.05 }) } })
    const jev = violates({ model: 'jev-latest', usage: { input_tokens: 480, output_tokens: 10 } })
    const clef = JSON.stringify({ result: JSON.parse(violates({ model: 'clef', usage: { input_tokens: 480, output_tokens: 0 } })), success: true, errors: [], messages: [] })
    const { requests, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clef }, 'api.typesafe.ai': { status: 200, body: jev } } })
    assert.ok(requests.length > 0)
    for (const request of requests) {
      assert.deepEqual(Object.keys(request.body.questions).sort(),['consequence', 'external', 'needs_person', 'reversible', 'violation'])
      assert.equal(JSON.stringify(request.body).includes('running tests happens without asking'), false)
    }
    assert.equal(rows[0].verdict, 'deny')
    assert.equal(rows[0].policyId, 'never_rewrite_shared_history')
  })
}

test('jev mode: behind a permits policy, a needs_person answer still names the real requires_human policy', () => {
  const home = makeHome({ settings: { mode: 'jev' } })
  writeFileSync(join(home, '.config', 'orca-supervisor', 'policies.json'), JSON.stringify(POLICIES_WITH_PERMITS))
  const body = JSON.stringify({ model: 'jev-latest', answers: policyAnswers(0.2, { needsPerson: { policy_2: 0.95, none: 0.05 } }), usage: { input_tokens: 480, output_tokens: 10 } })
  const { rows } = run(home, { script: { 'api.typesafe.ai': { status: 200, body } } })
  assert.equal(rows[0].verdict, 'ask')
  assert.equal(rows[0].policyId, 'client_always_asks')
})

// C2 (odd/tasks/clef-decides-policies.md): the person's line and the model's
// text name whoever decided. Jev's stay byte-identical to what they were.
function setLocale (home, locale) {
  writeFileSync(join(home, '.config', 'orca-supervisor', 'locale'), locale)
}
const SEGMENT = COMMAND

test('both mode: a Clef advice names Clef to the person and to the model (es)', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  setLocale(home, 'es')
  const { stdout, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefBody(2.5) }, 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } } })
  assert.equal(rows[0].provider, 'clef')
  const payload = JSON.parse(stdout)
  assert.equal(payload.systemMessage, 'clef · avisó al modelo antes de `' + SEGMENT + '`: Clef no está seguro de que sea inofensivo')
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^Clef advice \(not a refusal\): /)
  assert.doesNotMatch(payload.hookSpecificOutput.permissionDecisionReason, /\bJev\b/)
})

test('both mode: an advice Jev decided after Clef doubted still names Jev, exactly as before', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  setLocale(home, 'es')
  const { stdout, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefBody(LINE + 0.05) }, 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } } })
  assert.equal(rows[0].provider, 'jev')
  const payload = JSON.parse(stdout)
  assert.ok(payload.systemMessage.startsWith('jev · avisó al modelo antes de `' + SEGMENT + '`: '), payload.systemMessage)
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^Jev advice \(not a refusal\): /)
})

test('Jev-only mode: the advice is byte-identical to the one an unset mode gives', () => {
  const jevOnly = makeHome({ settings: { mode: 'jev' } })
  const unset = makeHome({})
  const script = { 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } }
  const a = run(jevOnly, { script }).stdout
  const b = run(unset, { script }).stdout
  assert.equal(a, b)
  assert.ok(JSON.parse(a).systemMessage.startsWith('jev · advised the model before `'))
  assert.match(JSON.parse(a).hookSpecificOutput.permissionDecisionReason, /^Jev advice \(not a refusal\): /)
})

test('Clef mode: a policy block Clef decided names Clef; the REFUSED text is unchanged', () => {
  const home = makeHome({ settings: { mode: 'clef' } })
  setLocale(home, 'es')
  writePolicies(home)
  const { stdout, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2, { violation: { none: 0.04, policy_1: 0.96 } }) } } })
  assert.equal(rows[0].provider, 'clef')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(payload.systemMessage, 'clef · bloqueó `' + SEGMENT + '`: lo prohíbe la política never_rewrite_shared_history')
  assert.ok(payload.hookSpecificOutput.permissionDecisionReason.startsWith('REFUSED: forbidden by the team policy never_rewrite_shared_history ('))
})

test('both mode: a policy block Jev decided after a Clef policy hit names Jev', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  setLocale(home, 'en')
  writePolicies(home)
  const jevDeny = JSON.stringify({ model: 'jev-latest', answers: policyAnswers(0.2, { violation: { none: 0.04, policy_1: 0.96 } }), usage: { input_tokens: 480, output_tokens: 10 } })
  const { stdout, rows } = run(home, { script: { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2, { violation: { none: 0.04, policy_1: 0.96 } }) }, 'api.typesafe.ai': { status: 200, body: jevDeny } } })
  assert.equal(rows[0].provider, 'jev')
  assert.equal(rows[0].escalation, 'policy')
  assert.equal(rows[0].verdict, 'deny')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(payload.hookSpecificOutput.permissionDecisionReason.startsWith('REFUSED: forbidden by the team policy never_rewrite_shared_history ('))
  assert.equal(payload.systemMessage, 'jev · blocked `' + SEGMENT + '`: forbidden by the policy never_rewrite_shared_history')
  assert.doesNotMatch(stdout, /\bclef\b/i)
})

// Captured from 0.13.3 (384e242) before C2: Jev-only output must never change.
// Recaptured on purpose in 0.13.7 (odd/tasks/advice-no-repeat.md): the model
// text no longer echoes a single-segment command nor the catalog note, and
// has a shorter header. The systemMessage part is byte for byte unchanged.
const GOLDEN_JEV_ADVICE = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Jev advice (not a refusal): worth a second look before it runs.\\nWhy: if it is wrong, it breaks something that matters to someone.\\nThis session could not be identified, so repeating the command will NOT be recognized as the same request and will be judged fresh. If the user explicitly asked for exactly this, say so plainly and proceed deliberately; otherwise, change course."},"systemMessage":"jev · advised the model before `some-unmeasured-tool --flag`: Jev isn\'t sure it\'s harmless"}'
const GOLDEN_JEV_DENY_ES = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"REFUSED: forbidden by the team policy never_rewrite_shared_history (Never rewrite history that others share.). You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work."},"systemMessage":"jev · bloqueó `some-unmeasured-tool --flag`: lo prohíbe la política never_rewrite_shared_history"}'

test('Jev-only mode: an advice and a policy block are byte-identical to the 0.13.7 capture', () => {
  assert.equal(run(makeHome({ settings: { mode: 'jev' } }), { script: { 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } } }).stdout, GOLDEN_JEV_ADVICE)
  const home = makeHome({ settings: { mode: 'jev' } })
  setLocale(home, 'es')
  writePolicies(home)
  const deny = JSON.stringify({ model: 'jev-latest', answers: policyAnswers(0.2, { violation: { none: 0.04, policy_1: 0.96 } }), usage: { input_tokens: 480, output_tokens: 10 } })
  assert.equal(run(home, { script: { 'api.typesafe.ai': { status: 200, body: deny } } }).stdout, GOLDEN_JEV_DENY_ES)
})

// C3b: a cache hit names whoever decided the entry it replays. Captured
// before C3b: a Jev-only cache hit must never change. Recaptured on purpose
// in 0.13.7 (odd/tasks/advice-no-repeat.md): the cached `·`-joined reason is
// split and the catalog note dropped, so it now matches the fresh advice. The
// systemMessage part is byte for byte unchanged.
const GOLDEN_JEV_CACHE_ADVICE = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Jev advice (not a refusal): worth a second look before it runs.\\nWhy: if it is wrong, it breaks something that matters to someone.\\nThis session could not be identified, so repeating the command will NOT be recognized as the same request and will be judged fresh. If the user explicitly asked for exactly this, say so plainly and proceed deliberately; otherwise, change course."},"systemMessage":"jev · advised the model before `some-unmeasured-tool --flag`: Jev isn\'t sure it\'s harmless"}'
const GOLDEN_JEV_CACHE_DENY_ES = GOLDEN_JEV_DENY_ES
const policyDenyAnswers = () => policyAnswers(0.2, { violation: { none: 0.04, policy_1: 0.96 } })

function cacheEntries (home) {
  return Object.values(JSON.parse(readFileSync(join(home, '.cache', 'orca-supervisor', 'gate-bash.json'), 'utf8')))
}

test('Jev-only mode: a cache hit is byte-identical to before, and its entry carries no provider', () => {
  const advise = makeHome({ settings: { mode: 'jev' } })
  const script = { 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } }
  run(advise, { script })
  const second = run(advise, { script })
  assert.deepEqual(second.rows.map((r) => r.source), ['jev', 'cache'])
  assert.equal(second.stdout, GOLDEN_JEV_CACHE_ADVICE)
  assert.ok(cacheEntries(advise).every((entry) => !('provider' in entry)))
  const home = makeHome({ settings: { mode: 'jev' } })
  setLocale(home, 'es')
  writePolicies(home)
  const deny = JSON.stringify({ model: 'jev-latest', answers: policyDenyAnswers(), usage: { input_tokens: 480, output_tokens: 10 } })
  run(home, { script: { 'api.typesafe.ai': { status: 200, body: deny } } })
  assert.equal(run(home, { script: { 'api.typesafe.ai': { status: 200, body: deny } } }).stdout, GOLDEN_JEV_CACHE_DENY_ES)
})

test('both mode: a cache hit of a Clef advice names Clef, to the person and the model', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  setLocale(home, 'es')
  const script = { 'api.cloudflare.com': { status: 200, body: clefBody(2.5) }, 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } }
  run(home, { script })
  assert.ok(cacheEntries(home).some((entry) => entry.provider === 'clef'))
  const second = run(home, { script })
  assert.equal(second.rows.at(-1).source, 'cache')
  const payload = JSON.parse(second.stdout)
  assert.equal(payload.systemMessage, 'clef · avisó al modelo antes de `' + SEGMENT + '`: Clef no está seguro de que sea inofensivo')
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /^Clef advice \(not a refusal\): /)
})

test('both mode: a cache hit of a Jev advice (after Clef doubted) still names Jev', () => {
  const home = makeHome({ settings: { mode: 'both' } })
  const script = { 'api.cloudflare.com': { status: 200, body: clefBody(LINE + 0.05) }, 'api.typesafe.ai': { status: 200, body: jevBody(2.5) } }
  run(home, { script })
  assert.ok(cacheEntries(home).every((entry) => !('provider' in entry)))
  const second = run(home, { script })
  assert.equal(second.rows.at(-1).source, 'cache')
  assert.equal(second.stdout, GOLDEN_JEV_CACHE_ADVICE)
})

test('Clef mode: a cache hit of a Clef policy block names Clef', () => {
  const home = makeHome({ settings: { mode: 'clef' } })
  setLocale(home, 'es')
  writePolicies(home)
  const script = { 'api.cloudflare.com': { status: 200, body: clefPolicyBody(0.2, { violation: { none: 0.04, policy_1: 0.96 } }) } }
  run(home, { script })
  const second = run(home, { script })
  assert.equal(second.rows.at(-1).source, 'cache')
  assert.equal(JSON.parse(second.stdout).systemMessage, 'clef · bloqueó `' + SEGMENT + '`: lo prohíbe la política never_rewrite_shared_history')
})
