// feature-modules T0: what each feature module costs today -- hook spawns,
// Jev calls and worker wakeups -- read from synthetic rows shaped like the
// real logs (gate decisions, mod measurements, router, steward, model
// reclassifications), Claude Code transcript lines and Orca's plugin audit log.

import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSetsByKey,
  boardCliRefreshes,
  buildModuleCostReport,
  derivedHookSpawns,
  finishTranscriptTally,
  formatModuleCostReport,
  gateJevCalls,
  modelDecisionJevCalls,
  newTranscriptTally,
  ourHooksFromSettings,
  percentile,
  routerJevCalls,
  skillJevCalls,
  stewardJevCalls,
  tallyTranscriptLine,
  toolJevCalls,
  verifyDoneJevCalls,
  WORKER_TASKS,
} from "./module_cost.ts";
import { MAX_JEV_CHOICES } from "./jev.ts";

const SINCE = Date.parse("2026-10-01T00:00:00.000Z");
const UNTIL = Date.parse("2026-10-08T00:00:00.000Z");
const WINDOW = { sinceMs: SINCE, untilMs: UNTIL };
const AT = "2026-10-03T10:00:00.000Z";

test("percentile is nearest-rank and null with no sample", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([30, 10, 20], 50), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("gate: a jev row is one call, an unreachable row is one failed call, cache and local rules are none", () => {
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", latencyMs: 420 }), { calls: 1, failures: 0, latencyMs: [420] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", latencyMs: null }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "none", stopReason: "unreachable", latencyMs: null }), { calls: 1, failures: 1, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "cache", latencyMs: null }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "local-rule", latencyMs: null }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls("not a row"), { calls: 0, failures: 0, latencyMs: [] });
});

test("gate: an identical retry passed before any Jev call (no latency) is no call; one after a call is", () => {
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", stopReason: "advice-retry", latencyMs: null }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(gateJevCalls({ type: "gate-decision", at: AT, source: "jev", stopReason: "advice-retry", latencyMs: 410 }), { calls: 1, failures: 0, latencyMs: [410] });
});

