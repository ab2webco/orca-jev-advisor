// Pure logic for the A/B benchmark: Jev vs. the large model, measured for
// real, out of band. See ab_benchmark.ts's own module note for the full
// design and its privacy tradeoff.
//
// Every test here injects a fake `BigModelRunner` -- none may invoke the
// real `claude` CLI (see the module note on BigModelRunner: a real call
// costs real usage, so it never belongs in a test that runs on every
// `npm test`). Real Jev is out of scope for this file entirely: nothing
// here calls network Jev either, since compareOne only ever receives an
// already-decided AbSampleEntry (Jev's own verdict/latency, captured once
// for free wherever the real decision was made).

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AB_BENCHMARK_CONFIG } from "./ab_benchmark_config.ts";
import {
  buildBigModelPrompt,
  buildReport,
  compareOne,
  computeLatencyStats,
  parseBigModelVerdict,
  parseClaudeCliEnvelope,
  parseSampleEntries,
  serializeSampleEntry,
  shouldSample,
  type AbComparisonResult,
  type AbSampleEntry,
  type BigModelRunOutcome,
} from "./ab_benchmark.ts";

// ---------------------------------------------------------------------------
// shouldSample
// ---------------------------------------------------------------------------

test("shouldSample: disabled config never samples, regardless of the random draw", () => {
  const config = { ...DEFAULT_AB_BENCHMARK_CONFIG, enabled: false, sampleRate: 1 };
  assert.equal(shouldSample(config, 0, 0), false);
});

test("shouldSample: at or past the daily cap, never samples even when enabled and the draw is favorable", () => {
  const config = { ...DEFAULT_AB_BENCHMARK_CONFIG, enabled: true, sampleRate: 1, dailySampleCap: 5 };
  assert.equal(shouldSample(config, 5, 0), false);
  assert.equal(shouldSample(config, 6, 0), false);
});

test("shouldSample: below the cap, samples exactly when random < sampleRate", () => {
  const config = { ...DEFAULT_AB_BENCHMARK_CONFIG, enabled: true, sampleRate: 0.1, dailySampleCap: 20 };
  assert.equal(shouldSample(config, 0, 0.05), true);
  assert.equal(shouldSample(config, 0, 0.1), false);
  assert.equal(shouldSample(config, 0, 0.5), false);
});

// ---------------------------------------------------------------------------
// serializeSampleEntry / parseSampleEntries
// ---------------------------------------------------------------------------

function sampleEntry(overrides: Partial<AbSampleEntry> = {}): AbSampleEntry {
  return {
    id: "s1",
    at: "2026-09-24T00:00:00.000Z",
    commandFamily: "git push",
    destinationKind: "project",
    jevVerdict: "ask",
    jevLatencyMs: 404,
    jevInputTokens: 120,
    jevOutputTokens: 40,
    ...overrides,
  };
}

test("serializeSampleEntry -> parseSampleEntries round-trips exactly", () => {
  const entry = sampleEntry();
  const parsed = parseSampleEntries(serializeSampleEntry(entry));
  assert.deepEqual(parsed, [entry]);
});

test("parseSampleEntries: never stores the raw command -- the type itself has no field for it, and an entry carrying one anyway is still read only for its known fields", () => {
  const withExtra = JSON.stringify({ ...sampleEntry(), command: "rm -rf /etc/foo" }) + "\n";
  const [parsed] = parseSampleEntries(withExtra);
  assert.equal(Object.hasOwn(parsed as object, "command"), false);
});

test("parseSampleEntries: a malformed line is skipped, siblings survive, never throws", () => {
  const raw = `${serializeSampleEntry(sampleEntry({ id: "a" }))}not json at all\n${serializeSampleEntry(sampleEntry({ id: "b" }))}`;
  const parsed = parseSampleEntries(raw);
  assert.deepEqual(parsed.map((e) => e.id), ["a", "b"]);
});

test("parseSampleEntries: a line missing a required field is dropped", () => {
  const bad = JSON.stringify({ id: "x", at: "2026-01-01T00:00:00.000Z" }) + "\n";
  assert.deepEqual(parseSampleEntries(bad), []);
});

test("parseSampleEntries: an empty string yields an empty list", () => {
  assert.deepEqual(parseSampleEntries(""), []);
});

