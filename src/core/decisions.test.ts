// Unit tests for interpretDestinationPolicy -- pure input to pure output,
// no filesystem, no network. Run with:
//   node --test src/core/decisions.test.ts
// (this project has no test runner configured yet; node:test is the
// built-in one, and Node 24's native TypeScript support runs this file
// directly, same as src/core/gate_stats.test.ts already does).
//
// Covers the full kind x match table from the policy fix:
//   permits/requires_human/prohibits, each with a match (>= gate) and a
//   non-match (< gate) -- plus the two coverage-side null paths (no policy
//   covers the action at all, and low-confidence coverage) that also
//   return null regardless of kind or match.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionGateState,
  buildSeedScopeIndex,
  CONSEQUENCE_NOISE_MARGIN,
  decideAction,
  decideGateAction,
  filterPoliciesForCommandScope,
  filterPoliciesForDestination,
  GATE_CONSEQUENCE_CEILING,
  GATE_DECISION_RULES_VERSION,
  interpretDestinationPolicy,
  isPolicyScope,
  resolvePolicyScope,
} from "./decisions.ts";
import type { Policy, PolicyScope } from "./decisions.ts";
import type { Answer, ChoiceAnswer, NoulAnswer, ScoreAnswer } from "./jev.ts";

const ACTION = "do something";

function policies(kind: Policy["kind"]): Policy[] {
  return [{ id: "rule", rule: "a test rule", kind }];
}

function coverageAnswer(choice: string, confidence: number): ChoiceAnswer {
  return { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
}

function matchAnswer(noul: number): NoulAnswer {
  return { type: "noul", noul };
}

function answers(choice: string, confidence: number, match: number): Record<string, Answer> {
  return { coverage: coverageAnswer(choice, confidence), same_kind: matchAnswer(match) };
}

// --- helpers shared by decideAction / decideGateAction tests ---------------

function noulAnswer(value: number): NoulAnswer {
  return { type: "noul", noul: value };
}

function scoreAnswer(value: number): ScoreAnswer {
  return { type: "score", score: value, legend: {}, probabilities: {}, confidence: 1 };
}

function riskAnswers(reversible: number, external: number, consequence: number): Record<string, Answer> {
  return { reversible: noulAnswer(reversible), external: noulAnswer(external), consequence: scoreAnswer(consequence) };
}

function combinedAnswers(
  policy: { choice: string; confidence: number; match: number } | null,
  risk: { reversible: number; external: number; consequence: number },
): Record<string, Answer> {
  return {
    ...(policy ? answers(policy.choice, policy.confidence, policy.match) : {}),
    ...riskAnswers(risk.reversible, risk.external, risk.consequence),
  };
}

// --- kind x match table (6 cells) -----------------------------------------

test("permits + match -> act", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("rule", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "act");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.policyId, "rule");
  assert.equal(decision?.isPolicyGap, false);
});

test("permits + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("rule", 0.9, 0.2));
  assert.equal(decision, null);
});

test("requires_human + match -> ask", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("requires_human"), answers("rule", 0.9, 0.9));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "ask");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.isPolicyGap, false);
});

test("requires_human + no match -> falls through (null)", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("requires_human"), answers("rule", 0.9, 0.1));
  assert.equal(decision, null);
});

test("prohibits + match -> do_not", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("rule", 0.9, 0.95));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "do_not");
  assert.equal(decision?.source, "policy");
  assert.equal(decision?.isPolicyGap, false);
});

test("prohibits + no match -> falls through (null), this is the reported bug's exact shape", () => {
  // This is the shape of the live bug: a permissive policy (here standing
  // in for read_and_test) with a low match score used to produce do_not
  // under the old two-gate logic. With kind-based branching, a non-match
  // on ANY kind -- including prohibits -- must fall through to risk
  // judgment, never resolve to do_not on its own.
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("rule", 0.9, 0.05));
  assert.equal(decision, null);
});

