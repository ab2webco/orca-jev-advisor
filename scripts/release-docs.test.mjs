// A release names one version everywhere a person reads it: package.json,
// the Orca manifest (orca-plugin.json), the newest CHANGELOG entry and the
// newest "What changed in" section of the README. 0.8.0 V6 adds this guard
// so a version bump without its notes, or notes without the bump, fails here.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(ROOT, name), 'utf8')

test('package.json and orca-plugin.json carry the same version', () => {
  assert.equal(JSON.parse(read('orca-plugin.json')).version, JSON.parse(read('package.json')).version)
})

test('the newest CHANGELOG entry and the newest README "What changed in" section are this version', () => {
  const version = JSON.parse(read('package.json')).version
  assert.equal(/^## (\S+)$/m.exec(read('CHANGELOG.md'))?.[1], version)
  assert.equal(/^## What changed in (\S+)$/m.exec(read('README.md'))?.[1], version)
})
