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
 * ONE DELIBERATE EXCEPTION: readDenyTierConfig (below) fails CLOSED. EVERY
 * NEVER_SILENTLY rule denies by default, and a missing, unreadable or
 * malformed deny-tier-config.json must never be read as quiet permission to
 * downgrade one -- see src/core/deny_tier_config.ts. Turning a rule off is
 * still possible, but only through an explicit, well-formed `false`; it
 * downgrades to 'ask', never to 'allow'.
 *
 * Why deny rather than ask: an 'ask' stops the PERSON and waits, a 'deny'
 * refuses the MODEL and hands it the reason, so it picks another approach and
 * nobody waits. Measured on the real approvals log before the change -- 3103
 * commands approved against 1 refused, and 5 of 16 questions never answered
 * at all -- the question was not buying safety, it was buying attention, and
 * the dialog opens on "Yes" anyway. Only the agent is refused; the person can
 * always run the command themselves, which is what the message says.
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
import { fileURLToPath } from 'node:url'
import { GATE_CONSEQUENCE_CEILING, buildActionGateQuestions, buildActionGateState, buildPolicyQuestions, buildSeedScopeIndex, decideGateAction, filterPoliciesForCommandScope, filterPoliciesForDestination } from '../../src/core/decisions.ts'
import type { GateActionReason, Policy, PolicyScope } from '../../src/core/decisions.ts'
import { parseSeedPolicies } from '../../src/core/policy_seed.ts'
import { buildPendingApprovalRecord, serializeApprovalRecord } from '../../src/core/approval_record.ts'
import { commandShape } from '../../src/core/command_shape.ts'
import { ORCA_USER_DATA_ENV, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { activeProfileId, isPluginDisabled, profileDataPath } from '../../src/core/orca_enablement.ts'
import { matchDestinationForCwd } from '../../src/core/linked_worktree.ts'
import { callJev, JevRequestError } from '../../src/core/jev.ts'
import { resolveApiKey } from '../../src/core/secrets.ts'
import { DEFAULT_LOCALE, parseLocaleFile, translate, translateReason } from '../../src/core/i18n.ts'
import type { Locale } from '../../src/core/i18n.ts'
import { GATE_CATALOG } from '../../src/core/i18n_gate.ts'
import type { GateKey } from '../../src/core/i18n_gate.ts'
import { DESTINATION_CATALOG } from '../../src/core/i18n_destination.ts'
import type { DestinationKey } from '../../src/core/i18n_destination.ts'
import { buildGateDecisionRecord, commandFamily, serializeGateRecord } from '../../src/core/gate_measurement.ts'
import type { GateSource, GateStopReason, GateVerdict } from '../../src/core/gate_measurement.ts'
import { withoutHeredocBodies } from '../../src/core/command_text.ts'
import { discardsUncommittedWork, hasUnbalancedQuoting, someSegmentMatches } from '../../src/core/git_discard.ts'
import { isObviouslySafeCommand, mentionsRatherThanRuns } from '../../src/core/gate_safe_command.ts'
import { decideNoKeyNotice } from '../../src/core/gate_key_notice.ts'
import { decideUnreachableNotice } from '../../src/core/gate_unreachable_notice.ts'
import { pruneGateCache } from '../../src/core/gate_cache.ts'
import type { GateCacheEntry } from '../../src/core/gate_cache.ts'
import { parseMirroredCatalog, parseMirroredPolicies } from '../../src/core/gate_catalog_mirror.ts'
import type { MirroredDestination } from '../../src/core/gate_catalog_mirror.ts'
import { DEFAULT_DENY_TIER_SWITCHES, parseDenyTierConfig } from '../../src/core/deny_tier_config.ts'
import type { DenyTierSwitches, DenyToggleKey } from '../../src/core/deny_tier_config.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'
import { parseAbBenchmarkConfig } from '../../src/core/ab_benchmark_config.ts'
import { parseSampleEntries, serializeSampleEntry, shouldSample } from '../../src/core/ab_benchmark.ts'
import type { AbSampleEntry, GateLikeVerdict } from '../../src/core/ab_benchmark.ts'

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
const UNREACHABLE_WARNED_PATH = join(CACHE_DIR, 'gate-bash.unreachable-warned.json')
// How many consecutive `{ kind: 'none' }` outcomes (askJev could not reach
// the backend at all) must happen before decideUnreachableNotice fires --
// see src/core/gate_unreachable_notice.ts. A single dropped request is
// ordinary network noise, not a signal the gate is disarmed.
const UNREACHABLE_WARN_THRESHOLD = 3
const LOCALE_PATH = join(CONFIG_DIR, 'locale')
const GATE_LOG_PATH = join(CACHE_DIR, 'gate-decisions.jsonl')
const APPROVALS_PATH = join(CACHE_DIR, 'gate-approvals.jsonl')
// This file runs IN PLACE from `<pluginRoot>/adapters/claude/gate-bash.ts`
// (see adapters/orca/install-claude-integration.mjs's hookSpecs, which
// points Claude Code's hook entry straight at the installed copy rather
// than copying it elsewhere), so two directories up from this module is
// always the installed plugin's own root.
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The shipped baseline this plugin ships inside its own tree (see
// src/core/policy_seed.ts's module note) -- read here only for the id ->
// scope map filterPoliciesForCommandScope's fallback needs (see
// readSeedScopeById below), never for the rows themselves: a developer's
// OWN stored policies (readPoliciesMirror) are what the gate actually
// judges against.
const SEED_POLICIES_PATH = join(PLUGIN_ROOT, 'seed', 'policies.json')
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
// No panel writes this today -- see src/core/ab_benchmark_config.ts's own
// module note. Created/edited by hand or by adapters/cli/ab_benchmark_cli.ts's
// `config` subcommand. Fails open to disabled, so a missing file behaves
// exactly like an install that never turned this on.
const AB_BENCHMARK_CONFIG_PATH = join(CONFIG_DIR, 'ab-benchmark-config.json')
// Appended by appendAbBenchmarkSample below, out of band, with no network
// call and no added latency; drained later by adapters/cli/ab_benchmark_cli.ts.
const AB_BENCHMARK_QUEUE_PATH = join(CACHE_DIR, 'ab-benchmark-queue.jsonl')
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

/** For text the MODEL reads rather than a person: always English, whatever
 *  locale the developer picked. A refusal is an instruction to the model, and
 *  its one reader understands English. */
const tEnglish = (key: GateKey, params?: Readonly<Record<string, string>>): string => translate(GATE_CATALOG, 'en', key, params)

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
 * Every NEVER_SILENTLY rule below denies by default: all nine switches in
 * DEFAULT_DENY_TIER_SWITCHES (src/core/deny_tier_config.ts) are `true`. A
 * rule's `denyToggle` names its switch -- `denyResetClean` guards two
 * entries -- and turning one off downgrades its rules to 'ask', never to
 * 'allow'.
 *
 * This used to be three rules (`rm -rf /`, DROP/TRUNCATE, terraform
 * destroy), with force push, pushes to protected branches, reset/clean,
 * kubectl delete|drain and `curl | bash` left at 'ask' because a person was
 * right there to answer. The approvals log overturned that (see the module
 * note above and deny_tier_config.ts): the question was answered "yes"
 * almost every time, or not at all, so it bought attention rather than
 * safety. What did not change is the floor: no switch reaches 'allow'.
 */

/**
 * resetClean's own fail-CLOSED fallback -- see its NEVER_SILENTLY entry
 * below and hasUnbalancedQuoting's doc comment (src/core/git_discard.ts).
 * Quote-blind on purpose: it exists ONLY for the one input
 * discardsUncommittedWork's tokenizer cannot parse with confidence, so
 * matching more freely there is the safe direction to err in.
 */
const RESET_CLEAN_FALLBACK_PATTERN = /git\s+(reset\s+--hard|clean\s+-[a-z]*f)/

/**
 * Tier 1b: the rules that never run unannounced. `why` is a catalog key,
 * resolved at emit time in the panel's chosen language.
 *
 * Every rule carries a `denyToggle`, and every toggle denies by default:
 * `deny` refuses the call and hands the reason to the model, which then picks
 * another approach, while `ask` stops the person and waits. Running with
 * permission prompts off is a deliberate choice that agents should not sit
 * waiting on a human, and an `ask` quietly puts that waiting back. Turning a
 * switch off downgrades that one rule to `ask` -- never to `allow`.
 *
 * Only the agent is refused. The person can always run the command in a
 * terminal, which is what the deny message tells them.
 */
const NEVER_SILENTLY: readonly {
  readonly pattern: { test(command: string): boolean }
  readonly why: GateKey
  readonly denyToggle: DenyToggleKey
  // 'segment' tests the pattern against each of the command's quote-aware
  // segments (splitOutsideQuotes) independently, so a `.*` inside the
  // pattern can never span a `&&`/`;`/`|`/newline/paren separator and
  // falsely implicate an unrelated segment (ADR-1). 'command' keeps
  // whole-string matching, for rules with no spanning quantifier and for
  // curlPipeShell, which matches ACROSS a pipe by design.
  readonly scope: 'segment' | 'command'
}[] = [
  { pattern: /git\s+push\b.*(--force|-f)\b/, why: 'rule.forcePush', denyToggle: 'denyForcePush', scope: 'segment' },
  { pattern: /git\s+push\b.*\b(main|master|production)\b/, why: 'rule.pushProtected', denyToggle: 'denyPushProtected', scope: 'segment' },
  // Irrecoverable, and beyond any repo: the whole home directory or the
  // filesystem root.
  { pattern: /rm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/, why: 'rule.rmRf', denyToggle: 'denyRmRf', scope: 'command' },
  // `git reset --hard` and `git clean -f` throw away uncommitted work with
  // no reflog behind them -- the closest call of the nine, since the blast
  // radius is one working tree. The same loss through `git checkout --
  // <path>`, `git checkout .`, `git checkout -f` or `git restore <path>`:
  // the working tree is overwritten and uncommitted changes are gone. This
  // form discarded an agent's work in a real session while reset/clean did
  // not know it. A branch switch, `-b`/`-B`, `git switch` and `git restore
  // --staged` are not matched -- see src/core/git_discard.ts for each
  // reason. All four subcommands share `rule.resetClean` on purpose: that
  // text ("discards uncommitted work -- nothing to recover it from") names
  // the effect, not the command.
  //
  // `command` scope: discardsUncommittedWork already segments on its own
  // and extracts `$(...)`/backticks/`bash -c`/`eval` first; pre-splitting
  // here would break its substitution extraction.
  //
  // Until T8 (odd/tasks/release-0.5.1.md, JEVADV-24) reset/clean were
  // matched by their OWN separate, quote-blind regex here -- a `printf`
  // whose double-quoted argument merely SPELLED OUT `git reset --hard` was
  // refused as if that command had run. Folding reset/clean into
  // discardsUncommittedWork's tokenizer fixes that, but its tokenizer fails
  // in the opposite direction on a genuinely unparseable command (an
  // unbalanced quote): it silently swallows the rest of the line into one
  // token instead of raising, which would hide a real `git reset --hard`
  // sitting after it. RESET_CLEAN_FALLBACK_PATTERN is the OLD regex, kept
  // as this rule's own fail-CLOSED fallback for exactly that one case --
  // see hasUnbalancedQuoting's doc comment.
  {
    pattern: { test: (command) => discardsUncommittedWork(command) || (hasUnbalancedQuoting(command) && RESET_CLEAN_FALLBACK_PATTERN.test(command)) },
    why: 'rule.resetClean', denyToggle: 'denyResetClean', scope: 'command',
  },
  // Irrecoverable without a backup nobody can assume exists.
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, why: 'rule.dropTable', denyToggle: 'denyDropTable', scope: 'command' },
  { pattern: /kubectl\s+(delete|drain)\b/, why: 'rule.kubectlDelete', denyToggle: 'denyKubectlDelete', scope: 'command' },
  { pattern: /\b(terraform|tofu)\s+apply\b/, why: 'rule.terraformApply', denyToggle: 'denyTerraformApply', scope: 'command' },
  { pattern: /\b(terraform|tofu)\s+destroy\b/, why: 'rule.terraformDestroy', denyToggle: 'denyTerraformDestroy', scope: 'command' },
  // Mandatory 'command' scope: this rule matches ACROSS a pipe by design.
  // splitOutsideQuotes splits on `|`, so segment scope would silently
  // disable it; `[^|]*` already bounds the curl side of the match.
  { pattern: /curl[^|]*\|\s*(bash|sh|zsh)\b/, why: 'rule.curlPipeShell', denyToggle: 'denyCurlPipeShell', scope: 'command' },
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
 * Same marker shape as readAuthWarned/readNoKeyWarned, for the THIRD way
 * Jev goes quiet: a key that is present and accepted, but the backend never
 * answers at all -- askJev's `{ kind: 'none' }` outcome (network error,
 * timeout, or budget exceeded). This one persists a consecutive-failure
 * COUNT rather than a boolean, because decideUnreachableNotice
 * (src/core/gate_unreachable_notice.ts) only warns once a run of failures
 * reaches UNREACHABLE_WARN_THRESHOLD, not on the very first one. A missing,
 * unreadable or malformed marker reads as 0 -- same fail-open default every
 * other marker in this file already uses.
 */
function readUnreachableFailures(): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(UNREACHABLE_WARNED_PATH, 'utf8'))
    const count = typeof parsed === 'object' && parsed !== null ? (parsed as { consecutiveFailures?: unknown }).consecutiveFailures : undefined
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
  } catch {
    return 0
  }
}

