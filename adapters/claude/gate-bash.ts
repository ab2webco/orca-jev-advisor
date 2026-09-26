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
import { GATE_CONSEQUENCE_CEILING, GATE_DECISION_RULES_VERSION, buildActionGateQuestions, buildActionGateState, buildPolicyQuestions, buildSeedScopeIndex, decideGateAction, filterPoliciesForCommandScope, filterPoliciesForDestination } from '../../src/core/decisions.ts'
import type { GateActionReason, GateActionResult, Policy, PolicyScope } from '../../src/core/decisions.ts'
import { gatePolicyFingerprint } from '../../src/core/gate_policy_fingerprint.ts'
import { adviceRetryKey, isAdviceRetryFresh, pruneAdviceRetryState } from '../../src/core/gate_advice_retry.ts'
import { composeAdviceText } from '../../src/core/gate_advice_text.ts'
import { resolveRecoverabilityTargets } from '../../src/core/git_recoverability.ts'
import type { GitStatusSets } from '../../src/core/git_recoverability.ts'
import { detectDeployPublish } from '../../src/core/deploy_publish.ts'
import { parseSeedPolicies } from '../../src/core/policy_seed.ts'
import { buildPendingApprovalRecord, serializeApprovalRecord } from '../../src/core/approval_record.ts'
import { commandShape } from '../../src/core/command_shape.ts'
import { ORCA_USER_DATA_ENV, resolveOrcaUserDataDir } from '../../src/core/orca_accounts.ts'
import { activeProfileId, isPluginDisabled, profileDataPath } from '../../src/core/orca_enablement.ts'
import { matchDestinationForCwd } from '../../src/core/linked_worktree.ts'
import { PROTECTED_BRANCH_NAMES } from '../../src/core/push_remote.ts'
import { qualifiesForLocalGitAllow } from '../../src/core/push_own_branch.ts'
import type { LocalGitAllowResult } from '../../src/core/push_own_branch.ts'
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
import { discardsUncommittedWork, someSegmentMatches } from '../../src/core/git_discard.ts'
import { resolvePushRemoteIsLocal } from '../../src/core/push_remote.ts'
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
// The advise-model release's own small state file: one entry per
// sha256(session_id + NUL + command), so an identical retry within the
// window (src/core/gate_advice_retry.ts) passes without a fresh Jev call.
// Never the real ~/.config or ~/.cache paths in a test -- same
// ORCA_SUPERVISOR_CACHE_DIR override every other path in this file honors.
const ADVICE_RETRY_PATH = join(CACHE_DIR, 'gate-advice-retry.json')
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

/**
 * Same as resolveGateActionReason, but always English -- for the advice
 * mechanism's own core reason, which is model-facing text and so must stay
 * in English regardless of the developer's chosen locale (same rule as
 * localRuleDeny/tEnglish above).
 */
function resolveGateActionReasonEnglish(reason: GateActionReason): string {
  if (isDestinationReasonKey(reason.key)) {
    return translateReason(DESTINATION_CATALOG, 'en', { key: reason.key, params: reason.params })
  }
  return translateReason(GATE_CATALOG, 'en', { key: reason.key as GateKey, params: reason.params })
}

/**
 * The REFUSED-style, model-facing message for a `prohibits` policy's own
 * hard stop -- decideGateAction's `verdict: 'deny'` with a non-null
 * `policyId`. Same wording pattern as localRuleDeny (see i18n_gate.ts's own
 * `policyDeny` key): the model is told plainly it cannot run this and must
 * not route around it, naming the policy and its rule rather than a local
 * rule's own catalog description. `gate.reasons` always carries exactly the
 * one `policy.forbidden` rationale entry for this case (see
 * interpretDestinationPolicy in decisions.ts); a missing `rule` param
 * (never happens in practice) falls back to the empty string rather than
 * throwing -- this text must never be the reason a stop fails to emit.
 */
