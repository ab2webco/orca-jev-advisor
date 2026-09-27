// Exercises agent-model.ts as the CLI it actually is (it runs `main()`
// unconditionally at import, so it is only testable as a subprocess) against
// a throwaway HOME -- never the real one, and never the developer's real
// Orca install or TYPESAFE_API_KEY. Same harness shape as gate-bash.test.mjs
// (see its own module note): ORCA_SUPERVISOR_CONFIG_DIR/CACHE_DIR point
// paths.ts at the throwaway HOME, ORCA_USER_DATA_PATH points at a directory
// that does not exist so the "plugin disabled in Orca" check fails open,
// and TYPESAFE_API_KEY is always deleted so a test can never accidentally
// reach the real network.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'agent-model.ts')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-agent-model-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Runs the hook against a throwaway HOME with `payload` on stdin, exactly
 *  as Claude Code itself invokes it. Never touches the real HOME, the real
 *  Orca install, or the real TYPESAFE_API_KEY. `stdin` may be a raw string
 *  instead, to exercise malformed input. */
function run (home, payload, extraEnv = {}) {
  const env = { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  delete env.TYPESAFE_API_KEY
  // An Orca terminal points CLAUDE_CONFIG_DIR at the real account vault; the
  // hook reads its settings.json (the model router's mode), so a test must
  // never inherit it (review finding 5). A test that needs one passes a temp
  // vault through `extraEnv`.
  delete env.CLAUDE_CONFIG_DIR
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  // Points Orca's userData resolution at a directory that does not exist,
  // so the "plugin disabled in Orca" check fails its own read and fails
  // open (disabled = false) instead of touching a real Orca install.
  env.ORCA_USER_DATA_PATH = join(home, 'orca-userdata-does-not-exist')
  Object.assign(env, extraEnv)
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT_PATH], {
    env,
    input,
    encoding: 'utf8'
  })
}

function logPath (home) {
  return join(home, '.cache', 'orca-supervisor', 'model-reclassifications.jsonl')
}

function readLogRecords (home) {
  const path = logPath(home)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const PRE_TOOL_USE_AGENT_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: 'agent-tool-use-1',
  tool_input: { prompt: 'summarize this repository', description: 'a research task', subagent_type: 'general-purpose' },
  permission_mode: 'default'
}

test('an Agent PreToolUse with no mirror file prints nothing and appends one source:"none"/"empty-ladder" row', () => {
  const home = makeHome()
  const stdout = run(home, PRE_TOOL_USE_AGENT_PAYLOAD)
  assert.equal(stdout, '', 'no mirror -> an empty ladder -> measurement mode -> stdout must stay untouched')

  const records = readLogRecords(home)
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'model-decision')
  assert.equal(records[0].source, 'none')
  assert.equal(records[0].failOpen, 'empty-ladder')
  assert.equal(records[0].id, 'agent-tool-use-1')
})

test('a non-Agent payload appends nothing to the log', () => {
  const home = makeHome()
  const stdout = run(home, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bash-1', tool_input: { command: 'ls' } })
  assert.equal(stdout, '')
  assert.equal(existsSync(logPath(home)), false, 'a non-Agent hook must never create the model-reclassifications log')
})

test('an Agent PostToolUse appends one model-outcome row', () => {
  const home = makeHome()
  const stdout = run(home, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_use_id: 'agent-tool-use-2',
    tool_response: { resolvedModel: 'claude-sonnet-5', status: 'ok', totalDurationMs: 1234, usage: { input_tokens: 10, output_tokens: 20 } }
  })
  assert.equal(stdout, '')

  const records = readLogRecords(home)
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'model-outcome')
  assert.equal(records[0].id, 'agent-tool-use-2')
  assert.equal(records[0].resolvedModel, 'claude-sonnet-5')
})

test('malformed stdin exits 0 with no output and nothing appended', () => {
  const home = makeHome()
  const stdout = run(home, '{not valid json')
  assert.equal(stdout, '')
  assert.equal(existsSync(logPath(home)), false)
})

// Review round 2, finding 5: the hook reads `$CLAUDE_CONFIG_DIR/settings.json`
// (the account vault) to learn whether the model router is active. A test must
// never read the real vault an Orca terminal points CLAUDE_CONFIG_DIR at.

const ACTIVE_READY_MIRROR = {
  active: true,
  ready: true,
  models: [{ id: 'claude-opus-5-5', provider: 'anthropic', label: 'Opus', rank: 1, agentModel: 'opus', source: '', available: true }]
}

function writeMirror (home) {
  const dir = join(home, '.config', 'orca-supervisor')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'models-catalog.json'), JSON.stringify(ACTIVE_READY_MIRROR))
}

function makeVault (routerMode) {
  const vault = makeHome()
  writeFileSync(join(vault, 'settings.json'), JSON.stringify({ pluginConfigs: { 'orca-jev-mod-skills@skills-dir': { options: { routerMode } } } }))
  return vault
}

test('finding 5: a CLAUDE_CONFIG_DIR inherited from the test runner never reaches the hook', () => {
  const home = makeHome()
  writeMirror(home)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = makeVault('active')
  try {
    run(home, PRE_TOOL_USE_AGENT_PAYLOAD)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
  assert.equal(readLogRecords(home)[0].mode, 'active', 'the inherited vault said active; the hook must not have read it')
})

test('finding 5: the hook reads routerMode from $CLAUDE_CONFIG_DIR/settings.json when a test points it at a temp vault', () => {
  const home = makeHome()
  writeMirror(home)
  run(home, PRE_TOOL_USE_AGENT_PAYLOAD, { CLAUDE_CONFIG_DIR: makeVault('active') })
  assert.equal(readLogRecords(home)[0].mode, 'measurement', 'router active -> the classic hook only measures')
})
