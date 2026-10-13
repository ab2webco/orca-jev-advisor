// The memory module in Shadow (odd/tasks/memory-shadow.md, M8): the row it
// logs per decision, the fork sample, what the main thread was seen saving,
// the dry judge, and the weekly summary the card shows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectMemoryBackend } from "./memory_detect.ts";
import type { MemorySignals } from "./memory_detect.ts";
import {
  EMPTY_SEEN,
  FORK_SAMPLE_EVERY,
  MEMORY_DECISIONS_FILE_PATTERN,
  agreementOf,
  classifyMainCall,
  draftCounts,
  dryJudgeBuilds,
  isForkSampled,
  memoryDecisionFileName,
  memoryReplayRecord,
  memoryShadowRecord,
  NO_WRITES,
  memoryTopics,
  noteMainCall,
  readMemSaveCandidates,
  summarizeMemoryDecisions,
  withinBudget,
} from "./memory_shadow.ts";
import type { MemoryShadowRecordInput } from "./memory_shadow.ts";

const NONE: MemorySignals = { liveServer: null, health: null, userConfigured: false, pluginEnabled: false, binaryVersion: null };
const LIVE = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "ok" });
const ABSENT = detectMemoryBackend(NONE);
const DIR = "/acct/projects/-repo/memory";

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_shadow.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The log file
// ---------------------------------------------------------------------------

test("file: one file per hour, next to the other decision logs", () => {
  assert.equal(memoryDecisionFileName("2026-10-12T09:41:00.000Z"), "memory-decisions-2026-10-12T09.jsonl");
  assert.ok(MEMORY_DECISIONS_FILE_PATTERN.test("memory-decisions-2026-10-12T09.jsonl"));
  assert.ok(!MEMORY_DECISIONS_FILE_PATTERN.test("verify-done-decisions-2026-10-12T09.jsonl"));
});

// ---------------------------------------------------------------------------
// The fork sample
// ---------------------------------------------------------------------------

test("sample: a fixed 1 in 5, deterministic per session and turn", () => {
  assert.equal(FORK_SAMPLE_EVERY, 5);
  const turns = Array.from({ length: 2000 }, (_, i) => `turn-${i}`);
  const sampled = turns.filter((turn) => isForkSampled("session-1", turn)).length;
  assert.ok(sampled > 300 && sampled < 500, `about a fifth: ${sampled}`);
  for (const turn of turns.slice(0, 50)) assert.equal(isForkSampled("session-1", turn), isForkSampled("session-1", turn));
  assert.notDeepEqual(turns.slice(0, 50).map((t) => isForkSampled("a", t)), turns.slice(0, 50).map((t) => isForkSampled("b", t)), "the session takes part");
  assert.equal(typeof isForkSampled(null, "turn-1"), "boolean");
});

// ---------------------------------------------------------------------------
// The main thread's own memory calls
// ---------------------------------------------------------------------------

test("observe: mem_save and mem_judge on either Engram server, and a Write or Edit of a .md in the memory dir", () => {
  assert.equal(classifyMainCall("mcp__engram__mem_save", {}, DIR), "engram-save");
  assert.equal(classifyMainCall("mcp__plugin_engram_engram__mem_save", {}, DIR), "engram-save");
  assert.equal(classifyMainCall("mcp__engram__mem_judge", {}, DIR), "engram-judge");
  assert.equal(classifyMainCall("Write", { file_path: `${DIR}/feedback_tu.md` }, DIR), "auto-memory-write");
  assert.equal(classifyMainCall("Edit", { file_path: `${DIR}/MEMORY.md` }, DIR), "auto-memory-write");
  assert.equal(classifyMainCall("MultiEdit", { file_path: `${DIR}/x.md` }, `${DIR}/`), "auto-memory-write", "a trailing slash on the dir");
});

