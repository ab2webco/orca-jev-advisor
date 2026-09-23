// Unit tests for tool_measurement.ts -- pure record shaping and JSONL
// serialization, no fs. Run with:
//   node --test src/core/tool_measurement.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { buildDecisionRecord, buildObservationRecord, serializeRecord } from "./tool_measurement.ts";

test("buildDecisionRecord stamps type 'decision' and carries every field through unchanged", () => {
  const record = buildDecisionRecord({
    id: "abc-123",
    at: "2026-09-23T00:00:00.000Z",
    mode: "measurement",
    prompt: "find every caller of callJev",
    orcaContext: { worktree: "/wt", project: "orca-supervisor", branch: "refactor/english-artifacts" },
    candidateCount: 12,
    listingChars: 480,
    wide: { ranked: [{ name: "Grep", probability: 0.8 }], gate: 0.7, needsOneTool: true },
    fit: { winner: "Grep", fits: { Grep: 0.9 } },
    decision: { name: "Grep", reason: "stage 2, fits 0.90" },
    latencyMs: { wide: 340, fit: 210 },
  });
  assert.equal(record.type, "decision");
  assert.equal(record.id, "abc-123");
  assert.equal(record.decision.name, "Grep");
  assert.equal(record.wide?.needsOneTool, true);
});

test("buildObservationRecord stamps type 'observation' and carries the correlating id and the tool name", () => {
  const record = buildObservationRecord("abc-123", "Grep", "2026-09-23T00:00:05.000Z");
  assert.deepEqual(record, { type: "observation", id: "abc-123", at: "2026-09-23T00:00:05.000Z", tool: "Grep" });
});

test("serializeRecord produces one newline-terminated JSON line, round-trippable", () => {
  const record = buildObservationRecord("id-1", "Bash", "2026-09-23T00:00:00.000Z");
  const line = serializeRecord(record);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), record);
});

test("serializeRecord on a decision record with null wide/fit (Jev never answered) still round-trips", () => {
  const record = buildDecisionRecord({
    id: "id-2",
    at: "2026-09-23T00:00:00.000Z",
    mode: "active",
    prompt: "what's the weather like",
    orcaContext: { worktree: null, project: null, branch: null },
    candidateCount: 8,
    listingChars: 200,
    wide: null,
    fit: null,
    decision: { name: null, reason: "jev didn't answer stage 1" },
    latencyMs: { wide: null, fit: null },
  });
  const parsed = JSON.parse(serializeRecord(record));
  assert.equal(parsed.wide, null);
  assert.equal(parsed.fit, null);
  assert.equal(parsed.decision.name, null);
});
