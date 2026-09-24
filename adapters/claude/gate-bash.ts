/**
 * gate-bash — PreToolUse hook. Decides whether a command runs, gets asked
 * about, or gets blocked, without the agent having to remember any of it.
 *
 * The problem with putting a model in the path of every command is cost and
 * latency. That's why there are three tiers, and only the third one calls Jev:
 *
 *   0. settings.json's `if` filter. The hook doesn't even launch for
 *      commands that don't match the patterns of interest. Claude Code does
 *      this before spending a process.
 *   1. Local lists, in microseconds. Harmless passes through; catastrophic
 *      gets blocked. No network, no cost.
 *   2. Only what's left in the middle goes to Jev, and the result is cached
 *      per command and repository, so the second time doesn't cost either.
 *
 * ALWAYS fails open: any error, timeout or missing key ends in a clean exit
 * with no verdict, and the permission follows its normal course. A gate that
 * breaks work when the network drops is worse than no gate at all. That same
 * fail-open contract now also covers the optional catalog/policies mirror
 * (see readCatalogMirror/readPoliciesMirror below): a missing, unreadable or
 * malformed mirror degrades to the pre-existing global-thresholds behavior,
 * never a crash and never an extra prompt.
 *
 * ONE DELIBERATE EXCEPTION: readDenyTierConfig (below) fails CLOSED. The
 * three NEVER_SILENTLY rules whose blast radius reaches beyond the
 * repository AND beyond recovery (rm -rf /, DROP/TRUNCATE TABLE, terraform
 * destroy) deny by default, and a missing, unreadable or malformed
 * deny-tier-config.json must never be read as quiet permission to downgrade
 * them to 'ask' -- see src/core/deny_tier_config.ts. Turning any of the
 * three off is still possible, but only through an explicit, well-formed
 * `false` in that file; it downgrades to 'ask', never to 'allow'.
 *
 * This is the Claude Code adapter: the three-tier design and the local
 * pattern lists below are this file's own (measured, and correct -- do not
 * fold them into src/core, they are not Jev questions). The Jev call
 * itself (question shapes, retry/backoff, latency budget, response
 * guards) and the key resolution come from src/core, shared with the Orca
 * plugin adapter -- see adapters/orca/.
 *
 * Tier 1a used to be a list of whole-string regexes: `/^\s*git\s+status\b/`
 * tested against the entire command. That worked for a simple command but
 * silently waved through a compound one that merely STARTED with a safe
 * verb (`git status && rm -rf /` matched the `git status` regex and never
 * reached tier 1b or Jev). `isObviouslySafeCommand` (src/core, pure and
 * unit-tested) fixes this by splitting on `&&`/`||`/`;`/`|` first and
 * requiring every resulting segment to be independently safe.
 *
 * Tier 2's single Jev call now also carries the destination-scoped policy
 * questions when the cwd matches a catalog destination with policies that
 * apply to it (see askJev below): one combined question set, one callJev
 * call, exactly as before -- decideGateAction (src/core/decisions.ts) is
 * what composes "does a policy already resolve this" with the existing
 * consequence-ceiling risk rule, substituting a per-destination ceiling
 * override when the matched destination's catalog entry carries one.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { GATE_CONSEQUENCE_CEILING, buildActionGateQuestions, buildActionGateState, buildPolicyQuestions, decideGateAction, filterPoliciesForDestination } from '../../src/core/decisions.ts'
import type { GateActionReason, Policy } from '../../src/core/decisions.ts'
import { buildPendingApprovalRecord, serializeApprovalRecord } from '../../src/core/approval_record.ts'
import { commandShape } from '../../src/core/command_shape.ts'
import { ORCA_USER_DATA_ENV, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { activeProfileId, isPluginDisabled, profileDataPath } from '../../src/core/orca_enablement.ts'
import { matchDestination } from '../../src/core/destination_match.ts'
import { callJev, JevRequestError } from '../../src/core/jev.ts'
import { resolveApiKey } from '../../src/core/secrets.ts'
import { DEFAULT_LOCALE, parseLocaleFile, translate, translateReason } from '../../src/core/i18n.ts'
import type { Locale } from '../../src/core/i18n.ts'
import { GATE_CATALOG } from '../../src/core/i18n_gate.ts'
import type { GateKey } from '../../src/core/i18n_gate.ts'
import { DESTINATION_CATALOG } from '../../src/core/i18n_destination.ts'
import type { DestinationKey } from '../../src/core/i18n_destination.ts'
import { buildGateDecisionRecord, commandFamily, serializeGateRecord } from '../../src/core/gate_measurement.ts'
import type { GateSource, GateVerdict } from '../../src/core/gate_measurement.ts'
import { isObviouslySafeCommand } from '../../src/core/gate_safe_command.ts'
import { decideNoKeyNotice } from '../../src/core/gate_key_notice.ts'
import { pruneGateCache } from '../../src/core/gate_cache.ts'
import type { GateCacheEntry } from '../../src/core/gate_cache.ts'
import { parseMirroredCatalog, parseMirroredPolicies } from '../../src/core/gate_catalog_mirror.ts'
import type { MirroredDestination } from '../../src/core/gate_catalog_mirror.ts'
import { DEFAULT_DENY_TIER_SWITCHES, parseDenyTierConfig } from '../../src/core/deny_tier_config.ts'
import type { DenyTierSwitches } from '../../src/core/deny_tier_config.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'

// `os.homedir()` is already HOME-vs-USERPROFILE correct per platform;
// resolveCacheDir/resolveConfigDir only decide the `.cache`/`.config` vs
// `%LOCALAPPDATA%`/`%APPDATA%` vs XDG convention on top of it -- see
// src/core/paths.ts.
const PLATFORM = normalizePlatform(process.platform)
const HOME_PATHS = {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
}
const CACHE_DIR = resolveCacheDir(PLATFORM, HOME_PATHS)
const CONFIG_DIR = resolveConfigDir(PLATFORM, HOME_PATHS)

const CACHE_PATH = join(CACHE_DIR, 'gate-bash.json')
const AUTH_WARNED_PATH = join(CACHE_DIR, 'gate-bash.auth-warned.json')
const NO_KEY_WARNED_PATH = join(CACHE_DIR, 'gate-bash.no-key-warned.json')
const LOCALE_PATH = join(CONFIG_DIR, 'locale')
const GATE_LOG_PATH = join(CACHE_DIR, 'gate-decisions.jsonl')
const APPROVALS_PATH = join(CACHE_DIR, 'gate-approvals.jsonl')
const ENABLEMENT_CACHE_PATH = join(CACHE_DIR, 'gate-enablement.json')
// Written by adapters/orca/write-secret-mirror.mjs, refreshed on plugin
// activation and on every config-panel save -- this hook has no channel
// into Orca's own `storage`, so this file mirror is its only way to see
// the catalog/policies at all. See src/core/gate_catalog_mirror.ts for
// the validation that stands between this file and the gate's decision.
const CATALOG_MIRROR_PATH = join(CONFIG_DIR, 'catalog.json')
const POLICIES_MIRROR_PATH = join(CONFIG_DIR, 'policies.json')
// Written by adapters/orca/write-secret-mirror.mjs's deny-tier-config-save,
// refreshed on plugin activation and on every config-panel save, same
// channel as the catalog/policies mirrors above. Unlike those two -- and
// unlike every other best-effort read in this file -- a missing, malformed
// or unreadable read of THIS file must never lower protection: see
// readDenyTierConfig below and src/core/deny_tier_config.ts's module note.
const DENY_TIER_CONFIG_PATH = join(CONFIG_DIR, 'deny-tier-config.json')
const BUDGET_MS = 1800

/** Since the hook started, so it can say how long deciding cost. */
const STARTED_AT = Date.now()

