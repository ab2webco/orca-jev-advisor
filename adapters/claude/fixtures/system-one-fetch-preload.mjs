// Test-only preload for adapters/claude/gate-providers.test.mjs and agent-model.test.mjs: replaces the
// global fetch of a spawned gate hook with a scripted one, so the hook's
// real provider wiring runs end to end with no network. Each request is
// logged (host and parsed body only) to SYSTEM_ONE_FETCH_LOG; the answer for
// each host comes from SYSTEM_ONE_FETCH_SCRIPT, a JSON object keyed by host
// whose values are { status, body }. A host with no entry fails like a
// network error. Never imported by app code.
import { appendFileSync } from 'node:fs'

const script = JSON.parse(process.env.SYSTEM_ONE_FETCH_SCRIPT ?? '{}')
const logPath = process.env.SYSTEM_ONE_FETCH_LOG

globalThis.fetch = async (url, init) => {
  const host = new URL(String(url)).host
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ host, path: new URL(String(url)).pathname, body: JSON.parse(init?.body ?? 'null') })}\n`)
  const entry = script[host]
  if (entry === undefined) throw new TypeError('fetch failed')
  return new Response(entry.body, { status: entry.status, headers: { 'content-type': 'application/json' } })
}
