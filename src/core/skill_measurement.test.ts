// Unit tests for skill_measurement.ts -- pure record shaping, JSONL
// serialization, and the comparable-decision fold `computeComparableStats`
// adds for JEVADV-4 (a restored-listing turn must not be counted as
// "listing not sent", and the readiness check needs the same join
// aggregateModSkills already does in adapters/orca/read-measurements.mjs,
// duplicated here in pure form since that file cannot be imported into the
// hooks sandbox). No fs. Run with:
//   node --test src/core/skill_measurement.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { buildDecisionRecord, buildObservationRecord, computeComparableStats, serializeRecord } from "./skill_measurement.ts";

// ---------------------------------------------------------------------------
// buildDecisionRecord / buildObservationRecord / serializeRecord
// ---------------------------------------------------------------------------

test("buildDecisionRecord stamps type 'decision' and carries every field through unchanged, including listingWithheld and readiness", () => {
  const record = buildDecisionRecord({
    id: "abc-123",
    at: "2026-09-25T00:00:00.000Z",
    mode: "active",
    prompt: "find every caller of callJev",
    orcaContext: { worktree: "/wt", proyecto: "orca-supervisor", rama: "refactor/english-artifacts" },
    candidateCount: 12,
    listingChars: 480,
    listingWithheld: true,
    wide: { ranked: [{ name: "graft", probability: 0.8 }], gate: 0.7, needsSkill: true },
    fit: { winner: "graft", fits: { graft: 0.9 } },
    decision: { name: "graft", reason: "stage 2, fits 0.90" },
    latencyMs: { wide: 340, fit: 210 },
    readiness: { ready: false, comparableShortfall: 600, matchRateMet: null, reason: "not-enough-samples" },
  });
  assert.equal(record.type, "decision");
  assert.equal(record.listingWithheld, true);
  assert.deepEqual(record.readiness, { ready: false, comparableShortfall: 600, matchRateMet: null, reason: "not-enough-samples" });
});

// This is the exact regression JEVADV-4 asks for: a turn where Jev picked a
// name but nothing was actually injected (e.g. the SKILL.md read failed)
// must record listingWithheld: false and readiness untouched by that
// failure -- the record must not claim a listing was saved that never was.
test("a decision whose skill was picked but never injected records listingWithheld: false", () => {
  const record = buildDecisionRecord({
    id: "id-2",
    at: "2026-09-25T00:00:00.000Z",
    mode: "active",
    prompt: "help me with graft",
    orcaContext: { worktree: null, proyecto: null, rama: null },
    candidateCount: 3,
    listingChars: 120,
    listingWithheld: false,
    wide: { ranked: [{ name: "graft", probability: 0.9 }], gate: 0.8, needsSkill: true },
    fit: { winner: "graft", fits: { graft: 0.95 } },
    decision: { name: "graft", reason: "stage 2, fits 0.95" },
    latencyMs: { wide: 100, fit: 80 },
    readiness: null,
  });
  assert.equal(record.decision.name, "graft");
  assert.equal(record.listingWithheld, false, "a picked-but-not-injected turn must never claim the listing was withheld");
});

test("buildObservationRecord stamps type 'observation' and carries the correlating id and the skill name", () => {
  const record = buildObservationRecord("abc-123", "graft", "2026-09-25T00:00:05.000Z");
  assert.deepEqual(record, { type: "observation", id: "abc-123", at: "2026-09-25T00:00:05.000Z", skill: "graft" });
});

test("serializeRecord produces one newline-terminated JSON line, round-trippable", () => {
  const record = buildObservationRecord("id-1", "code-review", "2026-09-25T00:00:00.000Z");
  const line = serializeRecord(record);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), record);
});

test("serializeRecord on a decision record with null wide/fit/readiness still round-trips", () => {
  const record = buildDecisionRecord({
    id: "id-3",
    at: "2026-09-25T00:00:00.000Z",
    mode: "measurement",
    prompt: "what's the weather like",
    orcaContext: { worktree: null, proyecto: null, rama: null },
    candidateCount: 8,
    listingChars: 200,
    listingWithheld: false,
    wide: null,
    fit: null,
    decision: { name: null, reason: "jev didn't answer stage 1" },
    latencyMs: { wide: null, fit: null },
    readiness: null,
  });
  const parsed = JSON.parse(serializeRecord(record));
  assert.equal(parsed.wide, null);
  assert.equal(parsed.readiness, null);
  assert.equal(parsed.listingWithheld, false);
});

// ---------------------------------------------------------------------------
// computeComparableStats
// ---------------------------------------------------------------------------

test("computeComparableStats: no rows reads as 0 comparable, null match rate", () => {
  assert.deepEqual(computeComparableStats([]), { comparableCount: 0, matchRate: null });
});

test("computeComparableStats: a measurement decision with no matching observation is not comparable yet", () => {
  const rows = [{ type: "decision", id: "a", mode: "measurement", decision: { name: "graft" } }];
  assert.deepEqual(computeComparableStats(rows), { comparableCount: 0, matchRate: null });
});

test("computeComparableStats: an active-mode decision never counts, even with a matching observation", () => {
  const rows = [
    { type: "decision", id: "a", mode: "active", decision: { name: "graft" } },
    { type: "observation", id: "a", skill: "graft" },
  ];
  assert.deepEqual(computeComparableStats(rows), { comparableCount: 0, matchRate: null });
});

test("computeComparableStats: joins decisions and observations by id, counting matches and misses", () => {
  const rows = [
    { type: "decision", id: "a", mode: "measurement", decision: { name: "graft" } },
    { type: "observation", id: "a", skill: "graft" },
    { type: "decision", id: "b", mode: "measurement", decision: { name: "graft" } },
    { type: "observation", id: "b", skill: "archify" },
    { type: "decision", id: "c", mode: "measurement", decision: { name: null } },
    { type: "observation", id: "c", skill: "graft" },
  ];
  assert.deepEqual(computeComparableStats(rows), { comparableCount: 3, matchRate: 1 / 3 });
});

test("computeComparableStats: a malformed or unrelated row is skipped, never thrown on", () => {
  const rows: unknown[] = [
    "not an object",
    null,
    42,
    { type: "decision", id: "a", mode: "measurement" }, // missing `decision`
    { type: "decision", id: "b", mode: "measurement", decision: { name: "graft" } },
    { type: "observation", id: "b", skill: "graft" },
  ];
  assert.deepEqual(computeComparableStats(rows), { comparableCount: 1, matchRate: 1 });
});