/**
 * The config panel's language choice, mirrored to plain text next to (not
 * inside) the API key's fallback file -- this process is a plain Node
 * script Claude Code spawns per command, with no channel back into Orca's
 * own `storage`, so the worker writes the choice out where this can just
 * read it. Not Orca's own `contributes.languagePacks` (see
 * src/core/i18n.ts's note): that mechanism replaces Orca's whole UI
 * language, not one plugin's own messages. Missing or unreadable defaults
 * to DEFAULT_LOCALE, same as an unrecognized value -- a hook must never
 * fail over something as small as which language to speak.
 */
function resolveLocale(): Locale {
  try {
    return parseLocaleFile(readFileSync(LOCALE_PATH, 'utf8'))
  } catch {
    return DEFAULT_LOCALE
  }
}

const LOCALE = resolveLocale()
const t = (key: GateKey, params?: Readonly<Record<string, string>>): string => translate(GATE_CATALOG, LOCALE, key, params)

/** True when `key` belongs to DESTINATION_CATALOG (a policy citation) rather than this file's own GATE_CATALOG (a risk reason) -- GateKey and DestinationKey are disjoint string unions by construction, so membership alone is enough to route it. */
function isDestinationReasonKey(key: string): key is DestinationKey {
  return Object.prototype.hasOwnProperty.call(DESTINATION_CATALOG.en, key)
}