function writeUnreachableFailures(consecutiveFailures: number): void {
  try {
    mkdirSync(dirname(UNREACHABLE_WARNED_PATH), { recursive: true })
    writeFileSync(UNREACHABLE_WARNED_PATH, JSON.stringify({ consecutiveFailures, at: Date.now() }), 'utf8')
  } catch {
    // A mark that can't be written is never a reason to block anything;
    // worst case, the notice fires on a different call than it should.
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
  stopReason: GateStopReason,
  policyId: string | null,
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
          stopReason,
          policyId,
        }),
      ),
    )
  } catch {
    // Best effort, exactly like the measurement log: never a reason to delay
    // or change a verdict.
  }
}

/**
 * The shipped plugin's own version, read once from `orca-plugin.json` at
 * PLUGIN_ROOT -- never from `package.json`, which carries the whole
 * monorepo's own (private) version, not the manifest that is actually
 * installed and versioned as this Claude Code plugin. This is the "which
 * plugin build produced this decision" GateDecisionRecord.pluginVersion
 * documents (src/core/gate_measurement.ts), read here at the adapter layer
 * so that module stays free of I/O -- never in src/core.
 *
 * Read once at module load and cached, same reasoning as PLATFORM/HOME_
 * PATHS above: it cannot change while this process is running. Best-effort,
 * same fail-open discipline as every other read in this file: a missing or
 * malformed manifest must never block or delay a verdict -- it simply
 * leaves pluginVersion off the record, exactly like a record written before
 * this field existed (see buildGateDecisionRecord's conditional spread).
 */
function readPluginVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'orca-plugin.json'), 'utf8')) as { readonly version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}
const PLUGIN_VERSION = readPluginVersion()

/**
 * Which of the SHIPPED policies are `"process"` scoped (see decisions.ts's
 * PolicyScope), for resolvePolicyScope's fallback when a stored row omits
 * its own `scope` -- see filterPoliciesForCommandScope below. Read once at
 * module load, same reasoning and same fail-open discipline as
 * readPluginVersion above: a missing or unreadable seed file yields an
 * empty index, which makes every unscoped stored row resolve to `"command"`
 * -- today's behavior, unchanged. This never lowers protection (no rule
 * that used to ask starts allowing silently); the worst case is simply that
 * the one bug T2 exists to fix (a process policy still gating an individual
 * command) is not fixed on a machine whose own plugin install is broken in
 * an unrelated way.
 */
function readSeedScopeById(): ReadonlyMap<string, PolicyScope> {
  try {
    const parsed = JSON.parse(readFileSync(SEED_POLICIES_PATH, 'utf8'))
    return buildSeedScopeIndex(parseSeedPolicies(parsed))
  } catch {
    return new Map()
  }
}
const SEED_SCOPE_BY_ID = readSeedScopeById()

/** Appends one measurement record. Best-effort, same as the auth-warned marker: a log that cannot be written is never a reason to block or delay a verdict. */
function appendGateRecord(cwd: string, command: string, source: GateSource, verdict: GateVerdict, latencyMs: number | null, stopReason: GateStopReason, policyId: string | null): void {
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
      stopReason,
      ...(policyId !== null ? { policyId } : {}),
      // BuildGateDecisionRecordInput declares this required -- true for
      // every caller that already knows its own build's version. This is
      // the one caller that resolves it from disk, so it stays honest about
      // the read possibly failing rather than forcing a fake version string.
      pluginVersion: PLUGIN_VERSION,
    })
    appendFileSync(GATE_LOG_PATH, serializeGateRecord(record), 'utf8')
  } catch {
    // Best-effort measurement; never blocks or delays a verdict.
  }
}

