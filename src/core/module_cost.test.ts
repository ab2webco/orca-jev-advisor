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
  // G8: a 402 (the key has no credit) is a failed call too.
  assert.deepEqual(routerJevCalls({ at: AT, point: "stage", tier: null, confidence: null, reason: "jev-payment" }), { calls: 1, failures: 1, latencyMs: [] });
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
  assert.deepEqual(spawns, { gate: 24, "model-router": 2, steward: 0, "skill-selection": 0, board: 0, "verify-done": 0, "ci-watch": 0 });
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

// ci-watch (0.9.0 C6): the 580 polls and 800 sleeps a week the module exists
// for are counted with the module's own predicates (src/core/ci_watch.ts), on
// the main thread only, so the baseline and the shadow figure are comparable.
test("transcript tally: the main thread's CI polls and sleeps, by the module's own predicates", () => {
  const tally = newTranscriptTally();
  const ts = "2026-10-03T10:00:00.000Z";
  const bash = (uuid: string, id: string, command: string, extra: Record<string, unknown> = {}): string =>
    line({ type: "assistant", uuid, sessionId: "s1", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] }, ...extra });
  for (const text of [
    bash("a1", "t1", "gh run list --branch main"),
    bash("a2", "t2", "gh run watch 5 --exit-status"),
    bash("a3", "t3", "gh pr checks 53"),
    bash("a4", "t4", "sleep 60 && gh run view 5"),
    bash("a5", "t5", "sleep 90"),
    bash("a6", "t6", "sleep 2"),
    bash("a7", "t7", "gh pr view 53"),
    bash("a8", "t8", "ls"),
    // A subagent's calls are its own business.
    bash("a9", "t9", "gh run list", { isSidechain: true }),
    bash("a10", "t10", "sleep 300", { isSidechain: true }),
    // The same tool call twice in the transcript counts once.
    bash("a11", "t1", "gh run list --branch main"),
    // Outside the window.
    line({ type: "assistant", uuid: "old", sessionId: "s1", timestamp: "2026-09-01T00:00:00.000Z", message: { content: [{ type: "tool_use", id: "t99", name: "Bash", input: { command: "gh run list" } }] } }),
  ]) {
    tallyTranscriptLine(tally, text, WINDOW);
  }
  assert.equal(tally.ciPolls, 4, "gh run list, gh run watch, gh pr checks, and the poll behind a sleep");
  assert.equal(tally.ciSleeps, 1, "sleep 90: a sleep of 10 s or more that is no poll");
  assert.equal(tally.anySleeps, 3, "the baseline's reading: every sleep, whatever its length or company");
});

test("report: per module totals, per prompt and per turn ratios, and a markdown table", () => {
  const tally = newTranscriptTally();
  tally.toolCalls.set("Bash", 100);
  tally.toolCalls.set("Agent", 2);
  tally.prompts = 10;
  tally.turns = 20;
  tally.verifyDoneTurns = 10;
  tally.verifyDoneCandidates = 4;
  tally.ciPolls = 50;
  tally.ciSleeps = 30;
  tally.anySleeps = 80;
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
      ciWatch: [
        { at: AT, outcome: "success", ghCalls: 9, agentPolls: 4, agentSleeps: 3, injected: false },
        { at: AT, outcome: "failure", ghCalls: 12, agentPolls: 2, agentSleeps: 1, injected: true },
        { at: AT, outcome: "no-runs", ghCalls: 8, agentPolls: 0, agentSleeps: 0, injected: false },
        { at: "2026-09-01T00:00:00.000Z", outcome: "success", ghCalls: 99, agentPolls: 99, agentSleeps: 99, injected: true },
      ],
      memory: [],
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
  const ciWatch = report.modules.find((row) => row.module === "ci-watch");
  assert.ok(ciWatch);
  assert.equal(ciWatch.jevCalls, 0, "it makes no Jev call");
  assert.equal(ciWatch.hookSpawns, 0);
  assert.deepEqual(report.ciWatch, { watches: 3, finished: 2, failed: 1, ghCalls: 29, pollsReplaced: 6, sleepsReplaced: 4, injected: 1, mainThreadPolls: 50, mainThreadLongSleeps: 30, mainThreadSleeps: 80 });
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /\| gate \|/);
  assert.match(text, /\| skill-selection \|/);
  assert.match(text, /\| verify-done \| 0 \| - \| - \| 4 \| 0\.4 \|/);
  assert.match(text, /ci-watch: 3 watches \(2 ended with a verdict, 1 failed\), 29 gh calls; during them the agent made 6 CI polls and 4 sleeps of 10 s or more that a note would replace, 1 notes sent\. Main thread in the window: 50 CI polls, 30 sleeps of 10 s or more, 80 sleeps of any length\./);
  assert.match(text, /verify-done: 2 would-block turns \(claimed done, unverified\) of 4 logged; 3 claims of done, 1 Jev failures\. Transcripts: 4 of 10 person turns are candidates \(0\.4 per prompt\)\./);
});