// ---------------------------------------------------------------------------
// buildBigModelPrompt -- the privacy tradeoff, made explicit and testable
// ---------------------------------------------------------------------------

test("buildBigModelPrompt: names the command family and asks for JSON-only output", () => {
  const prompt = buildBigModelPrompt({ commandFamily: "rm -rf", destinationKind: "client-site" });
  assert.match(prompt, /rm -rf/);
  assert.match(prompt, /client-site/);
  assert.match(prompt, /"verdict"/);
});

test("buildBigModelPrompt: a null destinationKind produces a prompt that says so, never 'null' or 'undefined' literally", () => {
  const prompt = buildBigModelPrompt({ commandFamily: "docker", destinationKind: null });
  assert.equal(/\bnull\b/i.test(prompt), false);
  assert.equal(/\bundefined\b/i.test(prompt), false);
});

// ---------------------------------------------------------------------------
// parseBigModelVerdict
// ---------------------------------------------------------------------------

test("parseBigModelVerdict: reads a bare JSON verdict", () => {
  assert.equal(parseBigModelVerdict('{"verdict":"allow"}'), "allow");
  assert.equal(parseBigModelVerdict('{"verdict":"ask"}'), "ask");
  assert.equal(parseBigModelVerdict('{"verdict":"deny"}'), "deny");
});

test("parseBigModelVerdict: tolerates a markdown fence the model added despite being told not to", () => {
  assert.equal(parseBigModelVerdict('```json\n{"verdict":"allow"}\n```'), "allow");
});

test("parseBigModelVerdict: an invalid verdict value, malformed JSON, or empty text all yield null, never a guess", () => {
  assert.equal(parseBigModelVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseBigModelVerdict("not json"), null);
  assert.equal(parseBigModelVerdict(""), null);
  assert.equal(parseBigModelVerdict('{"other":"allow"}'), null);
});

// ---------------------------------------------------------------------------
// parseClaudeCliEnvelope -- fixture captured from one real, manual
// `claude -p --output-format json` call (see the AB-benchmark task report
// for the exact command and full output this was copied from). Fields not
// read by this parser are left in the fixture verbatim, exactly as the real
// CLI printed them, to prove the parser ignores what it does not need
// (including total_cost_usd, which this plugin never stores -- see the
// module note on ClaudeCliEnvelope).
// ---------------------------------------------------------------------------

const REAL_CLI_OUTPUT_FIXTURE = JSON.stringify({
  duration_api_ms: 3110,
  stop_reason: "end_turn",
  session_id: "c2169d9e-e5f5-4fed-92eb-5c9bcc4f1728",
  total_cost_usd: 0.3946556,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 48996,
    cache_read_input_tokens: 12098,
    output_tokens: 13,
  },
  modelUsage: {
    "claude-opus-5-5[1m]": { inputTokens: 2, outputTokens: 13, cacheReadInputTokens: 12098, cacheCreationInputTokens: 48996, costUSD: 0.3946556 },
  },
  is_error: false,
  num_turns: 1,
  subtype: "success",
  result: '{"verdict":"allow"}',
  type: "result",
  duration_ms: 4517,
  uuid: "bd620781-5215-4d87-9c7f-5175f31fe135",
});

test("parseClaudeCliEnvelope: reads a real captured envelope's fields this benchmark needs", () => {
  const envelope = parseClaudeCliEnvelope(REAL_CLI_OUTPUT_FIXTURE);
  assert.ok(envelope);
  assert.equal(envelope.resultText, '{"verdict":"allow"}');
  assert.equal(envelope.durationApiMs, 3110);
  assert.equal(envelope.inputTokens, 2);
  assert.equal(envelope.outputTokens, 13);
  assert.equal(envelope.cacheCreationInputTokens, 48996);
  assert.equal(envelope.cacheReadInputTokens, 12098);
  assert.equal(envelope.isError, false);
  assert.equal(envelope.modelId, "claude-opus-5-5[1m]");
});

test("parseClaudeCliEnvelope: never surfaces total_cost_usd -- the parsed shape has no field for it", () => {
  const envelope = parseClaudeCliEnvelope(REAL_CLI_OUTPUT_FIXTURE);
  assert.ok(envelope);
  assert.equal(Object.hasOwn(envelope, "total_cost_usd"), false);
  assert.equal(Object.hasOwn(envelope, "totalCostUsd"), false);
  assert.equal(Object.hasOwn(envelope, "costUsd"), false);
  for (const value of Object.values(envelope as object)) assert.notEqual(value, 0.3946556);
});

