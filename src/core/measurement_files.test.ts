import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_DECISIONS_APPEND_FAILURES_FILE, GATE_DECISIONS_LEGACY_FILE, gateDecisionFileName, gateDecisionFilesToRead, measurementFileName, measurementFilesToRead, measurementLegacyFileName, nextAppendFailures, parseAppendFailures } from "./measurement_files.ts";

test("each hour of each log gets its own file", () => {
  assert.equal(measurementFileName("mod-skills", "2026-09-29T17:28:25.611Z"), "mod-skills-measurements-2026-09-29T17.jsonl");
  assert.equal(measurementFileName("mod-tools", "2026-09-29T00:00:00.000Z"), "mod-tools-measurements-2026-09-29T00.jsonl");
});

test("the single file written before 0.6.11 keeps its name", () => {
  assert.equal(measurementLegacyFileName("mod-skills"), "mod-skills-measurements.jsonl");
  assert.equal(measurementLegacyFileName("mod-tools"), "mod-tools-measurements.jsonl");
});

test("files to read: the legacy file first, then this log's hours in order, never the other log's", () => {
  const names = [
    "mod-skills-measurements-2026-09-30T01.jsonl",
    "mod-tools-measurements-2026-09-29T18.jsonl",
    "mod-skills-measurements.jsonl",
    "mod-skills-measurements-2026-09-29T18.jsonl",
    "turn-usage-2026-09-29T18.jsonl",
    "mod-skills-measurements-garbage.jsonl",
  ];
  assert.deepEqual(measurementFilesToRead("mod-skills", names), [
    "mod-skills-measurements.jsonl",
    "mod-skills-measurements-2026-09-29T18.jsonl",
    "mod-skills-measurements-2026-09-30T01.jsonl",
  ]);
});

test("files to read for one day: only that day's hours, plus the legacy file", () => {
  const names = [
    "mod-tools-measurements.jsonl",
    "mod-tools-measurements-2026-09-29T23.jsonl",
    "mod-tools-measurements-2026-09-30T00.jsonl",
  ];
  assert.deepEqual(measurementFilesToRead("mod-tools", names, "2026-09-30"), [
    "mod-tools-measurements.jsonl",
    "mod-tools-measurements-2026-09-30T00.jsonl",
  ]);
});

// 0.6.17 T4 (JEVADV-92): the gate's decision log rotates by the hour too,
// and the single file written before 0.6.17 keeps being read.
test("gate decisions: one file per UTC hour, the single legacy file read first", () => {
  assert.equal(gateDecisionFileName("2026-09-30T17:28:25.611Z"), "gate-decisions-2026-09-30T17.jsonl");
  assert.equal(GATE_DECISIONS_LEGACY_FILE, "gate-decisions.jsonl");
  const names = [
    "gate-decisions-2026-10-01T00.jsonl",
    "gate-approvals.jsonl",
    "gate-decisions.jsonl",
    "gate-decisions-2026-09-30T23.jsonl",
    "gate-decisions-garbage.jsonl",
    GATE_DECISIONS_APPEND_FAILURES_FILE,
    "mod-skills-measurements-2026-09-30T23.jsonl",
  ];
  assert.deepEqual(gateDecisionFilesToRead(names), ["gate-decisions.jsonl", "gate-decisions-2026-09-30T23.jsonl", "gate-decisions-2026-10-01T00.jsonl"]);
  assert.deepEqual(gateDecisionFilesToRead(["gate-decisions-2026-09-30T23.jsonl"]), ["gate-decisions-2026-09-30T23.jsonl"]);
});

test("gate decisions: a failed append is counted, with the time of the last one", () => {
  assert.deepEqual(parseAppendFailures(null), { count: 0, lastAt: null });
  assert.deepEqual(parseAppendFailures({ count: "x" }), { count: 0, lastAt: null });
  assert.deepEqual(parseAppendFailures({ count: 3, lastAt: "2026-09-30T10:00:00.000Z" }), { count: 3, lastAt: "2026-09-30T10:00:00.000Z" });
  assert.deepEqual(nextAppendFailures({ count: 3, lastAt: "2026-09-30T10:00:00.000Z" }, "2026-09-30T11:00:00.000Z"), { count: 4, lastAt: "2026-09-30T11:00:00.000Z" });
});
