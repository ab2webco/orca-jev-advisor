// Exercises gate-bash.ts as the CLI it actually is (it runs `main()`
// unconditionally at import, so it is only testable as a subprocess) against
// a throwaway HOME -- never the real one, and never the developer's real
// Orca install.
//
// Focus: the "no API key" defect. resolveApiKey() returning null used to
// pass every command through in total silence, forever -- a plugin whose
// whole purpose is judging commands, quietly judging nothing, with no way
// for the developer to notice. These tests never set TYPESAFE_API_KEY and
// never leave a fallback env file behind, so every command here takes the
// no-key path without ever reaching Jev over the network.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { commandShape } from '../../src/core/command_shape.ts'
import { GATE_DECISION_RULES_VERSION } from '../../src/core/decisions.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'gate-bash.ts')

const tempDirs = []
function makeHome () {
  const dir = mkdtempSync(join(tmpdir(), 'orca-jev-gate-bash-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// A command that is neither obviously safe (tier 1a) nor a NEVER_SILENTLY
// match (tier 1b), so it always reaches the apiKey check -- the only branch
// these tests exercise.
const MIDDLE_TIER_COMMAND = 'some-unmeasured-tool --flag'

/** Runs the hook against a throwaway HOME with a given hook payload on
 *  stdin, exactly as Claude Code itself invokes it. Never touches the real
 *  HOME, the real Orca install, or the real TYPESAFE_API_KEY. `apiKey`
 *  lets a test reach past the no-key path into the cache; GIT_CEILING_
 *  DIRECTORIES keeps `git` from walking up past the throwaway home even if
 *  the OS temp dir ever ends up nested under a real repository. */
function run (home, command, { cwd, apiKey } = {}) {
  const env = { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: home }
  delete env.XDG_CACHE_HOME
  delete env.XDG_CONFIG_HOME
  // src/core/paths.ts's resolveConfigDir/resolveCacheDir refuse to compute
  // a real path at all under node's test runner (see its module doc) --
  // this points them at exactly the directories they would have computed
  // for `home` on darwin with no XDG override, so gate-bash.ts's own
  // CACHE_DIR/CONFIG_DIR still land inside this throwaway HOME.
  env.ORCA_SUPERVISOR_CONFIG_DIR = join(home, '.config', 'orca-supervisor')
  env.ORCA_SUPERVISOR_CACHE_DIR = join(home, '.cache', 'orca-supervisor')
  if (apiKey === undefined) {
    delete env.TYPESAFE_API_KEY
  } else {
    env.TYPESAFE_API_KEY = apiKey
  }
  // Point Orca's userData resolution at a directory that does not exist,
  // so pluginDisabledInOrca() fails its own read and fails open (disabled
  // check = false) instead of touching the real developer's Orca install.
  env.ORCA_USER_DATA_PATH = join(home, 'orca-userdata-does-not-exist')
  const payload = { tool_input: { command }, cwd: cwd ?? home, tool_use_id: 'tool-key-notice' }
  return execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT_PATH], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8'
  })
}

function noKeyWarnedPath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-bash.no-key-warned.json')
}

function verdictCachePath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-bash.json')
}

/** Computes the exact cache key gate-bash.ts would compute for `command` run
 *  from `cwd` under `home`, given the destination match (or lack of one)
 *  gate-bash.ts itself would resolve. Mirrors cacheKey() in gate-bash.ts
 *  exactly, including the GATE_DECISION_RULES_VERSION prefix (JEVADV-35,
 *  review-3ca73b9da09b0927 R3/R4) -- a drift between this helper and that
 *  private function would show up as every "honoured" test below silently
 *  falling through to a cache MISS instead of failing on a key mismatch. */
function computeCacheKey (command, cwd, home, { destinationId = null, treeRoot, repoContext = 'no remote, unknown branch, this is a working branch, clean' } = {}) {
  const shape = commandShape(command, { cwd, home, destinationId, treeRoot, repoContext })
  if (shape === null) throw new Error('test command must have a non-null shape to exercise the cache path')
  return createHash('sha256').update(`v${GATE_DECISION_RULES_VERSION}:${shape}`).digest('hex').slice(0, 24)
}

/** No catalog mirror present (destinationId/treeRoot null) and `cwd` outside
 *  any git repository (repoContext resolves to this fixed, branch-less
 *  string) -- the shape every existing cache test in this file exercises. */
function expectedCacheKey (command, cwd, home) {
  return computeCacheKey(command, cwd, home)
}

test('no API key: the first command passes through with a one-time notice', () => {
  const home = makeHome()
  const stdout = run(home, MIDDLE_TIER_COMMAND)
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow', 'a missing key must never block a command')
  assert.equal(typeof payload.systemMessage, 'string', 'the first no-key command must say so')
  assert.match(payload.systemMessage, /jev/i)
  assert.ok(existsSync(noKeyWarnedPath(home)), 'the warned marker must be persisted so the next command stays silent')
})

test('no API key: the second command in the same session stays silent', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND) // first command: warns, writes the marker
  const stdout = run(home, MIDDLE_TIER_COMMAND) // second command: must not repeat
  // passThrough() with no notice writes nothing at all -- same silent
  // no-verdict exit every other fail-open path in this hook already uses.
  assert.equal(stdout, '', 'repeating the notice on every command would be as noisy as never warning at all')
})

test('the warned marker records that a warning was already shown', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND)
  const marker = JSON.parse(readFileSync(noKeyWarnedPath(home), 'utf8'))
  assert.equal(marker.warned, true)
})

