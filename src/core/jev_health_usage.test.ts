// 0.6.22 T2 (JEVADV-97): option usage -- how often Jev picks each option of
// each question, read from the router's and the steward's decision rows.

import assert from "node:assert/strict";
import test from "node:test";

import { buildStewardQuestions } from "./context_steward.ts";
import { ROUTER_TIERS } from "./model_catalog.ts";
import { WORK_KINDS } from "./work_kind.ts";
import { formatUsageReport, parseJsonlRows, summarizeUsage, usageFilesToRead } from "./jev_health_usage.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const AT = "2026-09-30T10:00:00.000Z";

function routerRow(extra: Record<string, unknown>): Record<string, unknown> {
  return { at: AT, point: "start", tier: "simple", confidence: 0.9, workKind: null, ...extra };
}

function stewardRow(extra: Record<string, unknown>): Record<string, unknown> {
  return { at: AT, verdict: "mid-task", confidence: 0.8, ...extra };
}

function question(report: ReturnType<typeof summarizeUsage>, title: string) {
  const found = report.questions.find((q) => q.title === title);
  assert.ok(found, `question ${title} present`);
  return found;
}

test("counts, share and mean confidence per option, split by router point", () => {
  const rows = [routerRow({ tier: "simple", confidence: 1 }), routerRow({ tier: "simple", confidence: 0.5 }), routerRow({ tier: "complex", confidence: 0.8 }), routerRow({ point: "stage", tier: "standard" })];
  const q = question(summarizeUsage(rows, [], NOW, 7), "router tier (start)");
  assert.equal(q.answered, 3);
  const simple = q.options.find((o) => o.option === "simple");
  assert.deepEqual([simple?.count, simple?.share, simple?.meanConfidence], [2, 2 / 3, 0.75]);
  assert.equal(question(summarizeUsage(rows, [], NOW, 7), "router tier (stage)").answered, 1);
});

test("every option of the full set is listed, in the set's own order", () => {
  const q = question(summarizeUsage([routerRow({})], [], NOW, 7), "router tier (start)");
  assert.deepEqual(q.options.map((o) => o.option), [...ROUTER_TIERS]);
  const steward = question(summarizeUsage([], [stewardRow({})], NOW, 7), "steward verdict");
  assert.deepEqual(steward.options.map((o) => o.option), Object.keys(buildStewardQuestions().verdict?.criteria ?? {}));
});

test("an option chosen 0 times is a FINDING with the number of answers", () => {
  const rows = [routerRow({ tier: "simple" }), routerRow({ tier: "standard" })];
  const q = question(summarizeUsage(rows, [], NOW, 7), "router tier (start)");
  assert.deepEqual(q.findings, ["FINDING: router tier (start) option complex chosen 0 of 2", "FINDING: router tier (start) option frontier chosen 0 of 2"]);
});

test("a question with no answers has no findings and says so", () => {
  const report = summarizeUsage([], [], NOW, 7);
  for (const q of report.questions) assert.deepEqual(q.findings, []);
  assert.match(formatUsageReport(report, 7).join("\n"), /no answers/);
});

test("mean margin covers only rows with a numeric margin; n/a when none, never 0", () => {
  const rows = [routerRow({ margin: 0.5 }), routerRow({ margin: 0.25 }), routerRow({}), routerRow({ margin: "0.9" }), routerRow({ margin: Number.NaN })];
  const q = question(summarizeUsage(rows, [], NOW, 7), "router tier (start)");
  assert.equal(q.marginRows, 2);
  assert.equal(q.options.find((o) => o.option === "simple")?.meanMargin, 0.375);
  assert.equal(q.options.find((o) => o.option === "standard")?.meanMargin, null);
  const text = formatUsageReport(summarizeUsage([routerRow({})], [], NOW, 7), 7).join("\n");
  assert.match(text, /margin on 0 of 1 rows/);
  assert.match(text, /n\/a/);
});

test("work kind counts only the kinds Jev gave, not the keyword fallback", () => {
  const kind = (value: string, source: string) => ({ workKind: { mode: "measure", kind: value, confidence: source === "jev" ? 0.9 : null, source, keywords: null, effort: null, hold: null, applied: false } });
  const rows = [routerRow({ point: "subagent", ...kind("read", "jev") }), routerRow({ point: "subagent", ...kind("review", "keywords") })];
  const q = question(summarizeUsage(rows, [], NOW, 7), "router work kind");
  assert.equal(q.answered, 1);
  assert.deepEqual(q.options.map((o) => o.option), [...WORK_KINDS]);
});

test("rows without an answer, outside the window or malformed are left out", () => {
  const rows = [routerRow({ tier: null }), routerRow({ at: "2026-09-01T00:00:00.000Z" }), routerRow({ tier: "bogus" }), "x", null, routerRow({})];
  assert.equal(question(summarizeUsage(rows, [], NOW, 7), "router tier (start)").answered, 1);
  const steward = [stewardRow({ verdict: null }), stewardRow({ verdict: "nope" }), stewardRow({})];
  assert.equal(question(summarizeUsage([], steward, NOW, 7), "steward verdict").answered, 1);
});

test("a steward row with no numeric confidence still counts, and has no mean confidence", () => {
  const q = question(summarizeUsage([], [stewardRow({ confidence: null })], NOW, 7), "steward verdict");
  assert.equal(q.answered, 1);
  assert.equal(q.options.find((o) => o.option === "mid-task")?.meanConfidence, null);
});

test("usageFilesToRead keeps the router and steward hourly files inside the window", () => {
  const names = [
    "model-router-decisions-2026-09-30T10.jsonl",
    "model-router-decisions-2026-09-01T10.jsonl",
    "context-steward-decisions-2026-09-30T11.jsonl",
    "turn-usage-2026-09-30T10.jsonl",
  ];
  assert.deepEqual(usageFilesToRead(names, NOW, 7), { router: ["model-router-decisions-2026-09-30T10.jsonl"], steward: ["context-steward-decisions-2026-09-30T11.jsonl"] });
});

test("parseJsonlRows skips blank and corrupt lines", () => {
  assert.deepEqual(parseJsonlRows('{"a":1}\n\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});