test("skills: wide is one call, fit one more when it ran; a null result after a latency is a failure", () => {
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: null, latencyMs: { wide: 400, fit: null } }), { calls: 1, failures: 0, latencyMs: [400] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: { winner: "x" }, latencyMs: { wide: 400, fit: 250 } }), { calls: 2, failures: 0, latencyMs: [400, 250] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: null, fit: null, latencyMs: { wide: 3000, fit: null } }), { calls: 1, failures: 1, latencyMs: [3000] });
  assert.deepEqual(skillJevCalls({ type: "decision", at: AT, wide: { gate: 0.7 }, fit: null, latencyMs: { wide: 400, fit: 3000 } }), { calls: 2, failures: 1, latencyMs: [400, 3000] });
  assert.deepEqual(skillJevCalls({ type: "observation", at: AT, skill: "x" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("tools: the wide stage is one call per batch of the roster", () => {
  const twoBatches = MAX_JEV_CHOICES + 60;
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: twoBatches, wide: { gate: 0.3 }, fit: null, latencyMs: { wide: 395, fit: null } }), { calls: 2, failures: 0, latencyMs: [395] });
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: 40, wide: { gate: 0.3 }, fit: { winner: "Bash" }, latencyMs: { wide: 300, fit: 200 } }), { calls: 2, failures: 0, latencyMs: [300, 200] });
  assert.deepEqual(toolJevCalls({ type: "decision", at: AT, candidateCount: 40, wide: null, fit: null, latencyMs: { wide: 3000, fit: null } }), { calls: 1, failures: 1, latencyMs: [3000] });
  assert.deepEqual(toolJevCalls({ type: "observation", at: AT, tool: "Bash" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("router: a row with a confidence or jev-failed is a call; an engine turn (no confidence) is not", () => {
  assert.deepEqual(routerJevCalls({ at: AT, point: "start", tier: "simple", confidence: 0.9, reason: "same" }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(routerJevCalls({ at: AT, point: "stage", tier: null, confidence: null, reason: "jev-failed" }), { calls: 1, failures: 1, latencyMs: [] });
  assert.deepEqual(routerJevCalls({ at: AT, point: "stage", tier: null, confidence: null, reason: "floor-restore" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("model reclassification: a decision row is one call, an outcome row none", () => {
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, source: "jev", failOpen: null, latencyMs: 800 }), { calls: 1, failures: 0, latencyMs: [800] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, source: "none", failOpen: "jev-unreachable", latencyMs: 6000 }), { calls: 1, failures: 1, latencyMs: [6000] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, source: "none", failOpen: "no-key", latencyMs: 0 }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-decision", at: AT, source: "none", failOpen: "empty-ladder", latencyMs: 0 }), { calls: 0, failures: 0, latencyMs: [] });
  assert.deepEqual(modelDecisionJevCalls({ type: "model-outcome", at: AT, status: "async_launched" }), { calls: 0, failures: 0, latencyMs: [] });
});

test("steward: a row is one call; a null verdict is a failure", () => {
  assert.deepEqual(stewardJevCalls({ at: AT, verdict: "mid-task", confidence: 0.8 }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(stewardJevCalls({ at: AT, verdict: null, confidence: null }), { calls: 1, failures: 1, latencyMs: [] });
});

test("verify-done: a row is one call with its latency; a jev-failed row is a failure", () => {
  assert.deepEqual(verifyDoneJevCalls({ at: AT, decision: "would-block", claim: "claimed-done", latencyMs: 420 }), { calls: 1, failures: 0, latencyMs: [420] });
  assert.deepEqual(verifyDoneJevCalls({ at: AT, decision: "jev-failed", claim: null, latencyMs: 3001 }), { calls: 1, failures: 1, latencyMs: [3001] });
  assert.deepEqual(verifyDoneJevCalls({ at: AT, decision: "no-claim", claim: "no-claim" }), { calls: 1, failures: 0, latencyMs: [] });
  assert.deepEqual(verifyDoneJevCalls("not a row"), { calls: 0, failures: 0, latencyMs: [] });
});

test("our hooks are read from settings.json by status message and script, other hooks ignored", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/gate-bash.ts"], statusMessage: "orca-jev-advisor: checks" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "bash other.sh" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/gate-files.mjs"], statusMessage: "orca-jev-advisor: edit" }] },
      ],
      PostToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "node", args: ["/x/adapters/claude/agent-model.ts"], statusMessage: "orca-jev-advisor: model" }] }],
    },
  };
  assert.deepEqual(ourHooksFromSettings(settings), [
    { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" },
    { event: "PreToolUse", matcher: "Edit|Write", script: "gate-files", module: "gate" },
    { event: "PostToolUse", matcher: "Agent", script: "agent-model", module: "model-router" },
  ]);
  assert.deepEqual(ourHooksFromSettings(null), []);
});

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

