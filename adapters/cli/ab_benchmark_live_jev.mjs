// REAL JEV INTEGRATION TEST -- calls the live Jev endpoint. Deliberately
// named WITHOUT `.test.` anywhere in it, so node's default `node --test`
// discovery never picks it up (that glob matches `*.test.{js,mjs,cjs,ts}`,
// `*-test.*` and bare `test.*` -- this file matches none of those) and CI
// (.github/workflows/check.yml's `npm run check` -> `npm test` -> `node
// --test --experimental-strip-types`) stays green with no Jev key
// available. This is the coordinator-approved exception to "never call a
// real network service from a test": real Jev is fast and cheap (this
// plugin's own measured median is 404ms over 1441 real calls) and this is
// a genuine contract test -- it proves the live endpoint still answers the
// exact question shape adapters/cli/ab_benchmark_cli.ts's direct-batch mode
// sends it, and that jev.ts's response guards still accept the reply. The
// large model is NEVER called here either -- see the fake BigModelRunner
// below; a real `claude -p` call costs real usage and belongs nowhere in
// any automated test, integration or not.
//
// Run explicitly:
//   node --test --experimental-strip-types adapters/cli/ab_benchmark_live_jev.mjs
//
// Skips loudly (prints why, via t.skip -- never a silent pass) when no Jev
// API key resolves on this machine.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { resolveApiKey } from '../../src/core/secrets.ts'
import { makeRealJevCaller } from './ab_benchmark_cli.ts'

test('live Jev: the real endpoint answers the command-gate question shape adapters/cli/ab_benchmark_cli.ts sends it, and jev.ts response guards accept it', async (t) => {
  const apiKey = await resolveApiKey()
  if (apiKey === null) {
    t.skip('no Jev API key resolved on this machine (src/core/secrets.ts) -- skipping the live Jev contract test, not passing it silently')
    return
  }

  const jevCaller = makeRealJevCaller(apiKey)
  const result = await jevCaller('git status')

  assert.notEqual(result, null, 'a resolved API key must reach a real answer, not a swallowed failure -- if this fails, the live endpoint or the response guards changed shape')
  assert.ok(result.verdict === 'allow' || result.verdict === 'ask', `expected a GateLikeVerdict, got ${JSON.stringify(result.verdict)}`)
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok(result.latencyMs > 0, 'a real network round trip takes measurable time')
  assert.equal(typeof result.inputTokens, 'number')
  assert.equal(typeof result.outputTokens, 'number')
  console.log(`live Jev contract check: verdict=${result.verdict} latencyMs=${result.latencyMs} inputTokens=${result.inputTokens} outputTokens=${result.outputTokens}`)
})