/** Resolves a decideGateAction reason through whichever catalog its key actually belongs to. */
function resolveGateActionReason(reason: GateActionReason): string {
  if (isDestinationReasonKey(reason.key)) {
    return translateReason(DESTINATION_CATALOG, LOCALE, { key: reason.key, params: reason.params })
  }
  return translateReason(GATE_CATALOG, LOCALE, { key: reason.key as GateKey, params: reason.params })
}

type Decision = 'allow' | 'deny' | 'ask'

/**
 * The three NEVER_SILENTLY rules whose blast radius reaches beyond the
 * repository AND beyond recovery -- the only ones this gate ever denies
 * outright instead of asking. Each key matches a boolean field on
 * DenyTierSwitches (src/core/deny_tier_config.ts); turning that field off
 * downgrades the rule to 'ask', never to 'allow'.
 *
 * Deliberately NOT on this list, however broad or damaging: force push
 * (most are a developer's own feature branch -- too broad to deny), a push
 * to main/master/production (damaging but revertible), `git reset --hard`
 * / `git clean -f` (the blast radius is one working tree and the person is
 * right there -- `clean -f` genuinely destroys untracked work, so this one
 * is a close call, not an obvious one), `kubectl delete|drain` (entirely
 * namespace-dependent; a dev namespace makes this routine), and
 * `curl | bash` (arbitrary remote code, but the person may have context
 * this gate does not). All five stay `ask`, on purpose -- do not "tidy"
 * this into denying more without re-reading the reasoning above.
 */
type DenyToggleKey = keyof DenyTierSwitches

/** Tier 1b: never runs without explicit human intervention. `why` is a catalog key, resolved at emit time in the panel's chosen language. `denyToggle` is set only for the three rules above, and only when its switch is on does the match become 'deny' instead of 'ask'. */
const NEVER_SILENTLY: readonly { readonly pattern: RegExp; readonly why: GateKey; readonly denyToggle?: DenyToggleKey }[] = [
  { pattern: /git\s+push\b.*(--force|-f)\b/, why: 'rule.forcePush' },
  { pattern: /git\s+push\b.*\b(main|master|production)\b/, why: 'rule.pushProtected' },
  // Irrecoverable, and beyond any repo: the whole home directory or the
  // filesystem root.
  { pattern: /rm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/, why: 'rule.rmRf', denyToggle: 'denyRmRf' },
  { pattern: /git\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: 'rule.resetClean' },
  // Irrecoverable without a backup nobody can assume exists.
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, why: 'rule.dropTable', denyToggle: 'denyDropTable' },
  { pattern: /kubectl\s+(delete|drain)\b/, why: 'rule.kubectlDelete' },
  // `apply` is routine and stays ask; only `destroy` is split out into deny.
  { pattern: /\b(terraform|tofu)\s+apply\b/, why: 'rule.terraformApply' },
  { pattern: /\b(terraform|tofu)\s+destroy\b/, why: 'rule.terraformDestroy', denyToggle: 'denyTerraformDestroy' },
  { pattern: /curl[^|]*\|\s*(bash|sh|zsh)\b/, why: 'rule.curlPipeShell' },
]