test("transcript tally dedupes tool calls, prompts and turns, and times our Bash hook", () => {
  const tally = newTranscriptTally();
  const ts = "2026-10-03T10:00:00.000Z";
  const toolUse = line({ type: "assistant", uuid: "a1", timestamp: ts, message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }, { type: "tool_use", id: "t2", name: "Edit" }] } });
  for (const text of [
    line({ type: "user", uuid: "p1", timestamp: ts, message: { content: "please do it" } }),
    line({ type: "user", uuid: "p1", timestamp: ts, message: { content: "please do it" } }),
    line({ type: "user", uuid: "m1", timestamp: ts, isMeta: true, message: { content: "meta" } }),
    line({ type: "user", uuid: "c1", timestamp: ts, message: { content: "<command-name>/x</command-name>" } }),
    line({ type: "user", uuid: "s1", timestamp: ts, isSidechain: true, message: { content: "subagent task" } }),
    toolUse,
    toolUse,
    line({ type: "user", uuid: "r1", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } }),
    line({ type: "attachment", uuid: "h1", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 120, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h1b", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 120, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h2", timestamp: ts, attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "other-guard.py", durationMs: 9, toolUseID: "t1" } }),
    line({ type: "attachment", uuid: "h3", timestamp: ts, attachment: { type: "hook_cancelled", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash", command: "orca-jev-advisor: checks", durationMs: 6000, toolUseID: "t9" } }),
    line({ type: "system", subtype: "turn_duration", uuid: "d1", timestamp: ts }),
    line({ type: "system", subtype: "turn_duration", uuid: "d1", timestamp: ts }),
    line({ type: "system", subtype: "turn_duration", uuid: "d0", timestamp: "2026-09-01T00:00:00.000Z" }),
    "not json",
  ]) {
    tallyTranscriptLine(tally, text, WINDOW);
  }
  assert.deepEqual(Object.fromEntries(tally.toolCalls), { Bash: 1, Edit: 1 });
  assert.deepEqual(Object.fromEntries(tally.toolErrors), { Bash: 1 });
  assert.equal(tally.prompts, 1);
  assert.equal(tally.turns, 1);
  assert.deepEqual(tally.gateBashHookMs, [120]);
  assert.equal(tally.gateHookCancelled, 1);
});

