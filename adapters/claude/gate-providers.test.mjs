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