function policyDenyReasonEnglish(gate: GateActionResult): string {
  const rule = gate.reasons.find((r) => r.key === 'policy.forbidden')?.params?.rule ?? ''
  return tEnglish('policyDeny', { policyId: gate.policyId ?? '', rule })
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
 * resetClean's raw-text-over-SCANNED-segment check (T10, JEVADV-28): read
 * through someSegmentMatches, so it only ever sees a segment reduced to the
 * text a shell -- or the program that segment names -- would actually treat
 * as a run (see git_discard.ts's module note on the allowlist inversion).
 * It exists for a command that IS parseable but is not shell syntax at all,
 * e.g. `python3 -c "...os.system('git reset --hard')..."` --
 * discardsUncommittedWork's tokenizer only understands shell grammar, so it
 * cannot look inside a Python string, but the string's own text is visible
 * (python3's `-c` argument is a known CODE position, never hidden -- see
 * git_discard.ts's INTERPRETER_CODE_FLAGS) and this pattern only needs to
 * find it there. Allows a flag or two between `reset` and `--hard` (`git
 * reset --quiet --hard`), same as discardsUncommittedWork's own
 * args-not-order reading of --hard.
 */
const RESET_CLEAN_RAW_PATTERN = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/

/**
 * One rule's outcome: `'deny'` means "this rule's pattern matched in command
 * position" (still subject to the rule's own `denyToggle` below); `'code'`
 * (the advise-model release) means "this rule's pattern matched, but ONLY
 * because an ambiguous interpreter-code position was visible" -- the gate
 * cannot tell executed code from data there, so this becomes an advice to
 * the coding model, never a hard stop, whatever the rule's own `denyToggle`
 * says; `'ask'` means "this rule's pattern matched, but ONLY as a mention"
 * -- the NEVER_SILENTLY loop below (JEVADV-37, odd/tasks/release-0.5.1.md)
 * treats that exactly like `null`: it is not a local-rule match at all, and
 * the command falls through to the ordinary Jev path instead of stopping
 * locally; `null` means no match at all. Every non-deny outcome makes the
 * loop move on to the next rule.
 */
type RuleOutcome = 'deny' | 'code' | 'ask' | null

/**
 * What a NEVER_SILENTLY rule's `evaluate` actually needs: the command text
 * (already de-heredoc'd) and the cwd the hook itself was invoked from.
 * `cwd` exists only for pushProtectedRule below (JEVADV-39) -- every other
 * rule ignores it -- but it is threaded through every rule uniformly rather
 * than special-cased, so the array's own shape (`{ evaluate, why,
 * denyToggle }[]`) never has to distinguish "rules that read cwd" from
 * "rules that don't".
 */
interface RuleContext {
  readonly command: string
  readonly cwd: string
}

/**
 * forcePush, pushProtected and resetClean read the command through
 * git_discard.ts's someSegmentMatches (odd/tasks/release-0.5.1.md JEVADV-36):
 * a match in COMMAND POSITION (including a real shell/interpreter wrapper's
 * own command, `$(...)`/backticks, or an interpreter CODE string) resolves
 * to `'deny'`; a match that exists ONLY because a quoted argument of some
 * OTHER, non-executing program stayed visible resolves to `'ask'` instead --
 * a MENTION, which the NEVER_SILENTLY loop below (JEVADV-37) routes to the
 * ordinary Jev path rather than stopping locally to ask a person who may not
 * be there to answer. See someSegmentMatches' own doc comment
 * (src/core/git_discard.ts) for exactly how the two scan passes decide this.
 */
function segmentRule(pattern: { test(segment: string): boolean }): (ctx: RuleContext) => RuleOutcome {
  return (ctx) => someSegmentMatches(ctx.command, pattern)
}

/** A plain whole-command regex, for the six rules with no spanning
 *  quantifier and no two-level model: any match is `'deny'`, never `'ask'`. */
function commandRule(pattern: RegExp): (ctx: RuleContext) => RuleOutcome {
  return (ctx) => (pattern.test(ctx.command) ? 'deny' : null)
}

// Built from push_remote.ts's own PROTECTED_BRANCH_NAMES -- the ONE
// shared/protected-branch list, so this rule and push_own_branch.ts's
// own-branch-push allow (real evidence: the owner's gate log, 2026-09-26) can
// never drift apart into two different notions of "shared".
const PUSH_PROTECTED_PATTERN = new RegExp(`git\\s+push\\b.*\\b(${PROTECTED_BRANCH_NAMES.join('|')})\\b`)

/**
 * pushProtected's own two-level match (segmentRule, same as forcePush above)
 * plus one narrowing step (JEVADV-39, odd/tasks/release-0.5.1.md T-lane-a):
 * a push naming main/master/production is only a shared-branch push once
 * its remote actually resolves to somewhere shared. `git push -u origin
 * main` in a brand-new personal repo whose `origin` is a LOCAL bare
 * directory (or a `file://` URL given directly) is not that -- it downgrades
 * a COMMAND-position match to `null`, not `'ask'`, so it takes the exact
 * same ordinary-Jev-path route a mention already does, never a local stop
 * either way. A MENTION-severity match is untouched: nothing about the
 * remote matters for text that was never actually run.
 *
 * Deliberately narrow: resolvePushRemoteIsLocal (src/core/push_remote.ts)
 * fails CLOSED (returns `false`) on anything it cannot positively resolve
 * without the network -- an unknown remote name, an unreadable config, a
 * GitHub/GitLab/SSH/HTTPS remote -- so every one of those keeps today's
 * `'deny'` exactly as before. Force push stays denied everywhere, including
 * to a local remote: that is forcePush's own rule above, untouched by this.
 */
function pushProtectedRule(ctx: RuleContext): RuleOutcome {
  const outcome = someSegmentMatches(ctx.command, PUSH_PROTECTED_PATTERN)
  if (outcome !== 'deny') return outcome
  if (resolvePushRemoteIsLocal({ command: ctx.command, cwd: ctx.cwd })) return null
  return 'deny'
}

/**
 * `git reset --hard` and `git clean -f` throw away uncommitted work with no
 * reflog behind them -- the closest call of the nine, since the blast
 * radius is one working tree. The same loss through `git checkout --
 * <path>`, `git checkout .`, `git checkout -f` or `git restore <path>`: the
 * working tree is overwritten and uncommitted changes are gone. This form
 * discarded an agent's work in a real session while reset/clean did not
 * know it. A branch switch, `-b`/`-B`, `git switch` and `git restore
 * --staged` are not matched -- see src/core/git_discard.ts for each reason.
 * All four subcommands share `rule.resetClean` on purpose: that text
 * ("discards uncommitted work -- nothing to recover it from") names the
 * effect, not the command.
 *
 * discardsUncommittedWork already segments the command on its own and
 * extracts `$(...)`/backticks/`bash -c`/`eval` first, so this reads the
 * WHOLE command, never a pre-split segment -- pre-splitting here would
 * break its substitution extraction. Until T8 (odd/tasks/release-0.5.1.md,
 * JEVADV-24) reset/clean were matched by their OWN separate, quote-blind
 * regex here -- a `printf` whose double-quoted argument merely SPELLED OUT
 * `git reset --hard` was refused as if that command had run. Folding
 * reset/clean into discardsUncommittedWork's tokenizer fixed that, and T10
 * (JEVADV-28) added someSegmentMatches(RESET_CLEAN_RAW_PATTERN) as a second
 * check reading each segment through the SAME visibility rules forcePush/
 * pushProtected already use, so a command spelled out through a non-shell
 * interpreter is still caught even though discardsUncommittedWork's
 * tokenizer, which only understands real shell syntax, cannot see into it.
 *
 * There used to be a THIRD disjunct here -- `cannotScanWithConfidence(command)
 * && RESET_CLEAN_FALLBACK_PATTERN.test(command)`, a second, quote-blind
 * regex kept as an explicit fallback for the one input someSegmentMatches'
 * own scan cannot parse with confidence (an unbalanced quote). It is
 * removed (odd/tasks/release-0.5.1.md JEVADV-36, review-3 follow-up on
 * this rule's dead-fallback question): someSegmentMatches now performs that
 * exact fallback ITSELF, per segment, matching the raw segment text and
 * resolving it to 'deny' whenever its own scan fails -- see its doc comment
 * in src/core/git_discard.ts. A second copy of the same fallback, gated on
 * `cannotScanWithConfidence` over the WHOLE unsplit command rather than one
 * segment, added no case this one does not already cover, and reading the
 * unsplit command risked the opposite mistake (treating an unrelated
 * segment's own unterminated quote as reason to fall back for a segment
 * that parsed just fine).
 */
function resetCleanRule(ctx: RuleContext): RuleOutcome {
  if (discardsUncommittedWork(ctx.command)) return 'deny'
  return someSegmentMatches(ctx.command, RESET_CLEAN_RAW_PATTERN)
}

/**
 * Tier 1b: the rules that never run unannounced. `why` is a catalog key,
 * resolved at emit time in the panel's chosen language.
 *
 * Every rule carries a `denyToggle`, and every toggle denies by default:
 * `deny` refuses the call and hands the reason to the model, which then picks
 * another approach, while `ask` stops the person and waits. Running with
 * permission prompts off is a deliberate choice that agents should not sit
 * waiting on a human, and an `ask` quietly puts that waiting back. Turning a
 * switch off downgrades that one rule's OWN `'deny'` outcome to `'ask'` --
 * never to `'allow'`, and never touches a rule's own `'ask'` outcome (see
 * the NEVER_SILENTLY loop below: the switch only ever matters once a rule
 * has already decided `'deny'`).
 *
 * Only the agent is refused. The person can always run the command in a
 * terminal, which is what the deny message tells them.
 */
/**
 * A leading `+` on a refspec IS a force push -- `git push origin +main`
 * rewrites main exactly the way `--force`/`-f` would, just scoped to that
 * one ref (git's own `+<src>:<dst>` / bare `+<ref>` forced-update syntax).
 * `(?:^|\s)\+\S` requires the `+` to actually START a token (preceded by
 * whitespace or the beginning of the segment, never mid-word) and to be
 * followed by a non-whitespace character, so a bare `+` alone never matches
 * and this can never fire on an unrelated `+` inside some other argument.
 * Found while building the own-branch-push allow (push_own_branch.ts):
 * this rule's own `(--force|-f)\b` pattern never matched `+feature/x` at
 * all, which is a real gap this closes rather than works around.
 */
const NEVER_SILENTLY: readonly {
  readonly evaluate: (ctx: RuleContext) => RuleOutcome
  readonly why: GateKey
  readonly denyToggle: DenyToggleKey
}[] = [
  // Two-level rules (odd/tasks/release-0.5.1.md JEVADV-36, and the
  // advise-model release): read through someSegmentMatches, which is what
  // can return 'code' or 'ask' as well as 'deny' -- see segmentRule's own
  // doc comment above. A leading `--force` NOT followed by `-with-lease`/
  // `-if-includes`: a `--force-with-lease` rebase against your OWN,
  // non-shared branch is normal rebase flow (pushProtectedRule below still
  // catches one aimed at a shared branch), and plain `--force`/`-f`/a
  // `+refspec` are unaffected.
  { evaluate: segmentRule(/git\s+push\b.*(?:(?:--force(?!-with-lease|-if-includes)\b|-f\b)|(?:^|\s)\+\S)/), why: 'rule.forcePush', denyToggle: 'denyForcePush' },
  { evaluate: pushProtectedRule, why: 'rule.pushProtected', denyToggle: 'denyPushProtected' },
  // Irrecoverable, and beyond any repo: the whole home directory or the
  // filesystem root. Segment-scoped (odd/tasks, the advise-model release):
  // a phrase inside a grep pattern, a quoted argument or a heredoc body is
  // data, not a command -- the same mention-vs-command treatment forcePush/
  // pushProtected/resetClean already had.
  { evaluate: segmentRule(/rm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/), why: 'rule.rmRf', denyToggle: 'denyRmRf' },
  { evaluate: resetCleanRule, why: 'rule.resetClean', denyToggle: 'denyResetClean' },
  // Irrecoverable without a backup nobody can assume exists. `DROP TABLE`
  // inside a `psql -c`/`mysql -e` argument is unambiguous SQL execution, not
  // ambiguous interpreter code -- see git_discard.ts's SQL_EXEC_FLAGS -- so
  // it keeps denying outright, never softening to 'code'/advice.
  { evaluate: segmentRule(/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i), why: 'rule.dropTable', denyToggle: 'denyDropTable' },
  { evaluate: segmentRule(/kubectl\s+(delete|drain)\b/), why: 'rule.kubectlDelete', denyToggle: 'denyKubectlDelete' },
  { evaluate: segmentRule(/\b(terraform|tofu)\s+apply\b/), why: 'rule.terraformApply', denyToggle: 'denyTerraformApply' },
  { evaluate: segmentRule(/\b(terraform|tofu)\s+destroy\b/), why: 'rule.terraformDestroy', denyToggle: 'denyTerraformDestroy' },
  // This rule matches ACROSS a pipe by design -- the whole point is
  // catching a curl piped into a shell -- so it stays a plain whole-command
  // regex, never someSegmentMatches (which would silently disable it: a
  // segment split on `|` would separate the curl from the shell it feeds).
  { evaluate: commandRule(/curl[^|]*\|\s*(bash|sh|zsh)\b/), why: 'rule.curlPipeShell', denyToggle: 'denyCurlPipeShell' },
]

type HookInput = { readonly command: string; readonly cwd: string; readonly toolUseId: string | null; readonly sessionId: string | null }

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
  // The advise-model release's retry pass keys on this: a missing session_id
  // means no retry pass at all (conservative) -- see gate_advice_retry.ts's
  // own module note and this file's own checkAdviceRetryPass.
  const rawSessionId = record['session_id']
  const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : null
  return { command, cwd, toolUseId, sessionId }
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
 *
 * The hashed material is prefixed with decisions.ts's own
 * GATE_DECISION_RULES_VERSION, not just the shape -- see that constant's
 * own comment (review-3ca73b9da09b0927, R3/R4 on JEVADV-26/T3). Without it,
 * an `allow` cached before a decision-rule change (e.g. CONSEQUENCE_NOISE_
 * MARGIN's introduction) keeps replaying after the upgrade, for a command
 * the NEW rules would no longer silently allow -- an older entry now simply
 * misses instead of being trusted across a rule change it never saw.
 *
 * JEVADV-48: the hashed material also carries
 * gatePolicyFingerprint's own fingerprint of `policies` (the same
 * destination/scope-filtered `commandScopedPolicies` askJev judges this
 * command against) and `consequenceCeiling` (the matched destination's own
 * autonomy override, when it has one). Without this, an `allow` cached
 * before a team added a `requires_human`/`prohibits` policy that covers
 * this exact command kept being served from the cache for up to
 * gate_cache.ts's own GATE_CACHE_TTL_MS (30 days) after the policy was
 * added -- verified on the owner's own machine, 2026-09-26. Unchanged
 * policies (including one filtered out for this destination or command
 * scope, or one whose stored `kind` merely got migrated from its legacy
 * Spanish spelling to English) fingerprint identically, so this never
 * costs a hit it didn't have to.
 */
function cacheKey(command: string, context: string, cwd: string, destinationId: string | null, treeRoot: string | null, policies: readonly Policy[], consequenceCeiling: number | undefined): string | null {
  const shape = commandShape(command, { cwd, home: HOME_PATHS.home, destinationId, treeRoot: treeRoot ?? undefined, repoContext: context })
  if (shape === null) return null
  const fingerprint = gatePolicyFingerprint({ policies, seedScopeById: SEED_SCOPE_BY_ID, consequenceCeiling })
  return createHash('sha256').update(`v${GATE_DECISION_RULES_VERSION}:${shape}:${fingerprint}`).digest('hex').slice(0, 24)
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

// ---------------------------------------------------------------------------
// The advise-model release: the advice retry-pass state, and the git-status
// reads that power recoverability naming. Both fail open, same discipline
// as every other read in this file: a missing/unreadable/malformed state
// never blocks anything, it just means the next command is judged fresh.
// ---------------------------------------------------------------------------

function readAdviceRetryState(): Record<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(ADVICE_RETRY_PATH, 'utf8'))
  } catch {
    return {}
  }
  const { fresh, changed } = pruneAdviceRetryState(parsed)
  if (changed) writeAdviceRetryState(fresh)
  return fresh
}

function writeAdviceRetryState(state: Readonly<Record<string, number>>): void {
  try {
    mkdirSync(dirname(ADVICE_RETRY_PATH), { recursive: true })
    writeFileSync(ADVICE_RETRY_PATH, JSON.stringify(state), 'utf8')
  } catch {
    // A retry-pass state that can't be written only costs the next identical
    // retry a fresh advice instead of a pass -- never a reason to block.
  }
}

/**
 * Whether (sessionId, command) already has a fresh advice on record -- an
 * identical retry within the window. `sessionId === null` (missing on the
 * hook's own stdin) always answers false: a missing session_id means no
 * retry pass at all, conservative by design (see gate_advice_retry.ts).
 */
function checkAdviceRetryPass(sessionId: string | null, command: string): boolean {
  if (sessionId === null) return false
  const key = adviceRetryKey(sessionId, command)
  const advisedAt = readAdviceRetryState()[key]
  return advisedAt !== undefined && isAdviceRetryFresh(advisedAt, Date.now())
}

/** Marks that an advice was just issued for (sessionId, command), opening its retry window. A missing session_id writes nothing -- there is nothing to key it by. */
function recordAdviceIssued(sessionId: string | null, command: string): void {
  if (sessionId === null) return
  const state = readAdviceRetryState()
  writeAdviceRetryState({ ...state, [adviceRetryKey(sessionId, command)]: Date.now() })
}

/** The repository root for recoverability resolution, or null when `cwd` is not inside a git repository at all (no recoverability naming, the advice still says what it can). */
function getRepoRootForAdvice(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** Already-fetched git status, read exactly once per advice -- `git status --porcelain --ignored -uall` plus `git ls-files`, the same two calls the validated advice-experiment prototype used (jobs/74914c09/tmp/advice-exp/proto-hook.mjs). Best-effort: any failure yields empty sets, which git_recoverability.ts reads as "nothing to protect" -- never a throw, never a block. */
function getGitStatusSetsForAdvice(repoRoot: string): GitStatusSets {
  const modified = new Set<string>()
  const untracked = new Set<string>()
  const ignored = new Set<string>()
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--ignored', '-uall'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split('\n')) {
      if (line.length === 0) continue
      const code = line.slice(0, 2)
      const path = line.slice(3).trim().replace(/^"|"$/g, '')
      if (code === '??') untracked.add(path)
      else if (code === '!!') ignored.add(path)
      else modified.add(path)
    }
  } catch {
    // Leave sets empty; the caller reads that as "nothing resolved".
  }
  let tracked = new Set<string>()
  try {
    tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter((line) => line.length > 0),
    )
  } catch {
    // Same as above.
  }
  return { modified, untracked, ignored, tracked }
}