/** Best-effort read; a missing, unreadable or malformed config is read as "off" -- see src/core/ab_benchmark_config.ts's own fail-open contract. */
function readAbBenchmarkConfig() {
  try {
    return parseAbBenchmarkConfig(readFileSync(AB_BENCHMARK_CONFIG_PATH, 'utf8'))
  } catch {
    return parseAbBenchmarkConfig('')
  }
}

/** How many samples this queue already holds for `today` (UTC date), so the daily cap means "today", not "ever". */
function samplesQueuedToday(today: string): number {
  try {
    const entries = parseSampleEntries(readFileSync(AB_BENCHMARK_QUEUE_PATH, 'utf8'))
    return entries.filter((e) => e.at.startsWith(today)).length
  } catch {
    return 0
  }
}

/**
 * Samples this real Jev decision for the AB benchmark, out of band: a
 * probabilistic, config-gated, best-effort append to a queue file, with NO
 * network call and NO added latency -- see src/core/ab_benchmark.ts's own
 * module note for the full design and adapters/cli/ab_benchmark_cli.ts for
 * what later drains this queue and asks the large model the same
 * family-level question.
 *
 * Never the raw command, same discipline as appendPendingApproval above:
 * only commandFamily and the matched destination's coarse `kind` (never its
 * label, id or path) are persisted, plus Jev's own verdict/latency/tokens --
 * already known here, so this never triggers a second Jev call.
 */