test("observe: anything else is not a memory call", () => {
  assert.equal(classifyMainCall("mcp__engram__mem_search", {}, DIR), null, "a read");
  assert.equal(classifyMainCall("mcp__other__mem_save", {}, DIR), null);
  assert.equal(classifyMainCall("Write", { file_path: "/repo/src/a.md" }, DIR), null);
  assert.equal(classifyMainCall("Write", { file_path: `${DIR}-other/a.md` }, DIR), null, "a sibling folder with the same prefix");
  assert.equal(classifyMainCall("Write", { file_path: `${DIR}/notes.txt` }, DIR), null);
  assert.equal(classifyMainCall("Read", { file_path: `${DIR}/a.md` }, DIR), null);
  assert.equal(classifyMainCall("Write", { file_path: `${DIR}/a.md` }, null), null, "no dir known");
  assert.equal(classifyMainCall("Write", {}, DIR), null);
});

test("observe: counts by kind and by Engram type, and the candidates' title and type, never their content", () => {
  let seen = noteMainCall(EMPTY_SEEN, "engram-save", { type: "policy", candidates: [{ title: "Spanish with vos", type: "policy" }] });
  seen = noteMainCall(seen, "engram-save", { type: undefined, candidates: [] });
  seen = noteMainCall(seen, "engram-judge", {});
  seen = noteMainCall(seen, "auto-memory-write", {});
  assert.deepEqual(seen, {
    engramSaves: 2,
    engramSaveTypes: { policy: 1, manual: 1 },
    judges: 1,
    autoMemoryWrites: 1,
    candidates: [{ title: "Spanish with vos", type: "policy" }],
  });
  assert.deepEqual(EMPTY_SEEN, { engramSaves: 0, engramSaveTypes: {}, judges: 0, autoMemoryWrites: 0, candidates: [] }, "never mutated");
});

test("observe: the candidates of a mem_save answer, from the tool result in any of the shapes core hands back", () => {
  const envelope = JSON.stringify({ id: 12, judgment_required: true, candidates: [{ id: 3, title: "Old rule", type: "policy", judgment_id: "rel-1" }] });
  const expected = [{ title: "Old rule", type: "policy" }];
  assert.deepEqual(readMemSaveCandidates({ content: [{ type: "text", text: envelope }], isError: false }), expected);
  assert.deepEqual(readMemSaveCandidates([{ type: "text", text: envelope }]), expected);
  assert.deepEqual(readMemSaveCandidates(envelope), expected);
  assert.deepEqual(readMemSaveCandidates({ content: [{ type: "text", text: "Failed to save" }], isError: true }), []);
  assert.deepEqual(readMemSaveCandidates(undefined), []);
});

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

test("agreement: the gate's verdict against what the main thread saved in the same turn", () => {
  assert.equal(agreementOf("update", true), "both");
  assert.equal(agreementOf("update", false), "module-only");
  assert.equal(agreementOf("skip", true), "main-only");
  assert.equal(agreementOf("skip", false), "neither");
  assert.equal(agreementOf("malformed", true), "unknown");
  assert.equal(agreementOf("no-answer", false), "unknown");
});

// ---------------------------------------------------------------------------
// The draft and the dry judge
// ---------------------------------------------------------------------------

const save = (type: "user" | "feedback" | "project" | "reference", key: string) => ({ type, title: key, content: `fact ${key}`, topic_key: key });

test("draft counts: by type, and where each save would go on this backend", () => {
  const draft = { saves: [save("feedback", "a"), save("user", "b"), save("project", "c")], updates: [{ name: "x.md", content: "y" }], deletes: ["z.md"] };
  assert.deepEqual(draftCounts(draft, LIVE), { wouldSave: { user: 1, feedback: 1, project: 1, reference: 0 }, wouldUpdate: 1, wouldDelete: 1, toEngram: 3, toAutoMemory: 2 });
  assert.deepEqual(draftCounts(draft, ABSENT), { wouldSave: { user: 1, feedback: 1, project: 1, reference: 0 }, wouldUpdate: 1, wouldDelete: 1, toEngram: 0, toAutoMemory: 3 });
});

