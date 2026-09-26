// Unit tests for gatePolicyFingerprint -- pure input to pure output, no
// filesystem, no process, no network. Run with:
//   node --test src/core/gate_policy_fingerprint.test.ts
//
// JEVADV-48: adapters/claude/gate-bash.ts's verdict cache key used to be
// command-shape only, so a cached 'allow' kept replaying for up to 30 days
// after a team added a `requires_human`/`prohibits` policy that covers the
// same command. Every test below is really asking one question: does the
// fingerprint change exactly when the policy stage's own judgment would?

import assert from "node:assert/strict";
import test from "node:test";

import { gatePolicyFingerprint } from "./gate_policy_fingerprint.ts";
import { filterPoliciesForCommandScope, filterPoliciesForDestination } from "./decisions.ts";
import type { Policy } from "./decisions.ts";

const NO_SEED_SCOPES = new Map();

function fp(policies: readonly Policy[], consequenceCeiling?: number): string {
  return gatePolicyFingerprint({ policies, seedScopeById: NO_SEED_SCOPES, consequenceCeiling });
}

test("an empty policy list fingerprints the same way every time", () => {
  assert.equal(fp([]), fp([]));
});

test("adding a covering policy changes the fingerprint -- the real incident this closes", () => {
  const covering: Policy = { id: "requires-human-1", rule: "anything matching this shape needs a human", kind: "requires_human" };
  assert.notEqual(fp([]), fp([covering]), "a fingerprint computed with no policies must not equal one computed with a covering policy");
});

test("a changed kind on the same id/rule changes the fingerprint", () => {
  const before: Policy = { id: "p1", rule: "same rule text", kind: "permits" };
  const after: Policy = { id: "p1", rule: "same rule text", kind: "requires_human" };
  assert.notEqual(fp([before]), fp([after]));
});

test("changed rule text on the same id/kind changes the fingerprint", () => {
  const before: Policy = { id: "p1", rule: "the original rule text", kind: "prohibits" };
  const after: Policy = { id: "p1", rule: "an edited rule text", kind: "prohibits" };
  assert.notEqual(fp([before]), fp([after]));
});

test("a legacy Spanish kind fingerprints identically to its migrated English equivalent", () => {
  const legacy = { id: "p1", rule: "same rule text", kind: "permite" } as unknown as Policy;
  const english: Policy = { id: "p1", rule: "same rule text", kind: "permits" };
  assert.equal(fp([legacy]), fp([english]),
    "the worker's one-time kind migration (adapters/orca/main.mjs) must never invalidate a cache entry it did not change the MEANING of");
});

test("every legacy kind maps to its own English equivalent, not to each other", () => {
  const permite = { id: "p1", rule: "r", kind: "permite" } as unknown as Policy;
  const prohibe = { id: "p1", rule: "r", kind: "prohibe" } as unknown as Policy;
  const pregunta = { id: "p1", rule: "r", kind: "pregunta" } as unknown as Policy;
  const values = new Set([fp([permite]), fp([prohibe]), fp([pregunta])]);
  assert.equal(values.size, 3, "three different kinds must never collide onto the same fingerprint");
});

test("unchanged policies fingerprint identically across two separate computations", () => {
  const policies: readonly Policy[] = [
    { id: "a", rule: "rule a", kind: "permits" },
    { id: "b", rule: "rule b", kind: "requires_human" },
  ];
  assert.equal(fp(policies), fp(policies.map((p) => ({ ...p }))));
});

test("input order never matters -- the fingerprint sorts by id internally", () => {
  const a: Policy = { id: "a", rule: "rule a", kind: "permits" };
  const b: Policy = { id: "b", rule: "rule b", kind: "requires_human" };
  assert.equal(fp([a, b]), fp([b, a]));
});

test("a changed consequence ceiling changes the fingerprint even with the same policies", () => {
  const policies: readonly Policy[] = [{ id: "a", rule: "rule a", kind: "permits" }];
  assert.notEqual(fp(policies, 40), fp(policies, 70));
});

test("an undefined ceiling is stable and distinct from any real numeric ceiling", () => {
  const policies: readonly Policy[] = [{ id: "a", rule: "rule a", kind: "permits" }];
  assert.equal(fp(policies, undefined), fp(policies, undefined));
  assert.notEqual(fp(policies, undefined), fp(policies, 0));
});

test("resolved scope is part of the fingerprint: an explicit process scope differs from an explicit command scope on the same id/kind/rule", () => {
  const asCommand: Policy = { id: "p1", rule: "same rule", kind: "requires_human", scope: "command" };
  const asProcess: Policy = { id: "p1", rule: "same rule", kind: "requires_human", scope: "process" };
  assert.notEqual(fp([asCommand]), fp([asProcess]));
});

// JEVADV-48's own required scenario: "a policy filtered out for this
// destination or scope -> still a hit". filterPoliciesForDestination and
// filterPoliciesForCommandScope (decisions.ts) are what gate-bash.ts calls
// BEFORE building the fingerprint's input -- so a policy that never
// survives that filtering must produce the exact same fingerprint as if it
// never existed at all.
test("a policy filtered out by destination or scope contributes nothing -- the fingerprint matches the filtered set, not the raw one", () => {
  const survivor: Policy = { id: "kept", rule: "kept rule", kind: "requires_human" };
  const filteredByDestination: Policy = { id: "scoped-elsewhere", rule: "only applies to another destination", kind: "prohibits", destinations: ["some-other-destination"] };
  const filteredByScope: Policy = { id: "process-claim", rule: "a claim about the whole workflow, not one command", kind: "requires_human", scope: "process" };

  // The exact two-step filter gate-bash.ts's askJev path runs before ever
  // reaching this fingerprint: no destination matched (destinationId null)
  // excludes the destination-scoped policy, and the command-scope filter
  // excludes the process-scoped one. Only `survivor` should ever reach
  // gatePolicyFingerprint, so its fingerprint over the RAW three-policy set
  // (after filtering) must equal a fingerprint computed with the extras
  // never having existed at all.
  const filtered = filterPoliciesForCommandScope(
    filterPoliciesForDestination([survivor, filteredByDestination, filteredByScope], null),
    NO_SEED_SCOPES,
  );
  assert.equal(fp(filtered), fp([survivor]));
});