function appendAbBenchmarkSample(
  command: string,
  verdict: GateLikeVerdict,
  latencyMs: number,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  destinationKind: string | null,
): void {
  try {
    const config = readAbBenchmarkConfig()
    if (!config.enabled) return
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    if (!shouldSample(config, samplesQueuedToday(today), Math.random())) return
    const entry: AbSampleEntry = {
      id: randomUUID(),
      at: now.toISOString(),
      commandFamily: commandFamily(command),
      destinationKind,
      jevVerdict: verdict,
      jevLatencyMs: latencyMs,
      jevInputTokens: usage.inputTokens,
      jevOutputTokens: usage.outputTokens,
    }
    mkdirSync(dirname(AB_BENCHMARK_QUEUE_PATH), { recursive: true })
    appendFileSync(AB_BENCHMARK_QUEUE_PATH, serializeSampleEntry(entry), 'utf8')
  } catch {
    // Best-effort sampling; never blocks or delays a verdict.
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
  | {
      readonly kind: 'verdict'
      readonly decision: Decision
      readonly reason: string
      readonly axes: GateAxes
      readonly destinationId: string | null
      /** The matched destination's catalog `kind` (never its label, id or path) -- coarse enough for the AB benchmark to persist. Null when no destination matched. */
      readonly destinationKind: string | null
      /** Jev's own token usage for this call -- carried out so the AB benchmark can record it for free, with no second Jev call. */
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
      /** The policy that resolved this verdict, or null when the risk stage decided (or no policy matched). See decisions.ts's GateActionResult.policyId. */
      readonly policyId: string | null
    }
  | { readonly kind: 'auth-rejected'; readonly status: number }
  | { readonly kind: 'none' }

/**
 * Calls Jev (src/core) and translates the verdict into the hook's decision.
 * Never throws.
 *
 * Also resolves the cwd against the (optional) catalog mirror --
 * matchDestinationForCwd (linked_worktree.ts) tries cwd directly first, then
 * falls back to its linked git worktree's main checkout when cwd itself has
 * no match, because Orca creates a worktree NEXT TO its main checkout
 * (JEVADV-3) -- then filters the (optional) policies mirror down to
 * whatever applies at the matched destination, and then to whatever is
 * `"command"` scoped (see filterPoliciesForCommandScope, decisions.ts) -- a
 * `"process"` policy
 * (e.g. "screenshots get looked at before being called done") describes how
 * the agent works across many commands, not something a single command's
 * text can honestly be judged against, so it must never reach the coverage
 * question at all. When at least one policy survives both filters, its two
 * extra policy-stage questions fold into the SAME callJev call the gate
 * already makes (no second network round trip). decideGateAction then
 * composes "does a policy already resolve this" with the existing
 * consequence-ceiling risk rule, substituting the matched destination's own
 * ceiling override when its catalog entry carries one.
 */
async function askJev(apiKey: string, command: string, context: string, cwd: string): Promise<JevOutcome> {
  try {
    const catalog = readCatalogMirror()
    const policies = readPoliciesMirror()
    // Only `.destination` (whose rules apply) is needed here -- `.treeRoot`
    // is for command_shape.ts's cache key, computed once in main() below.
    const catalogMatch = catalog !== null ? matchDestinationForCwd(cwd, catalog.destinations) : null
    const matched: MirroredDestination | null = catalogMatch?.destination ?? null
    const filteredPolicies = filterPoliciesForDestination(policies, matched?.id ?? null)
    const commandScopedPolicies = filterPoliciesForCommandScope(filteredPolicies, SEED_SCOPE_BY_ID)

    const questions = {
      ...buildActionGateQuestions(),
      ...(commandScopedPolicies.length > 0 ? buildPolicyQuestions(commandScopedPolicies) : {}),
    }
    const destination = matched !== null ? { label: matched.label, kind: matched.kind } : undefined
    const response = await callJev(apiKey, buildActionGateState(command, context, destination), questions, { budgetMs: BUDGET_MS })
    const gate = decideGateAction({
      action: command,
      policies: commandScopedPolicies,
      answers: response.answers,
      consequenceCeiling: matched?.autonomy?.consequenceCeiling,
      noDestinationMatched: matched === null,
    })
    const reason = gate.reasons.length > 0 ? gate.reasons.map(resolveGateActionReason).join(' · ') : t('reason.allowClear')
    return {
      kind: 'verdict',
      decision: gate.verdict,
      reason,
      axes: gate.axes,
      destinationId: matched?.id ?? null,
      destinationKind: matched?.kind ?? null,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      policyId: gate.policyId,
    }
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
  // Naming one of these is not running it. Measured live: searching this
  // repository's own source for a rule's phrase was refused as if the
  // command were that rule. Under `ask` it cost a click; under `deny` it
  // would leave an agent unable to search the code it is working on. A
  // mention skips tier 1b and is judged by the ordinary path instead -- it
  // is not waved through.
  // A heredoc body is data handed to a program on stdin, not a command line,
  // so the rules look at what is left after removing it. Writing a file whose
  // CONTENT describes one of these rules used to be refused as if the rule
  // were being run -- which refused the author of this very comment. A body
  // read by a shell keeps its text, because there it really is commands.
  const inspected = withoutHeredocBodies(command)
  const mentionOnly = mentionsRatherThanRuns(inspected)
  for (const { pattern, why, denyToggle, scope } of NEVER_SILENTLY) {
    if (mentionOnly) break
    if (scope === 'segment' ? someSegmentMatches(inspected, pattern) : pattern.test(inspected)) {
      // Every rule denies unless its switch was deliberately turned off, in
      // which case it drops to 'ask' -- never to 'allow'. readDenyTierConfig()
      // fails CLOSED, so an unreadable config denies exactly as a fresh
      // install does.
      const decision: Decision = readDenyTierConfig()[denyToggle] ? 'deny' : 'ask'
      appendGateRecord(cwd, command, 'local-rule', decision, null, 'local-rule', null)
      // Recorded like any other stop, with no scores: a local rule needs no
      // model and no threshold, so there is nothing here to calibrate -- but
      // whether the person accepted the interruption is still worth knowing.
      appendPendingApproval(toolUseId, cwd, command, null, null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING, 'local-rule', null)
      // A refusal is read by the MODEL and an ask is read by a PERSON, so
      // they resolve in different languages on purpose: the ask follows the
      // developer's chosen locale, the refusal is always English, including
      // the interpolated reason. Half-translating it -- an English sentence
      // carrying a Spanish clause -- would be worse than either.
      if (decision === 'deny') {
        emit(decision, tEnglish('localRuleDeny', { why: tEnglish(why) }))
      } else {
        emit(decision, t('localRule', { why: t(why) }))
      }
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
  //
  // `.treeRoot`, not `.destination.worktreePath`, is what commandShape needs
  // as its in-tree/out-of-tree boundary: for a linked worktree resolved
  // through its main checkout (JEVADV-3), those two differ on purpose --
  // `.destination` is the main checkout, whose policies and ceiling apply,
  // but the main checkout is a SIBLING of cwd's own worktree, never an
  // ancestor of it. Using it as treeRoot would classify an ordinary in-tree
  // target as out-of-tree (see MatchedDestinationForCwd's own comment,
  // linked_worktree.ts) -- the exact class of bug this project's Windows
  // path audit already fixed once, for a different cause.
  const cachedCatalog = readCatalogMirror()
  const cachedMatch = cachedCatalog !== null ? matchDestinationForCwd(cwd, cachedCatalog.destinations) : null
  const key = cacheKey(command, context, cwd, cachedMatch?.destination.id ?? null, cachedMatch?.treeRoot ?? null)
  const cache = key === null ? {} : readCache()
  const hit = key === null ? undefined : cache[key]
  if (hit !== undefined) {
    appendGateRecord(cwd, command, 'cache', hit.decision, null, 'cache', null)
    if (hit.decision !== 'allow') {
      // A cached stop is still a question the person has to answer, so it is
      // recorded -- without scores, which the cache does not keep. The cache
      // entry itself carries no policyId either (see GateCacheEntry): 'cache'
      // is the honest, complete stopReason on its own -- it does not know,
      // and does not claim to know, which sub-reason produced the original
      // verdict it is replaying.
      appendPendingApproval(toolUseId, cwd, command, key, cachedMatch?.destination.id ?? null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING, 'cache', null)
    }
    emit(hit.decision, t('cached', { reason: hit.reason }))
    return
  }

  const jevStartedAt = Date.now()
  const outcome = await askJev(apiKey as string, command, context, cwd)
  const jevLatencyMs = Date.now() - jevStartedAt

  if (outcome.kind === 'none') {
    // The decision is a truthful 'allow' (failing open is correct and must
    // stay); 'none' as the SOURCE is the truthful record of who decided --
    // nobody did. Without this, the log kept filling with 'cache' and
    // 'local-rule' rows and looked healthy while this half of the gate was
    // silently judging nothing. Best-effort, same as every other record.
    appendGateRecord(cwd, command, 'none', 'allow', null, 'unreachable', null)
    const previousUnreachableFailures = readUnreachableFailures()
    const unreachableNotice = decideUnreachableNotice(false, previousUnreachableFailures, UNREACHABLE_WARN_THRESHOLD)
    if (unreachableNotice.nextConsecutiveFailures !== previousUnreachableFailures) writeUnreachableFailures(unreachableNotice.nextConsecutiveFailures)
    if (unreachableNotice.shouldWarn) passThroughWithNotice(t('jevUnreachable'))
    passThrough()
  }

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
  // Same reset for the unreachable-backend counter: a successful Jev
  // answer means the backend was reached, so a later run of failures earns
  // a fresh warning instead of a stale marker keeping the gate silent.
  const previousUnreachableFailures = readUnreachableFailures()
  if (previousUnreachableFailures !== 0) writeUnreachableFailures(decideUnreachableNotice(true, previousUnreachableFailures, UNREACHABLE_WARN_THRESHOLD).nextConsecutiveFailures)

  const resolved = outcome as Extract<JevOutcome, { kind: 'verdict' }>
  if (key !== null) {
    cache[key] = { decision: resolved.decision, reason: resolved.reason, at: Date.now() }
    writeCache(cache)
  }
  // A jev-sourced verdict was decided by a policy when decideGateAction's
  // own policyId is non-null (see decisions.ts's GateActionResult.policyId);
  // otherwise the consequence-ceiling risk rule decided it, including a
  // clean 'allow'.
  const jevStopReason: GateStopReason = resolved.policyId !== null ? 'policy' : 'risk'
  appendGateRecord(cwd, command, 'jev', resolved.decision, jevLatencyMs, jevStopReason, resolved.policyId)
  // AB benchmark: 'deny' never reaches here -- decideGateAction's Jev-sourced
  // verdict is always allow/ask (GateVerdict, decisions.ts) -- but the guard
  // is kept explicit rather than trusting the cast, matching this file's own
  // fail-open discipline: an unexpected value is skipped, never forced into
  // the sample's narrower type.
  if (resolved.decision === 'allow' || resolved.decision === 'ask') {
    appendAbBenchmarkSample(command, resolved.decision, jevLatencyMs, resolved.usage, resolved.destinationKind)
  }
  // Only a stop becomes a question worth an answer. A pass was never asked
  // about, so recording it would bury the handful of real decisions under
  // hundreds of non-events.
  if (resolved.decision !== 'allow') {
    appendPendingApproval(
      toolUseId, cwd, command, key, resolved.destinationId,
      { reversible: resolved.axes?.reversible ?? null, external: resolved.axes?.external ?? null, consequence: resolved.axes?.consequence ?? null },
      resolved.axes?.ceiling ?? GATE_CONSEQUENCE_CEILING,
      jevStopReason, resolved.policyId,
    )
  }
  emit(resolved.decision, resolved.reason)
}

await main()
