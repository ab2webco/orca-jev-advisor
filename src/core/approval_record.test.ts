import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  UNRESOLVED_AFTER_MS,
  buildApprovalOutcomeRecord,
  buildPendingApprovalRecord,
  ceilingEvidence,
  parsePendingToolUseIds,
  serializeApprovalRecord,
  summarizeApprovals,
} from "./approval_record.ts";
import type { LabelledDecision, PendingApprovalRecord } from "./approval_record.ts";

const AT = "2026-09-23T12:00:00.000Z";
const NOW = Date.parse("2026-09-23T12:30:00.000Z");

// A gate-pending record only ever exists because the gate stopped
// something, so `stopReason` is never genuinely unknown at write time --
// every helper call below defaults to the risk stage, the most common
// shape, and the stopReason/policyId-specific tests further down override
// it explicitly.
function pending(toolUseId: string, consequence: number | null, at = AT, stopReason: PendingApprovalRecord["stopReason"] = "risk", policyId: string | null = null): PendingApprovalRecord {
  return buildPendingApprovalRecord({
    toolUseId,
    at,
    project: "app",
    destinationId: "app",
    commandFamily: "rm -rf",
    shape: "abc123",
    reversible: 0.4,
    external: 0.1,
    consequence,
    ceiling: 1.78,
    stopReason,
    policyId,
  });
}

const outcome = (toolUseId: string, o: "approved" | "rejected", at = AT) =>
  buildApprovalOutcomeRecord({ toolUseId, at, outcome: o });

test("joins the two halves by tool_use_id, exactly", () => {
  const s = summarizeApprovals(
    [pending("a", 1.9), pending("b", 2.4)],
    [outcome("b", "rejected"), outcome("a", "approved")],
    NOW,
  );
  assert.equal(s.asked, 2);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.notRun, 0);
  assert.equal(s.awaiting, 0, "both were answered, nothing is still waiting");
  assert.equal(s.labelled.length, 2);
});

// odd/tasks/production-honesty-pass.md P7: every `deny` verdict writes a
// gate-pending too (gate-bash.ts's appendPendingApproval runs whenever the
// decision isn't 'allow', ask OR deny), and a denied command never runs --
// no PostToolUse, no PostToolUseFailure, no PermissionDenied, ever, by
// construction. With nine rules denying outright, this is now the main
// shape a pending-with-no-outcome takes, not "someone walked away". `asked`
// still counts it (the gate did stop something), and it belongs in the
// summary as its own category, counted alongside approved and rejected --
// not silently dropped the way a bare `unresolved` figure invites.
test("a pending with no outcome past the TTL is classified notRun, counted alongside approved and rejected", () => {
  // Someone closed the prompt or walked away -- OR the gate denied it
  // outright and the command never ran at all. Counting it as approval
  // would teach the gate to relax every time a desk is empty; the honest
  // move is its own category, not a guess at either answer.
  const old = new Date(NOW - UNRESOLVED_AFTER_MS - 1000).toISOString();
  const s = summarizeApprovals([pending("a", 1.9, old)], [], NOW);
  assert.equal(s.approved, 0);
  assert.equal(s.rejected, 0);
  assert.equal(s.notRun, 1);
  assert.equal(s.awaiting, 0, "past the TTL, it is notRun, not still awaiting");
  assert.equal(s.asked, 1, "asked still counts every gate-pending, notRun included");
});

// The calibration card's legend (board.html renderApprovals) draws
// approved/rejected/notRun as a percentage of `asked` -- before `awaiting`
// existed, a pending prompt still inside UNRESOLVED_AFTER_MS fell into none
// of those three buckets, so the legend never summed to 100%.
test("a prompt still on screen is neither answered nor written off -- it is awaiting", () => {
  const s = summarizeApprovals([pending("a", 1.9)], [], NOW);
  assert.equal(s.notRun, 0, "still within the window");
  assert.equal(s.approved + s.rejected, 0);
  assert.equal(s.awaiting, 1);
});

test("awaiting, together with approved/rejected/notRun, always sums to asked", () => {
  const old = new Date(NOW - UNRESOLVED_AFTER_MS - 1000).toISOString();
  const s = summarizeApprovals(
    [pending("a", 1.9), pending("b", 2.4), pending("c", 1.1, old), pending("d", 0.5)],
    [outcome("a", "approved"), outcome("b", "rejected")],
    NOW,
  );
  assert.equal(s.asked, 4);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.notRun, 1);
  assert.equal(s.awaiting, 1);
  assert.equal(s.approved + s.rejected + s.notRun + s.awaiting, s.asked);
});

test("notRun is a classification, not a fact -- a labelled outcome always wins even after the TTL has passed", () => {
  // The exact ambiguity this category cannot resolve: a session that
  // crashed after the command ran and before gate-outcome.ts recorded the
  // result leaves the identical trace as a genuine non-run. But an outcome
  // that DID arrive, however late, is real evidence and must never be
  // downgraded to notRun just because it crossed the TTL first.
  const late = new Date(NOW - UNRESOLVED_AFTER_MS - 1000).toISOString();
  const s = summarizeApprovals([pending("a", 1.9, late)], [outcome("a", "approved", late)], NOW);
  assert.equal(s.approved, 1);
  assert.equal(s.notRun, 0);
});

