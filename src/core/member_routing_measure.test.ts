// JEVADV-118 T7: the acceptance measurement -- per Orca member session, the
// steps and tokens before and after the router change, read from the router's
// decision rows, the turn-usage rows and the CI watch rows.

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMemberRoutingMarkdown,
  measureMemberRouting,
  memberRoutingFilesToRead,
  memberStartClass,
  modelShortLabel,
  parseJsonlCounted,
  parseMemberRoutingArgs,
} from "./member_routing_measure.ts";

const FROM = Date.parse("2026-10-20T00:00:00.000Z");
const TO = Date.parse("2026-10-28T00:00:00.000Z");

function start(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: "2026-10-21T10:00:00.000Z", point: "start", reason: "held-by-guard", guard: "pointer-prompt", sessionId, ...extra };
}

function step(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: "2026-10-21T10:01:00.000Z", agent: "main", sessionId, model: "claude-opus-5-5", effort: "high", input: 1, output: 10, cacheRead: 100, cacheWrite: 5, ...extra };
}

function measure(decisions: readonly unknown[], usage: readonly unknown[] = [], ciWatches: readonly unknown[] = []) {
  return measureMemberRouting({ decisions, usage, ciWatches, fromMs: FROM, toMs: TO, malformedLines: 0 });
}

test("a start held by the pointer guard, by an Orca pin, or judged from a brief is a member start", () => {
  assert.equal(memberStartClass(start("a")), "pointer");
  assert.equal(memberStartClass(start("a", { reason: "held-by-orca-pin", guard: null })), "orca-pin");
  assert.equal(memberStartClass(start("a", { reason: "switch", guard: null, brief: true })), "brief");
  assert.equal(memberStartClass(start("a", { reason: "held-by-guard", guard: "low-confidence" })), null);
  assert.equal(memberStartClass(start("a", { reason: "switch", guard: null })), null);
});

test("an Orca pin over a brief start counts as the pin: the pin chose the model", () => {
  assert.equal(memberStartClass(start("a", { reason: "held-by-orca-pin", guard: null, brief: true })), "orca-pin");
});

test("only a session whose FIRST start is a member start, inside the window, is a member", () => {
  const decisions = [
    start("member"),
    // Its first start is a person's prompt; a later pointer start does not make it a member.
    start("person", { reason: "switch", guard: null, at: "2026-10-21T09:00:00.000Z" }),
    start("person", { at: "2026-10-21T11:00:00.000Z" }),
    // Started before the window.
    start("early", { at: "2026-10-19T23:59:59.000Z" }),
    start("early", { at: "2026-10-21T11:00:00.000Z" }),
    // Started at the window's end: exclusive.
    start("late", { at: "2026-10-28T00:00:00.000Z" }),
    // A stage row never starts a session.
    start("stage-only", { point: "stage" }),
  ];
  const report = measure(decisions);
  assert.equal(report.memberSessions, 1);
  assert.deepEqual(report.startsByClass, { pointer: 1, "orca-pin": 0, brief: 0 });
});

test("the first start is found by time, not by row order", () => {
  const decisions = [start("s", { at: "2026-10-21T11:00:00.000Z" }), start("s", { reason: "switch", guard: null, at: "2026-10-21T09:00:00.000Z" })];
  assert.equal(measure(decisions).memberSessions, 0);
});

test("steps, medians and totals cover only member sessions; input is input + cache read + cache write", () => {
  const decisions = [start("a"), start("b", { reason: "held-by-orca-pin", guard: null }), start("c", { brief: true, reason: "switch", guard: null }), start("not-member", { reason: "switch", guard: null })];
  const usage = [
    step("a", { output: 10, input: 1, cacheRead: 100, cacheWrite: 9 }),
    step("a", { agent: "subagent", output: 30, input: 0, cacheRead: 0, cacheWrite: 0 }),
    step("b", { output: 5, input: 2, cacheRead: 0, cacheWrite: 0 }),
    step("c", { output: 100, input: 1000, cacheRead: 0, cacheWrite: 0 }),
    step("c", { output: 100 }),
    step("c", { output: 100 }),
    step("not-member", { output: 99999 }),
  ];
  const report = measure(decisions, usage);
  assert.equal(report.memberSessions, 3);
  assert.equal(report.steps, 6);
  assert.equal(report.mainSteps, 5);
  assert.equal(report.subagentSteps, 1);
  // Per session: steps a=2, b=1, c=3; output a=40, b=5, c=300; input a=110, b=2, c=1000+106+106.
  assert.equal(report.medianStepsPerSession, 2);
  assert.equal(report.medianOutputPerSession, 40);
  assert.equal(report.medianInputPerSession, 110);
  assert.equal(report.totalOutput, 345);
  assert.deepEqual(report.startsByClass, { pointer: 1, "orca-pin": 1, brief: 1 });
});

