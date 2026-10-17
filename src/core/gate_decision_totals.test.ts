// 0.6.21 T1 (JEVADV-98): the running totals old gate decision files are
// folded into. Pure input to pure output: no filesystem, no clock.

import assert from "node:assert/strict";
import test from "node:test";

import {
  addGateDecisions,
  emptyGateDecisionTotals,
  GATE_DECISION_TOTALS_FILE,
  gateHealthOf,
  gateHourFileFoldable,
  isFoldedFile,
  legacyGateFileFoldable,
  parseGateDecisionTotals,
} from "./gate_decision_totals.ts";
import type { GateDecisionBatch, GateDecisionTotals } from "./gate_decision_totals.ts";
import type { GateDecisionRecord } from "./gate_measurement.ts";
import { gateDecisionFilesToRead } from "./measurement_files.ts";

const DAY = 24 * 60 * 60 * 1000;

let nextId = 0;
function record(overrides: Partial<GateDecisionRecord> & Pick<GateDecisionRecord, "source" | "verdict" | "at">): GateDecisionRecord {
  nextId += 1;
  return { type: "gate-decision", id: `t-${nextId}`, project: "demo", commandFamily: "git push", latencyMs: null, ...overrides };
}

function batch(records: readonly GateDecisionRecord[], extra: Partial<Omit<GateDecisionBatch, "records">> = {}): GateDecisionBatch {
  return { records, corruptLines: 0, malformedRows: 0, jevRecordsForAb: 0, ...extra };
}

/** In time order, as a log written hour by hour is; two builds, a Jev failure streak, an unreadable time. */
function history(): GateDecisionRecord[] {
  return [
    record({ at: "2026-09-01T10:00:00.000Z", source: "jev", verdict: "allow", latencyMs: 200 }),
    record({ at: "2026-09-01T10:05:00.000Z", source: "none", verdict: "allow" }),
    record({ at: "2026-09-02T11:00:00.000Z", source: "local-rule", verdict: "deny", pluginVersion: "0.6.16", commandFamily: "rm" }),
    record({ at: "not a time", source: "cache", verdict: "allow", pluginVersion: "0.6.16" }),
    record({ at: "2026-09-03T12:00:00.000Z", source: "jev", verdict: "ask", latencyMs: 900, pluginVersion: "0.6.17", project: null }),
    record({ at: "2026-09-03T12:30:00.000Z", source: "none", verdict: "allow", pluginVersion: "0.6.17" }),
    record({ at: "2026-09-04T09:00:00.000Z", source: "none", verdict: "allow", pluginVersion: "0.6.17" }),
    record({ at: "2026-09-05T08:00:00.000Z", source: "local-rule", verdict: "advise", pluginVersion: "0.6.17", commandFamily: "terraform" }),
    record({ at: "2026-09-06T08:00:00.000Z", source: "jev", verdict: "allow", latencyMs: 150, pluginVersion: "0.6.18" }),
    record({ at: "2026-09-06T09:00:00.000Z", source: "none", verdict: "allow", pluginVersion: "0.6.18" }),
    record({ at: "2026-09-07T09:00:00.000Z", source: "cache", verdict: "allow", pluginVersion: "0.6.18" }),
    record({ at: "2026-09-08T09:00:00.000Z", source: "cache", verdict: "allow", pluginVersion: "0.6.18" }),
  ];
}

test("T1: totals continued with later decisions equal the totals of all of them, at every split point", () => {
  const records = history();
  const whole = addGateDecisions(emptyGateDecisionTotals(), batch(records, { corruptLines: 3, malformedRows: 2, jevRecordsForAb: 5 }));
  for (let split = 0; split <= records.length; split += 1) {
    const head = addGateDecisions(emptyGateDecisionTotals(), batch(records.slice(0, split), { corruptLines: 1, malformedRows: 2, jevRecordsForAb: 4 }));
    const continued = addGateDecisions(head, batch(records.slice(split), { corruptLines: 2, jevRecordsForAb: 1 }));
    assert.deepEqual(continued, whole, `split at ${split}`);
  }
});