/**
 * Composes the full advice, resolving recoverability against the REAL,
 * CURRENT git status -- never a stale, cached one (see gate_cache.ts's own
 * module note on GateCacheDecision's "advise" entry: the shape cache stores
 * only the core English reason, and this is recomputed fresh on every
 * advice, cache hit or not, because the repository's own state can change
 * between two occurrences of the identical command SHAPE).
 */
function buildAdviceForCommand(command: string, cwd: string, reasonsEnglish: readonly string[], sessionEligibleForRetry: boolean) {
  const repoRoot = getRepoRootForAdvice(cwd)
  const recoverability = repoRoot === null ? undefined : resolveRecoverabilityTargets(command, cwd, repoRoot, getGitStatusSetsForAdvice(repoRoot))
  return composeAdviceText({ command, reasons: reasonsEnglish, recoverability, sessionEligibleForRetry })
}

/**
 * Emits an advice: `permissionDecision: 'deny'` (the model is refused THIS
 * attempt, not asked -- Claude Code has no third verb), with a model-facing
 * reason that is never "REFUSED" and always carries the retry clause. The
 * person sees one short, non-blocking line, always -- unlike an ordinary
 * 'allow' this is never silent, because a person who never sees the model
 * changing course cannot tell an advice from the model simply doing
 * something else on its own.
 */