// Cache expiry (a separate defect: cached verdicts never expired, since
// nothing ever read the `at` timestamp back). Both cases below supply a
// TYPESAFE_API_KEY so the command reaches the cache section at all -- a
// missing key skips it entirely -- but a FRESH entry means the run returns
// on the cache hit before ever reaching Jev, so no network call happens
// either way.
test('a fresh cached verdict is honoured without a fresh Jev call', () => {
  const home = makeHome()
  const cwd = home
  const key = expectedCacheKey(MIDDLE_TIER_COMMAND, cwd, home)
  const cachePath = verdictCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [key]: { decision: 'ask', reason: 'stale test reason', at: Date.now() - 1000 },
  }))

  const stdout = run(home, MIDDLE_TIER_COMMAND, { cwd, apiKey: 'test-key-unused-on-cache-hit' })
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(payload.systemMessage, /stale test reason/)
  assert.match(payload.systemMessage, /cached/)
})

test('an expired cached verdict is dropped from disk instead of being reused forever', () => {
  const home = makeHome()
  const cwd = home
  const freshKey = expectedCacheKey(MIDDLE_TIER_COMMAND, cwd, home)
  const cachePath = verdictCachePath(home)
  const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [freshKey]: { decision: 'ask', reason: 'still fresh', at: Date.now() - 1000 },
    'unrelated-expired-key': { decision: 'allow', reason: 'months old', at: Date.now() - thirtyOneDaysMs },
  }))

  run(home, MIDDLE_TIER_COMMAND, { cwd, apiKey: 'test-key-unused-on-cache-hit' })

  const persisted = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.ok(Object.hasOwn(persisted, freshKey), 'a verdict cached seconds ago must survive a read')
  assert.equal(Object.hasOwn(persisted, 'unrelated-expired-key'), false, 'a verdict cached over 30 days ago must be dropped on read, not reused forever')
})

// odd/tasks/release-0.5.1.md JEVADV-35 (review-3ca73b9da09b0927, R3/R4): the
// verdict cache key must fold in decisions.ts's GATE_DECISION_RULES_VERSION,
// not just the command's shape -- otherwise a verdict cached under one
// release's decision rules (e.g. an 'allow' cached before CONSEQUENCE_NOISE_
// MARGIN existed) keeps replaying after an upgrade that changes what that
// same shape should resolve to. This is a pure, in-process comparison (no
// subprocess, no network): it fails the moment the version stops changing
// the key, which is exactly the defect this task closes.
test('the verdict cache key changes with GATE_DECISION_RULES_VERSION, so a verdict cached under an older release misses instead of replaying after a decision-rule upgrade', () => {
  const home = makeHome()
  const cwd = home
  const repoContext = 'no remote, unknown branch, this is a working branch, clean'
  const shape = commandShape(MIDDLE_TIER_COMMAND, { cwd, home, destinationId: null, treeRoot: undefined, repoContext })
  // gate-bash.ts's pre-JEVADV-35 formula: the shape alone, with no version
  // folded in at all -- what every cache entry written before this task was
  // keyed with.
  const unversionedKey = createHash('sha256').update(shape).digest('hex').slice(0, 24)
  const versionedKey = expectedCacheKey(MIDDLE_TIER_COMMAND, cwd, home)
  assert.notEqual(versionedKey, unversionedKey, 'folding the rules version into the key must actually change it, or an old entry would still be honoured after an upgrade')
  // The end-to-end proof that gate-bash.ts's own (private) cacheKey() really
  // computes this same versioned formula, not just this test's own copy of
  // it, is 'a fresh cached verdict is honoured without a fresh Jev call'
  // above: it round-trips through expectedCacheKey() and the real running
  // hook, and a drift between the two would turn that hit into a silent
  // cache miss reaching for the network instead (which is why no test here
  // pre-populates the cache under a stale key and then runs the hook with a
  // real API key -- a genuine miss would call the real Jev endpoint, which
  // this suite never does; see this file's own header note).
})

// odd/tasks/release-0.5.1.md JEVADV-29: the verdict-cache key must stay
// computed from the command's REAL (unredacted) shape -- secret redaction
// is wired into decisions.ts's buildActionGateState, which only the Jev
// request itself passes through; gate-bash.ts's cacheKey() call happens
// earlier in main(), straight off the raw `command` variable, and this task
// must not change that. expectedCacheKey() (this file's own mirror of
// cacheKey()) is given the RAW command including the secret-shaped
// assignment; a hit here proves the running hook keyed its cache entry off
// the same unredacted text, not some redacted stand-in.
test('JEVADV-29: the cache key for a command with a secret-shaped value is still computed from the unredacted text', () => {
  const home = makeHome()
  const cwd = home
  const command = 'export TOKEN=abc123456789; some-unmeasured-tool --flag'
  const key = expectedCacheKey(command, cwd, home)
  const cachePath = verdictCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [key]: { decision: 'ask', reason: 'unredacted cache key test', at: Date.now() - 1000 },
  }))

  const stdout = run(home, command, { cwd, apiKey: 'test-key-unused-on-cache-hit' })
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(payload.systemMessage, /unredacted cache key test/)
})

// ---------------------------------------------------------------------------
// Deny tier -- NEVER_SILENTLY used to only ever emit 'ask', even for the
// three rules whose blast radius is beyond the repository AND beyond
// recovery (rm -rf /, DROP/TRUNCATE TABLE, terraform/tofu destroy). These
// all fire in the tier-1b loop, BEFORE the API key check, so none of these
// tests need TYPESAFE_API_KEY or reach Jev.
// ---------------------------------------------------------------------------

/** `<home>/.config/orca-supervisor/deny-tier-config.json` -- the fail-CLOSED
 *  mirror gate-bash.ts reads for the deny-tier switches (see
 *  src/core/deny_tier_config.ts). */
