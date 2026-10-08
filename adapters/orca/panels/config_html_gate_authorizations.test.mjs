// 0.6.28 T4: the remembered delivery authorizations section of the config
// panel. Source-as-text checks, same approach as config_html_queue_mode.test.mjs;
// real-DOM coverage is in scripts/panels.spec.mjs.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DELIVERY_CLASSES } from '../../../src/core/delivery_class.ts'

const configHtml = readFileSync(new URL('./config.html', import.meta.url), 'utf8')

function tabPanelMarkup (id) {
  const start = configHtml.indexOf(`id="panel-${id}"`)
  assert.ok(start >= 0, `panel-${id} not found`)
  const next = configHtml.indexOf('class="tab-panel"', start + 1)
  return configHtml.slice(start, next === -1 ? undefined : next)
}

function catalogBlock (locale) {
  const start = configHtml.indexOf(`        ${locale}: {`)
  assert.ok(start >= 0, `catalog ${locale} not found`)
  return configHtml.slice(start, configHtml.indexOf('\n        }', start))
}

const KEYS = [
  'gateAuth.heading', 'gateAuth.hint', 'gateAuth.empty', 'gateAuth.lastUsed', 'gateAuth.expires', 'gateAuth.uses',
  'gateAuth.forget', 'gateAuth.forgetAll', 'gateAuth.forgetting', 'gateAuth.forgotten', 'gateAuth.unreadable', 'gateAuth.loading',
  ...DELIVERY_CLASSES.map((cls) => `gateAuth.class.${cls}`),
]

test('config.html: the remembered authorizations section sits in the Rules tab, after the deny tier', () => {
  const rules = tabPanelMarkup('rules')
  assert.match(rules, /<section id="gate-authorizations-section">/)
  assert.ok(rules.indexOf('id="deny-tier-section"') < rules.indexOf('id="gate-authorizations-section"'))
  assert.match(rules, /<div id="gate-auth-rows"><\/div>/)
  assert.match(rules, /id="gate-auth-empty"/)
})

test('config.html: every remembered-authorization key exists once in es and once in en', () => {
  for (const locale of ['es', 'en']) {
    const block = catalogBlock(locale)
    for (const key of KEYS) assert.equal(block.split(`'${key}':`).length - 1, 1, `${locale}: ${key}`)
  }
})

test('config.html: the empty line says how an authorization is learned', () => {
  assert.match(catalogBlock('en'), /'gateAuth\.empty': '[^']*confirms the same[^']*advice/)
  assert.match(catalogBlock('es'), /'gateAuth\.empty': '[^']*confirma la misma[^']*aviso/)
})

test('config.html: a forget goes through the worker request key, never straight to storage the gate reads', () => {
  assert.match(configHtml, /var GATE_AUTH_FORGET_REQUEST_KEY = 'gateAuthorizationForgetRequest'/)
  assert.match(configHtml, /var GATE_AUTH_FORGET_RESULT_KEY = 'gateAuthorizationForgetResult'/)
  assert.match(configHtml, /var GATE_AUTH_STATUS_KEY = 'gateAuthorizationsStatus'/)
})