function emitAdvice(effect: string, modelText: string): void {
  const payload = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: modelText },
    systemMessage: t('advisedLine', { effect }),
  }
  process.stdout.write(JSON.stringify(payload))
}

/**
 * Whether an identical retry pass fires for (sessionId, command), and if so,
 * emits it: a truthful, silent 'allow' (recorded stopReason 'advice-retry'),
 * never a fresh Jev call and never a fresh advice composition. Returns
 * whether it fired, so a caller that checked this BEFORE calling Jev at all
 * (main()'s own early check, below) knows to stop right there, and
 * resolveAdviceOutcome (which every advice path still funnels through) can
 * reuse the exact same check for the paths that reach it with no earlier
 * chance to ask -- a local rule's own advice, and a cache-hit replay of a
 * previously-cached 'advise' entry.
 *
 * `source` records what WOULD have been asked, had the pass not fired --
 * 'jev' for the risk-stage/deploy-floor/cache-hit paths, 'local-rule' for a
 * local rule's own toggled-off/interpreter-code advice.
 */
function tryAdviceRetryPass(command: string, cwd: string, sessionId: string | null, source: GateSource, latencyMs: number | null = null): boolean {
  if (!checkAdviceRetryPass(sessionId, command)) return false
  appendGateRecord(cwd, command, source, 'allow', latencyMs, 'advice-retry', null)
  // No visible systemMessage: emit() only shows one for a non-'allow'
  // decision, and a truthful, silent 'allow' is exactly right here -- the
  // person already saw the advice line once, on the original occurrence.
  emit('allow', 'Jev: identical retry within the advice window; proceeding.')
  return true
}