test("dry judge: one prompt built per drafted save and candidate seen; none without a candidate; nothing is asked", () => {
  const saves = [save("feedback", "a"), save("project", "b")];
  const candidates = [{ title: "Old rule", type: "policy" }, { title: "Old fact", type: "discovery" }];
  assert.equal(dryJudgeBuilds(saves, candidates), 4);
  assert.equal(dryJudgeBuilds(saves, []), 0);
  assert.equal(dryJudgeBuilds([], candidates), 0);
});

test("topics: the topic keys of the auto-memory files, for the fork when Engram is live", () => {
  const files = {
    "a.md": "---\nname: a\nmetadata:\n  type: feedback\n  topic_key: spanish-tu\n---\n\nx\n",
    "b.md": "---\nname: b\n---\n\nno key\n",
    "c.md": "---\nmetadata:\n  topic_key: merge-email\n---\n",
  };
  assert.deepEqual(memoryTopics(files), ["merge-email", "spanish-tu"]);
});

test("budget: at most N files and C characters, whole files only, MEMORY.md left out", () => {
  const files: Record<string, string> = { "MEMORY.md": "index", "a.md": "aaaa", "b.md": "bbbb", "c.md": "cc" };
  assert.deepEqual(withinBudget(files, 2, 100), { "a.md": "aaaa", "b.md": "bbbb" });
  assert.deepEqual(withinBudget(files, 10, 6), { "a.md": "aaaa", "c.md": "cc" });
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

const BASE: MemoryShadowRecordInput = {
  at: "2026-10-12T09:00:00.000Z",
  account: "acct-1",
  project: "repo",
  sessionId: "session-1",
  backend: LIVE,
  detectedAt: "start",
  gate: "update",
  gateMs: 420,
  gateUsage: { input_tokens: 900, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  fork: "drafted",
  forkMs: 5100,
  forkUsage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 2_000 },
  draft: { wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 }, wouldUpdate: 0, wouldDelete: 0, toEngram: 1, toAutoMemory: 1 },
  judgeBuilds: 1,
  seen: { engramSaves: 1, engramSaveTypes: { policy: 1 }, judges: 2, autoMemoryWrites: 0, candidates: [{ title: "Secret title of an old rule", type: "policy" }] },
};

test("row: counts, types, outcomes and usage; no memory content, no titles", () => {
  const row = memoryShadowRecord(BASE);
  assert.deepEqual(row, {
    at: "2026-10-12T09:00:00.000Z",
    account: "acct-1",
    project: "repo",
    mode: "shadow",
    effective: "shadow",
    sessionId: "session-1",
    backend: "live",
    decidedBy: "tools+health",
    permission: "ok",
    detectedAt: "start",
    gate: "update",
    gateMs: 420,
    gateTokens: { input: 900, output: 9, cacheRead: 0, cacheWrite: 0 },
    forkSampled: true,
    fork: "drafted",
    forkMs: 5100,
    forkTokens: { input: 10, output: 300, cacheRead: 180_000, cacheWrite: 2_000 },
    wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 },
    wouldUpdate: 0,
    wouldDelete: 0,
    toEngram: 1,
    toAutoMemory: 1,
    judgeBuilds: 1,
    mainEngramSaves: 1,
    mainEngramSaveTypes: { policy: 1 },
    mainJudges: 2,
    mainCandidates: 1,
    mainAutoMemoryWrites: 0,
    agreement: "both",
    spooled: 0,
    written: 0,
    updated: 0,
    backups: 0,
    dropped: 0,
    writeFailures: 0,
    lockHeld: false,
  });
  assert.doesNotMatch(JSON.stringify(row), /Secret title/);
});