// ---------------------------------------------------------------------------
// Memory (odd/tasks/memory-shadow.md, M15): what the main thread spends on
// Engram today, from the transcripts, and what the module spends in the
// background, from its own log. Claude Code writes one transcript line per
// content block, so a response is its message.id, never a line.
// ---------------------------------------------------------------------------

function engramLine(messageId: string, toolUseId: string, tool: string, extra: Record<string, unknown> = {}): string {
  return line({ type: "assistant", uuid: `${messageId}-${toolUseId}`, timestamp: AT, ...extra, message: { id: messageId, content: [{ type: "tool_use", id: toolUseId, name: tool }] } });
}

test("transcript tally: main-thread Engram calls by tool, and the responses that held only Engram calls, by message id", () => {
  const tally = newTranscriptTally();
  for (const text of [
    line({ type: "user", uuid: "p1", timestamp: AT, message: { content: "guarda esto" } }),
    // One response written as two lines: a save and a judge.
    engramLine("m1", "e1", "mcp__engram__mem_save"),
    engramLine("m1", "e2", "mcp__engram__mem_judge"),
    // A judge alone, its line written twice.
    engramLine("m2", "j1", "mcp__engram__mem_judge"),
    engramLine("m2", "j1", "mcp__engram__mem_judge"),
    // A search next to real work: it holds an Engram call, but not only Engram calls.
    engramLine("m3", "s1", "mcp__engram__mem_search"),
    engramLine("m3", "b1", "Bash"),
    // A subagent's save is not the main thread's.
    engramLine("m4", "x1", "mcp__engram__mem_save", { isSidechain: true }),
    // The plugin's server spelling.
    engramLine("m6", "p1", "mcp__plugin_engram_engram__mem_save"),
    // Outside the window.
    line({ type: "assistant", uuid: "old", timestamp: "2026-09-01T00:00:00.000Z", message: { id: "m0", content: [{ type: "tool_use", id: "o1", name: "mcp__engram__mem_save" }] } }),
  ]) {
    tallyTranscriptLine(tally, text, WINDOW);
  }
  const report = buildModuleCostReport({ window: WINDOW, tally, hooks: [], rows: { gate: [], skills: [], tools: [], router: [], models: [], steward: [], verifyDone: [], ciWatch: [], memory: [] }, audit: { times: new Map(), firstMs: null, lastMs: null } });
  assert.deepEqual(report.memory.engramCalls, { mem_save: 2, mem_judge: 2, mem_search: 1 });
  assert.equal(report.memory.engramCallTotal, 5);
  assert.equal(report.memory.engramCallsPerPrompt, 5);
  assert.equal(report.memory.responsesWithEngram, 4);
  assert.equal(report.memory.engramOnlyResponses, 3);
  assert.equal(report.memory.engramOnlySaveResponses, 2, "m1 and m6 hold a save");
  assert.equal(report.memory.engramOnlyJudgeOnlyResponses, 1, "m2: judges and no save");
});

