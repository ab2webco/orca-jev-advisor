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

import { decideAction, decideGateAction, filterPoliciesForDestination, interpretDestinationPolicy } from "./decisions.ts";
import type { Policy } from "./decisions.ts";
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
// decideAction: options.consequenceCeiling override (backward compatible)
// ===========================================================================

test("decideAction: still callable with a single argument, using the global ceiling", () => {
  const highRisk = riskAnswers(0.1, 0.9, 2.5);
  assert.equal(decideAction(highRisk).verdict, "ask");
});

test("decideAction: an explicit per-destination ceiling overrides the global one, in both directions", () => {
  const midRisk = riskAnswers(0.9, 0.1, 1.9); // above the global 1.78 ceiling
  assert.equal(decideAction(midRisk).verdict, "ask");
  assert.equal(decideAction(midRisk, { consequenceCeiling: 2.0 }).verdict, "allow");

  const lowRisk = riskAnswers(0.9, 0.1, 0.5); // below the global ceiling
  assert.equal(decideAction(lowRisk).verdict, "allow");
  assert.equal(decideAction(lowRisk, { consequenceCeiling: 0.1 }).verdict, "ask");
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

  const withDestinationCeiling = decideGateAction({ action: ACTION, policies: [permits], answers: noMatch, consequenceCeiling: 2.0 });
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