test("a member session with no recorded step counts as zero steps in the medians", () => {
  const report = measure([start("a"), start("b"), start("c")], [step("a"), step("a"), step("a")]);
  assert.equal(report.medianStepsPerSession, 0);
  assert.equal(report.sessionsWithoutSteps, 2);
});

test("a step whose token figures are null is a step, and its tokens are left out of the sums, never invented", () => {
  const usage = [step("a", { output: 10 }), step("a", { input: null, output: null, cacheRead: null, cacheWrite: null })];
  const report = measure([start("a")], usage);
  assert.equal(report.steps, 2);
  assert.equal(report.stepsWithoutTokens, 1);
  assert.equal(report.totalOutput, 10);
});

test("the step mix is by short model label and effort, most used first, ties in the order first seen", () => {
  const usage = [
    step("a", { model: "claude-haiku-5-5", effort: "xhigh" }),
    step("a", { model: "claude-opus-5-5", effort: "high" }),
    step("a", { model: "claude-opus-5-5", effort: "high" }),
    step("a", { model: "glm-5.3", effort: "medium" }),
  ];
  assert.deepEqual(measure([start("a")], usage).stepMix, [
    { label: "Opus 5.5 · high", count: 2 },
    { label: "Haiku 5.5 · xhigh", count: 1 },
    { label: "glm-5.3 · medium", count: 1 },
  ]);
});