test("parseClaudeCliEnvelope: malformed JSON, a non-object, or a missing required field all yield null, never a crash", () => {
  assert.equal(parseClaudeCliEnvelope("not json"), null);
  assert.equal(parseClaudeCliEnvelope("42"), null);
  assert.equal(parseClaudeCliEnvelope('{"result":"ok"}'), null, "missing duration_api_ms/usage");
  assert.equal(parseClaudeCliEnvelope('{"duration_api_ms":1,"usage":{"input_tokens":1,"output_tokens":1}}'), null, "missing result");
});

test("parseClaudeCliEnvelope: missing cache token fields default to 0 rather than failing the whole envelope", () => {
  const envelope = parseClaudeCliEnvelope(
    JSON.stringify({ duration_api_ms: 500, result: "{}", usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }),
  );
  assert.ok(envelope);
  assert.equal(envelope.cacheCreationInputTokens, 0);
  assert.equal(envelope.cacheReadInputTokens, 0);
  assert.equal(envelope.modelId, null);
});

test("parseClaudeCliEnvelope: is_error true is read through, never silently swallowed", () => {
  const envelope = parseClaudeCliEnvelope(
    JSON.stringify({ duration_api_ms: 500, result: "", usage: { input_tokens: 1, output_tokens: 0 }, is_error: true }),
  );
  assert.ok(envelope);
  assert.equal(envelope.isError, true);
});

// ---------------------------------------------------------------------------
// compareOne
// ---------------------------------------------------------------------------

function okOutcome(resultText: string, overrides: Record<string, unknown> = {}): BigModelRunOutcome {
  return {
    kind: "ok",
    stdout: JSON.stringify({
      duration_api_ms: 5466,
      result: resultText,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
      is_error: false,
      modelUsage: { "claude-opus-5-5[1m]": {} },
      ...overrides,
    }),
  };
}

test("compareOne: agreement when the big model's verdict matches Jev's", async () => {
  const entry = sampleEntry({ jevVerdict: "ask" });
  const result = await compareOne(entry, { bigModelRunner: async () => okOutcome('{"verdict":"ask"}') });
  assert.equal(result.agree, true);
  assert.equal(result.bigModel.verdict, "ask");
  assert.equal(result.bigModel.latencyMs, 5466);
  assert.equal(result.bigModel.failureReason, null);
});

test("compareOne: disagreement when the big model's verdict differs from Jev's -- reported flatly, never softened", async () => {
  const entry = sampleEntry({ jevVerdict: "allow" });
  const result = await compareOne(entry, { bigModelRunner: async () => okOutcome('{"verdict":"deny"}') });
  assert.equal(result.agree, false);
  assert.equal(result.bigModel.verdict, "deny");
});

test("compareOne: the CLI binary missing is a reported state, not a crash and not a zero", async () => {
  const entry = sampleEntry();
  const result = await compareOne(entry, { bigModelRunner: async () => ({ kind: "not-found" }) });
  assert.equal(result.agree, null);
  assert.equal(result.bigModel.verdict, null);
  assert.equal(result.bigModel.latencyMs, null);
  assert.equal(result.bigModel.failureReason, "cli_not_found");
});

test("compareOne: a runner-level error is reported as inconclusive, not folded into disagreement", async () => {
  const entry = sampleEntry();
  const result = await compareOne(entry, { bigModelRunner: async () => ({ kind: "error", message: "boom" }) });
  assert.equal(result.agree, null);
  assert.equal(result.bigModel.failureReason, "cli_error");
});

test("compareOne: an unparseable envelope is inconclusive, never a crash", async () => {
  const entry = sampleEntry();
  const result = await compareOne(entry, { bigModelRunner: async () => ({ kind: "ok", stdout: "not json" }) });
  assert.equal(result.agree, null);
  assert.equal(result.bigModel.failureReason, "unparseable_envelope");
});

test("compareOne: is_error:true from the CLI is reported as cli_error but still keeps the real latency/tokens it spent", async () => {
  const entry = sampleEntry();
  const result = await compareOne(entry, { bigModelRunner: async () => okOutcome("", { is_error: true }) });
  assert.equal(result.agree, null);
  assert.equal(result.bigModel.failureReason, "cli_error");
  assert.equal(result.bigModel.latencyMs, 5466);
});

