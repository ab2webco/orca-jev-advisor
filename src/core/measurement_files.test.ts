import assert from "node:assert/strict";
import { test } from "node:test";
import { measurementFileName, measurementFilesToRead, measurementLegacyFileName } from "./measurement_files.ts";

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