type HookInput = { readonly command: string; readonly cwd: string; readonly toolUseId: string | null }

function readHookInput(): HookInput | null {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const toolInput = record['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const command = (toolInput as Record<string, unknown>)['command']
  if (typeof command !== 'string' || command.trim().length === 0) return null
  const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : process.cwd()
  // Carried so a later PostToolUse/PermissionDenied can be joined back to the
  // question this process asked. Absent in a hand-made payload, which only
  // means that one decision goes unlabelled.
  const rawId = record['tool_use_id']
  const toolUseId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null
  return { command, cwd, toolUseId }
}

/**
 * `permissionDecisionReason` is only seen when the verdict stops something. A
 * silent permission leaves Jev invisible: nobody can tell whether it weighed
 * in, whether it got it right, or with what numbers -- and what can't be seen
 * can't be calibrated. That's why every model call also leaves a line for the user.
 */
function emit(decision: Decision, reason: string, visible = true): void {
  const payload: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }
  // Only announced when it changes the course of things. An 'allow' per
  // command is noise that buries the one notice that mattered.
  if (visible && decision !== 'allow') {
    const verb = t(decision === 'deny' ? 'verb.blocks' : 'verb.asks')
    payload['systemMessage'] = t('statusLine', { verb, reason, ms: String(Date.now() - STARTED_AT) })
  }
  process.stdout.write(JSON.stringify(payload))
}

/** No verdict: the permission follows its normal course. This is the default exit. */
function passThrough(): void {
  process.exit(0)
}

/**
 * No verdict, but with a notice: the permission follows its course (failing
 * open is still correct), but the user learns that Jev couldn't weigh in --
 * failing open in silence is worse than failing open with one line. Used
 * only for the authentication rejection (401/403), and only once per mark
 * (see readAuthWarned/writeAuthWarned): every command repeating the same
 * notice would be as noisy as never warning at all.
 */
function passThroughWithNotice(message: string): void {
  const payload = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    systemMessage: t('notice', { message }),
  }
  process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

type CacheEntry = GateCacheEntry

/**
 * The cache key for a command, or null when it must not be cached.
 *
 * It used to hash the literal command text, which over 702 real decisions
 * hit 3.1% of the time: commands almost never repeat verbatim. The key is
 * now the command's SHAPE (see src/core/command_shape.ts), which collapses
 * `node --test a.test.ts` and `node --test b.test.ts` into one entry while
 * keeping `rm -rf dist` apart from `rm -rf ../other-project` -- measured at
 * 1.37 and 2.13, so merging those two would be a hole, not a cache.
 *
 * Null means "ask every time": a command whose meaning cannot be known
 * without running it never borrows another command's answer.
 */
function cacheKey(command: string, context: string, cwd: string, destinationId: string | null, treeRoot: string | null): string | null {
  const shape = commandShape(command, { cwd, home: HOME_PATHS.home, destinationId, treeRoot: treeRoot ?? undefined, repoContext: context })
  return shape === null ? null : createHash('sha256').update(shape).digest('hex').slice(0, 24)
}

/**
 * Reads the cache, dropping expired and malformed entries (see
 * pruneGateCache, src/core/gate_cache.ts, for the TTL and its rationale).
 * When anything was dropped, the pruned set is persisted immediately so
 * this file doesn't quietly keep growing with verdicts nobody can use
 * anymore -- best-effort, same fail-open discipline as writeCache itself.
 */
function readCache(): Record<string, CacheEntry> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const { fresh, changed } = pruneGateCache(parsed as Record<string, unknown>)
  if (changed) writeCache(fresh)
  return fresh
}