test("report: the memory module's own background cost from its log, per prompt, in a line of its own", () => {
  const tally = newTranscriptTally();
  tally.prompts = 10;
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    at: AT, backend: "live", decidedBy: "tools+health", permission: "ok", gate: "skip", gateTokens: { input: 1000, output: 2, cacheRead: 0, cacheWrite: 0 },
    fork: null, forkTokens: null, wouldSave: { user: 0, feedback: 0, project: 0, reference: 0 }, judgeBuilds: 0, mainEngramSaves: 0, mainJudges: 0, mainAutoMemoryWrites: 0, agreement: "neither", ...overrides,
  });
  const report = buildModuleCostReport({
    window: WINDOW,
    tally,
    hooks: [],
    rows: {
      gate: [], skills: [], tools: [], router: [], models: [], steward: [], verifyDone: [], ciWatch: [],
      memory: [
        row({}),
        row({ gate: "update", fork: "drafted", forkTokens: { input: 10, output: 300, cacheRead: 150_000, cacheWrite: 0 }, judgeBuilds: 2, agreement: "module-only" }),
        row({ gate: "no-answer", gateTokens: null, agreement: "unknown" }),
        row({ at: "2026-09-01T00:00:00.000Z" }),
      ],
    },
    audit: { times: new Map(), firstMs: null, lastMs: null },
  });
  assert.equal(report.memory.gates, 3);
  assert.equal(report.memory.gateFailures, 1);
  assert.equal(report.memory.updates, 1);
  assert.equal(report.memory.gatesPerPrompt, 0.3);
  assert.equal(report.memory.forks, 1);
  assert.equal(report.memory.forksPerPrompt, 0.1);
  assert.equal(report.memory.judgeBuilds, 2);
  assert.deepEqual(report.memory.haikuTokens, { input: 2000, output: 4 });
  assert.deepEqual(report.memory.forkTokens, { input: 10, output: 300, cacheRead: 150_000 });
  assert.equal(report.modules.some((module) => (module.module as string) === "memory"), false, "the Jev table keeps its own ids: memory uses Haiku");
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /memory \(main thread, transcripts\): 0 Engram calls \(0 per prompt\); 0 responses held an Engram call, 0 held only Engram calls \(0 with a save, 0 with judges and no save\)\./);
  assert.match(text, /memory \(module, its log\): 3 Haiku gates \(0\.3 per prompt, 1 failed, 1 UPDATE\), 1 forks \(0\.1 per prompt\), 2 judge builds \(0\.2 per prompt, none asked\); Haiku tokens 2000 in \/ 4 out; fork tokens 10 in \/ 300 out \/ 150000 cache read\./);
  assert.match(text, /memory \(Active, its log\): 0 turns wrote the files store; 0 files written, 0 rewritten \(0 backups\), 0 saves spooled, 0 replayed at a session start, 0 failed writes, 0 refused updates, 0 passes held by the lock\./);
});