// --- coverage-side null paths (2 cells) ------------------------------------

test("no policy covers the action (coverage = no_policy) -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("prohibits"), answers("no_policy", 0.95, 0.95));
  assert.equal(decision, null);
});

test("low-confidence coverage -> null regardless of match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("rule", 0.5, 0.95));
  assert.equal(decision, null);
});

// --- the exact regression from the diagnosed bug ---------------------------

test("regression: a low match against a PERMISSIVE policy never resolves to do_not", () => {
  // Before the fix, interpretDestinationPolicy had no notion of `kind` and
  // treated every low 'cumple'/'same_kind' value as a violation -- so
  // 'delete the node_modules folder to reinstall', matched to a permits
  // rule (read_and_test) with a low match score, came back do_not. After
  // the fix the same shape of answer set (permits + low match) must fall
  // through to risk judgment (null), never do_not.
  const decision = interpretDestinationPolicy(
    "delete the node_modules folder to reinstall",
    [{ id: "read_and_test", rule: "happens without asking", kind: "permits" }],
    answers("read_and_test", 0.9, 0.3),
  );
  assert.notEqual(decision?.outcome, "do_not");
  assert.equal(decision, null);
});

// --- boundary check on the match gate --------------------------------------

test("match exactly at the gate counts as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("rule", 0.9, 0.7));
  assert.notEqual(decision, null);
  assert.equal(decision?.outcome, "act");
});

test("match just under the gate does not count as a match", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("rule", 0.9, 0.6999));
  assert.equal(decision, null);
});

test("unknown policy id in coverage's choice (not in the provided policies list) -> null", () => {
  const decision = interpretDestinationPolicy(ACTION, policies("permits"), answers("some_other_rule_not_listed", 0.9, 0.9));
  assert.equal(decision, null);
});

// ===========================================================================
// filterPoliciesForDestination
// ===========================================================================

test("filterPoliciesForDestination: a global policy (no destinations field) applies to any destination id, including null", () => {
  const global: Policy = { id: "global", rule: "applies everywhere", kind: "permits" };
  assert.deepEqual(filterPoliciesForDestination([global], "site-a"), [global]);
  assert.deepEqual(filterPoliciesForDestination([global], "site-b"), [global]);
  assert.deepEqual(filterPoliciesForDestination([global], null), [global]);
});

test("filterPoliciesForDestination: an empty destinations array is global too, same as the field being absent", () => {
  const global: Policy = { id: "global-empty", rule: "applies everywhere too", kind: "permits", destinations: [] };
  assert.deepEqual(filterPoliciesForDestination([global], "site-a"), [global]);
  assert.deepEqual(filterPoliciesForDestination([global], null), [global]);
});

test("filterPoliciesForDestination: a scoped policy applies only in its own destination id, not in another", () => {
  const scoped: Policy = { id: "scoped", rule: "only for site-a", kind: "prohibits", destinations: ["site-a"] };
  assert.deepEqual(filterPoliciesForDestination([scoped], "site-a"), [scoped]);
  assert.deepEqual(filterPoliciesForDestination([scoped], "site-b"), []);
});

test("filterPoliciesForDestination: a policy naming an unrecognized destination id doesn't crash and simply doesn't match", () => {
  const scoped: Policy = { id: "scoped", rule: "only for a destination that isn't in the catalog", kind: "prohibits", destinations: ["ghost-destination"] };
  assert.doesNotThrow(() => filterPoliciesForDestination([scoped], "site-a"));
  assert.deepEqual(filterPoliciesForDestination([scoped], "site-a"), []);
});

test("filterPoliciesForDestination: when destinationId is null, scoped policies are excluded but global ones remain", () => {
  const global: Policy = { id: "global", rule: "applies everywhere", kind: "permits" };
  const scoped: Policy = { id: "scoped", rule: "only for site-a", kind: "prohibits", destinations: ["site-a"] };
  assert.deepEqual(filterPoliciesForDestination([global, scoped], null), [global]);
});