function writeCache(cache: Record<string, CacheEntry>): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8')
  } catch {
    // A cache that can't be written is never a reason to block anything.
  }
}

/**
 * Whether the last authentication rejection was already warned about --
 * persisted alongside the cache because this process doesn't live between
 * commands (Claude Code spawns the hook once per command): without this
 * mark on disk, "once" would actually mean "on every command".
 */
function readAuthWarned(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(AUTH_WARNED_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { warned?: unknown }).warned === true
  } catch {
    return false
  }
}

function writeAuthWarned(warned: boolean): void {
  try {
    mkdirSync(dirname(AUTH_WARNED_PATH), { recursive: true })
    writeFileSync(AUTH_WARNED_PATH, JSON.stringify({ warned, at: Date.now() }), 'utf8')
  } catch {
    // A mark that can't be written is never a reason to block anything;
    // worst case, the notice repeats next time.
  }
}

/**
 * Same marker shape as readAuthWarned/writeAuthWarned, for the OTHER way
 * Jev goes quiet: no key configured at all (see decideNoKeyNotice,
 * src/core/gate_key_notice.ts, for the warn-once/reset rule itself). A
 * missing key must never block a command, but a plugin whose whole purpose
 * is judging commands, quietly judging nothing forever, is the worst
 * failure this thing can have -- especially since the local, no-key-needed
 * rules keep running and mask that the rest is gone.
 */
function readNoKeyWarned(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(NO_KEY_WARNED_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { warned?: unknown }).warned === true
  } catch {
    return false
  }
}

function writeNoKeyWarned(warned: boolean): void {
  try {
    mkdirSync(dirname(NO_KEY_WARNED_PATH), { recursive: true })
    writeFileSync(NO_KEY_WARNED_PATH, JSON.stringify({ warned, at: Date.now() }), 'utf8')
  } catch {
    // A mark that can't be written is never a reason to block anything;
    // worst case, the notice repeats next time.
  }
}

/**
 * Best-effort, fail-open reads of the optional catalog/policies mirror --
 * same discipline as readCache/resolveLocale above: a missing file, an
 * unreadable one, or one that fails src/core/gate_catalog_mirror.ts's shape
 * validation is never a throw, it is simply "no catalog" / "no policies",
 * and the gate keeps working exactly as it did before this feature existed.
 */
function readCatalogMirror(): { readonly destinations: readonly MirroredDestination[] } | null {
  try {
    return parseMirroredCatalog(JSON.parse(readFileSync(CATALOG_MIRROR_PATH, 'utf8')))
  } catch {
    return null
  }
}

function readPoliciesMirror(): readonly Policy[] {
  try {
    return parseMirroredPolicies(JSON.parse(readFileSync(POLICIES_MIRROR_PATH, 'utf8'))) ?? []
  } catch {
    return []
  }
}

/**
 * Fails CLOSED, not open -- the one deliberate exception to every other
 * best-effort read in this file. A missing DENY_TIER_CONFIG_PATH (nobody
 * has touched the panel's switches yet), an unreadable one, or one that
 * fails parseDenyTierConfig's own shape validation all read the exact same
 * way a brand-new install does: every switch stays at its default of
 * `true`, still denying. See src/core/deny_tier_config.ts's module note --
 * a config that cannot be read is not permission to stop protecting.
 */
function readDenyTierConfig(): DenyTierSwitches {
  try {
    return parseDenyTierConfig(readFileSync(DENY_TIER_CONFIG_PATH, 'utf8'))
  } catch {
    return DEFAULT_DENY_TIER_SWITCHES
  }
}

/**
 * The project name the measurement log records: the repo's short remote
 * name when there is one (matches what a person calls the project),
 * falling back to the working directory's own name for a repo with no
 * remote. Never the full path, which can carry a username or a client's
 * name in a way the remote's short form does not.
 */