function denyTierConfigPath (home) {
  return join(home, '.config', 'orca-supervisor', 'deny-tier-config.json')
}

function writeDenyTierConfig (home, value) {
  const path = denyTierConfigPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

test('deny tier: rm -rf / is denied, not just asked, with no config file present', () => {
  const home = makeHome()
  const stdout = run(home, 'rm -rf /')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /terminal/i, 'a deny must say the human can still run it themselves')
})

test('deny tier: DROP TABLE is denied, not just asked', () => {
  const home = makeHome()
  const stdout = run(home, 'psql -c "DROP TABLE users"')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: terraform destroy is denied, not just asked', () => {
  const home = makeHome()
  const stdout = run(home, 'terraform destroy -auto-approve')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// These two used to assert the opposite, back when deny was the exception.
// The numbers overturned that: 3103 approvals against 1 refusal, and 5 of 16
// questions never answered. An `ask` stops the person; a `deny` refuses the
// model and lets it pick another way. What must NOT change is the floor --
// switching a rule off reaches `ask`, never `allow` -- so each of these now
// asserts both halves.
test('terraform apply denies by default, and drops to ask when its switch is off', () => {
  const home = makeHome()
  assert.equal(
    JSON.parse(run(home, 'terraform apply -auto-approve')).hookSpecificOutput.permissionDecision,
    'deny',
  )
  writeDenyTierConfig(home, { denyTerraformApply: false })
  assert.equal(
    JSON.parse(run(home, 'terraform apply -auto-approve')).hookSpecificOutput.permissionDecision,
    'ask',
    'switched off must reach ask, never allow',
  )
})

test('a force push denies by default, and drops to ask when its switch is off', () => {
  const home = makeHome()
  assert.equal(
    JSON.parse(run(home, 'git push --force origin main')).hookSpecificOutput.permissionDecision,
    'deny',
  )
  writeDenyTierConfig(home, { denyForcePush: false })
  assert.equal(
    JSON.parse(run(home, 'git push --force origin feature/x')).hookSpecificOutput.permissionDecision,
    'ask',
    'switched off must reach ask, never allow',
  )
  // Every rule is evaluated before anything is emitted (review finding
  // R3-ask-short-circuits-later-deny): switching off the force-push rule
  // does not switch off the protected-branch rule, which still denies a
  // push that names main.
  assert.equal(
    JSON.parse(run(home, 'git push --force origin main')).hookSpecificOutput.permissionDecision,
    'deny',
    'another rule that still denies must win over a switched-off one',
  )
})

// odd/tasks/release-0.5.1.md JEVADV-29: secret redaction (src/core/secret_
// redaction.ts, wired into decisions.ts's buildActionGateState) must never
// reach the local-rule path -- it is wired in only where a command becomes
// a Jev request, and the tier-1b NEVER_SILENTLY loop runs BEFORE the API
// key check, well before askJev is ever called. This is the same local-rule
// deny path as the test above, just with a leading env assignment whose
// NAME is secret-shaped, proving that leading text does not somehow shield
// the force-push pattern from the (unredacted) local rule that must catch it.
test('JEVADV-29: a command with a secret-shaped env assignment is still refused locally -- redaction never reaches the local-rule path', () => {
  const home = makeHome()
  const stdout = run(home, 'export TOKEN=abc123456789; git push --force origin main')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// pluginVersion stamping -- every written gate-decision record must carry
// the shipped plugin's own version (see src/core/gate_measurement.ts's
// GateDecisionRecord.pluginVersion doc comment). Uses the local-rule deny
// path (tier 1b), which runs before the API key check, so this needs no
// TYPESAFE_API_KEY and never reaches Jev.
// ---------------------------------------------------------------------------

function gateLogPath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-decisions.jsonl')
}

/** The real orca-plugin.json's own `version`, read the same way a developer
 *  or the installer would -- never hardcoded, so this test fails loudly
 *  (instead of silently going stale) if the manifest's version ever
 *  changes. */
function expectedPluginVersion () {
  const manifestPath = join(__dirname, '..', '..', 'orca-plugin.json')
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version
}

test('a written gate-decision record carries the real plugin version', () => {
  const home = makeHome()
  run(home, 'rm -rf /')

  const lines = readFileSync(gateLogPath(home), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'the local-rule deny must write exactly one decision row')
  const record = JSON.parse(lines[0])
  assert.equal(record.pluginVersion, expectedPluginVersion(), 'the row must carry the shipped plugin version, not be missing the field')
})

// odd/tasks/release-0.5.1.md T1: end-to-end evidence (real hook process, no
// Jev mocking needed since a local-rule deny never reaches the network)
// that the hook itself -- not just buildGateDecisionRecord in isolation --
// stamps stopReason on the record it actually writes.
test('a local-rule stop is recorded with stopReason "local-rule"', () => {
  const home = makeHome()
  run(home, 'rm -rf /')

  const lines = readFileSync(gateLogPath(home), 'utf8').trim().split('\n')
  const record = JSON.parse(lines[0])
  assert.equal(record.stopReason, 'local-rule')
  assert.equal(record.policyId, undefined, 'a local-rule stop never carries a policyId')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-35 (review-3ca73b9da09b0927, R3): treeRoot
// wiring for a linked worktree, exercised through the REAL hook process (a
// real `git worktree add`, a real catalog mirror), not just linked_worktree
// .test.ts's unit coverage of the resolver alone -- proving the two are
// actually wired together inside gate-bash.ts's own main(). Runs entirely
// off the cache-hit path (see this file's own header note on never reaching
// the real network): a pre-populated cache entry, keyed the way the FIXED
// wiring computes it, is only ever honoured if main() really resolved the
// sibling worktree's cwd to its main checkout's destination AND kept the
// sibling's own root as treeRoot -- resolving to `main` for either one
// would produce a different key and miss.
// ---------------------------------------------------------------------------

function approvalsPath (home) {
  return join(home, '.cache', 'orca-supervisor', 'gate-approvals.jsonl')
}

function catalogMirrorPath (home) {
  return join(home, '.config', 'orca-supervisor', 'catalog.json')
}

/** Same isolation as src/core/linked_worktree.test.ts's own `git` helper. */
function git (args, cwd) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull }
  })
}

function initRepo (root) {
  mkdirSync(root, { recursive: true })
  git(['init', '-q'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['commit', '--allow-empty', '-q', '-m', 'init'], root)
}

test('a command run in a linked sibling worktree is judged with the main checkout\'s destination, with the sibling\'s own root as treeRoot', () => {
  // realpath'd immediately, same reasoning as linked_worktree.test.ts: macOS
  // resolves $TMPDIR through a /var -> /private/var symlink, and git itself
  // resolves it too when it writes an absolute gitdir: line.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-treeroot-test-')))
  const main = join(base, 'cineco-frontend')
  initRepo(main)
  const sibling = join(base, 'cineco-frontend-cin-985')
  git(['worktree', 'add', '-q', sibling, '-b', 'cin-985'], main)

  const home = makeHome()
  mkdirSync(dirname(catalogMirrorPath(home)), { recursive: true })
  writeFileSync(catalogMirrorPath(home), JSON.stringify({ destinations: [{ id: 'cineco-frontend', worktreePath: main }] }))

  // A command that is neither tier-1a nor a NEVER_SILENTLY match, with a
  // relative-path argument -- so treeRoot actually changes its shape:
  // `./dist` from `sibling` resolves to `sibling/dist`, which is IN_TREE
  // under the (correct) sibling treeRoot and OUT_OF_TREE under `main`.
  const command = 'some-unmeasured-tool ./dist'
  const repoContext = 'no remote, branch cin-985, this is a working branch, clean'
  const correctKey = computeCacheKey(command, sibling, home, { destinationId: 'cineco-frontend', treeRoot: sibling, repoContext })
  const wrongKey = computeCacheKey(command, sibling, home, { destinationId: 'cineco-frontend', treeRoot: main, repoContext })
  assert.notEqual(correctKey, wrongKey, 'treeRoot must actually change the shape, or this test proves nothing')

  const cachePath = verdictCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({
    [correctKey]: { decision: 'ask', reason: 'treeRoot wiring test', at: Date.now() - 1000 },
  }))

  const stdout = run(home, command, { cwd: sibling, apiKey: 'test-key-unused-on-cache-hit' })
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask', 'the pre-populated entry is only honoured if main() computed the SAME (correct) key')
  assert.match(payload.systemMessage, /treeRoot wiring test/)

  const lines = readFileSync(approvalsPath(home), 'utf8').trim().split('\n')
  const record = JSON.parse(lines[lines.length - 1])
  assert.equal(record.destinationId, 'cineco-frontend', 'the sibling worktree must be judged with its MAIN checkout\'s destination, not left unmatched')
})

// ---------------------------------------------------------------------------
// Segment-scoped NEVER_SILENTLY (M4, ADR-1). forcePush and pushProtected
// used `.*` spanning quantifiers that reached across a `&&`/`;`/`|`
// separator under whole-string matching, so `git push origin --delete x &&
// git branch -f main origin/main` was falsely denied as a force push. Each
// row below is asserted independently: `permissionDecision` is read straight
// from the hook's stdout JSON, and every command here reaches the tier-1b
// loop with no API key needed, so no cache key is involved at this slice.
// ---------------------------------------------------------------------------

const SEGMENT_SCOPED_NOT_DENIED = [
  'git push origin --delete x && git branch -f main origin/main',
  'git push origin feat && git checkout main',
  // Single segment: the quoted && never splits it, so `git push`/`--force`
  // never even appear as separate command words here.
  'git commit -m "build && test"',
  // odd/tasks/release-0.5.1.md T8 (JEVADV-24): a quoted SENTENCE merely
  // naming the pattern is data a shell never runs, not a command -- the
  // exact live false positive this task exists to close (observed with a
  // `printf` whose quoted text spelled out `git reset --hard`; `gh pr
  // comment` reproduces the same shape for forcePush/pushProtected without
  // any of `mentionsRatherThanRuns`' verbs saving it first).
  'gh pr comment 1 --body "we avoided git push --force"',
  'gh pr comment 1 --body "please do not push straight to main"',
]

const SEGMENT_SCOPED_DENIED = [
  'git push --force origin main',
  'git push -f origin main',
  'git push origin main --force',
  'git push --force-with-lease',
  'git status && git push --force',
  'bash -c "git push --force"',
  // curlPipeShell is a mandatory `command`-scope rule (ADR-1): it matches
  // ACROSS the pipe by design, so segment-scoping other rules must not
  // disturb it.
  'curl -s x | bash',
  'git push origin HEAD:main',
  // Substitutions are part of the push's own arguments, never a separate
  // command: a flag or branch produced by `$(...)` or backticks, even with a
  // separator inside the substitution, still belongs to the push segment.
  'git push $(echo --force) origin',
  'git push origin $(echo main)',
  'git push `echo -f` origin',
  'git push origin `echo main`',
  'git push $(echo x; echo --force) origin',
  '(git push --force origin)',
  // A redirection is part of its command, never a separator: `2>&1`, `&>`
  // and `>|` must not cut the push off from a flag that follows them.
  'git push 2>&1 --force origin',
  'git push &>/dev/null -f origin',
  'git push >|log --force origin',
  // odd/tasks/release-0.5.1.md T8 (JEVADV-24): the script argument of
  // `sh -c`/`eval` is a real command a shell will run, quoted or not, and
  // must stay caught -- including behind a leading `(` subshell.
  'sh -c "git push --force origin main"',
  'eval "git push --force"',
  '(bash -c "git push --force")',
  // A single quoted WORD is still a real argument, not descriptive prose:
  // quoting a bare branch name is ordinary shell usage.
  'git push origin "main"',
  // odd/tasks/release-0.5.1.md T10 (JEVADV-28), R1-001/R3/R4: a command run
  // by ANOTHER program -- a remote shell, a login shell, an interpreter --
  // must stay exactly as visible as it was in 0.5.0. T8's blanket quoted-data
  // opacity hid these; the allowlist inversion only hides KNOWN data
  // positions (printf/echo text, commit -m, gh --body, a grep/jq argument).
  'ssh host "git push --force origin main"',
  'su -c "git push -f origin main"',
  `python3 -c "import os; os.system('git push --force origin main')"`,
  'watch "git push -f"',
  'script -c "git push -f"',
  // The push-protected rule's own wrapper example named in the task.
  'ssh host "git push origin main"',
  // odd/tasks/release-0.5.1.md JEVADV-37 item 3: a real shell -c pair still
  // runs whichever program precedes it, not only a modelled wrapper.
  'parallel sh -c "git push --force"',
]

for (const command of SEGMENT_SCOPED_NOT_DENIED) {
  test(`segment-scoped NEVER_SILENTLY: not denied: ${command}`, () => {
    const home = makeHome()
    const payload = JSON.parse(run(home, command))
    assert.notEqual(payload.hookSpecificOutput.permissionDecision, 'deny')
  })
}

for (const command of SEGMENT_SCOPED_DENIED) {
  test(`segment-scoped NEVER_SILENTLY: denied: ${command}`, () => {
    const home = makeHome()
    const payload = JSON.parse(run(home, command))
    assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
  })
}

// ---------------------------------------------------------------------------
// JEVADV-39 (odd/tasks/release-0.5.1.md T-lane-a): a push naming
// main/master/production is only a shared-branch push once its remote
// actually resolves to somewhere shared. Real temp git repos throughout --
// same discipline as the linked-sibling-worktree test above -- since the
// whole point is reading the exact remote config `git remote add` writes.
// ---------------------------------------------------------------------------

test('JEVADV-39: a push naming main to the repo\'s own LOCAL bare remote is not a local-rule stop', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-push-local-remote-test-')))
  const bareRemote = join(base, 'sandbox-remote.git')
  git(['init', '-q', '--bare', bareRemote], base)
  const repo = join(base, 'sandbox-app')
  initRepo(repo)
  git(['remote', 'add', 'origin', bareRemote], repo)

  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push -u origin main', { cwd: repo }))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow', 'a fresh personal repo pushed to its own local bare remote must not be refused as a shared-branch push')
})

