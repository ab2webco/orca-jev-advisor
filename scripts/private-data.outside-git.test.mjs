// 0.6.17 T4 (JEVADV-92): an installed copy of the plugin has no `.git`, and
// running the whole suite there failed the privacy test on `git ls-files`.
// Outside a git checkout it now skips, with a reason, instead of failing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'private-data.test.mjs')

test('outside a git checkout the privacy test skips with a reason and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-no-git-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    copyFileSync(SCRIPT, join(dir, 'scripts', 'private-data.test.mjs'))
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dir }
    delete env.PRIVATE_DATA_TIPS
    delete env.PRIVATE_DATA_COMMITS
    // A nested runner would otherwise report to this one instead of its own stdout.
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'scripts/private-data.test.mjs'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# SKIP not a git checkout/)
    assert.match(result.stdout, /# fail 0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