// ===========================================================================
// resolvePolicyScope / filterPoliciesForCommandScope / buildSeedScopeIndex
// -- odd/tasks/release-0.5.1.md T2. A "process" policy (e.g. "screenshots
// get looked at before being called done") describes how the agent works
// across many commands, not something a single command's text can be
// judged against -- it must never reach the coverage question at all.
// ===========================================================================

function seedScope(entries: Readonly<Record<string, PolicyScope>>): ReadonlyMap<string, PolicyScope> {
  return new Map(Object.entries(entries));
}

test("resolvePolicyScope: an explicit scope on the row always wins, regardless of the seed", () => {
  assert.equal(resolvePolicyScope({ id: "visual_evidence", scope: "command" }, seedScope({ visual_evidence: "process" })), "command");
  assert.equal(resolvePolicyScope({ id: "own_branch", scope: "process" }, seedScope({})), "process");
});

test("resolvePolicyScope: no explicit scope falls back to the seed's own scope for that same id", () => {
  assert.equal(resolvePolicyScope({ id: "visual_evidence" }, seedScope({ visual_evidence: "process" })), "process");
});

test("resolvePolicyScope: no explicit scope and no seed entry for that id defaults to 'command' -- today's behavior, unchanged, a user rule is never silently dropped", () => {
  assert.equal(resolvePolicyScope({ id: "own_branch" }, seedScope({ visual_evidence: "process" })), "command");
  assert.equal(resolvePolicyScope({ id: "own_branch" }, seedScope({})), "command");
});

test("filterPoliciesForCommandScope: drops a policy that resolves to 'process', keeps the rest", () => {
  const visualEvidence: Policy = { id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits" };
  const ownBranch: Policy = { id: "own_branch", rule: "work goes on a feature branch", kind: "permits" };
  const filtered = filterPoliciesForCommandScope([visualEvidence, ownBranch], seedScope({ visual_evidence: "process" }));
  assert.deepEqual(
    filtered.map((p) => p.id),
    ["own_branch"],
  );
});

test("filterPoliciesForCommandScope: an explicit 'command' scope keeps a policy even if the seed marks it 'process'", () => {
  const visualEvidence: Policy = { id: "visual_evidence", rule: "screenshots get looked at", kind: "prohibits", scope: "command" };
  const filtered = filterPoliciesForCommandScope([visualEvidence], seedScope({ visual_evidence: "process" }));
  assert.deepEqual(
    filtered.map((p) => p.id),
    ["visual_evidence"],
  );
});

test("filterPoliciesForCommandScope: with no seed index and no explicit scope, every policy keeps today's behavior (all 'command')", () => {
  const policies: Policy[] = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "prohibits" },
  ];
  assert.deepEqual(filterPoliciesForCommandScope(policies, seedScope({})).map((p) => p.id), ["a", "b"]);
});

test("buildSeedScopeIndex: only rows with an explicit scope contribute an entry", () => {
  const index = buildSeedScopeIndex([
    { id: "visual_evidence", scope: "process" },
    { id: "own_branch" },
    { id: "unit_commits", scope: "command" },
  ]);
  assert.equal(index.get("visual_evidence"), "process");
  assert.equal(index.get("unit_commits"), "command");
  assert.equal(index.has("own_branch"), false);
});

// ===========================================================================
// PolicyScope's third member -- odd/tasks/release-0.5.1.md T10 (JEVADV-34).
// A policy already enforced by a local deny/ask rule (no_force_push,
// discard_uncommitted_work) is never judged by Jev: a real instance never
// reaches the policy stage at all (gate-bash.ts's NEVER_SILENTLY already
// refused or asked about it), so only a command that merely MENTIONS the
// rule in quoted data would ever reach `coverage`, and Jev cannot honestly
// answer whether that mention is "a concrete instance" of a rule that never
// ran.
// ===========================================================================