test("T1: the current build is the one that wrote the latest stamped decision, and its window starts at its first decision", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch(history()));
  assert.deepEqual(totals.latestStamped, { atMs: Date.parse("2026-09-08T09:00:00.000Z"), pluginVersion: "0.6.18" });
  const versions = new Map(totals.byVersion);
  assert.equal(versions.get("0.6.18")?.firstAtMs, Date.parse("2026-09-06T08:00:00.000Z"));
  assert.equal(versions.get("0.6.18")?.tally.totalDecisions, 4);
  // A build whose only decision has an unreadable time still counts, with no start.
  assert.equal(versions.get("0.6.16")?.tally.totalDecisions, 2);
  assert.equal(versions.get("0.6.16")?.firstAtMs, Date.parse("2026-09-02T11:00:00.000Z"));
});

test("T1: health counts the Jev failures since the last Jev answer, across the fold", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch(history()));
  assert.deepEqual(gateHealthOf(totals), {
    lastJevAt: "2026-09-06T08:00:00.000Z",
    consecutiveFailures: 1,
    lastFailureAt: "2026-09-06T09:00:00.000Z",
  });
  assert.deepEqual(gateHealthOf(emptyGateDecisionTotals()), { lastJevAt: null, consecutiveFailures: 0, lastFailureAt: null });
  const neverAnswered = addGateDecisions(emptyGateDecisionTotals(), batch([
    record({ at: "2026-09-01T10:00:00.000Z", source: "none", verdict: "allow" }),
    record({ at: "2026-09-02T10:00:00.000Z", source: "none", verdict: "allow" }),
  ]));
  const later = addGateDecisions(neverAnswered, batch([record({ at: "2026-09-12T10:00:00.000Z", source: "none", verdict: "allow" })]));
  assert.equal(gateHealthOf(later).consecutiveFailures, 3);
});

test("T1: recent keeps the last ten decisions in log order, readable fields only", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch(history()));
  assert.equal(totals.recent.length, 10);
  assert.deepEqual(totals.recent.at(-1), { at: "2026-09-08T09:00:00.000Z", project: "demo", commandFamily: "git push", source: "cache", verdict: "allow", latencyMs: null });
  assert.equal(totals.recent[0]?.at, "2026-09-02T11:00:00.000Z");
});

test("C3: a recent decision keeps who answered it, so the board can name Clef", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch([
    record({ at: "2026-10-17T10:00:00.000Z", source: "jev", verdict: "advise", provider: "clef" }),
    record({ at: "2026-10-17T10:01:00.000Z", source: "jev", verdict: "deny", provider: "jev", escalation: "policy" }),
    record({ at: "2026-10-17T10:02:00.000Z", source: "jev", verdict: "allow" }),
  ]));
  assert.equal(totals.recent[0]?.provider, "clef");
  assert.equal(totals.recent[1]?.provider, "jev");
  // A Jev-only row carries no provider, and its recent entry carries none either.
  assert.equal("provider" in (totals.recent[2] ?? {}), false);
  assert.deepEqual(parseGateDecisionTotals(JSON.parse(JSON.stringify(totals))), totals);
  const good = JSON.parse(JSON.stringify(totals));
  assert.deepEqual(parseGateDecisionTotals({ ...good, recent: [{ ...good.recent[0], provider: "gpt" }] })?.recent, []);
});

