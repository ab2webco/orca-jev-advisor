// Multi-provider P6 (odd/tasks/multi-provider.md): the config panel's
// "Decision provider" section -- the mode (Jev / Both / Clef), the Clef
// model, the Cloudflare credentials (sent as secret requests, shown only
// masked) and a connection test. Source-as-text checks, same approach as
// config_html_queue_mode.test.mjs; real-DOM coverage is in
// scripts/panels.spec.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { extractFunction } from './panel_html_copies.mjs'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

function generalTab () {
  const start = configHtml.indexOf('id="panel-general"')
  const next = configHtml.indexOf('class="tab-panel"', start + 1)
  return configHtml.slice(start, next)
}

function catalogBlock (locale) {
  const start = configHtml.indexOf(`        ${locale}: {`)
  assert.ok(start >= 0, `catalog ${locale} not found`)
  return configHtml.slice(start, configHtml.indexOf('\n        }', start))
}

const KEYS = [
  'provider.heading', 'provider.intro', 'provider.modeLabel', 'provider.modeJev', 'provider.modeBoth', 'provider.modeClef',
  'provider.modelLabel', 'provider.allowance', 'provider.receives', 'provider.cloudflareHeading', 'provider.accountLabel',
  'provider.tokenLabel', 'provider.save', 'provider.clear', 'provider.test', 'provider.testing', 'provider.status',
  'provider.notConfigured', 'provider.saved', 'provider.cleared', 'provider.needBoth', 'provider.test.ok',
  'provider.test.rejected', 'provider.test.no-credentials', 'provider.test.allowance', 'provider.test.unreachable',
  'provider.test.failed', 'provider.test.expired', 'provider.test.timeout', 'save.whichProvider',
  'provider.reading', 'provider.readFailed'
]

test('the section sits on the General tab with the three modes, the three models and two masked inputs', () => {
  const general = generalTab()
  assert.match(general, /<section id="provider-section" data-state="loading">/)
  assert.match(general, /<div id="provider-mode" class="mode-buttons" role="group" aria-labelledby="provider-mode-label">/)
  for (const mode of ['jev', 'both', 'clef']) assert.match(general, new RegExp(`<button type="button" data-value="${mode}"`))
  assert.match(general, /<div id="clef-model" class="mode-buttons" role="group" aria-labelledby="clef-model-label">/)
  for (const model of ['clef', 'clef-flash', 'clef-omni']) assert.match(general, new RegExp(`data-value="${model}"`))
  assert.match(general, /<input id="cloudflare-account-id" type="password" autocomplete="off"/)
  assert.match(general, /<input id="cloudflare-token" type="password" autocomplete="off"/)
  assert.match(general, /id="test-clef"/)
})

test('every provider string exists in both languages', () => {
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of KEYS) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
  }
})

test('the copy says what Clef receives and how far the free tier goes', () => {
  const en = catalogBlock('en')
  assert.match(en, /'provider\.receives': '[^']*redacted[^']*'/)
  assert.match(en, /'provider\.allowance': '[^']*950[^']*'/)
})

test('the allowance with policies is the one measured for 0.13.8, which no longer sends the permits rules', () => {
  // odd/tasks/gate-model-spend.md: about 1,680 input tokens a call with 20 policies.
  assert.match(catalogBlock('en'), /'provider\.allowance': '[^']*with about 20, clef reaches about 245 calls a day and clef-omni about 390[^']*'/)
  assert.match(catalogBlock('es'), /'provider\.allowance': '[^']*con unas 20, clef llega a unas 245 llamadas al día y clef-omni a unas 390[^']*'/)
})