test("resolvePolicyScope: an explicit 'local-rule' scope on the row wins, regardless of the seed", () => {
  assert.equal(resolvePolicyScope({ id: "no_force_push", scope: "local-rule" }, seedScope({})), "local-rule");
});

test("resolvePolicyScope: an unrecognised scope value resolves as absent, not as itself", () => {
  // Simulates data that crossed an untyped boundary (JSON.parse) without
  // this module's own validation -- store.ts/gate_catalog_mirror.ts already
  // normalize this at read time (R4), but resolvePolicyScope must not trust
  // a caller that didn't.
  const policy = { id: "own_branch", scope: "sometimes" } as unknown as Pick<Policy, "id" | "scope">;
  assert.equal(resolvePolicyScope(policy, seedScope({})), "command");
  assert.equal(resolvePolicyScope(policy, seedScope({ own_branch: "process" })), "process");
});

test("filterPoliciesForCommandScope: drops a policy that resolves to 'local-rule', keeps the rest", () => {
  const noForcePush: Policy = { id: "no_force_push", rule: "never rewrite remote history", kind: "prohibits" };
  const ownBranch: Policy = { id: "own_branch", rule: "work goes on a feature branch", kind: "permits" };
  const filtered = filterPoliciesForCommandScope([noForcePush, ownBranch], seedScope({ no_force_push: "local-rule" }));
  assert.deepEqual(
    filtered.map((p) => p.id),
    ["own_branch"],
  );
});

test("filterPoliciesForCommandScope: an explicit 'command' scope keeps a policy even if the seed marks it 'local-rule'", () => {
  const noForcePush: Policy = { id: "no_force_push", rule: "never rewrite remote history", kind: "prohibits", scope: "command" };
  const filtered = filterPoliciesForCommandScope([noForcePush], seedScope({ no_force_push: "local-rule" }));
  assert.deepEqual(
    filtered.map((p) => p.id),
    ["no_force_push"],
  );
});

test("isPolicyScope: recognises exactly the three real members, nothing else", () => {
  assert.equal(isPolicyScope("command"), true);
  assert.equal(isPolicyScope("process"), true);
  assert.equal(isPolicyScope("local-rule"), true);
  assert.equal(isPolicyScope("proceso"), false);
  assert.equal(isPolicyScope(undefined), false);
  assert.equal(isPolicyScope(null), false);
  assert.equal(isPolicyScope(3), false);
});

test("buildSeedScopeIndex: an unrecognised scope value is never carried into the map, even if a caller forgot to normalize it first -- JEVADV-36", () => {
  // parseSeedPolicies (policy_seed.ts) now normalizes an invalid `scope` to
  // absent before this ever runs, but this map is a public building block
  // in its own right: it must not blindly trust a caller's claimed
  // `PolicyScope` typing, the same way resolvePolicyScope itself does not
  // trust a row's own `scope` field above.
  const leaked = { id: "own_branch", scope: "proceso" } as unknown as Pick<Policy, "id" | "scope">;
  const byId = buildSeedScopeIndex([leaked]);
  assert.equal(byId.has("own_branch"), false, "an invalid scope value must never reach the map");
});

// ===========================================================================
// decideAction: options.consequenceCeiling override (backward compatible)
// ===========================================================================

test("decideAction: still callable with a single argument, using the global ceiling", () => {
  const highRisk = riskAnswers(0.1, 0.9, 2.5);
  assert.equal(decideAction(highRisk).verdict, "ask");
});