test("the first answer wins, so a retried tool call cannot overwrite a decision", () => {
  const s = summarizeApprovals(
    [pending("a", 1.9)],
    [outcome("a", "rejected"), outcome("a", "approved")],
    NOW,
  );
  assert.equal(s.rejected, 1);
  assert.equal(s.approved, 0);
});

test("a decision with no score is counted but never labelled, since it teaches nothing about a threshold", () => {
  const s = summarizeApprovals([pending("a", null)], [outcome("a", "approved")], NOW);
  assert.equal(s.approved, 1);
  assert.equal(s.labelled.length, 0);
});

test("a record carries no command, only its shape hash and a coarse family", () => {
  const line = serializeApprovalRecord(pending("a", 1.9));
  assert.equal(line.endsWith("\n"), true);
  const parsed: unknown = JSON.parse(line);
  assert.ok(!line.includes("/Users/"), "a path leaked");
  assert.deepEqual(Object.keys(parsed as object).includes("command"), false);
});

const label = (consequence: number, outcome: "approved" | "rejected"): LabelledDecision => ({
  at: AT,
  project: "app",
  destinationId: "app",
  commandFamily: "x",
  consequence,
  ceiling: 1.78,
  outcome,
});

test("suggests the midpoint of the band the person's own answers leave", () => {
  const e = ceilingEvidence([
    label(1.2, "approved"),
    label(1.6, "approved"),
    label(2.2, "rejected"),
    label(2.6, "rejected"),
  ]);
  assert.equal(e.highestApproved, 1.6);
  assert.equal(e.lowestRejected, 2.2);
  assert.equal(e.band, 0.6);
  assert.equal(e.suggestedCeiling, 1.9);
});

test("suggests NOTHING when approvals and rejections overlap", () => {
  // No threshold separates them, and answering with a midpoint anyway would
  // dress a coin flip as a measurement -- the exact mistake that shipped a
  // gating question whose band was -0.03.
  const e = ceilingEvidence([
    label(2.1, "approved"),
    label(1.4, "rejected"),
  ]);
  assert.ok(e.band !== null && e.band < 0);
  assert.equal(e.suggestedCeiling, null);
});

test("suggests nothing from one-sided evidence", () => {
  assert.equal(ceilingEvidence([label(1.2, "approved")]).suggestedCeiling, null);
  assert.equal(ceilingEvidence([label(2.2, "rejected")]).suggestedCeiling, null);
  assert.equal(ceilingEvidence([]).suggestedCeiling, null);
});

test("reports how much evidence each side rests on, so a suggestion from two samples is not read as settled", () => {
  const e = ceilingEvidence([label(1.2, "approved"), label(2.2, "rejected")]);
  assert.equal(e.approvedCount, 1);
  assert.equal(e.rejectedCount, 1);
});

test("parsePendingToolUseIds collects only gate-pending tool_use_ids, ignoring gate-outcome lines", () => {
  const raw = [
    serializeApprovalRecord(pending("a", 1.9)),
    serializeApprovalRecord(outcome("a", "approved")),
    serializeApprovalRecord(pending("b", 2.1)),
  ].join("");
  const ids = parsePendingToolUseIds(raw);
  assert.equal(ids.has("a"), true);
  assert.equal(ids.has("b"), true);
  assert.equal(ids.has("c"), false, "an id that never appeared as gate-pending must not be reported as joinable");
});

test("parsePendingToolUseIds skips malformed lines instead of throwing -- must be at least as forgiving as the file it reads", () => {
  const raw = [
    "not json at all\n",
    serializeApprovalRecord(pending("a", 1.9)),
    "{\"broken\": \n",
    "",
  ].join("");
  const ids = parsePendingToolUseIds(raw);
  assert.equal(ids.has("a"), true);
  assert.equal(ids.size, 1);
});

test("parsePendingToolUseIds on empty input returns an empty set", () => {
  assert.equal(parsePendingToolUseIds("").size, 0);
});

// ---------------------------------------------------------------------------
// stopReason / policyId -- odd/tasks/release-0.5.1.md T1. A gate-pending
// record is always written BECAUSE the gate stopped something, so it always
// knows why. policyId is set only for a "policy" stop.
// ---------------------------------------------------------------------------

test("a pending record carries the stopReason it was built with", () => {
  const record = pending("a", 1.9, AT, "local-rule");
  assert.equal(record.stopReason, "local-rule");
  assert.equal(record.policyId, null);
});

test("a policy stop's pending record carries the policy's id", () => {
  const record = pending("a", null, AT, "policy", "client_always_asks");
  assert.equal(record.stopReason, "policy");
  assert.equal(record.policyId, "client_always_asks");
});

test("a pending record carries no command, only stopReason/policyId as ids -- never the command", () => {
  const line = serializeApprovalRecord(pending("a", 1.9, AT, "policy", "client_always_asks"));
  assert.ok(!line.includes("/Users/"), "a path leaked");
  const parsed: unknown = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed as object).includes("command"), false);
});