test('JEVADV-39: a push naming main to a github.com remote still denies', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-push-github-remote-test-')))
  const repo = join(base, 'sandbox-app')
  initRepo(repo)
  git(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo)

  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push -u origin main', { cwd: repo }))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('JEVADV-39: a push naming main whose remote name is not configured at all still denies (fails closed)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-push-unresolvable-remote-test-')))
  const repo = join(base, 'sandbox-app')
  initRepo(repo)
  // No `git remote add` at all: "origin" resolves to nothing this process can read.

  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push -u origin main', { cwd: repo }))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('JEVADV-39: force push to the SAME local bare remote still denies -- force push stays denied everywhere', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-push-local-force-test-')))
  const bareRemote = join(base, 'sandbox-remote.git')
  git(['init', '-q', '--bare', bareRemote], base)
  const repo = join(base, 'sandbox-app')
  initRepo(repo)
  git(['remote', 'add', 'origin', bareRemote], repo)

  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push --force origin main', { cwd: repo }))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('JEVADV-39: a file:// URL given directly as the push argument is not a local-rule stop', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push file:///tmp/orca-jev-nonexistent-remote.git main'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'allow')
})

test('JEVADV-39: a remote whose url is local but whose pushurl is shared still denies -- git push itself goes to pushurl', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-jev-push-pushurl-test-')))
  const bareRemote = join(base, 'sandbox-remote.git')
  git(['init', '-q', '--bare', bareRemote], base)
  const repo = join(base, 'sandbox-app')
  initRepo(repo)
  git(['remote', 'add', 'origin', bareRemote], repo)
  git(['remote', 'set-url', '--push', 'origin', 'https://github.com/example/repo.git'], repo)

  const home = makeHome()
  const payload = JSON.parse(run(home, 'git push -u origin main', { cwd: repo }))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny', "today's bug: reading url alone ignored pushurl, which is where this push actually goes")
})