test("decideAction: an explicit per-destination ceiling overrides the global one, in both directions", () => {
  const midRisk = riskAnswers(0.9, 0.1, 1.9); // above the global 1.78 ceiling
  assert.equal(decideAction(midRisk).verdict, "ask");
  // JEVADV-26: 1.9 sits inside a 2.0 ceiling's noise band (2.0 - 0.12 =
  // 1.88), so the override here is 2.1 -- comfortably above 1.9 + the
  // margin -- to keep testing what this case is actually about (the
  // override changing the verdict), not the band itself (covered below).
  assert.equal(decideAction(midRisk, { consequenceCeiling: 2.1 }).verdict, "allow");

  const lowRisk = riskAnswers(0.9, 0.1, 0.5); // below the global ceiling
  assert.equal(decideAction(lowRisk).verdict, "allow");
  assert.equal(decideAction(lowRisk, { consequenceCeiling: 0.1 }).verdict, "ask");
});

// ===========================================================================
// decideAction: CONSEQUENCE_NOISE_MARGIN -- JEVADV-26. A silent allow must
// clear the ceiling by 3σ of Jev's measured repeat-call noise, not just sit
// under it by an arbitrary amount. See CONSEQUENCE_NOISE_MARGIN's own
// module comment in decisions.ts for the measurement behind 0.12.
// ===========================================================================

test("decideAction: consequence exactly at ceiling-margin allows", () => {
  const atMargin = riskAnswers(0.9, 0.1, GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN);
  const result = decideAction(atMargin);
  assert.equal(result.verdict, "allow");
});

test("decideAction: ceiling-margin + 0.01 asks, with the band's own reason key", () => {
  const justInsideBand = riskAnswers(0.9, 0.1, GATE_CONSEQUENCE_CEILING - CONSEQUENCE_NOISE_MARGIN + 0.01);
  const result = decideAction(justInsideBand);
  assert.equal(result.verdict, "ask");
  assert.ok(
    result.reasons.some((r) => r.key === "reason.tooCloseToTheLine"),
    `expected the band's own reason key, got: ${JSON.stringify(result.reasons)}`,
  );
});

test("decideAction: above the ceiling still asks, with today's reason keys -- the band reason is only for the band", () => {
  const aboveCeiling = riskAnswers(0.9, 0.1, 1.9);
  const result = decideAction(aboveCeiling);
  assert.equal(result.verdict, "ask");
  assert.ok(result.reasons.some((r) => r.key === "reason.needsCleanupAfter"));
  assert.equal(result.reasons.some((r) => r.key === "reason.tooCloseToTheLine"), false);
});

test("decideAction: a per-destination ceiling is honoured with the same 0.12 margin", () => {
  const options = { consequenceCeiling: 2.0 };
  const atMargin = riskAnswers(0.9, 0.1, 2.0 - CONSEQUENCE_NOISE_MARGIN);
  assert.equal(decideAction(atMargin, options).verdict, "allow");

  const justInsideBand = riskAnswers(0.9, 0.1, 2.0 - CONSEQUENCE_NOISE_MARGIN + 0.01);
  const inBand = decideAction(justInsideBand, options);
  assert.equal(inBand.verdict, "ask");
  assert.ok(inBand.reasons.some((r) => r.key === "reason.tooCloseToTheLine"));
});

// ===========================================================================
// decideGateAction: policy first, risk fallback, per-destination ceiling
// ===========================================================================

test("decideGateAction: a permits policy can NEVER turn an ask into an allow", () => {
  // Measured against the live API over a labelled corpus, `same_kind` does
  // not separate a policy that genuinely covers a command from one that
  // merely sounds close -- 0.69-0.75 against 0.64-0.72, a band of -0.03. At
  // coverage confidence 1.00, a policy about reading code and running tests
  // waved through `rm -rf dist`. A wrong stop costs a prompt; a wrong pass is
  // how something irreversible happens, so permits never short-circuits risk.
  const permits: Policy = { id: "rule", rule: "a permissive rule", kind: "permits" };
  const highRisk = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.9 }, { reversible: 0.1, external: 0.9, consequence: 2.5 });

  const withoutPolicy = decideGateAction({ action: ACTION, policies: [], answers: highRisk });
  assert.equal(withoutPolicy.verdict, "ask");

  const withPolicy = decideGateAction({ action: ACTION, policies: [permits], answers: highRisk });
  assert.equal(withPolicy.verdict, "ask", "a permissive rule must not overrule the risk judgement");
});