test("derived hook spawns: Pre per call, Post per success, PostFailure per error, PermissionDenied not observable", () => {
  const hooks = [
    { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" as const },
    { event: "PostToolUse", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PostToolUseFailure", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PermissionDenied", matcher: "Bash", script: "gate-outcome", module: "gate" as const },
    { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "gate-files", module: "gate" as const },
    { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" as const },
    { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" as const },
  ];
  const spawns = derivedHookSpawns(hooks, new Map([["Bash", 10], ["Edit", 3], ["Write", 1], ["Read", 50], ["Agent", 2]]), new Map([["Bash", 4]]));
  assert.deepEqual(spawns, { gate: 24, "model-router": 2, steward: 0, "skill-selection": 0, board: 0, "verify-done": 0 });
});

test("audit sets count ok outcomes of our plugin only, in the window", () => {
  const rows = [
    line({ ts: Date.parse(AT), actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "attempt" }),
    line({ ts: Date.parse(AT), actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "ok" }),
    line({ ts: Date.parse(AT) + 1000, actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board extra", outcome: "ok" }),
    line({ ts: Date.parse(AT), actor: "plugin:someone.else", method: "storage.set", summary: "key=board", outcome: "ok" }),
    line({ ts: SINCE - 1, actor: "plugin:ab2web.orca-jev-advisor", method: "storage.set", summary: "key=board", outcome: "ok" }),
  ];
  const audit = auditSetsByKey(rows, "plugin:ab2web.orca-jev-advisor", WINDOW);
  assert.deepEqual(audit.times.get("board"), [Date.parse(AT), Date.parse(AT) + 1000]);
  assert.equal(audit.firstMs, Date.parse(AT));
  assert.equal(audit.lastMs, Date.parse(AT) + 1000);
});

test("board CLI refreshes: one per event that arrives after the 30 s cache expired", () => {
  assert.equal(boardCliRefreshes([], 30_000), 0);
  assert.equal(boardCliRefreshes([0, 10_000, 29_999, 30_000, 31_000, 100_000], 30_000), 3);
});

test("worker tasks: every timer names its cadence and the modules it serves", () => {
  const measurements = WORKER_TASKS.filter((task) => task.intervalMs === 15_000 && task.sidecarsPerRun === 1);
  assert.equal(measurements.length, 3);
  assert.ok(WORKER_TASKS.some((task) => task.owner === "board" && task.trigger.startsWith("event")));
  assert.ok(WORKER_TASKS.some((task) => task.owner === "base"));
});

// verify-done (0.8.0 V5): before any verify-done row exists, what shadow would
// cost is the main-thread person turns its own rule (isVerifyDoneCandidate)
// would ask Jev about, read from the transcripts.
test("transcript tally: person turns that edited files with no passing test are the verify-done candidates", () => {
  const tally = newTranscriptTally();
  const ts = "2026-10-03T10:00:00.000Z";
  const prompt = (uuid: string, session: string, extra: Record<string, unknown> = {}): string => line({ type: "user", uuid, sessionId: session, timestamp: ts, message: { content: `prompt ${uuid}` }, ...extra });
  const uses = (uuid: string, session: string, parts: Record<string, unknown>[], extra: Record<string, unknown> = {}): string => line({ type: "assistant", uuid, sessionId: session, timestamp: ts, message: { content: parts }, ...extra });
  const result = (uuid: string, session: string, id: string, content: unknown, isError = false): string => line({ type: "user", uuid, sessionId: session, timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
  for (const text of [
    // s1 turn 1: an edit and no test -- a candidate.
    prompt("p1", "s1"),
    uses("a1", "s1", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/a.ts" } }]),
    // s2 turn 1, interleaved: an edit and a passing test -- not one.
    prompt("q1", "s2"),
    uses("b1", "s2", [{ type: "tool_use", id: "e2", name: "Write", input: { file_path: "src/b.ts" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }]),
    result("r2", "s2", "t2", "ℹ pass 9\nℹ fail 0"),
    // s1 turn 2: an edit and a failing test (text in content parts) -- a candidate.
    prompt("p2", "s1"),
    uses("a2", "s1", [{ type: "tool_use", id: "e3", name: "Edit", input: { file_path: "src/a.ts" } }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }]),
    result("r3", "s1", "t3", [{ type: "text", text: "ℹ pass 8\nℹ fail 1" }]),
    // s1 turn 3: reading only -- not one. A subagent's edit on the side chain does not count.
    prompt("p3", "s1"),
    uses("a3", "s1", [{ type: "tool_use", id: "x3", name: "Read", input: { file_path: "src/a.ts" } }]),
    uses("a4", "s1", [{ type: "tool_use", id: "x4", name: "Edit", input: { file_path: "src/c.ts" } }], { isSidechain: true }),
    // s2 turn 2: an edit, its test errored -- a candidate (closed only by finishTranscriptTally).
    prompt("q2", "s2"),
    uses("b2", "s2", [{ type: "tool_use", id: "e5", name: "MultiEdit", input: { file_path: "src/d.ts" } }, { type: "tool_use", id: "t5", name: "Bash", input: { command: "node --test" } }]),
    result("r5", "s2", "t5", "boom", true),
    // Outside the window: never counted.
    line({ type: "user", uuid: "old", sessionId: "s3", timestamp: "2026-09-01T00:00:00.000Z", message: { content: "old prompt" } }),
  ]) {
    tallyTranscriptLine(tally, text, WINDOW);
  }
  assert.equal(tally.verifyDoneCandidates, 2, "two turns closed by a later prompt are candidates so far");
  finishTranscriptTally(tally);
  assert.equal(tally.verifyDoneTurns, 5);
  assert.equal(tally.verifyDoneCandidates, 3);
  finishTranscriptTally(tally);
  assert.equal(tally.verifyDoneTurns, 5, "finishing twice counts nothing twice");
});

test("report: per module totals, per prompt and per turn ratios, and a markdown table", () => {
  const tally = newTranscriptTally();
  tally.toolCalls.set("Bash", 100);
  tally.toolCalls.set("Agent", 2);
  tally.prompts = 10;
  tally.turns = 20;
  tally.verifyDoneTurns = 10;
  tally.verifyDoneCandidates = 4;
  tally.gateBashHookMs.push(100, 200, 300);
  const report = buildModuleCostReport({
    window: WINDOW,
    tally,
    hooks: [
      { event: "PreToolUse", matcher: "Bash", script: "gate-bash", module: "gate" },
      { event: "PreToolUse", matcher: "Agent", script: "agent-model", module: "model-router" },
    ],
    rows: {
      gate: [{ at: AT, source: "jev", latencyMs: 500 }, { at: AT, source: "cache", latencyMs: null }, { at: "2026-09-01T00:00:00.000Z", source: "jev", latencyMs: 9 }],
      skills: [{ type: "decision", at: AT, mode: "active", wide: {}, fit: null, latencyMs: { wide: 400, fit: null } }],
      tools: [{ type: "decision", at: AT, mode: "active", candidateCount: 10, wide: {}, fit: {}, latencyMs: { wide: 300, fit: 100 } }],
      router: [{ at: AT, point: "start", confidence: 0.9, reason: "same" }],
      models: [{ type: "model-decision", at: AT, source: "jev", failOpen: null, latencyMs: 700 }],
      steward: [{ at: AT, verdict: "mid-task" }],
      verifyDone: [
        { at: AT, decision: "would-block", claim: "claimed-done", latencyMs: 300 },
        { at: AT, decision: "would-block", claim: "claimed-done", latencyMs: 500 },
        { at: AT, decision: "claimed-unverified-low-confidence", claim: "claimed-done", latencyMs: 400 },
        { at: AT, decision: "jev-failed", claim: null, latencyMs: 3000 },
        { at: "2026-09-01T00:00:00.000Z", decision: "would-block", claim: "claimed-done", latencyMs: 1 },
      ],
    },
    audit: { times: new Map([["board", [Date.parse(AT), Date.parse(AT) + 3_600_000]], ["measurementsSummary", [Date.parse(AT)]]]), firstMs: Date.parse(AT), lastMs: Date.parse(AT) + 3_600_000 },
  });
  const gate = report.modules.find((row) => row.module === "gate");
  assert.ok(gate);
  assert.equal(gate.hookSpawns, 100);
  assert.equal(gate.hookMsP50, 200);
  assert.equal(gate.jevCalls, 1);
  assert.equal(gate.jevPerPrompt, 0.1);
  assert.equal(gate.jevPerTurn, 0.05);
  assert.equal(gate.jevMsP50, 500);
  const skills = report.modules.find((row) => row.module === "skill-selection");
  assert.ok(skills);
  assert.equal(skills.jevCalls, 3);
  assert.equal(skills.hookSpawns, 0);
  const router = report.modules.find((row) => row.module === "model-router");
  assert.ok(router);
  assert.equal(router.jevCalls, 2);
  assert.equal(router.hookSpawns, 2);
  assert.deepEqual(report.modes.skills, { active: 1 });
  assert.equal(report.audit.spanHours, 1);
  const board = report.worker.find((row) => row.auditKey === "board");
  assert.ok(board);
  assert.equal(board.observedPerHour, 2);
  const verifyDone = report.modules.find((row) => row.module === "verify-done");
  assert.ok(verifyDone);
  assert.equal(verifyDone.jevCalls, 4);
  assert.equal(verifyDone.jevFailures, 1);
  assert.equal(verifyDone.jevPerPrompt, 0.4);
  assert.equal(verifyDone.jevMsP50, 400);
  assert.equal(verifyDone.jevMsP90, 3000);
  assert.equal(verifyDone.hookSpawns, 0);
  assert.deepEqual(report.verifyDone, { decisions: 4, claims: 3, wouldBlock: 2, jevFailed: 1, candidateTurns: 4, personTurns: 10, candidatesPerPrompt: 0.4 });
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /\| gate \|/);
  assert.match(text, /\| skill-selection \|/);
  assert.match(text, /\| verify-done \| 0 \| - \| - \| 4 \| 0\.4 \|/);
  assert.match(text, /verify-done: 2 would-block turns \(claimed done, unverified\) of 4 logged; 3 claims of done, 1 Jev failures\. Transcripts: 4 of 10 person turns are candidates \(0\.4 per prompt\)\./);
});