test('deny tier: a rule switched off downgrades to ask, never to allow', () => {
  const home = makeHome()
  writeDenyTierConfig(home, { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true })
  const stdout = run(home, 'rm -rf /')
  const payload = JSON.parse(stdout)
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask', 'turning the switch off must downgrade to ask, never disappear into allow')
})

test('deny tier: the other two switches are unaffected by turning one off', () => {
  const home = makeHome()
  writeDenyTierConfig(home, { denyRmRf: false, denyDropTable: true, denyTerraformDestroy: true })
  const dropTable = JSON.parse(run(home, 'DROP TABLE users'))
  const destroy = JSON.parse(run(home, 'terraform destroy'))
  assert.equal(dropTable.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(destroy.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: a malformed config file keeps all three rules denying (fail closed)', () => {
  const home = makeHome()
  const path = denyTierConfigPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{not valid json')
  const rmRf = JSON.parse(run(home, 'rm -rf /'))
  const dropTable = JSON.parse(run(home, 'DROP TABLE users'))
  const destroy = JSON.parse(run(home, 'terraform destroy'))
  assert.equal(rmRf.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(dropTable.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(destroy.hookSpecificOutput.permissionDecision, 'deny')
})

test('deny tier: an unreadable config file (a directory instead of a file) keeps all three rules denying (fail closed)', () => {
  const home = makeHome()
  const path = denyTierConfigPath(home)
  // Making the "file" a directory forces readFileSync to throw EISDIR,
  // exercising the failure path distinctly from a JSON.parse failure.
  mkdirSync(path, { recursive: true })
  const rmRf = JSON.parse(run(home, 'rm -rf /'))
  assert.equal(rmRf.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-37 (part 2): the mention tier must not
// stall an unattended agent. A match in COMMAND POSITION still denies (toggle
// on) / asks (toggle off), exactly as before; a match that exists ONLY
// because a quoted argument of some OTHER, non-executing program stayed
// visible -- someSegmentMatches' own 'ask' severity -- is NOT a local-rule
// match at all anymore: it is not a local `ask` either, it falls through to
// the ordinary Jev path, exactly like mentionsRatherThanRuns' own mention
// verbs already do. These tests run with no API key, so "the ordinary path"
// means the no-key pass-through (`allow` with a notice, or silent `none` on a
// later call in the same home) -- see decisionFor() and the no-key tests
// above for that same pattern.
// ---------------------------------------------------------------------------

// odd/tasks/release-0.5.1.md JEVADV-38 T-lane-a task 2: 'allow'/'none' alone
// cannot fail on the actual claim -- both are exactly what the no-key
// pass-through around a local-rule BUG (item 1's own gap) would also
// produce. Every gate-level mention case below also asserts that no
// local-rule gate record was written at all, the same direct check
// test('a mention is no longer a local-rule stop...') already established.

test('real subprocess, not a local-rule stop: sed\'s own script argument merely mentions a hard reset', () => {
  const home = makeHome()
  const decision = decisionFor(home, "sed -i 's/git reset --hard//' f")
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  assert.equal(existsSync(gateLogPath(home)), false, 'a mention must never reach the local-rule record path')
})

test('real subprocess, not a local-rule stop: an unrecognised program\'s quoted argument merely mentions a force push', () => {
  const home = makeHome()
  const decision = decisionFor(home, 'some-unknown-tool "please never git push --force"')
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  assert.equal(existsSync(gateLogPath(home)), false, 'a mention must never reach the local-rule record path')
})

test('real subprocess, still DENIES: a wrapper (su -c) really running a hard reset stays command position', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'su -c "git reset --hard"'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// odd/tasks/release-0.5.1.md JEVADV-38 T-lane-a task 1: a shell option
// BEFORE its own -c (an unmodelled wrapper's flag, `bash -x -c`/`sh -e -c`)
// used to hide the real run entirely -- with no key configured, that read as
// a silent pass-through where 0.5.0's own quote-blind regex denied outright.
test('real subprocess, still DENIES: a shell option before -c behind an unmodelled wrapper still runs a force push', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'parallel bash -x -c "git push --force origin main"'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('real subprocess, still DENIES: bash\'s own -o <opt> before -c behind an unmodelled wrapper still runs a hard reset', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'flock /tmp/l bash -o pipefail -c "git reset --hard"'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('a mention is no longer a local-rule stop, so it writes no local-rule gate record', () => {
  const home = makeHome()
  run(home, "sed -i 's/git reset --hard//' f")
  // No API key and no local-rule match at all: main() returns from the
  // no-key branch before ever calling appendGateRecord.
  assert.equal(existsSync(gateLogPath(home)), false, 'a mention must never reach the local-rule record path')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-36: new known DATA positions resolve to
// the ordinary Jev/allow path, not even the mention-only ask tier -- see
// the "SPEC NOTE" in git_discard.ts's own someSegmentMatches tests for why
// this, and not 'ask', is the right outcome for `git grep`/`git log -S`.
// ---------------------------------------------------------------------------

test('real subprocess, not stopped by a local rule at all: git grep\'s pattern is a known data position', () => {
  const home = makeHome()
  const decision = decisionFor(home, 'git grep "git reset --hard"')
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  assert.equal(existsSync(gateLogPath(home)), false, 'a known data position must never reach the local-rule record path')
})

test('real subprocess, not stopped by a local rule at all: a generic --body flag on an unrecognised program is a known data position', () => {
  const home = makeHome()
  const decision = decisionFor(home, 'orca plane create --body "plan: run git reset --hard origin/main next"')
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  assert.equal(existsSync(gateLogPath(home)), false, 'a known data position must never reach the local-rule record path')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-36, item 2: a wrapper name must be
// recognised only at a segment's command position, never as an arbitrary
// later token belonging to some other program's own argument.
// ---------------------------------------------------------------------------

test('real subprocess, not a local-rule stop: a wrapper NAME sitting inside another program\'s own argument is not treated as that wrapper', () => {
  const home = makeHome()
  // Not "grep": that leading verb is mentionsRatherThanRuns' own MENTION_ONLY
  // fast path (a separate, earlier guard), which would exit this command
  // silently before it ever reaches the NEVER_SILENTLY loop this test means
  // to exercise -- see git_discard.test.ts's own unit-level version of this
  // same case for that one instead.
  const decision = decisionFor(home, 'some-tool -n watch "…git reset --hard…" f')
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  assert.equal(existsSync(gateLogPath(home)), false, 'a mention must never reach the local-rule record path')
})

// ---------------------------------------------------------------------------
// AB benchmark sampling (appendAbBenchmarkSample) -- only its NEGATIVE case
// is testable here. The real 'jev' verdict path (the only source this
// benchmark samples) needs a live network response from Jev's fixed
// endpoint; this suite's harness has no fetch injection point for a
// subprocess-spawned hook (see the module note above -- every test here
// takes the no-key or deny-tier path specifically to avoid the network),
// so it cannot exercise the append itself. That is covered instead by
// src/core/ab_benchmark.test.ts's unit tests for shouldSample/
// serializeSampleEntry/parseSampleEntries -- the exact functions
// appendAbBenchmarkSample calls.
// ---------------------------------------------------------------------------

function abBenchmarkQueuePath (home) {
  return join(home, '.cache', 'orca-supervisor', 'ab-benchmark-queue.jsonl')
}

test('AB benchmark: no queue file is created on the no-key path -- sampling never runs before a real Jev decision exists', () => {
  const home = makeHome()
  run(home, MIDDLE_TIER_COMMAND)
  assert.equal(existsSync(abBenchmarkQueuePath(home)), false)
})

test('AB benchmark: no queue file is created on a deny-tier local-rule verdict -- only source:"jev" decisions are ever sampled', () => {
  const home = makeHome()
  run(home, 'rm -rf /')
  assert.equal(existsSync(abBenchmarkQueuePath(home)), false)
})

// ---------------------------------------------------------------------------
// Discarding uncommitted work. `git checkout -- <file>` discarded an agent's
// uncommitted work in a real session while `rule.resetClean` only knew
// `reset --hard` and `clean -f`; the same loss through checkout or restore
// reached Jev instead, and scored on both sides of the ceiling. These fire
// under the same `denyResetClean` switch, before the API key check.
// ---------------------------------------------------------------------------

/** The decision the hook emitted, or 'none' when it passed through silently. */
function decisionFor (home, command) {
  const stdout = run(home, command)
  return stdout === '' ? 'none' : JSON.parse(stdout).hookSpecificOutput.permissionDecision
}

const DISCARDING_COMMANDS = [
  'git checkout -- src/app.ts',
  'git checkout -- .',
  'git checkout .',
  'git checkout main -- src/app.ts',
  'git checkout -f',
  'git checkout --force',
  'git checkout -f main',
  'git checkout --force feature/x',
  'git restore src/app.ts',
  'git restore .',
  'git restore --worktree src/app.ts',
  'git restore --source=HEAD~1 src/app.ts',
  // odd/tasks/release-0.5.1.md T8 (JEVADV-24): reset/clean folded into the
  // same tokenizer discardsUncommittedWork already gives checkout/restore
  // -- exercised end to end through the real hook, not just the unit tests
  // in src/core/git_discard.test.ts.
  'git reset --hard',
  'git clean -fd',
  'bash -c "git reset --hard"',
  'env A=1 git reset --hard',
  'git -C ../repo reset --hard',
  // A bare `--` is what xargs leaves in the static text; the real
  // pathspecs only exist once xargs appends them at runtime.
  'find . | xargs git checkout --',
  // Required STILL-refused case: a preceding, unrelated segment must not
  // hide the discard in the one that follows it.
  'x && git checkout -- file',
  // odd/tasks/release-0.5.1.md T10 (JEVADV-28), R1-002: reset/clean must
  // stay caught through ssh's remote command and `su -c`, the same way it
  // already is through `bash -c`/`eval`.
  'ssh host "git reset --hard"',
  'su -c "git reset --hard"',
  // A command SUBSTITUTION really does run, even behind a mention-only
  // verb like `echo` -- see mentionsRatherThanRuns' hasCommandSubstitution
  // guard, without which these two broke the NEVER_SILENTLY loop before
  // the deny tier ever got a look at the substitution's body.
  'echo "$(git reset --hard)"',
  'echo `git reset --hard`',
  // odd/tasks/release-0.5.1.md JEVADV-37 item 3: a real shell -c pair still
  // runs whichever program precedes it, not only a modelled wrapper.
  'flock /tmp/l sh -c "git reset --hard"',
]

const NON_DISCARDING_COMMANDS = [
  'git checkout main',
  'git checkout -b new-branch',
  'git checkout -B rebuilt origin/main',
  'git checkout src/app.ts',
  'git switch main',
  'git switch -c new-branch',
  'git restore --staged src/app.ts',
  'git restore -S src/app.ts',
  // Naming the command in a message is not running it; this rule denies,
  // so a false match would refuse the agent's commit outright.
  'git commit -m "note: use git restore src/app.ts to undo"',
  'git reset --soft HEAD~1',
  'git clean -n',
  // odd/tasks/release-0.5.1.md T10 (JEVADV-28), R3-checkout-trailing-dashdash:
  // a bare `--` after a real branch name is a harmless branch switch, not a
  // path-form checkout -- only xargs feeding the paths at runtime makes it one.
  'git checkout main --',
]

for (const command of DISCARDING_COMMANDS) {
  test(`discarding uncommitted work denies by default and drops to ask when its switch is off: ${command}`, () => {
    const home = makeHome()
    assert.equal(decisionFor(home, command), 'deny')
    writeDenyTierConfig(home, { denyResetClean: false })
    assert.equal(decisionFor(home, command), 'ask', 'switched off must reach ask, never allow')
  })
}

for (const command of NON_DISCARDING_COMMANDS) {
  test(`not a discard, so no local rule stops it: ${command}`, () => {
    const home = makeHome()
    const decision = decisionFor(home, command)
    assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path, got ${decision}`)
  })
}

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T8 (JEVADV-24) -- the exact command observed
// live on 2026-09-25: a `printf` whose double-quoted text spelled out a
// hard reset, followed by an unrelated `orca plane comment add` call, was
// REFUSED as "discards uncommitted work -- nothing to recover it from". No
// work was being discarded; the git words sat inside a quoted argument.
// Two segments matter here: `printf` alone would already be saved by
// mentionsRatherThanRuns (every segment leads with a read/print verb), but
// `orca plane comment add` does not lead with one, so that guard never
// fires and the OLD, quote-blind regex was the only thing standing between
// this command and a denial it never earned.
// ---------------------------------------------------------------------------

test('real subprocess, not refused: a printf whose quoted text spells out a hard reset, followed by an unrelated command', () => {
  const home = makeHome()
  const command = 'printf \'%s\\n\' "most risk-stage asks are right: git reset --hard origin/main." > "$B"; orca plane comment add 1 --body-file "$B"'
  const decision = decisionFor(home, command)
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path (no work is discarded here), got ${decision}`)
})

test('real subprocess, still refused: the same command with the quotes removed really does discard uncommitted work', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'echo start; git reset --hard; echo done'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('resetClean fails CLOSED on a command its tokenizer cannot parse: an unterminated quote falls back to the raw-text match', () => {
  const home = makeHome()
  // Not an obviously-safe verb and not a bare mention-only read/print
  // command, so this reaches the NEVER_SILENTLY loop rather than being
  // waved through by an earlier tier.
  const payload = JSON.parse(run(home, 'git commit -m "git reset --hard'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T10 (JEVADV-28), R1-002: reset/clean run by
// another program must stay caught. `su -c`/ssh are real shells, caught by
// discardsUncommittedWork's own recursion (git_discard.ts); python3 is not
// shell syntax at all, so this is caught by the resetClean rule's own raw
// pattern over the SAME scanned (visible-by-default) text forcePush/
// pushProtected already use -- see gate-bash.ts's NEVER_SILENTLY entry.
// ---------------------------------------------------------------------------

test('real subprocess, refused: `su -c "git reset --hard"` -- a real shell, not descriptive text', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'su -c "git reset --hard"'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('real subprocess, refused: a python3 -c string that runs a hard reset is not descriptive text either', () => {
  const home = makeHome()
  const command = `python3 -c "import os; os.system('git reset --hard')"`
  const payload = JSON.parse(run(home, command))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// Review finding R3-ask-short-circuits-later-deny: a mention that asks under
// one rule must never stop the loop before a later rule that DENIES a real
// command-position run in the same command.
// ---------------------------------------------------------------------------

test('real subprocess, refused: a mention in one rule never hides a real run caught by a later rule', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, 'some-tool "git push --force" && git reset --hard'))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

test('real subprocess, refused: a sed mention before a recursive delete of the home directory still denies', () => {
  const home = makeHome()
  const payload = JSON.parse(run(home, "sed -i 's/git push --force//' notes.txt && rm -rf ~"))
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny')
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T10 (JEVADV-28): the exact command refused live
// on 2026-09-25 (odd/tasks/release-0.5.1.md's "Progress" section references
// this session) must stay allowed after the allowlist inversion. Its
// printf's double-quoted arguments -- one of which spells out
// "git reset --hard origin/main" -- are DATA (printf's own arguments), and
// its final `orca plane create --title "..."` argument is VISIBLE (orca is
// not an allowlisted program) but names nothing this file denies.
// ---------------------------------------------------------------------------

test('real subprocess, not refused: the exact command refused live on 2026-09-25', () => {
  const home = makeHome()
  const command = readFileSync(join(__dirname, 'fixtures', 'jevadv-28-live-command.txt'), 'utf8').trim()
  const decision = decisionFor(home, command)
  assert.ok(decision === 'allow' || decision === 'none', `expected the ordinary path (no destructive command actually runs here), got ${decision}`)
})

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T8 (JEVADV-24)'s full required NOT-refused
// list, locked in here for regression even though every one of these five
// was ALREADY not refused before this task's changes -- each is saved by a
// DIFFERENT, pre-existing guard, not by scanSegment/discardsUncommittedWork's
// new reset/clean dispatch:
//   - printf/echo/grep: mentionsRatherThanRuns' MENTION_ONLY_VERBS already
//     breaks the NEVER_SILENTLY loop for a single safe-verb segment with no
//     command substitution.
//   - the git commit case: `checkout` was already recognised only through
//     discardsUncommittedWork's own tokenizer (never the old raw regex,
//     which only ever matched reset/clean), and that tokenizer already
//     required `git` in COMMAND position -- correct before this task too.
//   - the heredoc: withoutHeredocBodies already strips the body before any
//     rule (or mentionsRatherThanRuns) ever sees it.
// `gh pr comment` above is the one genuine false positive this task fixes
// (`gh` leads none of those guards); these five prove the fix does not
// depend on them, and would keep them true even if a future change removed
// one of the pre-existing guards.
// ---------------------------------------------------------------------------

const ALREADY_NOT_DENIED_BEFORE_T8 = [
  "printf '%s' \"text mentioning git reset --hard origin/main\"",
  "echo 'git clean -fd'",
  'git commit -m "revert the git checkout -- change"',
  "cat > notes.md <<'EOF'\ngit reset --hard\nEOF",
  'grep -n "git reset --hard" README.md',
]

for (const command of ALREADY_NOT_DENIED_BEFORE_T8) {
  test(`not refused (already true before T8): ${JSON.stringify(command)}`, () => {
    const home = makeHome()
    const decision = decisionFor(home, command)
    assert.notEqual(decision, 'deny')
  })
}