test("decideGateAction: a permits policy leaves an already-safe command alone", () => {
  const permits: Policy = { id: "rule", rule: "a permissive rule", kind: "permits" };
  const safe = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.2 });
  assert.equal(decideGateAction({ action: ACTION, policies: [permits], answers: safe }).verdict, "allow");
});

test("decideGateAction: a prohibits policy match turns what would otherwise be a safe allow into ask", () => {
  const prohibits: Policy = { id: "rule", rule: "a forbidding rule", kind: "prohibits" };
  const safe = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.2 });

  const withoutPolicy = decideGateAction({ action: ACTION, policies: [], answers: safe });
  assert.equal(withoutPolicy.verdict, "allow");

  const withPolicy = decideGateAction({ action: ACTION, policies: [prohibits], answers: safe });
  assert.equal(withPolicy.verdict, "ask");
  assert.deepEqual(withPolicy.reasons, [{ key: "policy.forbidden", params: { policyId: "rule", rule: prohibits.rule } }]);
});

test("decideGateAction: a requires_human policy match also produces ask", () => {
  const requiresHuman: Policy = { id: "rule", rule: "needs a human", kind: "requires_human" };
  const safe = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.2 });

  const result = decideGateAction({ action: ACTION, policies: [requiresHuman], answers: safe });
  assert.equal(result.verdict, "ask");
  assert.deepEqual(result.reasons, [{ key: "policy.needsHuman", params: { policyId: "rule", rule: requiresHuman.rule } }]);
});

test("decideGateAction: no policy match falls through to the consequence-ceiling rule, using the per-destination ceiling when provided and the global one when not", () => {
  const permits: Policy = { id: "rule", rule: "a permissive rule", kind: "permits" };
  // Match is below MATCH_GATE, so interpretDestinationPolicy returns null and this falls through.
  const noMatch = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.2 }, { reversible: 0.9, external: 0.1, consequence: 1.9 });

  const withGlobalCeiling = decideGateAction({ action: ACTION, policies: [permits], answers: noMatch });
  assert.equal(withGlobalCeiling.verdict, "ask");

  // JEVADV-26: 1.9 sits inside a 2.0 ceiling's 0.12 noise band (2.0 - 0.12 =
  // 1.88), so the override is 2.1 here -- see the same note on
  // decideAction's own per-destination-ceiling test above.
  const withDestinationCeiling = decideGateAction({ action: ACTION, policies: [permits], answers: noMatch, consequenceCeiling: 2.1 });
  assert.equal(withDestinationCeiling.verdict, "allow");
});

test("decideGateAction: fail-open is preserved -- incomplete/null answers still allow, even with policies present", () => {
  const prohibits: Policy = { id: "rule", rule: "a forbidding rule", kind: "prohibits" };
  const incomplete: Record<string, Answer> = {};
  const result = decideGateAction({ action: ACTION, policies: [prohibits], answers: incomplete });
  assert.equal(result.verdict, "allow");
});

test("decideGateAction: noDestinationMatched appends a fallback reason only when the risk rule was actually reached", () => {
  const safe = riskAnswers(0.9, 0.1, 0.2);
  const result = decideGateAction({ action: ACTION, policies: [], answers: safe, noDestinationMatched: true });
  assert.equal(result.verdict, "allow");
  assert.ok(result.reasons.some((r) => r.key === "reason.noDestinationMatched"));
});