/**
 * The single choke point every advice path (the risk stage, fresh or
 * replayed from the shape cache; a local rule whose deny-tier switch is
 * off; an interpreter-code-only local-rule match) resolves through: the
 * retry pass is checked FIRST, so an identical retry always passes
 * regardless of which path produced the ORIGINAL advice, and only a fresh
 * (non-retry) occurrence ever composes and shows the advice text.
 *
 * By the time either of THIS function's own callers reaches it, main()'s own
 * early check (tryAdviceRetryPass, called before any Jev call -- see below)
 * has already run and found no pass; this call is therefore never redundant
 * with it -- it covers the two paths that never go anywhere NEAR that early
 * check at all: a local rule's own advice (decided before Jev is even
 * considered) and a cache-hit replay of a previously-cached 'advise' entry
 * (which also never calls Jev).
 */
function resolveAdviceOutcome(input: {
  readonly command: string
  readonly cwd: string
  readonly sessionId: string | null
  readonly toolUseId: string | null
  readonly reasonsEnglish: readonly string[]
  readonly source: GateSource
  readonly stopReason: GateStopReason
  readonly latencyMs?: number | null
}): void {
  const { command, cwd, sessionId, reasonsEnglish, source, stopReason } = input
  if (tryAdviceRetryPass(command, cwd, sessionId, source, input.latencyMs ?? null)) return
  const sessionEligible = sessionId !== null
  const advice = buildAdviceForCommand(command, cwd, reasonsEnglish, sessionEligible)
  appendGateRecord(cwd, command, source, 'advise', input.latencyMs ?? null, stopReason, null)
  recordAdviceIssued(sessionId, command)
  emitAdvice(advice.effectSummary, advice.modelText)
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
 * Which of the SHIPPED policies are `"process"` or `"local-rule"` scoped
 * (see decisions.ts's PolicyScope), for resolvePolicyScope's fallback when a
 * stored row omits its own `scope` -- see filterPoliciesForCommandScope
 * below. Read once at module load, same reasoning and same fail-open
 * discipline as readPluginVersion above: a missing or unreadable seed file
 * yields an empty index, which makes every unscoped stored row resolve to
 * `"command"` -- today's behavior, unchanged. This never lowers protection
 * (no rule that used to ask starts allowing silently); the worst case is
 * simply that the bugs T2 (a process policy gating an individual command)
 * and T10/JEVADV-28 (a local-rule policy asked about instead of being
 * refused by the deny tier that already covers it) are not fixed on a
 * machine whose own plugin install is broken in an unrelated way.
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
      /**
       * True when this 'allow' happened because the command already
       * structurally qualified for the local-only allow (own-branch push /
       * guarded git delete -- push_own_branch.ts's qualifiesForLocalGitAllow)
       * and no policy stopped it (Option D, see decisions.ts's
       * DecideGateActionInput.localAllowQualifies). The risk axes never
       * decided this verdict; `reason` is already this feature's own local
       * text, never a risk-derived one. Always false when the command did
       * not so qualify.
       */
      readonly viaLocalAllow: boolean
      /**
       * True when this Jev-sourced 'ask' is the RISK stage's own ask (no
       * policy resolved it -- policyId is null, and it is not an Option D
       * local allow) -- the advise-model release's own trigger: this
       * becomes an ADVICE to the coding model, not a human ask. A policy's
       * own requires_human/prohibits ask (policyId non-null) keeps
       * isRiskAdvice false and stays a human ask, unchanged.
       */
      readonly isRiskAdvice: boolean
      /** The risk stage's own reasons, resolved in ENGLISH -- only meaningful when isRiskAdvice is true; empty otherwise. */
      readonly riskAdviceReasonsEnglish: readonly string[]
      /**
       * Part 3(b)'s own local floor: non-null only when `decision` is
       * 'allow' AND src/core/deploy_publish.ts detected this command as a
       * deploy/publish action -- names it, so the caller floors what would
       * otherwise be a silent allow into an advice instead. Null in every
       * other case, including every non-'allow' decision.
       */
      readonly deployPublishAdvice: string | null
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
 * `"process"` policy (e.g. "screenshots get looked at before being called
 * done") describes how the agent works across many commands, not something a
 * single command's text can honestly be judged against, and a `"local-rule"`
 * policy (no_force_push, discard_uncommitted_work) is already enforced by
 * one of this file's own NEVER_SILENTLY rules before this function ever
 * runs, so a real instance never reaches here at all -- neither must ever
 * reach the coverage question. When at least one policy survives both, its two
 * extra policy-stage questions fold into the SAME callJev call the gate
 * already makes (no second network round trip). decideGateAction then
 * composes "does a policy already resolve this" with the existing
 * consequence-ceiling risk rule, substituting the matched destination's own
 * ceiling override when its catalog entry carries one.
 *
 * `localGitAllow` is Option D's own contribution (odd/tasks/
 * release-0.5.1-push-own-branch.md's follow-up): when the command already
 * structurally qualifies for the local-only allow AND at least one
 * command-scoped policy survives filtering (the ONLY reason this function
 * gets called for a qualifying command at all -- see main()'s own
 * short-circuit for the no-policies case), `localAllowQualifies` tells
 * decideGateAction to let the policy stage's coverage question keep
 * deciding while the risk axes never do. `qualifies: false` (the ordinary
 * case) changes nothing here.
 */
async function askJev(apiKey: string, command: string, context: string, cwd: string, localGitAllow: LocalGitAllowResult): Promise<JevOutcome> {
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
    // The advise-model release, Part 3(a): a local, no-network fact ("this
    // triggers a deployment workflow", "this publishes a package") is fed
    // into the SAME state both the policy and risk questions read from, so
    // a destination policy (client_always_asks, ...) can recognise it too --
    // see decisions.ts's own doc on buildActionGateState's deployPublishSignal.
    const deployPublish = detectDeployPublish(command)
    const response = await callJev(apiKey, buildActionGateState(command, context, destination, deployPublish?.description), questions, { budgetMs: BUDGET_MS })
    const gate = decideGateAction({
      action: command,
      policies: commandScopedPolicies,
      answers: response.answers,
      consequenceCeiling: matched?.autonomy?.consequenceCeiling,
      noDestinationMatched: matched === null,
      localAllowQualifies: localGitAllow.qualifies,
    })
    // Option D: no policy stopped it (policyId null) and the command
    // already structurally qualified -- decideGateAction's own verdict is
    // unconditionally 'allow' here, and gate-bash.ts's own local reason
    // text is shown, never a risk-derived one (there may not even be one:
    // decideGateAction returns empty reasons for this case).
    const viaLocalAllow = localGitAllow.qualifies && gate.verdict === 'allow' && gate.policyId === null
    // The advise-model release: a 'ask' that no policy resolved (policyId
    // null) IS the risk stage's own ask -- viaLocalAllow already implies
    // 'allow', so the two conditions never overlap.
    const isRiskAdvice = gate.verdict === 'ask' && gate.policyId === null
    // A `prohibits` policy match: decideGateAction's own hard stop
    // (verdict 'deny', policyId non-null -- the risk stage never produces
    // 'deny' on its own). Model-facing REFUSED text, always English, never
    // the locale-resolved `policy.forbidden` string a person would read.
    const isPolicyDeny = gate.verdict === 'deny' && gate.policyId !== null
    const reason = viaLocalAllow
      ? t(localGitAllow.reasonKind === 'guardedGitDelete' ? 'reason.guardedGitDelete' : 'reason.ownBranchPush')
      : isPolicyDeny
        ? policyDenyReasonEnglish(gate)
        : gate.reasons.length > 0 ? gate.reasons.map(resolveGateActionReason).join(' · ') : t('reason.allowClear')
    return {
      kind: 'verdict',
      decision: gate.verdict,
      reason,
      axes: gate.axes,
      destinationId: matched?.id ?? null,
      destinationKind: matched?.kind ?? null,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      policyId: gate.policyId,
      viaLocalAllow,
      isRiskAdvice,
      riskAdviceReasonsEnglish: isRiskAdvice ? gate.reasons.map(resolveGateActionReasonEnglish) : [],
      // Part 3(b): a command this local floor recognises as a deploy/publish
      // action must never resolve to a SILENT allow -- named here whenever
      // the final verdict would otherwise be exactly that, whatever decided
      // it (the risk stage's own clean pass, Option D, or even a policy that
      // permits it outright). Null whenever the verdict is anything but
      // 'allow', or no such command was detected at all.
      deployPublishAdvice: gate.verdict === 'allow' && deployPublish !== null ? deployPublish.description : null,
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
  const { command, cwd, toolUseId, sessionId } = input as HookInput

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
  // Every rule is evaluated before anything is emitted: an 'ask' from one
  // rule (a rule whose switch is off) must never hide a command-position run
  // that a LATER rule denies in the same command (review finding
  // R3-ask-short-circuits-later-deny). A deny with its switch on wins
  // outright; otherwise the first downgraded-to-ask rule found speaks.
  let firstAdvice: { readonly why: GateKey; readonly kind: 'code' | 'toggle-off' } | null = null
  for (const { evaluate, why, denyToggle } of NEVER_SILENTLY) {
    if (mentionOnly) break
    const outcome = evaluate({ command: inspected, cwd })
    if (outcome === null) continue
    // JEVADV-37 (odd/tasks/release-0.5.1.md): a MENTION -- a match found
    // only in the "visible" view of an unknown program's quoted argument,
    // someSegmentMatches' own 'ask' severity -- is NOT a local-rule match at
    // all anymore. A local `ask` on a mere mention stalled an unattended
    // agent until a human answered, where 0.5.0 gave a fast refusal;
    // continuing here sends the command to the ordinary Jev path below (a
    // real risk/policy judgment, never a silent allow), exactly the way
    // mentionsRatherThanRuns already routes its own mention verbs (see the
    // `mentionOnly` guard above). A COMMAND-position match is unaffected: it
    // is still 'deny' here, never 'ask'.
    if (outcome === 'ask') continue
    // The advise-model release: a match that exists ONLY because an
    // interpreter-code position was visible (someSegmentMatches' own
    // 'code' severity) is never a hard stop, whatever this rule's own
    // deny-tier toggle says -- the gate genuinely cannot tell executed code
    // from data there (a regex classifier over literal test strings, a
    // script reading such a string from a file -- both real false
    // positives). It becomes an advice, exactly like a toggled-off rule
    // below: the FIRST rule found in NEVER_SILENTLY's own order wins,
    // whether it got there via 'code' or via a toggled-off 'deny'.
    if (outcome === 'code') {
      if (firstAdvice === null) firstAdvice = { why, kind: 'code' }
      continue
    }
    if (readDenyTierConfig()[denyToggle]) {
      appendGateRecord(cwd, command, 'local-rule', 'deny', null, 'local-rule', null)
      appendPendingApproval(toolUseId, cwd, command, null, null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING, 'local-rule', null)
      emit('deny', tEnglish('localRuleDeny', { why: tEnglish(why) }))
      return
    }
    if (firstAdvice === null) firstAdvice = { why, kind: 'toggle-off' }
  }
  if (firstAdvice !== null) {
    const { why, kind } = firstAdvice
    // The advise-model release: a rule that would deny but whose switch was
    // deliberately turned off, or whose only match was an ambiguous
    // interpreter-code position, is now an ADVICE to the coding model --
    // never 'ask' (a person stopped and waiting), never 'allow'.
    // readDenyTierConfig() fails CLOSED, so an unreadable config still
    // denies (above) exactly as a fresh install does. resolveAdviceOutcome
    // checks the retry pass first, same choke point every advice goes
    // through (fresh Jev risk stage included).
    //
    // A 'code' match is phrased as a CONDITIONAL, never asserted as fact:
    // the whole reason this severity exists is that the gate cannot tell
    // whether the text is a real command or merely data (a regex
    // classifier's own literal test string, a script reading such a string
    // from a file) -- stating the rule's effect outright ("force push:
    // rewrites the remote...") would tell the model something the gate does
    // not actually know here. A toggled-off rule carries no such doubt: its
    // match WAS a real command-position run, only the operator's own switch
    // decided not to hard-stop it.
    const reasonEnglish =
      kind === 'code'
        ? `this text appears only inside inline interpreter code, which may be data rather than a command; if it ran, it would: ${tEnglish(why)}`
        : tEnglish(why)
    resolveAdviceOutcome({
      command, cwd, sessionId, toolUseId,
      reasonsEnglish: [reasonEnglish],
      source: 'local-rule', stopReason: 'local-rule',
    })
    return
  }

  // The catalog/policies mirror is read here, once, and reused below for the
  // cache key -- the same reads askJev makes on its own later, but resolving
  // the destination here lets the own-branch-push stage right after this
  // run BEFORE any network call or cache lookup even happens.
  const catalogMirror = readCatalogMirror()
  const catalogMatch = catalogMirror !== null ? matchDestinationForCwd(cwd, catalogMirror.destinations) : null
  const matchedDestination = catalogMatch?.destination ?? null
  const policiesMirror = readPoliciesMirror()
  const commandScopedPolicies = filterPoliciesForCommandScope(filterPoliciesForDestination(policiesMirror, matchedDestination?.id ?? null), SEED_SCOPE_BY_ID)

  // Own-branch-push / guarded-git-delete local allow (Option D, real
  // evidence: the owner's gate log, 2026-09-26): a plain, non-force push of
  // the agent's own non-shared branch, or one of git's own GUARDED
  // delete/worktree operations (a plain `git branch -d`, `git worktree
  // remove` with no `--force`, `git worktree prune`, or `git worktree add`
  // with no `--force`/`-B`), cannot destroy anything on its own -- but the
  // POLICY stage stays fully authoritative: a destination policy
  // (never_write_to_main, client_always_asks, ...) can still stop it, and
  // only Jev's own coverage question can honestly say whether one of them
  // actually covers THIS command. So:
  //
  //   - When no command-scoped policy survives filtering at all, there is
  //     truly nothing for Jev to judge -- allow locally, right here, with no
  //     Jev call and no cache read/write, exactly as before Option D.
  //   - When at least one does, this falls through to the ordinary
  //     apiKey/cache/askJev path below, WITH `localGitAllow` threaded into
  //     askJev: the risk axes never decide for a qualifying command, but the
  //     policy coverage question still does (see decisions.ts's
  //     decideGateAction and its own `localAllowQualifies` option).
  const localGitAllow: LocalGitAllowResult = mentionOnly ? { qualifies: false } : qualifiesForLocalGitAllow({ command, cwd })
  if (localGitAllow.qualifies && commandScopedPolicies.length === 0) {
    appendGateRecord(cwd, command, 'local-rule', 'allow', null, 'local-allow', null)
    emit('allow', t(localGitAllow.reasonKind === 'guardedGitDelete' ? 'reason.guardedGitDelete' : 'reason.ownBranchPush'))
    return
  }

  // The advise-model release: local rules and Option D's own policy-stage
  // authority have both already had their say above -- NEITHER stopped this
  // command, and neither ever writes a retry-pass entry (recordAdviceIssued
  // is only ever called from an advice path). So a fresh entry here can only
  // mean one thing: this exact command, in this exact session, already
  // received a genuine advice within the window -- never a policy ask or a
  // hard stop, which never reach this state at all. Checked BEFORE resolving
  // an API key, before any cache read, and before any Jev call, so a retry
  // costs neither a wasted network round trip nor even the no-key notice
  // machinery below -- true for an uncacheable command shape exactly as much
  // as a cacheable one.
  if (tryAdviceRetryPass(command, cwd, sessionId, 'jev')) return

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
  // catalogMatch/matchedDestination were already resolved above, before the
  // own-branch-push check -- reused here rather than read a second time.
  // commandScopedPolicies (resolved further above, same destination/scope
  // filtering askJev's own path applies) and the matched destination's own
  // ceiling override are what JEVADV-48 folds into the key -- see cacheKey's
  // own doc.
  const key = cacheKey(command, context, cwd, matchedDestination?.id ?? null, catalogMatch?.treeRoot ?? null, commandScopedPolicies, matchedDestination?.autonomy?.consequenceCeiling)
  const cache = key === null ? {} : readCache()
  const hit = key === null ? undefined : cache[key]
  if (hit !== undefined) {
    // An 'advise' hit is never replayed as a canned line: recoverability
    // depends on the CURRENT git status, which the shape-only cache key
    // knows nothing about, and an identical retry must still be checked
    // fresh -- see buildAdviceForCommand/checkAdviceRetryPass's own module
    // notes. hit.reason for an 'advise' entry is the core ENGLISH reason
    // only (gate_cache.ts's own doc on GateCacheDecision), never
    // locale-resolved and never the full composed text.
    if (hit.decision === 'advise') {
      resolveAdviceOutcome({ command, cwd, sessionId, toolUseId, reasonsEnglish: [hit.reason], source: 'cache', stopReason: 'risk' })
      return
    }
    appendGateRecord(cwd, command, 'cache', hit.decision, null, 'cache', null)
    if (hit.decision !== 'allow') {
      // A cached stop is still a question the person has to answer, so it is
      // recorded -- without scores, which the cache does not keep. The cache
      // entry itself carries no policyId either (see GateCacheEntry): 'cache'
      // is the honest, complete stopReason on its own -- it does not know,
      // and does not claim to know, which sub-reason produced the original
      // verdict it is replaying.
      appendPendingApproval(toolUseId, cwd, command, key, matchedDestination?.id ?? null, { reversible: null, external: null, consequence: null }, GATE_CONSEQUENCE_CEILING, 'cache', null)
    }
    emit(hit.decision, t('cached', { reason: hit.reason }))
    return
  }

  const jevStartedAt = Date.now()
  const outcome = await askJev(apiKey as string, command, context, cwd, localGitAllow)
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
  // A jev-sourced verdict was decided by a policy when decideGateAction's
  // own policyId is non-null (see decisions.ts's GateActionResult.policyId);
  // 'local-allow' when Option D's own structural check decided it instead
  // (askJev's own viaLocalAllow -- the risk axes never ran this verdict);
  // otherwise the consequence-ceiling risk rule decided it, including a
  // clean 'allow'.
  const jevStopReason: GateStopReason = resolved.policyId !== null ? 'policy' : resolved.viaLocalAllow ? 'local-allow' : 'risk'
  // AB benchmark: 'deny' never reaches here -- decideGateAction can now
  // return it (a `prohibits` policy's own hard stop), but the AB benchmark
  // never samples that case: its own BigModelVerdict/GateLikeVerdict
  // vocabulary (ab_benchmark.ts) only ever compares allow/ask, and a policy
  // stop is a team's own written rule, not a risk judgment to calibrate
  // against a second model. The guard is kept explicit rather than trusting
  // the cast, matching this file's own fail-open discipline: an unexpected
  // value is skipped, never forced into the sample's narrower type. Sampled
  // on the RAW Jev verdict, always -- whether it then became a human ask or
  // an advice is this file's own presentation choice, not Jev's own
  // judgment, which the benchmark
  // compares against the big model exactly as Jev gave it.
  if (resolved.decision === 'allow' || resolved.decision === 'ask') {
    appendAbBenchmarkSample(command, resolved.decision, jevLatencyMs, resolved.usage, resolved.destinationKind)
  }

  // The advise-model release: the risk stage's own 'ask' (no policy
  // resolved it) is no longer a human ask -- it is an advice to the coding
  // model. Cached as 'advise' (never as a silent 'allow'), with the core
  // ENGLISH reason only -- see gate_cache.ts's own doc on GateCacheDecision
  // and buildAdviceForCommand's own note on why recoverability is always
  // recomputed fresh rather than cached alongside it.
  if (resolved.isRiskAdvice) {
    if (key !== null) {
      cache[key] = { decision: 'advise', reason: resolved.riskAdviceReasonsEnglish.join(' · '), at: Date.now() }
      writeCache(cache)
    }
    resolveAdviceOutcome({
      command, cwd, sessionId, toolUseId,
      reasonsEnglish: resolved.riskAdviceReasonsEnglish,
      source: 'jev', stopReason: 'risk', latencyMs: jevLatencyMs,
    })
    return
  }

  // Part 3(b): a command the local deploy/publish floor recognises must
  // never resolve to a SILENT allow -- reuses the exact same advice choke
  // point as the risk stage's own advice above, cached the same way (as
  // 'advise', never as 'allow'), so a future cache hit for this exact
  // command shape already replays through resolveAdviceOutcome's own
  // cache-hit branch with no special-casing needed there.
  if (resolved.decision === 'allow' && resolved.deployPublishAdvice !== null) {
    if (key !== null) {
      cache[key] = { decision: 'advise', reason: resolved.deployPublishAdvice, at: Date.now() }
      writeCache(cache)
    }
    resolveAdviceOutcome({
      command, cwd, sessionId, toolUseId,
      reasonsEnglish: [resolved.deployPublishAdvice],
      source: 'jev', stopReason: 'risk', latencyMs: jevLatencyMs,
    })
    return
  }

  if (key !== null) {
    cache[key] = { decision: resolved.decision, reason: resolved.reason, at: Date.now() }
    writeCache(cache)
  }
  appendGateRecord(cwd, command, 'jev', resolved.decision, jevLatencyMs, jevStopReason, resolved.policyId)
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