function projectName(cwd: string): string | null {
  let remote = ''
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .replace(/^.*[:/]/, '')
      .replace(/\.git$/, '')
  } catch {
    remote = ''
  }
  if (remote.length > 0) return remote
  try {
    return basename(cwd) || null
  } catch {
    return null
  }
}

/**
 * Leaves the question behind, so the answer can be joined to it later.
 *
 * Only written when the gate actually stops something: a command that passed
 * was never a question, and recording it would drown the few real decisions
 * in hundreds of non-events. Carries no command -- the shape hash and a
 * coarse family are enough to calibrate against and cannot be read back.
 */
function appendPendingApproval(
  toolUseId: string | null,
  cwd: string,
  command: string,
  shape: string | null,
  destinationId: string | null,
  axes: { readonly reversible: number | null; readonly external: number | null; readonly consequence: number | null },
  ceiling: number,
): void {
  if (toolUseId === null) return
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    appendFileSync(
      APPROVALS_PATH,
      serializeApprovalRecord(
        buildPendingApprovalRecord({
          toolUseId,
          at: new Date().toISOString(),
          project: projectName(cwd),
          destinationId,
          commandFamily: commandFamily(command),
          shape,
          reversible: axes.reversible,
          external: axes.external,
          consequence: axes.consequence,
          ceiling,
        }),
      ),
    )
  } catch {
    // Best effort, exactly like the measurement log: never a reason to delay
    // or change a verdict.
  }
}

/** Appends one measurement record. Best-effort, same as the auth-warned marker: a log that cannot be written is never a reason to block or delay a verdict. */
function appendGateRecord(cwd: string, command: string, source: GateSource, verdict: GateVerdict, latencyMs: number | null): void {
  try {
    mkdirSync(dirname(GATE_LOG_PATH), { recursive: true })
    const record = buildGateDecisionRecord({
      id: randomUUID(),
      at: new Date().toISOString(),
      project: projectName(cwd),
      command,
      source,
      verdict,
      latencyMs,
    })
    appendFileSync(GATE_LOG_PATH, serializeGateRecord(record), 'utf8')
  } catch {
    // Best-effort measurement; never blocks or delays a verdict.
  }
}

/**
 * What makes a feature branch different from a client's main. This string
 * is sent to Jev as model input (see askJev/buildActionGateState below) and
 * is also folded into the cache key, so it stays in English like every
 * other prompt this project sends the model.
 */
function repoContext(cwd: string): string {
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = run(['remote', 'get-url', 'origin']).replace(/^.*[:/]/, '').replace(/\.git$/, '')
  const dirty = run(['status', '--porcelain']).length > 0
  const parts = [
    remote.length > 0 ? `repository ${remote}` : 'no remote',
    branch.length > 0 ? `branch ${branch}` : 'unknown branch',
    branch === 'main' || branch === 'master' ? 'this is the shared main branch' : 'this is a working branch',
    dirty ? 'with uncommitted changes' : 'clean',
  ]
  return parts.join(', ')
}

type GateAxes = { readonly reversible: number | null; readonly external: number | null; readonly consequence: number | null; readonly ceiling: number } | null

type JevOutcome =
  | { readonly kind: 'verdict'; readonly decision: Decision; readonly reason: string; readonly axes: GateAxes; readonly destinationId: string | null }
  | { readonly kind: 'auth-rejected'; readonly status: number }
  | { readonly kind: 'none' }

/**
 * Calls Jev (src/core) and translates the verdict into the hook's decision.
 * Never throws.
 *
 * Also resolves the cwd against the (optional) catalog mirror, filters the
 * (optional) policies mirror down to whatever applies at the matched
 * destination, and -- when at least one policy applies -- folds the two
 * extra policy-stage questions into the SAME callJev call the gate already
 * makes (no second network round trip). decideGateAction then composes
 * "does a policy already resolve this" with the existing consequence-
 * ceiling risk rule, substituting the matched destination's own ceiling
 * override when its catalog entry carries one.
 */
