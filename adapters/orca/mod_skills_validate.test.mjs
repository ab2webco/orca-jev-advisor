// JEVADV-43 -- mod-skills has never actually loaded on any machine. This is
// the regression test for that: it builds the installed copy the real way
// (planModSkillsCopy + writeModSkillsCopy, install-claude-integration.mjs's
// own exported functions -- exactly what `install` runs, not a hand-rolled
// duplicate of it) into a scratch temp directory, then asks the real
// `claude` binary to validate it (`claude plugin validate --json`), the
// same check this mod's own diagnosis was made with. Before this fix,
// `success` was `false` (no `.claude-plugin/plugin.json` at all -- reason
// #1 of the diagnosis); this test is RED against the pre-fix installer and
// GREEN once the manifest/closure-copy wiring above is in place, and it
// stays in the suite (wired into `npm test`, and so into `npm run check`)
// so this exact regression cannot ship silently again.
//
// No live `claude -p` session runs here (that needs login and touches the
// real HOME) -- see this feature's own report for the one-off manual check
// that did run one.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { planModSkillsCopy, writeModSkillsCopy } from './install-claude-integration.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..', '..')

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function findClaudeBinary () {
  try {
    const path = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).trim().split('\n')[0]
    return path && path.length > 0 ? path : null
  } catch {
    return null
  }
}

test('the installed copy validates cleanly with the real `claude` binary -- the exact regression this mod shipped with', async (t) => {
  const claudeBinary = findClaudeBinary()
  if (!claudeBinary) {
    t.skip('SKIPPED (loudly): no `claude` binary found on PATH -- this machine cannot run `claude plugin validate`, so this regression check did not run. Install Claude Code to exercise it.')
    return
  }

  const destination = mkdtempSync(join(tmpdir(), 'orca-jev-mod-skills-validate-'))
  tempDirs.push(destination)

  const plan = await planModSkillsCopy(PLUGIN_ROOT)
  await writeModSkillsCopy(PLUGIN_ROOT, destination, plan)

  const raw = execFileSync(claudeBinary, ['plugin', 'validate', '--json', destination], { encoding: 'utf8' })
  const result = JSON.parse(raw)
  assert.equal(result.success, true, `claude plugin validate reported failure: ${JSON.stringify(result)}`)
  // JEVADV-105: the engine lists what `$.env.get` reads off the process env; Orca's pins and game mode must be among them.
  const envReads = JSON.stringify(result).match(/env reads: [^"]*/)?.[0] ?? ''
  for (const name of ['ORCA_GAME_MODE', 'ORCA_GAME_HUD', 'ORCA_AGENT_MODEL_PINNED', 'ORCA_AGENT_EFFORT_PINNED']) {
    assert.match(envReads, new RegExp(`\\b${name}\\b`), `${name} is read from the process env`)
  }
})

// Memory in Shadow (odd/tasks/memory-shadow.md, M8): the hooks module now
// imports the memory core. The copy must carry every one of those files, and
// none may import from node:, which the hooks sandbox does not have. The
// validate run above then checks that same copy.
test('the installed copy carries the memory core the hooks import, all of it free of node: imports', async () => {
  const plan = await planModSkillsCopy(PLUGIN_ROOT)
  for (const name of ['memory_detect', 'memory_decide', 'memory_draft', 'memory_judge', 'memory_spool', 'memory_tidy', 'memory_shadow']) {
    const path = `src/core/${name}.ts`
    assert.ok(plan.closurePaths.includes(path), `${path} is in the copy`)
  }
  for (const path of plan.closurePaths.filter((p) => p.startsWith('src/'))) {
    const source = readFileSync(join(PLUGIN_ROOT, ...path.split('/')), 'utf8')
    assert.doesNotMatch(source, /from ['"]node:/, `${path} imports nothing from node:`)
  }
})