test("compareOne: a big-model reply that is not valid verdict JSON is inconclusive but keeps latency/tokens -- the call happened, only the answer did not parse", async () => {
  const entry = sampleEntry();
  const result = await compareOne(entry, { bigModelRunner: async () => okOutcome("I think you should allow it.") });
  assert.equal(result.agree, null);
  assert.equal(result.bigModel.failureReason, "unparseable_verdict");
  assert.equal(result.bigModel.latencyMs, 5466);
});

test("compareOne: never sends the raw command anywhere -- the prompt the fake runner receives only ever carries family and kind", async () => {
  const entry = sampleEntry({ commandFamily: "rm -rf", destinationKind: "client-site" });
  let seenPrompt = "";
  await compareOne(entry, {
    bigModelRunner: async (prompt) => {
      seenPrompt = prompt;
      return okOutcome('{"verdict":"ask"}');
    },
  });
  assert.match(seenPrompt, /rm -rf/);
  assert.match(seenPrompt, /client-site/);
});

test("compareOne: carries Jev's own verdict/latency/tokens through unchanged -- no second Jev call is made here", async () => {
  const entry = sampleEntry({ jevVerdict: "ask", jevLatencyMs: 404, jevInputTokens: 80, jevOutputTokens: 20 });
  const result = await compareOne(entry, { bigModelRunner: async () => okOutcome('{"verdict":"ask"}') });
  assert.deepEqual(result.jev, { verdict: "ask", latencyMs: 404, inputTokens: 80, outputTokens: 20 });
});

// ---------------------------------------------------------------------------
// computeLatencyStats
// ---------------------------------------------------------------------------

test("computeLatencyStats: null for an empty sample -- never a fabricated zero", () => {
  assert.equal(computeLatencyStats([]), null);
});

test("computeLatencyStats: median, min and max over an odd-sized sample", () => {
  assert.deepEqual(computeLatencyStats([300, 100, 200]), { count: 3, medianMs: 200, minMs: 100, maxMs: 300 });
});

