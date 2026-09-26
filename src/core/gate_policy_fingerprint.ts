// Pure fingerprint of what adapters/claude/gate-bash.ts's policy stage would
// judge a command against -- folded into that file's own cacheKey() so a
// cached verdict cannot keep replaying once a POLICY changes underneath it.
//
// The defect this closes (JEVADV-48): the verdict cache key was command
// shape only (plus decisions.ts's own GATE_DECISION_RULES_VERSION -- see
// that constant's doc for why THAT folds in). Nothing about the key
// depended on which policies exist, so an `allow` cached before a team
// added a `requires_human` or `prohibits` policy that covers the same
// command kept being served from the cache for up to gate_cache.ts's own
// GATE_CACHE_TTL_MS (30 days) -- verified on the owner's own machine,
// 2026-09-26: a policy added that day did not take effect until the stale
// entry finally expired.
//
// Takes exactly the inputs gate-bash.ts's askJev path judges against:
// filterPoliciesForDestination and filterPoliciesForCommandScope (both in
// decisions.ts) already narrow a destination's policies down to the ones
// that would actually reach buildPolicyQuestions/decideGateAction for THIS
// command. This function never re-decides that filtering -- it only
// fingerprints what survives it, resolving each survivor's own scope again
// (resolvePolicyScope) so a caller that hands it an unfiltered list still
// gets a correct, if redundant, answer instead of a silently wrong one.
import { migratePolicyKind, resolvePolicyScope } from "./decisions.ts";
import type { Policy, PolicyScope } from "./decisions.ts";

export interface GatePolicyFingerprintInput {
  readonly policies: readonly Policy[];
  /** Same id -> scope lookup resolvePolicyScope's own fallback needs -- see buildSeedScopeIndex in decisions.ts. */
  readonly seedScopeById: ReadonlyMap<string, PolicyScope>;
  /**
   * The matched destination's per-destination override of
   * GATE_CONSEQUENCE_CEILING (decideGateAction's own `consequenceCeiling`),
   * or undefined for the global default. Folded in because it can change
   * the RISK stage's verdict for the exact same surviving policies (or
   * none at all) -- see decideGateAction in decisions.ts.
   */
  readonly consequenceCeiling?: number;
}

const FIELD_SEP = "\u0000";
const ROW_SEP = "\u0001";

/**
 * A stable string that changes if and only if what the policy stage would
 * judge this command against changes: a policy's id, its migrated KIND (see
 * migratePolicyKind -- a row still spelled `permite`/`prohibe`/`pregunta`
 * fingerprints identically to its English equivalent, so the one-time
 * worker migration in adapters/orca/main.mjs never invalidates a cache
 * entry it didn't change the MEANING of), its rule text, or its resolved
 * scope; the surviving set as a whole (a policy added or removed); or the
 * consequence ceiling. Input order never matters -- the per-policy tuples
 * are sorted by id before joining.
 *
 * Deliberately not itself a hash: gate-bash.ts's own cacheKey() folds this
 * string into the same sha256 it already computes from the command shape
 * and GATE_DECISION_RULES_VERSION, and a plain string is simpler to assert
 * on in a unit test.
 */
export function gatePolicyFingerprint(input: GatePolicyFingerprintInput): string {
  const rows = input.policies
    .map((policy) => {
      const kind = migratePolicyKind(policy.kind) ?? String(policy.kind);
      const scope = resolvePolicyScope(policy, input.seedScopeById);
      return { id: policy.id, row: [policy.id, kind, policy.rule, scope].join(FIELD_SEP) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => entry.row);
  const ceilingPart = input.consequenceCeiling === undefined ? "" : String(input.consequenceCeiling);
  return [`ceiling:${ceilingPart}`, ...rows].join(ROW_SEP);
}
