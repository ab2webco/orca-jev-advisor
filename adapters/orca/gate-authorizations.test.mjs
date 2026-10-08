// T4 (0.6.28): the sidecar the worker runs to list and forget the gate's
// remembered delivery authorizations (<cacheDir>/gate-authorizations.json).
// Run as the real subprocess, against a throwaway cache dir.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gate-authorizations.mjs')
const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function cacheDir () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-gate-authorizations-'))
  dirs.push(dir)
  return join(dir, 'cache')
}

function run (cache, mode, stdin) {
  const env = { ...process.env, ORCA_SUPERVISOR_CACHE_DIR: cache }
  return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, mode], { env, input: stdin ?? '', encoding: 'utf8' }))
}

const NOW = new Date().toISOString()
const STORE = {
  version: 1,
  repos: {
    'github.com/acme/widgets': {
      'pr-merge': { firstAt: NOW, lastAt: NOW, uses: 3 },
      'release-create': { firstAt: NOW, lastAt: NOW, uses: 1 },
    },
    'github.com/acme/site': { 'push-branch': { firstAt: NOW, lastAt: NOW, uses: 2 } },
  },
}

function writeStore (cache, value) {
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'gate-authorizations.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

function readStore (cache) {
  return JSON.parse(readFileSync(join(cache, 'gate-authorizations.json'), 'utf8'))
}

test('read: a missing or corrupt store lists nothing, and is never an error', () => {
  const cache = cacheDir()
  assert.deepEqual(run(cache, 'read'), { ok: true, value: { repos: [] } })
  writeStore(cache, '{ not json')
  assert.deepEqual(run(cache, 'read'), { ok: true, value: { repos: [] } })
})

test('read: lists each repository with its classes, last use and expiry', () => {
  const cache = cacheDir()
  writeStore(cache, STORE)
  const result = run(cache, 'read')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.repos.map((row) => row.repo), ['github.com/acme/site', 'github.com/acme/widgets'])
  assert.deepEqual(result.value.repos[1].classes.map((row) => row.cls), ['pr-merge', 'release-create'])
  assert.equal(typeof result.value.repos[1].classes[0].expiresAt, 'string')
})

test('forget: one class of one repository, the rest kept, written atomically', () => {
  const cache = cacheDir()
  writeStore(cache, STORE)
  const result = run(cache, 'forget', JSON.stringify({ repo: 'github.com/acme/widgets', cls: 'pr-merge' }))
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(readStore(cache).repos['github.com/acme/widgets']), ['release-create'])
  assert.ok(readStore(cache).repos['github.com/acme/site'])
  assert.deepEqual(result.value.repos.find((row) => row.repo === 'github.com/acme/widgets').classes.map((row) => row.cls), ['release-create'])
  assert.deepEqual(readdirSync(cache).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind')
})

test('forget: every class of one repository', () => {
  const cache = cacheDir()
  writeStore(cache, STORE)
  const result = run(cache, 'forget', JSON.stringify({ repo: 'github.com/acme/widgets', cls: null }))
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(readStore(cache).repos), ['github.com/acme/site'])
})

test('forget: a malformed request changes nothing', () => {
  const cache = cacheDir()
  writeStore(cache, STORE)
  for (const bad of ['', 'x', '{}', JSON.stringify({ repo: '', cls: null }), JSON.stringify({ repo: 'github.com/acme/widgets', cls: 'rm-rf' })]) {
    const result = run(cache, 'forget', bad)
    assert.equal(result.ok, false, bad)
    assert.equal(result.reason, 'invalid-request', bad)
  }
  assert.deepEqual(readStore(cache), STORE)
})

test('forget: on a missing store succeeds with nothing to list, and writes nothing it does not need', () => {
  const cache = cacheDir()
  const result = run(cache, 'forget', JSON.stringify({ repo: 'github.com/acme/widgets', cls: null }))
  assert.deepEqual(result, { ok: true, value: { repos: [] } })
  assert.equal(existsSync(join(cache, 'gate-authorizations.json')), true)
})

test('an unknown mode answers a parseable failure', () => {
  assert.equal(run(cacheDir(), 'nope').reason, 'unknown-mode')
})
