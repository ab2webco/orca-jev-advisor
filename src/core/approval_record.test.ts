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

function pending(toolUseId: string, consequence: number | null, at = AT): PendingApprovalRecord {
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
  assert.equal(s.unresolved, 0);
  assert.equal(s.labelled.length, 2);
});

test("silence is never counted as an answer", () => {
  // Someone closed the prompt or walked away. Counting that as approval would
  // teach the gate to relax every time a desk is empty.
  const old = new Date(NOW - UNRESOLVED_AFTER_MS - 1000).toISOString();
  const s = summarizeApprovals([pending("a", 1.9, old)], [], NOW);
  assert.equal(s.approved, 0);
  assert.equal(s.rejected, 0);
  assert.equal(s.unresolved, 1);
});

test("a prompt still on screen is neither answered nor written off", () => {
  const s = summarizeApprovals([pending("a", 1.9)], [], NOW);
  assert.equal(s.unresolved, 0, "still within the window");
  assert.equal(s.approved + s.rejected, 0);
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
