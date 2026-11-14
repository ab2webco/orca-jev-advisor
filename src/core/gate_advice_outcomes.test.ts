import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ADVICE_OUTCOMES,
  NEVER_SILENT_FAMILIES,
  OUTCOME_TTL_MS,
  RECENT_OUTCOMES,
  SILENT_AFTER,
  familyKey,
  isSilentFamily,
  parseAdviceOutcomes,
  recordAdviceIssued,
  recordIdenticalRetry,
  replayAdviceOutcomes,
  settleAdviceOutcomes,
  type AdviceOutcomeStore,
} from "./gate_advice_outcomes.ts";
import { ADVICE_RETRY_WINDOW_MS } from "./gate_advice_retry.ts";
import type { GateDecisionRecord } from "./gate_measurement.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const MINUTE = 60 * 1000;

/** `count` advices for (project, family), each retried unchanged one minute later. */
function retriedAdvices(store: AdviceOutcomeStore, project: string | null, family: string, count: number, start = T0): AdviceOutcomeStore {
  let next = store;
  for (let i = 0; i < count; i++) {
    const at = start + i * 2 * MINUTE;
    next = recordAdviceIssued(next, `k-${family}-${start}-${i}`, project, family, at);
    next = recordIdenticalRetry(next, `k-${family}-${start}-${i}`, at + MINUTE);
  }
  return next;
}

test("a family is not silent until its last SILENT_AFTER advices were all retried unchanged", () => {
  const almost = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "python3", SILENT_AFTER - 1);
  assert.equal(isSilentFamily(almost, "app", "python3", T0 + 60 * MINUTE), false);
  const enough = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "python3", SILENT_AFTER);
  assert.equal(isSilentFamily(enough, "app", "python3", T0 + 60 * MINUTE), true);
});

test("silence is per project: another project, or another family, still gets the advice", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "python3", SILENT_AFTER);
  assert.equal(isSilentFamily(store, "other-app", "python3", T0 + 60 * MINUTE), false);
  assert.equal(isSilentFamily(store, "app", "gh cli", T0 + 60 * MINUTE), false);
});

test("an advice whose window closes with no identical retry is 'changed' and ends the silence", () => {
  let store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "git push", SILENT_AFTER);
  const at = T0 + 30 * MINUTE;
  store = recordAdviceIssued(store, "changed-1", "app", "git push", at);
  assert.equal(isSilentFamily(store, "app", "git push", at + MINUTE), true, "still pending: not yet known");
  assert.equal(isSilentFamily(store, "app", "git push", at + ADVICE_RETRY_WINDOW_MS), false, "the window closed: the advice changed what ran");
  const settled = settleAdviceOutcomes(store, at + ADVICE_RETRY_WINDOW_MS);
  assert.deepEqual(settled.pending, {});
  assert.equal(settled.families[familyKey("app", "git push")]?.recent.at(-1), "changed");
});

test("a retry after the window is not counted as 'same'", () => {
  let store = recordAdviceIssued(EMPTY_ADVICE_OUTCOMES, "late", "app", "gh cli", T0);
  store = recordIdenticalRetry(store, "late", T0 + ADVICE_RETRY_WINDOW_MS);
  assert.deepEqual(store.families[familyKey("app", "gh cli")]?.recent, ["changed"]);
});

test("a retry of something never advised (a local rule's advice) teaches nothing", () => {
  const store = recordIdenticalRetry(EMPTY_ADVICE_OUTCOMES, "unknown", T0);
  assert.deepEqual(store.families, {});
});

test("families whose mistake cannot be taken back never go silent", () => {
  for (const family of NEVER_SILENT_FAMILIES) {
    const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", family, RECENT_OUTCOMES);
    assert.equal(isSilentFamily(store, "app", family, T0 + 60 * MINUTE), false, family);
  }
  const legacy = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "git reset/clean", RECENT_OUTCOMES);
  assert.equal(isSilentFamily(legacy, "app", "git reset/clean", T0 + 60 * MINUTE), false, "the legacy discard family name too");
});

test("a family with no outcome for the TTL forgets what it learned", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "orca", SILENT_AFTER);
  const last = T0 + (SILENT_AFTER - 1) * 2 * MINUTE + MINUTE;
  assert.equal(isSilentFamily(store, "app", "orca", last + OUTCOME_TTL_MS - 1), true);
  assert.equal(isSilentFamily(store, "app", "orca", last + OUTCOME_TTL_MS), false);
});