// odd/tasks/release-0.5.1.md T1: the gate's own measurement log needs to
// record WHICH policy resolved a stop, not just that one did -- previously
// that id was only reachable by parsing GateActionResult.reasons' rationale
// params, which is text meant for a person to read, not a stable field for
// a caller to key off.
test("decideGateAction: a policy stop carries the policy's id on the result, not just inside the rationale text", () => {
  const prohibits: Policy = { id: "client_always_asks", rule: "a forbidding rule", kind: "prohibits" };
  const safe = combinedAnswers({ choice: "client_always_asks", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.2 });
  const result = decideGateAction({ action: ACTION, policies: [prohibits], answers: safe });
  assert.equal(result.policyId, "client_always_asks");
});

test("decideGateAction: a risk-resolved stop carries policyId: null -- no policy settled it", () => {
  const highRisk = riskAnswers(0.1, 0.9, 2.5);
  const result = decideGateAction({ action: ACTION, policies: [], answers: highRisk });
  assert.equal(result.verdict, "ask");
  assert.equal(result.policyId, null);
});

test("decideGateAction: noDestinationMatched is NOT added when a policy resolved the decision", () => {
  // Only a policy that STOPS resolves the decision now; a permissive one
  // falls through to risk, so this is checked with a prohibiting rule.
  const prohibits: Policy = { id: "rule", rule: "a forbidding rule", kind: "prohibits" };
  const match = combinedAnswers({ choice: "rule", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.2 });
  const result = decideGateAction({ action: ACTION, policies: [prohibits], answers: match, noDestinationMatched: true });
  assert.equal(
    result.reasons.some((r) => r.key === "reason.noDestinationMatched"),
    false,
  );
});

// ===========================================================================
// localAllowQualifies -- Option D (push_own_branch.ts's own-branch-push /
// guarded-git-delete local allow). The policy stage stays fully authoritative
// (a requires_human/prohibits match still asks, exactly as above); what
// changes is the RISK stage: for a command gate-bash.ts has already
// determined structurally qualifies for the local allow, the reversible/
// external/consequence axes never decide FOR it -- not even a high
// consequence score turns it into an ask -- once no policy stops it.
// ===========================================================================

test("decideGateAction: localAllowQualifies allows even a high-consequence risk score, once no policy covers it", () => {
  // The owner's real policy set: global requires_human/prohibits policies
  // whose RULES are not about this command at all (never_write_to_main,
  // client_always_asks, infrastructure_changes, ...) -- Jev's own coverage
  // question answers "no_policy" (none of them actually covers a plain
  // push), and the same high-consequence risk answers that would normally
  // ask (see decideAction's own "a permits policy can NEVER turn an ask
  // into an allow" test above, same shape) must not turn this into an ask.
  const ownerLikePolicies: Policy[] = [
    { id: "never_write_to_main", rule: "Never write directly on main or develop.", kind: "prohibits" },
    { id: "client_always_asks", rule: "Anything touching a client is confirmed with a human.", kind: "requires_human" },
    { id: "infrastructure_changes", rule: "Changing real infrastructure is decided by a person.", kind: "requires_human" },
  ];
  const notCovered = combinedAnswers({ choice: "no_policy", confidence: 0.95, match: 0.1 }, { reversible: 0.1, external: 0.9, consequence: 2.5 });

  const withoutLocalAllow = decideGateAction({ action: ACTION, policies: ownerLikePolicies, answers: notCovered });
  assert.equal(withoutLocalAllow.verdict, "ask", "sanity check: this risk score alone would ask");

  const result = decideGateAction({ action: ACTION, policies: ownerLikePolicies, answers: notCovered, localAllowQualifies: true });
  assert.equal(result.verdict, "allow");
  assert.equal(result.policyId, null);
  assert.deepEqual(result.reasons, [], "the local reason text is gate-bash.ts's own concern, not this pure function's");
});

test("decideGateAction: localAllowQualifies still asks when a policy resolves to requires_human", () => {
  const policies: Policy[] = [{ id: "client_always_asks", rule: "Anything touching a client is confirmed with a human.", kind: "requires_human" }];
  const covered = combinedAnswers({ choice: "client_always_asks", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.1 });

  const result = decideGateAction({ action: ACTION, policies, answers: covered, localAllowQualifies: true });
  assert.equal(result.verdict, "ask");
  assert.equal(result.policyId, "client_always_asks");
});