test("SF2: Jev's last answer and its failure streak count only Jev's own rows", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch([
    record({ at: "2026-10-17T10:00:00.000Z", source: "jev", verdict: "allow" }),
    record({ at: "2026-10-17T10:05:00.000Z", source: "none", verdict: "allow", provider: "jev" }),
    record({ at: "2026-10-17T10:10:00.000Z", source: "jev", verdict: "allow", provider: "clef" }),
    record({ at: "2026-10-17T10:15:00.000Z", source: "none", verdict: "allow", provider: "clef" }),
  ]));
  assert.deepEqual(gateHealthOf(totals), { lastJevAt: "2026-10-17T10:00:00.000Z", consecutiveFailures: 1, lastFailureAt: "2026-10-17T10:05:00.000Z" });
});

test("SF1: totals carry Clef's latencies apart, and a totals file written before them still reads", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch([
    record({ at: "2026-10-17T10:00:00.000Z", source: "jev", verdict: "allow", latencyMs: 900 }),
    record({ at: "2026-10-17T10:01:00.000Z", source: "jev", verdict: "allow", latencyMs: 250, provider: "clef" }),
  ]));
  assert.deepEqual(totals.all.jevLatencies, [[900, 1]]);
  assert.deepEqual(totals.all.clefLatencies, [[250, 1]]);
  assert.deepEqual(parseGateDecisionTotals(JSON.parse(JSON.stringify(totals))), totals);
  const older = JSON.parse(JSON.stringify(totals));
  delete older.all.clefLatencies;
  assert.deepEqual(parseGateDecisionTotals(older)?.all.clefLatencies, []);
});

test("nit: one recent row with an unknown provider is dropped, never the whole list", () => {
  const good = JSON.parse(JSON.stringify(addGateDecisions(emptyGateDecisionTotals(), batch(history()))));
  const recent = [...good.recent];
  recent[0] = { ...recent[0], provider: "gpt" };
  const parsed = parseGateDecisionTotals({ ...good, recent });
  assert.ok(parsed !== null);
  assert.equal(parsed.recent.length, good.recent.length - 1);
});

test("T1: totals survive a JSON round trip through the parser unchanged", () => {
  const totals: GateDecisionTotals = {
    ...addGateDecisions(emptyGateDecisionTotals(), batch(history(), { corruptLines: 2, malformedRows: 1, jevRecordsForAb: 3 })),
    files: [{ name: "gate-decisions.jsonl", size: 5041214, mtimeMs: 1790000000000.5 }, { name: "gate-decisions-2026-09-01T10.jsonl", size: 77000, mtimeMs: 1788000000000 }],
    foldedFiles: 2,
    checkedAt: "2026-09-20T00:00:00.000Z",
  };
  assert.deepEqual(parseGateDecisionTotals(JSON.parse(JSON.stringify(totals))), totals);
  assert.deepEqual(parseGateDecisionTotals(JSON.parse(JSON.stringify(emptyGateDecisionTotals()))), emptyGateDecisionTotals());
});

test("T1: a totals file of any other shape is refused, never half-read", () => {
  const good = JSON.parse(JSON.stringify(addGateDecisions(emptyGateDecisionTotals(), batch(history()))));
  assert.equal(parseGateDecisionTotals(null), null);
  assert.equal(parseGateDecisionTotals([]), null);
  assert.equal(parseGateDecisionTotals({ ...good, schema: 2 }), null);
  assert.equal(parseGateDecisionTotals({ ...good, files: ["gate-decisions.jsonl"] }), null);
  assert.equal(parseGateDecisionTotals({ ...good, files: [{ name: "a", size: -1, mtimeMs: 0 }] }), null);
  assert.equal(parseGateDecisionTotals({ ...good, corruptLines: -1 }), null);
  assert.equal(parseGateDecisionTotals({ ...good, all: { ...good.all, bySource: { jev: 1 } } }), null);
  assert.equal(parseGateDecisionTotals({ ...good, all: { ...good.all, jevLatencies: [[1, 0.5]] } }), null);
  assert.equal(parseGateDecisionTotals({ ...good, recent: [{ at: 1 }] }), null);
  assert.equal(parseGateDecisionTotals({ ...good, health: { ...good.health, failuresAfterLastJev: "2" } }), null);
});