test("recent outcomes are capped", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "python3", RECENT_OUTCOMES + 5);
  assert.equal(store.families[familyKey("app", "python3")]?.recent.length, RECENT_OUTCOMES);
});

test("parse is tolerant: garbage is an empty store, a good store round-trips", () => {
  assert.deepEqual(parseAdviceOutcomes(null), EMPTY_ADVICE_OUTCOMES);
  assert.deepEqual(parseAdviceOutcomes({ version: 2 }), EMPTY_ADVICE_OUTCOMES);
  assert.deepEqual(parseAdviceOutcomes({ version: 1, families: { a: { recent: "x" } }, pending: { b: { key: 1 } } }), EMPTY_ADVICE_OUTCOMES);
  const store = recordAdviceIssued(retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "python3", 3), "p", "app", "python3", T0 + 10 * MINUTE);
  assert.deepEqual(parseAdviceOutcomes(JSON.parse(JSON.stringify(store))), store);
  const mixed = parseAdviceOutcomes({ version: 1, families: { k: { recent: ["same", "bogus", "changed"], lastAt: new Date(T0).toISOString() } }, pending: {} });
  assert.deepEqual(mixed.families.k?.recent, ["same", "changed"]);
});

// --- replay over the decision log -------------------------------------------

let nextId = 0;
function record(at: number, fields: Partial<GateDecisionRecord>): GateDecisionRecord {
  return {
    type: "gate-decision",
    id: `r${nextId++}`,
    at: new Date(at).toISOString(),
    project: "app",
    commandFamily: "python3",
    source: "jev",
    verdict: "advise",
    latencyMs: 300,
    stopReason: "risk",
    ...fields,
  };
}

test("replay links each risk advice to its identical retry and reports what would have been silent", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER + 3; i++) {
    const at = T0 + i * 5 * MINUTE;
    records.push(record(at, {}));
    records.push(record(at + MINUTE, { verdict: "allow", stopReason: "advice-retry" }));
  }
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.advised, SILENT_AFTER + 3);
  assert.equal(replay.retried, SILENT_AFTER + 3);
  assert.equal(replay.wouldBeSilent, 3, "the first SILENT_AFTER advices teach, the rest would have been silent");
  assert.equal(replay.untouched, SILENT_AFTER + 3, "the retries themselves are untouched");
});

test("replay never silences a deny, a policy, a local rule or a never-silent family", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER * 2; i++) {
    const at = T0 + i * 5 * MINUTE;
    records.push(record(at, { commandFamily: "rm -rf" }));
    records.push(record(at + MINUTE, { commandFamily: "rm -rf", verdict: "allow", stopReason: "advice-retry" }));
    records.push(record(at + 2 * MINUTE, { source: "local-rule", verdict: "advise", stopReason: "local-rule" }));
    records.push(record(at + 2 * MINUTE + 1000, { source: "local-rule", verdict: "allow", stopReason: "advice-retry" }));
    records.push(record(at + 3 * MINUTE, { verdict: "deny", stopReason: "local-rule", source: "local-rule" }));
    records.push(record(at + 3 * MINUTE + 1000, { verdict: "ask", stopReason: "policy", policyId: "p" }));
  }
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.wouldBeSilent, 0);
  assert.deepEqual(replay.families.map((item) => item.family), ["rm -rf"], "only the risk advices are measured");
  assert.equal(replay.families[0]?.silenceable, false);
  assert.equal(replay.untouched, records.length - SILENT_AFTER * 2);
});

test("replay: an advice followed by a different command is 'changed' and keeps the family advised", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER * 2; i++) {
    const at = T0 + i * 15 * MINUTE;
    records.push(record(at, { commandFamily: "gh cli" }));
    if (i % 4 !== 0) records.push(record(at + MINUTE, { commandFamily: "gh cli", verdict: "allow", stopReason: "advice-retry" }));
    else records.push(record(at + MINUTE, { commandFamily: "gh cli", verdict: "allow", stopReason: "contained", source: "local-rule" }));
  }
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.retried, SILENT_AFTER * 2 - 4);
  assert.equal(replay.wouldBeSilent, 0, "never SILENT_AFTER identical retries in a row");
});