async function askJev(apiKey: string, command: string, context: string, cwd: string): Promise<JevOutcome> {
  try {
    const catalog = readCatalogMirror()
    const policies = readPoliciesMirror()
    const matched: MirroredDestination | null = catalog !== null ? matchDestination(cwd, catalog.destinations) : null
    const filteredPolicies = filterPoliciesForDestination(policies, matched?.id ?? null)

    const questions = {
      ...buildActionGateQuestions(),
      ...(filteredPolicies.length > 0 ? buildPolicyQuestions(filteredPolicies) : {}),
    }
    const destination = matched !== null ? { label: matched.label, kind: matched.kind } : undefined
    const response = await callJev(apiKey, buildActionGateState(command, context, destination), questions, { budgetMs: BUDGET_MS })
    const gate = decideGateAction({
      action: command,
      policies: filteredPolicies,
      answers: response.answers,
      consequenceCeiling: matched?.autonomy?.consequenceCeiling,
      noDestinationMatched: matched === null,
    })
    const reason = gate.reasons.length > 0 ? gate.reasons.map(resolveGateActionReason).join(' · ') : t('reason.allowClear')
    return { kind: 'verdict', decision: gate.verdict, reason, axes: gate.axes, destinationId: matched?.id ?? null }
  } catch (error) {
    if (error instanceof JevRequestError && (error.status === 401 || error.status === 403)) {
      return { kind: 'auth-rejected', status: error.status }
    }
    return { kind: 'none' }
  }
}

/**
 * True when Orca has this plugin switched off.
 *
 * The gate is a Claude Code hook, so nothing about it stopped when the plugin
 * was disabled in Orca: it kept judging every command, and kept interrupting,
 * with the plugin visibly off. It consults Orca's own `disabledPlugins` now.
 *
 * That file holds the whole profile and runs to megabytes, so parsing it on
 * every command would cost more than the judgement does. The answer is cached
 * against the file's size and mtime -- a stat, measured at a fifth of a
 * millisecond -- and only re-read when Orca has actually written to it.
 *
 * Every failure answers false and leaves the gate running. A plugin that
 * silently stops protecting because a file moved is worse than one that keeps
 * asking after being switched off: the second at least announces itself to
 * the person it annoys.
 */