test("report: what memory in Active wrote, from its decision and replay rows; a replay is never a gate", () => {
  const tally = newTranscriptTally();
  tally.prompts = 10;
  const writes = { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false };
  const decision = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    at: AT, mode: "active", effective: "active", backend: "absent", decidedBy: "none", permission: "unknown", gate: "update", gateTokens: { input: 1000, output: 2, cacheRead: 0, cacheWrite: 0 },
    fork: "drafted", forkTokens: { input: 10, output: 300, cacheRead: 150_000, cacheWrite: 0 }, wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 }, judgeBuilds: 0, mainEngramSaves: 0, mainJudges: 0, mainAutoMemoryWrites: 0, agreement: "module-only", ...writes, ...overrides,
  });
  const report = buildModuleCostReport({
    window: WINDOW,
    tally,
    hooks: [],
    rows: {
      gate: [], skills: [], tools: [], router: [], models: [], steward: [], verifyDone: [], ciWatch: [],
      memory: [
        decision({ spooled: 2, written: 1, updated: 1, backups: 1 }),
        decision({ spooled: 1, lockHeld: true }),
        decision({ effective: "shadow", backend: "live" }),
        { at: AT, event: "replay", mode: "active", effective: "active", backend: "absent", items: 1, replayed: 1, superseded: 0, written: 1, updated: 0, backups: 0, writeFailures: 1, lockHeld: false },
      ],
    },
    audit: { times: new Map(), firstMs: null, lastMs: null },
  });
  assert.equal(report.memory.gates, 3, "the replay row asked no Haiku");
  assert.equal(report.memory.activeDecisions, 2);
  assert.equal(report.memory.written, 2);
  assert.equal(report.memory.updated, 1);
  assert.equal(report.memory.spooled, 3);
  assert.equal(report.memory.replayed, 1);
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /memory \(Active, its log\): 2 turns wrote the files store; 2 files written, 1 rewritten \(1 backups\), 3 saves spooled, 1 replayed at a session start, 1 failed writes, 0 refused updates, 1 passes held by the lock\./);
});

test("E5 report: what memory in Active sent to Engram, judged and replayed; judge tokens join the Haiku tokens", () => {
  const tally = newTranscriptTally();
  tally.prompts = 10;
  const base = {
    at: AT, mode: "active", effective: "active", backend: "live", decidedBy: "tools+health", permission: "ok", gate: "update", gateTokens: { input: 1000, output: 2, cacheRead: 0, cacheWrite: 0 },
    fork: "drafted", forkTokens: { input: 10, output: 300, cacheRead: 150_000, cacheWrite: 0 }, wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 }, judgeBuilds: 0, mainEngramSaves: 0, mainJudges: 0, mainAutoMemoryWrites: 0, agreement: "module-only",
  };
  const report = buildModuleCostReport({
    window: WINDOW,
    tally,
    hooks: [],
    rows: {
      gate: [], skills: [], tools: [], router: [], models: [], steward: [], verifyDone: [], ciWatch: [],
      memory: [
        { ...base, spooled: 2, engramSaved: 2, mirrored: 1, judged: 2, judgePending: 1, judgeFailed: 1, judgeTokens: { input: 900, output: 60 } },
        { ...base, droppedMainSaved: 1, engramFailed: 1, judgeUnavailable: 2 },
        { at: AT, event: "replay", mode: "active", effective: "active", backend: "live", items: 2, replayed: 2, superseded: 0, engramSaved: 2, replayedToEngram: 2, fallbackRemoved: 1, fallbackMirrored: 1 },
      ],
    },
    audit: { times: new Map(), firstMs: null, lastMs: null },
  });
  assert.deepEqual(
    [report.memory.engramSaved, report.memory.engramFailed, report.memory.mirrored, report.memory.judged, report.memory.judgePending, report.memory.judgeFailed, report.memory.judgeUnavailable, report.memory.droppedMainSaved, report.memory.replayedToEngram, report.memory.fallbackRemoved, report.memory.fallbackMirrored],
    [4, 1, 1, 2, 1, 1, 2, 1, 2, 1, 1],
  );
  assert.deepEqual(report.memory.haikuTokens, { input: 2900, output: 64 }, "two gates and the judges");
  const text = formatModuleCostReport(report).join("\n");
  assert.match(text, /memory \(Active, Engram\): 4 saved to Engram, 1 failed, 1 mirrored into files; conflicts: 2 judged, 1 left pending, 1 judge failed, 2 with no mem_judge; 1 drafts dropped because the main thread saved in the same turn; 2 fallback copies replayed into Engram \(1 removed, 1 turned into mirrors\)\./);
});