test("row in Active: the switch and what ran, and what it wrote, as counts only", () => {
  const writes = { spooled: 2, written: 1, updated: 1, backups: 1, dropped: 1, writeFailures: 0, lockHeld: false };
  const row = memoryShadowRecord({ ...BASE, backend: ABSENT, mode: "active", effective: "active", writes });
  assert.equal(row.mode, "active");
  assert.equal(row.effective, "active");
  assert.deepEqual(
    { spooled: row.spooled, written: row.written, updated: row.updated, backups: row.backups, dropped: row.dropped, writeFailures: row.writeFailures, lockHeld: row.lockHeld },
    writes,
  );
  const measuring = memoryShadowRecord({ ...BASE, mode: "active", effective: "shadow" });
  assert.equal(measuring.mode, "active");
  assert.equal(measuring.effective, "shadow", "Engram live: Active keeps measuring, and the row says so");
  assert.equal(measuring.written, 0);
  assert.deepEqual(NO_WRITES, { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false });
});

test("replay row: an event of its own, counts only", () => {
  const row = memoryReplayRecord({
    at: "2026-10-12T08:00:00.000Z",
    account: "acct-1",
    project: "repo",
    sessionId: "session-2",
    backend: ABSENT,
    items: 3,
    replayed: 2,
    superseded: 1,
    writes: { spooled: 0, written: 1, updated: 1, backups: 1, dropped: 0, writeFailures: 0, lockHeld: false },
  });
  assert.deepEqual(row, {
    at: "2026-10-12T08:00:00.000Z",
    account: "acct-1",
    project: "repo",
    event: "replay",
    mode: "active",
    effective: "active",
    sessionId: "session-2",
    backend: "absent",
    decidedBy: "none",
    permission: "unknown",
    items: 3,
    replayed: 2,
    superseded: 1,
    written: 1,
    updated: 1,
    backups: 1,
    writeFailures: 0,
    lockHeld: false,
  });
});

test("row: a skip has no fork; a gate with no answer has no usage", () => {
  const skip = memoryShadowRecord({ ...BASE, gate: "skip", fork: null, forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0, seen: EMPTY_SEEN });
  assert.equal(skip.forkSampled, false);
  assert.equal(skip.fork, null);
  assert.equal(skip.forkTokens, null);
  assert.deepEqual(skip.wouldSave, { user: 0, feedback: 0, project: 0, reference: 0 });
  assert.equal(skip.agreement, "neither");
  const failed = memoryShadowRecord({ ...BASE, gate: "no-answer", gateUsage: null, fork: null, forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0 });
  assert.equal(failed.gateTokens, null);
  assert.equal(failed.agreement, "unknown");
  const unsampled = memoryShadowRecord({ ...BASE, fork: "not-sampled", forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0 });
  assert.equal(unsampled.forkSampled, false);
  assert.equal(unsampled.agreement, "both", "an UPDATE agrees with a main save whether or not it was drafted");
});

