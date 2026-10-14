import assert from "node:assert/strict";
import test from "node:test";

import { addGateDecisions, emptyGateDecisionTotals } from "./gate_decision_totals.ts";
import type { GateDecisionRecord } from "./gate_measurement.ts";
import { BOARD_WINDOW_KEYS, HOURLY_LOG_KEPT_MS, boardWindows, coverageSinceMs, isInWindow, versionStartOf, windowSpanMs } from "./board_windows.ts";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function gateRecord(at: string, pluginVersion: string | undefined): GateDecisionRecord {
  return {
    type: "gate-decision",
    id: `g-${at}`,
    at,
    project: "alpha",
    commandFamily: "git",
    source: "jev",
    verdict: "allow",
    latencyMs: 100,
    ...(pluginVersion === undefined ? {} : { pluginVersion }),
  } as GateDecisionRecord;
}

test("the four windows, in the order the board shows them", () => {
  assert.deepEqual(BOARD_WINDOW_KEYS, ["day", "week", "version", "all"]);
});

test("day and week are rolling from now; all has no bound; version is unavailable without a stamped build", () => {
  const windows = boardWindows(NOW, null);
  assert.deepEqual(windows.day, { key: "day", sinceMs: NOW - DAY, available: true, pluginVersion: null });
  assert.deepEqual(windows.week, { key: "week", sinceMs: NOW - 7 * DAY, available: true, pluginVersion: null });
  assert.deepEqual(windows.all, { key: "all", sinceMs: null, available: true, pluginVersion: null });
  assert.deepEqual(windows.version, { key: "version", sinceMs: null, available: false, pluginVersion: null });
});

test("version starts at the first decision the running build stamped", () => {
  const windows = boardWindows(NOW, { pluginVersion: "0.11.0", firstAtMs: NOW - 2 * HOUR });
  assert.deepEqual(windows.version, { key: "version", sinceMs: NOW - 2 * HOUR, available: true, pluginVersion: "0.11.0" });
});

test("a stamped build whose first time does not read leaves version unavailable, never a guessed start", () => {
  const windows = boardWindows(NOW, { pluginVersion: "0.11.0", firstAtMs: null });
  assert.equal(windows.version.available, false);
  assert.equal(windows.version.sinceMs, null);
});

test("versionStartOf reads the build of the latest stamped decision and its first time from the gate fold", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), {
    records: [
      gateRecord(new Date(NOW - 3 * DAY).toISOString(), "0.10.0"),
      gateRecord(new Date(NOW - 5 * HOUR).toISOString(), "0.10.1"),
      gateRecord(new Date(NOW - 1 * HOUR).toISOString(), "0.10.1"),
      gateRecord(new Date(NOW - 30 * 60_000).toISOString(), undefined),
    ],
    corruptLines: 0,
    malformedRows: 0,
    jevRecordsForAb: 0,
  });
  assert.deepEqual(versionStartOf(totals), { pluginVersion: "0.10.1", firstAtMs: NOW - 5 * HOUR });
  assert.equal(versionStartOf(emptyGateDecisionTotals()), null);
});

test("windowSpanMs is the span a summarizer's windowMs takes; all is unbounded", () => {
  const windows = boardWindows(NOW, { pluginVersion: "0.11.0", firstAtMs: NOW - 2 * HOUR });
  assert.equal(windowSpanMs(windows.day, NOW), DAY);
  assert.equal(windowSpanMs(windows.version, NOW), 2 * HOUR);
  assert.equal(windowSpanMs(windows.all, NOW), Number.POSITIVE_INFINITY);
  assert.equal(windowSpanMs(boardWindows(NOW, null).version, NOW), 0);
});

test("isInWindow: from sinceMs up to now, inclusive; an unavailable window holds nothing", () => {
  const windows = boardWindows(NOW, null);
  assert.equal(isInWindow(NOW - DAY, windows.day, NOW), true);
  assert.equal(isInWindow(NOW - DAY - 1, windows.day, NOW), false);
  assert.equal(isInWindow(NOW + 1, windows.day, NOW), false);
  assert.equal(isInWindow(0, windows.all, NOW), true);
  assert.equal(isInWindow(NOW, windows.version, NOW), false);
});

test("coverageSinceMs: the later of the window's start and what the source still keeps", () => {
  const windows = boardWindows(NOW, null);
  const keptSince = NOW - HOURLY_LOG_KEPT_MS;
  // 24 h asks for less than the source keeps: the window speaks for itself.
  assert.equal(coverageSinceMs(windows.day, keptSince), NOW - DAY);
  // "all" asks for more than an 8-day log keeps: the card can only speak since then.
  assert.equal(coverageSinceMs(windows.all, keptSince), keptSince);
  // A log nobody prunes speaks for every window it is asked about.
  assert.equal(coverageSinceMs(windows.all, null), null);
  assert.equal(coverageSinceMs(windows.week, null), NOW - 7 * DAY);
});

test("the hourly logs are kept eight days", () => {
  assert.equal(HOURLY_LOG_KEPT_MS, 8 * DAY);
});