test('Save writes decisionProvider from the two groups, Jev and clef by default', () => {
  assert.match(configHtml, /if \(providerSettingsLoaded\) namedWrites\.push\(\{ label: t\('save\.whichProvider'\), promise: write\('decisionProvider', readProviderSettings\(\)\) \}\)/)
  const read = extractFunction(configHtml, 'readProviderSettings')
  assert.match(read, /pressedValue\(providerModeEl, 'jev'\)/)
  assert.match(read, /pressedValue\(clefModelEl, 'clef'\)/)
  assert.match(extractFunction(configHtml, 'loadProviderSettings'), /readStrictRetrying\('decisionProvider', retriesLeft\)/)
})

// 0.13.2: the first paint showed Jev before the stored choice was read, and a
// failed read left it there; the owner read that as "it does not save".
test('the first paint shows no provider choice, and a failed read retries instead of falling back to Jev', () => {
  const load = extractFunction(configHtml, 'load')
  assert.doesNotMatch(load, /fillProviderSettings\(null\)/)
  assert.match(load, /showProviderUnread\('loading'\)/)
  assert.match(load, /loadProviderSettings\(PROVIDER_READ_RETRIES\)/)
  const loader = extractFunction(configHtml, 'loadProviderSettings')
  assert.match(extractFunction(configHtml, 'readStrictRetrying'), /retriesLeft - 1/)
  assert.match(loader, /showProviderUnread\('failed'\)/)
  assert.doesNotMatch(loader, /fillProviderSettings\(null\)/)
})

test('an unread Cloudflare status says checking, not "no credentials"', () => {
  const body = extractFunction(configHtml, 'renderCloudflareStatus')
  assert.ok(body.indexOf("t('secret.checking')") >= 0 && body.indexOf("t('secret.checking')") < body.indexOf("t('provider.notConfigured')"))
})

test('the Cloudflare credentials travel only as secret requests naming their secret', () => {
  assert.match(extractFunction(configHtml, 'sendSecretRequest'), /if \(secret !== undefined\) request\.secret = secret/)
  assert.match(configHtml, /sendSecretRequest\('save', accountId, 'cloudflareAccountId'\)/)
  assert.match(configHtml, /sendSecretRequest\('save', token, 'cloudflareApiToken'\)/)
  assert.doesNotMatch(configHtml, /write\('cloudflare/)
})

test('the masked status shows at most the last four characters', () => {
  const body = extractFunction(configHtml, 'renderCloudflareStatus')
  assert.match(body, /endsWith/)
  assert.doesNotMatch(body, /\.value\b/)
})

test('C3b: the intro says Jev also answers when Clef sees a possible policy hit, in both languages', () => {
  assert.ok(catalogBlock('es').includes("'provider.intro': 'Jev (TypeSafe) juzga cada comando hoy. Clef (Cloudflare Workers AI) habla el mismo contrato y tiene una cuota gratis diaria. En «Ambos», Clef responde primero y Jev responde cuando Clef duda, ve que podría aplicar una política, falla o se acaba la cuota del día.'"))
  assert.ok(catalogBlock('en').includes("'provider.intro': 'Jev (TypeSafe) judges every command today. Clef (Cloudflare Workers AI) speaks the same contract and has a free daily allowance. In Both, Clef answers first and Jev answers when Clef is in doubt, sees a possible policy hit, fails, or the day\\u2019s allowance is spent.'"))
})

test('C3c: the neuron estimate stays true once policies are sent, in both languages', () => {
  const es = catalogBlock('es')
  const en = catalogBlock('en')
  // 0.13.8 (odd/tasks/gate-model-spend.md): ~180 became ~245 once the permits rules stopped being sent.
  assert.ok(es.includes('sin políticas') && es.includes('245'), 'es names the no-policy figures and the ~245 calls with about 20 policies')
  assert.ok(/without policies/i.test(en) && en.includes('245'), 'en names the no-policy figures and the ~245 calls with about 20 policies')
  assert.doesNotMatch(es, /alcanza para unas 950 llamadas del gate con clef, 1\.500 con clef-omni y 6\.000 con clef-flash\./)
  assert.doesNotMatch(es, /\b(tenés|podés|mirá|elegí)\b/)
})