test("row: an auto-memory write by the main thread counts as a main save", () => {
  const row = memoryShadowRecord({ ...BASE, gate: "skip", fork: null, forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0, seen: { ...EMPTY_SEEN, autoMemoryWrites: 1 } });
  assert.equal(row.agreement, "main-only");
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const WEEK = 7 * 24 * 3_600_000;

test("summary: the week's gates, UPDATE rate, forks, would-save by type, main saves and agreement; the latest backend", () => {
  const rows = [
    memoryShadowRecord({ ...BASE, at: "2026-10-12T09:00:00.000Z" }),
    memoryShadowRecord({ ...BASE, at: "2026-10-11T09:00:00.000Z", gate: "skip", fork: null, forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0, seen: EMPTY_SEEN }),
    memoryShadowRecord({ ...BASE, at: "2026-10-10T09:00:00.000Z", gate: "update", fork: "not-sampled", forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0, seen: EMPTY_SEEN }),
    memoryShadowRecord({ ...BASE, at: "2026-10-09T09:00:00.000Z", gate: "malformed", gateUsage: null, fork: null, forkMs: null, forkUsage: null, draft: null, judgeBuilds: 0 }),
    memoryShadowRecord({ ...BASE, at: "2026-10-01T09:00:00.000Z" }),
    "not a row",
    { at: "garbage" },
  ];
  const summary = summarizeMemoryDecisions(rows, NOW, WEEK);
  assert.deepEqual(summary, {
    decisions: 4,
    gates: 4,
    updates: 2,
    skips: 1,
    gateFailures: 1,
    updateRate: 2 / 3,
    forks: 1,
    drafts: 1,
    wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 },
    judgeBuilds: 1,
    mainEngramSaves: 2,
    mainJudges: 4,
    mainAutoMemoryWrites: 0,
    agreement: { both: 1, moduleOnly: 1, mainOnly: 0, neither: 1, unknown: 1 },
    agreementRate: 2 / 3,
    haikuTokens: { input: 2700, output: 27 },
    forkTokens: { input: 10, output: 300, cacheRead: 180_000 },
    latest: { at: "2026-10-12T09:00:00.000Z", backend: "live", decidedBy: "tools+health", permission: "ok" },
    activeDecisions: 0,
    draftFailures: 0,
    spooled: 0,
    written: 0,
    updated: 0,
    backups: 0,
    dropped: 0,
    writeFailures: 0,
    lockHeld: 0,
    replays: 0,
    replayed: 0,
  });
});

test("summary in Active: what was written, updated, spooled and replayed; a replay row is never a decision", () => {
  const writes = { spooled: 2, written: 1, updated: 1, backups: 1, dropped: 1, writeFailures: 0, lockHeld: false };
  const rows = [
    memoryShadowRecord({ ...BASE, at: "2026-10-12T09:00:00.000Z", backend: ABSENT, mode: "active", effective: "active", writes }),
    memoryShadowRecord({ ...BASE, at: "2026-10-12T08:00:00.000Z", backend: ABSENT, mode: "active", effective: "active", fork: "unparsable", forkUsage: null, draft: null, judgeBuilds: 0 }),
    memoryShadowRecord({ ...BASE, at: "2026-10-12T07:00:00.000Z", backend: ABSENT, mode: "active", effective: "active", writes: { ...NO_WRITES, spooled: 1, lockHeld: true } }),
    memoryShadowRecord({ ...BASE, at: "2026-10-12T06:00:00.000Z", mode: "active", effective: "shadow" }),
    memoryReplayRecord({ at: "2026-10-12T10:00:00.000Z", account: "acct-1", project: "repo", sessionId: "session-2", backend: ABSENT, items: 2, replayed: 1, superseded: 0, writes: { ...NO_WRITES, written: 1, writeFailures: 1 } }),
  ];
  const summary = summarizeMemoryDecisions(rows, NOW, WEEK);
  assert.equal(summary.decisions, 4, "the replay row is not a decision");
  assert.equal(summary.gates, 4);
  assert.equal(summary.activeDecisions, 3, "the row that only measured under a live Engram is not an Active one");
  assert.equal(summary.draftFailures, 1);
  assert.equal(summary.spooled, 3);
  assert.equal(summary.written, 2, "one at a turn, one at the replay");
  assert.equal(summary.updated, 1);
  assert.equal(summary.backups, 1);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.writeFailures, 1);
  assert.equal(summary.lockHeld, 1);
  assert.equal(summary.replays, 1);
  assert.equal(summary.replayed, 1);
  assert.equal(summary.latest?.backend, "absent");
});

test("summary: no rows is zeros and nulls, never a division by zero", () => {
  const summary = summarizeMemoryDecisions([], NOW, WEEK);
  assert.equal(summary.decisions, 0);
  assert.equal(summary.updateRate, null);
  assert.equal(summary.agreementRate, null);
  assert.equal(summary.latest, null);
});
