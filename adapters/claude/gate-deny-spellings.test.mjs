// Release 0.6.12: every spelling the 0.6.11 live QA (odd/qa/qa-0.6.11.md,
// F-01..F-04) saw pass or get only advice, where a local rule must refuse.
// Runs the real hook as a subprocess, no API key, throwaway HOME -- a local
// rule fires before the key check, so anything that is not a local rule
// shows up here as "not REFUSED". A refusal must also hold on an identical
// retry in the same session (advice lets that retry through; a rule never).
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('./gate-bash.ts', import.meta.url))

const homes = []
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

function makeHome () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-deny-spellings-')))
  homes.push(dir)
  return dir
}

function verdict (home, command, { cwd = home, sessionId = 'deny-spellings' } = {}) {
  const env = { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  delete env.TYPESAFE_API_KEY
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  env.ORCA_USER_DATA_PATH = join(home, 'orca-userdata-does-not-exist')
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', GATE], {
    env,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: sessionId, tool_use_id: 'deny-spellings' }),
    encoding: 'utf8',
  })
  if (stdout.trim() === '') return { decision: 'pass', reason: '' }
  const out = JSON.parse(stdout).hookSpecificOutput ?? {}
  return { decision: out.permissionDecision ?? 'pass', reason: out.permissionDecisionReason ?? '' }
}

function assertRefusedTwice (command, rule, options = {}) {
  const home = options.home ?? makeHome()
  for (const attempt of ['first', 'identical retry']) {
    const { decision, reason } = verdict(home, command, options)
    assert.equal(decision, 'deny', `${attempt}: ${JSON.stringify(command)} must be refused`)
    assert.match(reason, /^REFUSED/, `${attempt}: ${JSON.stringify(command)} must be a local-rule refusal, not advice (got: ${reason.slice(0, 80)})`)
    assert.match(reason, rule, `${attempt}: ${JSON.stringify(command)} must name the right rule`)
  }
}

function assertNotRefused (command, options = {}) {
  const home = options.home ?? makeHome()
  const { reason } = verdict(home, command, options)
  assert.doesNotMatch(reason, /^REFUSED/, `${JSON.stringify(command)} is data or harmless, never a local-rule refusal`)
}

// The rule texts, as rule.* in src/core/i18n_gate.ts renders them in English.
const RM_RULE = /recursive delete from \/ or \$HOME/

// F-01 (JEVADV-64): every rm spelling from the QA table H-rm-*/J01.
const RM_SPELLINGS = [
  'rm -fr /',
  'rm -r -f /',
  'rm --recursive --force /',
  'rm -rf /*',
  'rm -rf ~/*',
  'rm -rf ~/',
  '(rm -rf ~)',
  'rm -rf -- /',
  'rm -Rf ~',
  'rm -rf //',
  'rm -rf /.',
  'rm -rf ${HOME}',
  'rm -rfv /',
  'rm -f -R ~',
  'rm -rf "$HOME"/',
  'rm -rf ${HOME}/*',
  'rm --force --recursive -- ~',
  'rm -rf / --no-preserve-root',
]

for (const command of RM_SPELLINGS) {
  test(`F-01: ${command} is refused by the rm rule, and so is its retry`, () => {
    assertRefusedTwice(command, RM_RULE)
  })
}

test('F-01: cd / then rm -rf * is refused', () => {
  assertRefusedTwice('cd / && rm -rf *', RM_RULE)
})

test('F-01: pushd ~ then rm -rf . is refused', () => {
  assertRefusedTwice('pushd ~ && rm -rf .', RM_RULE)
})

test('F-01: the home directory spelled as its absolute path is refused', () => {
  const home = makeHome()
  assertRefusedTwice(`rm -rf ${home}`, RM_RULE, { home })
})

test('F-01: rm -rf * with the session itself in the home directory is refused', () => {
  const home = makeHome()
  assertRefusedTwice('rm -rf *', RM_RULE, { home, cwd: home })
})

test('F-01: an ordinary recursive delete inside a project is not the rm rule', () => {
  const home = makeHome()
  const project = join(home, 'project')
  for (const command of ['rm -rf build', 'rm -rf ./dist', 'rm -rf /tmp/scratch-dir', 'rm -rf ~/tmp/scratch', 'rm -f /', 'cd /tmp && rm -rf *', 'rm -rf ./*']) {
    assertNotRefused(command, { home, cwd: project })
  }
})

test('F-01: an rm spelling inside a grep pattern, a quoted argument, an echo or a heredoc body stays data', () => {
  for (const command of [
    'grep -rn "rm -fr /" src/',
    'echo "rm -r -f /"',
    "git commit -m 'block rm -Rf ~ in the gate'",
    "cat > notes.md <<'EOF'\nrm --recursive --force /\nEOF",
  ]) {
    assertNotRefused(command)
  }
})