test("a model id reads as its short label; an unknown id prints as it is", () => {
  assert.equal(modelShortLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelShortLabel("claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelShortLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelShortLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelShortLabel("claude-opus-5-5[1m]"), "Opus 5.5");
  assert.equal(modelShortLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelShortLabel("glm-5.3"), "glm-5.3");
});

test("escalations in member sessions are counted by signal", () => {
  const escalate = (sessionId: string, signal: string | undefined) => ({ ...start(sessionId, { point: "stage", reason: "escalate", guard: null, at: "2026-10-21T10:30:00.000Z" }), ...(signal === undefined ? {} : { signal }) });
  const decisions = [start("a"), start("other", { reason: "switch", guard: null }), escalate("a", "code-edit"), escalate("a", "code-edit"), escalate("a", "test-loop"), escalate("a", undefined), escalate("other", "code-edit")];
  assert.deepEqual(measure(decisions).escalationsBySignal, [
    { signal: "code-edit", count: 2 },
    { signal: "test-loop", count: 1 },
    { signal: "none", count: 1 },
  ]);
});

test("CI watches of member sessions: outcomes, sessions watched, pass rate over success and failure", () => {
  const watch = (sessionId: string, outcome: string) => ({ at: "2026-10-21T12:00:00.000Z", sessionId, outcome });
  const ci = [watch("a", "success"), watch("a", "failure"), watch("a", "no-runs"), watch("b", "success"), watch("b", "cap"), watch("other", "failure")];
  const report = measure([start("a"), start("b"), start("other", { reason: "switch", guard: null })], [], ci);
  assert.equal(report.ci.sessionsWatched, 2);
  assert.equal(report.ci.watches, 5);
  assert.deepEqual(report.ci.byOutcome, [
    { outcome: "success", count: 2 },
    { outcome: "failure", count: 1 },
    { outcome: "no-runs", count: 1 },
    { outcome: "cap", count: 1 },
  ]);
  assert.equal(report.ci.passRate, 2 / 3);
  assert.equal(measure([start("a")]).ci.passRate, null);
});

test("rows that are not records or carry no session are skipped and counted, never thrown on", () => {
  const report = measureMemberRouting({
    decisions: [start("a"), null, "text", { point: "start", reason: "held-by-guard", guard: "pointer-prompt", sessionId: "x", at: "not a date" }, start("y", { sessionId: null })],
    usage: [step("a"), 42, step("a", { sessionId: undefined }), step("a", { model: 7 })],
    ciWatches: [{ outcome: "success" }],
    fromMs: FROM,
    toMs: TO,
    malformedLines: 3,
  });
  assert.equal(report.memberSessions, 1);
  assert.equal(report.steps, 1);
  assert.deepEqual(report.skipped, { malformedLines: 3, decisionRows: 4, usageRows: 3, ciRows: 1 });
});

test("parseJsonlCounted keeps the rows and counts the corrupt lines; blank lines are neither", () => {
  assert.deepEqual(parseJsonlCounted('{"a":1}\n\n{broken\n[2]\n'), { rows: [{ a: 1 }, [2]], malformed: 1 });
});

test("the Markdown table uses the baseline's measure names, and says 5h/7d use is not recorded per session", () => {
  const report = measure([start("a")], [step("a", { output: 11300, input: 991699, cacheRead: 0, cacheWrite: 0 })]);
  const text = formatMemberRoutingMarkdown(report, "2026-10-20", "2026-10-28").join("\n");
  for (const name of [
    "| Member sessions | 1 |",
    "| Main and subagent steps | 1 |",
    "| Median steps per session | 1 |",
    "| Median output tokens per session | 11,300 |",
    "| Median input tokens per session (input + cache read + cache write) | 991,699 |",
    "| Total output tokens | 11,300 |",
    "| Step mix | Opus 5.5 · high 1 |",
    "| Member starts by class | pointer 1; orca-pin 0; brief 0 |",
    "| Escalations by signal | none |",
  ]) {
    assert.ok(text.includes(name), `has ${name}`);
  }
  assert.match(text, /5h\/7d use per session: not recorded per session/);
  assert.match(text, /CI pass rate .* n\/a/);
});

test("args: --from and --to are ISO dates, from before to; --json switches the output", () => {
  assert.deepEqual(parseMemberRoutingArgs(["--from", "2026-10-20", "--to", "2026-10-28"]), { command: "measure", from: "2026-10-20", to: "2026-10-28", fromMs: FROM, toMs: TO, json: false });
  assert.equal(parseMemberRoutingArgs(["--from", "2026-10-20", "--to", "2026-10-28", "--json"]).command, "measure");
  assert.deepEqual(parseMemberRoutingArgs(["--from", "2026-10-28", "--to", "2026-10-20"]), { command: "error", message: "--from must be before --to" });
  assert.deepEqual(parseMemberRoutingArgs(["--from", "20-10-2026", "--to", "2026-10-28"]), { command: "error", message: "--from needs an ISO date (YYYY-MM-DD)" });
  assert.deepEqual(parseMemberRoutingArgs(["--from", "2026-10-20"]), { command: "error", message: "--to needs an ISO date (YYYY-MM-DD)" });
  assert.deepEqual(parseMemberRoutingArgs(["--help"]), { command: "help" });
});

test("files: every decision file (a first start may precede the window), usage and CI files from the window's start on", () => {
  const names = [
    "model-router-decisions-2026-10-19T15.jsonl",
    "model-router-decisions-2026-10-27T15.jsonl",
    "turn-usage-2026-10-19T23.jsonl",
    "turn-usage-2026-10-20T00.jsonl",
    "turn-usage-2026-10-29T00.jsonl",
    "ci-watch-decisions-2026-10-13T01.jsonl",
    "ci-watch-decisions-2026-10-21T01.jsonl",
    "typing-2026-10-21T01.jsonl",
  ];
  assert.deepEqual(memberRoutingFilesToRead(names, FROM), {
    decisions: ["model-router-decisions-2026-10-19T15.jsonl", "model-router-decisions-2026-10-27T15.jsonl"],
    usage: ["turn-usage-2026-10-20T00.jsonl", "turn-usage-2026-10-29T00.jsonl"],
    ci: ["ci-watch-decisions-2026-10-21T01.jsonl"],
  });
});