test("computeLatencyStats: median averages the two middle values over an even-sized sample", () => {
  assert.deepEqual(computeLatencyStats([100, 200, 300, 400]), { count: 4, medianMs: 250, minMs: 100, maxMs: 400 });
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

function comparison(overrides: Partial<AbComparisonResult> = {}): AbComparisonResult {
  return {
    id: "s1",
    at: "2026-09-24T00:00:00.000Z",
    commandFamily: "git push",
    destinationKind: "project",
    jev: { verdict: "ask", latencyMs: 404, inputTokens: 80, outputTokens: 20 },
    bigModel: {
      verdict: "ask",
      latencyMs: 5466,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 0,
      modelId: "claude-opus-5-5[1m]",
      failureReason: null,
    },
    agree: true,
    ...overrides,
  };
}

test("buildReport: an empty result set reports zero counts, an empty byModel list, and null stats -- never a fabricated number", () => {
  const report = buildReport([]);
  assert.equal(report.sampleCount, 0);
  assert.deepEqual(report.byModel, []);
  assert.equal(report.jevLatency, null);
});

test("buildReport: groups by the model id the CLI actually reported -- never one averaged figure across models", () => {
  const results = [
    comparison({ id: "a", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" }, agree: true }),
    comparison({ id: "b", bigModel: { ...comparison().bigModel, modelId: "claude-sonnet-5" }, agree: false }),
  ];
  const report = buildReport(results);
  assert.equal(report.byModel.length, 2);
  assert.equal(report.byModel[0]?.modelId, "claude-opus-5-5[1m]");
  assert.equal(report.byModel[0]?.sampleCount, 1);
  assert.equal(report.byModel[1]?.modelId, "claude-sonnet-5");
  assert.equal(report.byModel[1]?.sampleCount, 1);
});

test("buildReport: a sample with no reported model id is grouped under modelId: null (\"model not reported\"), never merged into a named group or dropped", () => {
  const results = [
    comparison({ id: "a", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" } }),
    comparison({
      id: "b",
      agree: null,
      bigModel: { ...comparison().bigModel, modelId: null, verdict: null, latencyMs: null, failureReason: "cli_not_found" },
    }),
  ];
  const report = buildReport(results);
  assert.equal(report.byModel.length, 2);
  const notReported = report.byModel.find((g) => g.modelId === null);
  assert.ok(notReported);
  assert.equal(notReported.sampleCount, 1);
  assert.equal(notReported.inconclusiveCount, 1);
});

test("buildReport: within a model's group, agreement rate is computed only over CONCLUSIVE comparisons -- an inconclusive one never counts as disagreement", () => {
  const results = [
    comparison({ id: "a", agree: true }),
    comparison({ id: "b", agree: false }),
    comparison({ id: "c", agree: null, bigModel: { ...comparison().bigModel, verdict: null, latencyMs: null, failureReason: "cli_error" } }),
  ];
  const report = buildReport(results);
  assert.equal(report.sampleCount, 3);
  assert.equal(report.byModel.length, 1, "all three share the same modelId, so they group together");
  const group = report.byModel[0] as NonNullable<(typeof report.byModel)[number]>;
  assert.equal(group.sampleCount, 3);
  assert.equal(group.conclusiveCount, 2);
  assert.equal(group.inconclusiveCount, 1);
  assert.equal(group.agreeCount, 1);
  assert.equal(group.disagreeCount, 1);
  assert.equal(group.agreementRate, 0.5);
});

test("buildReport: jevLatency is computed over every sample (Jev always answers or the sample would not exist); a model group's latency only over its own conclusive samples", () => {
  const results = [
    comparison({ id: "a", jev: { ...comparison().jev, latencyMs: 300 }, agree: true }),
    comparison({
      id: "b",
      jev: { ...comparison().jev, latencyMs: 500 },
      agree: null,
      bigModel: { ...comparison().bigModel, verdict: null, latencyMs: null, failureReason: "cli_not_found" },
    }),
  ];
  const report = buildReport(results);
  assert.deepEqual(report.jevLatency, { count: 2, medianMs: 400, minMs: 300, maxMs: 500 });
  assert.equal(report.byModel.length, 1, "both samples share the fixture's default modelId, so they group together");
  assert.deepEqual(report.byModel[0]?.latency, { count: 1, medianMs: 5466, minMs: 5466, maxMs: 5466 }, "only sample a's latency counts -- sample b never reached a big-model latency");
});

test("buildReport: named model groups stay in first-seen order, and a 'model not reported' group always sorts last regardless of when it appeared", () => {
  const results = [
    comparison({ id: "a", bigModel: { ...comparison().bigModel, modelId: null, verdict: null, latencyMs: null, failureReason: "cli_not_found" }, agree: null }),
    comparison({ id: "b", bigModel: { ...comparison().bigModel, modelId: "claude-sonnet-5" } }),
    comparison({ id: "c", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" } }),
  ];
  const report = buildReport(results);
  assert.deepEqual(
    report.byModel.map((g) => g.modelId),
    ["claude-sonnet-5", "claude-opus-5-5[1m]", null],
  );
});

test("buildReport: sums tokens as tokens within each model's group, never converts them to a cost, never averages across models", () => {
  const results = [
    comparison({ id: "a", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" } }),
    comparison({ id: "b", bigModel: { ...comparison().bigModel, modelId: "claude-opus-5-5[1m]" } }),
  ];
  const report = buildReport(results);
  assert.deepEqual(report.jevTokens, { input: 160, output: 40 });
  assert.equal(report.byModel.length, 1);
  assert.deepEqual(report.byModel[0]?.tokens, { input: 20, output: 10, cacheCreation: 200, cacheRead: 0 });
  const flat = [report, ...report.byModel];
  for (const value of flat) {
    for (const key of Object.keys(value)) assert.doesNotMatch(key.toLowerCase(), /cost|usd|dollar/);
  }
});

test("buildReport: decisionsBigModelSkipped is null when the caller supplies no total (no wider log was read)", () => {
  assert.equal(buildReport([comparison()]).decisionsBigModelSkipped, null);
});

test("buildReport: decisionsBigModelSkipped is the wider Jev-decision total minus how many were actually sampled here", () => {
  const results = [comparison({ id: "a" }), comparison({ id: "b" })];
  assert.equal(buildReport(results, 1441).decisionsBigModelSkipped, 1439);
});

test("buildReport: decisionsBigModelSkipped never goes negative, even if the supplied total undercounts the sampled set", () => {
  assert.equal(buildReport([comparison()], 0).decisionsBigModelSkipped, 0);
});