test("decideGateAction: localAllowQualifies still asks when a policy resolves to prohibits (the gate's own 2-way verdict, same as without localAllowQualifies)", () => {
  const policies: Policy[] = [{ id: "never_write_to_main", rule: "Never write directly on main.", kind: "prohibits" }];
  const covered = combinedAnswers({ choice: "never_write_to_main", confidence: 0.9, match: 0.9 }, { reversible: 0.9, external: 0.1, consequence: 0.1 });

  const result = decideGateAction({ action: ACTION, policies, answers: covered, localAllowQualifies: true });
  assert.equal(result.verdict, "ask");
  assert.equal(result.policyId, "never_write_to_main");
});

test("decideGateAction: localAllowQualifies with no policies configured at all still allows regardless of risk", () => {
  const highRisk = riskAnswers(0.1, 0.9, 3.9);
  const result = decideGateAction({ action: ACTION, policies: [], answers: highRisk, localAllowQualifies: true });
  assert.equal(result.verdict, "allow");
  assert.equal(result.policyId, null);
});

// ===========================================================================
// GATE_DECISION_RULES_VERSION -- native review follow-up on JEVADV-26
// (review-3ca73b9da09b0927, R3/R4): gate-bash.ts's verdict cache is keyed
// on the command's SHAPE alone, with no way to tell a verdict computed
// under one release's decision rules from one computed under another. An
// `allow` cached under 0.5.0 -- before CONSEQUENCE_NOISE_MARGIN existed --
// for a score that 0.5.1's margin would now put inside the ask band keeps
// replaying after the upgrade, silently skipping the very check the margin
// exists to add. This constant is folded into gate-bash.ts's own cacheKey()
// (adapters/claude/gate-bash.ts) so an older entry simply misses instead of
// being trusted across a rule change it was never judged against.
// ===========================================================================

test("GATE_DECISION_RULES_VERSION: is an exported, stable positive integer -- gate-bash.ts's cache key folds it in so an upgrade invalidates old entries instead of replaying them", () => {
  assert.equal(typeof GATE_DECISION_RULES_VERSION, "number");
  assert.equal(Number.isInteger(GATE_DECISION_RULES_VERSION), true);
  assert.ok(GATE_DECISION_RULES_VERSION >= 1);
});

// ===========================================================================
// buildActionGateState: JEVADV-29 (odd/tasks/release-0.5.1.md) -- the single
// point where a proposed command enters a Jev request must send a REDACTED
// copy, never the raw command. One test here stands for both the risk and
// the policy stage (gate-bash.ts's askJev shares this SAME state across
// both, in one callJev call) and for the AB benchmark's direct-batch path
// (ab_benchmark_cli.ts's makeRealJevCaller also calls this function) --
// wiring it here, once, covers every caller with no separate call-site fix.
// ===========================================================================

test("buildActionGateState: a secret-shaped value in the command is redacted before it reaches proposed_command", () => {
  const state = buildActionGateState("export TOKEN=abc123456789; git push", "some context");
  assert.equal(state.proposed_command, "export TOKEN=[REDACTED]; git push");
  assert.notEqual(state.proposed_command, "export TOKEN=abc123456789; git push", "the raw command must never reach the state Jev receives");
});

test("buildActionGateState: a command with nothing secret-shaped is passed through unchanged", () => {
  const state = buildActionGateState("git status", "some context");
  assert.equal(state.proposed_command, "git status");
});

test("buildActionGateState: context and destination are unaffected by redaction -- only the command is ever touched", () => {
  const state = buildActionGateState("export TOKEN=abc123456789", "repo context here", { label: "a client site", kind: "client-site" });
  assert.equal(state.context, "repo context here");
  assert.deepEqual(state.destination, { kind: "client-site", description: "a client site" });
});