test("T1: an hour file folds once its whole hour is more than 8 days old", () => {
  const now = Date.parse("2026-10-01T12:30:00.000Z");
  assert.equal(gateHourFileFoldable("gate-decisions-2026-09-23T03.jsonl", now), true);
  assert.equal(gateHourFileFoldable("gate-decisions-2026-09-23T11.jsonl", now), true, "ended at 12:00, more than 8 days before 12:30");
  assert.equal(gateHourFileFoldable("gate-decisions-2026-09-23T12.jsonl", now), false, "still inside its last hour");
  assert.equal(gateHourFileFoldable("gate-decisions-2026-09-30T10.jsonl", now), false);
  assert.equal(gateHourFileFoldable("gate-decisions.jsonl", now), false);
  assert.equal(gateHourFileFoldable(GATE_DECISION_TOTALS_FILE, now), false);
  assert.equal(gateHourFileFoldable("gate-decisions-2026-13-45T99.jsonl", now), false, "a name that does not date is never folded");
});

test("T1: the legacy file folds only once its newest decision's hour is more than 8 days old", () => {
  const now = Date.parse("2026-10-01T12:30:00.000Z");
  assert.equal(legacyGateFileFoldable(null, now), true, "nothing dated in it");
  assert.equal(legacyGateFileFoldable(Date.parse("2026-09-23T11:59:00.000Z"), now), true);
  assert.equal(legacyGateFileFoldable(Date.parse("2026-09-23T12:10:00.000Z"), now), false);
  assert.equal(legacyGateFileFoldable(now - 3 * DAY, now), false);
});

test("T1: the totals file is not a decision file", () => {
  assert.deepEqual(gateDecisionFilesToRead([GATE_DECISION_TOTALS_FILE, "gate-decisions-2026-09-01T10.jsonl"]), ["gate-decisions-2026-09-01T10.jsonl"]);
});

test("T1: a reader skips a folded file only while it is still the file that was folded", () => {
  const totals: GateDecisionTotals = { ...emptyGateDecisionTotals(), files: [{ name: "gate-decisions.jsonl", size: 100, mtimeMs: 5 }] };
  assert.equal(isFoldedFile(totals, "gate-decisions.jsonl", { size: 100, mtimeMs: 5 }), true);
  assert.equal(isFoldedFile(totals, "gate-decisions.jsonl", null), true, "gone since the listing: the totals hold it");
  assert.equal(isFoldedFile(totals, "gate-decisions.jsonl", { size: 40, mtimeMs: 9 }), false, "written again under the same name");
  assert.equal(isFoldedFile(totals, "gate-decisions-2026-09-01T10.jsonl", { size: 100, mtimeMs: 5 }), false);
});

// Multi-provider P7: the provider counts survive a fold, and a totals file written before they existed still reads.
test("provider counts are kept in the totals, and an older totals file reads with them at zero", () => {
  const totals = addGateDecisions(emptyGateDecisionTotals(), batch([
    record({ at: "2026-10-16T10:00:00.000Z", source: "jev", verdict: "allow", provider: "clef" }),
    record({ at: "2026-10-16T10:01:00.000Z", source: "jev", verdict: "allow", provider: "jev", escalation: "doubt" }),
  ]));
  const roundTrip = parseGateDecisionTotals(JSON.parse(JSON.stringify(totals)));
  assert.ok(roundTrip !== null);
  assert.equal(roundTrip.all.providers.answeredBy.clef, 1);
  assert.equal(roundTrip.all.providers.escalations.doubt, 1);
  const older = JSON.parse(JSON.stringify(totals));
  delete older.all.providers;
  const parsedOlder = parseGateDecisionTotals(older);
  assert.ok(parsedOlder !== null, "a totals file from before the provider counts must not be thrown away");
  assert.equal(parsedOlder.all.providers.tagged, 0);
  assert.equal(parsedOlder.all.totalDecisions, 2);
});