function pluginDisabledInOrca(): boolean {
  try {
    const userData = resolveOrcaUserDataDir(PLATFORM, {
      home: HOME_PATHS.home,
      appDataDir: process.env.APPDATA,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      orcaUserDataPath: process.env[ORCA_USER_DATA_ENV],
    })
    const profileId = activeProfileId(JSON.parse(readFileSync(join(userData.path, 'orca-profile-index.json'), 'utf8')))
    if (profileId === null) return false
    const dataPath = profileDataPath(PLATFORM, userData.path, profileId)
    const stat = statSync(dataPath)
    const stamp = `${stat.size}:${stat.mtimeMs}`

    try {
      const cached: unknown = JSON.parse(readFileSync(ENABLEMENT_CACHE_PATH, 'utf8'))
      if (typeof cached === 'object' && cached !== null) {
        const record = cached as Record<string, unknown>
        if (record['stamp'] === stamp && typeof record['disabled'] === 'boolean') return record['disabled']
      }
    } catch {
      // No usable cache yet; fall through and read the file once.
    }

    const disabled = isPluginDisabled(JSON.parse(readFileSync(dataPath, 'utf8')))
    try {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(ENABLEMENT_CACHE_PATH, JSON.stringify({ stamp, disabled }))
    } catch {
      // A cache that cannot be written only costs the next command a re-read.
    }
    return disabled
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const input = readHookInput()
  if (input === null) passThrough()
  const { command, cwd, toolUseId } = input as HookInput

  // Before anything else, and before any work: if Orca has the plugin
  // switched off, this hook has no business judging anything.
  if (pluginDisabledInOrca()) passThrough()

  if (isObviouslySafeCommand(command)) passThrough()
  for (const { pattern, why, denyToggle } of NEVER_SILENTLY) {
    if (pattern.test(command)) {
      // Only the three deny-tier rules ever carry a denyToggle, and only
      // when its switch is (still) on does the match become 'deny' instead
      // of 'ask' -- readDenyTierConfig() fails CLOSED, so an unreadable
      // config denies exactly as a fresh install would.
      const decision: Decision = denyToggle !== undefined && readDenyTierConfig()[denyToggle] ? 'deny' : 'ask'
      appendGateRecord(cwd, command, 'local-rule', decision, null)
      // Recorded like any other stop, with no scores: a local rule needs no
      // model and no threshold, so there is nothing here to calibrate -- but
      // whether the person accepted the interruption is still worth knowing.
      appendPendingApproval(toolUseId, cwd, command, null, null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING)
      const reasonKey = decision === 'deny' ? 'localRuleDeny' : 'localRule'
      emit(decision, t(reasonKey, { why: t(why) }))
      return
    }
  }

  const apiKey = await resolveApiKey()
  const previouslyWarnedNoKey = readNoKeyWarned()
  const noKeyNotice = decideNoKeyNotice(apiKey !== null, previouslyWarnedNoKey)
  if (noKeyNotice.nextWarned !== previouslyWarnedNoKey) writeNoKeyWarned(noKeyNotice.nextWarned)
  if (apiKey === null) {
    if (noKeyNotice.shouldWarn) passThroughWithNotice(t('noApiKey'))
    passThrough()
  }

  const context = repoContext(cwd)
  // The destination is resolved here as well as inside askJev: it is part of
  // the cache key, because two repositories with different thresholds must
  // never share a verdict. Both reads hit the same small mirror file.
  const cachedCatalog = readCatalogMirror()
  const cachedMatch = cachedCatalog !== null ? matchDestination(cwd, cachedCatalog.destinations) : null
  const key = cacheKey(command, context, cwd, cachedMatch?.id ?? null, cachedMatch?.worktreePath ?? null)
  const cache = key === null ? {} : readCache()
  const hit = key === null ? undefined : cache[key]
  if (hit !== undefined) {
    appendGateRecord(cwd, command, 'cache', hit.decision, null)
    if (hit.decision !== 'allow') {
      // A cached stop is still a question the person has to answer, so it is
      // recorded -- without scores, which the cache does not keep.
      appendPendingApproval(toolUseId, cwd, command, key, cachedMatch?.id ?? null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING)
    }
    emit(hit.decision, t('cached', { reason: hit.reason }))
    return
  }

  const jevStartedAt = Date.now()
  const outcome = await askJev(apiKey as string, command, context, cwd)
  const jevLatencyMs = Date.now() - jevStartedAt

  if (outcome.kind === 'none') passThrough()

  if (outcome.kind === 'auth-rejected') {
    if (!readAuthWarned()) {
      writeAuthWarned(true)
      passThroughWithNotice(t('authRejected', { status: String(outcome.status) }))
    }
    passThrough()
  }

  // Getting here is a valid response: if the last rejection notice was
  // still standing, the key works again now, and the next rejection
  // deserves a fresh warning.
  if (readAuthWarned()) writeAuthWarned(false)

  const resolved = outcome as { kind: 'verdict'; decision: Decision; reason: string }
  if (key !== null) {
    cache[key] = { decision: resolved.decision, reason: resolved.reason, at: Date.now() }
    writeCache(cache)
  }
  appendGateRecord(cwd, command, 'jev', resolved.decision, jevLatencyMs)
  // Only a stop becomes a question worth an answer. A pass was never asked
  // about, so recording it would bury the handful of real decisions under
  // hundreds of non-events.
  if (resolved.decision !== 'allow') {
    appendPendingApproval(
      toolUseId, cwd, command, key, resolved.destinationId,
      { reversible: resolved.axes?.reversible ?? null, external: resolved.axes?.external ?? null, consequence: resolved.axes?.consequence ?? null },
      resolved.axes?.ceiling ?? GATE_CONSEQUENCE_CEILING,
    )
  }
  emit(resolved.decision, resolved.reason)
}

await main()
