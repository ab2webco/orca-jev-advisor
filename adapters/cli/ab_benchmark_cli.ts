#!/usr/bin/env node
// The AB-benchmark's own runnable command: drains sampled gate decisions
// (queued out of band by adapters/claude/gate-bash.ts, see that file's own
// note on appendAbBenchmarkSample) and/or a person-supplied batch of
// commands, asks the large model the same family-level question for each,
// and reports the comparison. See src/core/ab_benchmark.ts's module note
// for the full design and its privacy tradeoff.
//
// Usage (also `npm run ab-benchmark -- <args>`):
//
//   node --experimental-strip-types adapters/cli/ab_benchmark_cli.ts compare [--cap N] [--commands-file PATH]
//   node --experimental-strip-types adapters/cli/ab_benchmark_cli.ts config --enable|--disable [--sample-rate N] [--daily-cap N]
//
// `compare` works with an empty queue: pass --commands-file to measure
// against a person-supplied batch of real commands (one per line, '#'
// starts a comment) without waiting for the gate to sample real traffic.
// Those commands are used ONLY in memory, to compute a family and to call
// Jev -- never written to disk (see runCompare below).
//
// --cap bounds how many big-model calls THIS RUN makes (defaulting to the
// config's dailySampleCap when omitted) -- a sample-count safety, not a
// financial one: this plugin's large-model account is a Claude
// subscription, not pay-per-token (see ab_benchmark.ts's module note), so
// the risk a cap protects against is exhausting a subscription's usage
// allowance and rate-limiting the person out of their own editor, not a
// bill. This run's own per-sample lines and final report never mention a
// dollar figure, for the same reason.
//
// `runCompare` is deliberately IO-free (every input is plain data or an
// injected function) so it is unit-tested directly -- see
// ab_benchmark_cli.test.ts. Everything below it in this file is the thin,
// untested-by-unit-tests IO shell: real fs reads/writes, the real `claude`
// spawn, the real Jev network call, argv and console.log.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { buildActionGateQuestions, buildActionGateState, decideAction } from "../../src/core/decisions.ts";
import { commandFamily, parseGateDecisionRecords } from "../../src/core/gate_measurement.ts";
import { callJev } from "../../src/core/jev.ts";
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from "../../src/core/paths.ts";
import { resolveApiKey } from "../../src/core/secrets.ts";
import {
  buildReport,
  compareOne,
  parseSampleEntries,
  serializeSampleEntry,
  type AbBenchmarkReport,
  type AbComparisonResult,
  type AbSampleEntry,
  type BigModelRunner,
  type GateLikeVerdict,
} from "../../src/core/ab_benchmark.ts";
import { DEFAULT_AB_BENCHMARK_CONFIG, parseAbBenchmarkConfig, type AbBenchmarkConfig } from "../../src/core/ab_benchmark_config.ts";

// ---------------------------------------------------------------------------
// runCompare -- IO-free orchestration. See this file's own header note.
// ---------------------------------------------------------------------------

export interface JevCallResult {
  readonly verdict: GateLikeVerdict;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Resolves after judging one direct-batch command, or null when Jev was unavailable or the call failed -- a reported skip, never a fabricated verdict. */
export type JevCaller = (command: string) => Promise<JevCallResult | null>;

export interface RunCompareInput {
  readonly queueRaw: string;
  /** Raw lines from --commands-file, already read; empty when that flag was not given. */
  readonly commandLines: readonly string[];
  readonly config: AbBenchmarkConfig;
  /** Max big-model calls this run makes, across the queue and the commands file combined. */
  readonly cap: number;
  readonly bigModelRunner: BigModelRunner;
  /** null when no Jev API key resolved -- direct-batch commands are then reported skipped, not measured. */
  readonly jevCaller: JevCaller | null;
  readonly totalJevDecisions: number | null;
  readonly onSample?: (result: AbComparisonResult, index: number, total: number) => void;
}

export interface RunCompareOutput {
  readonly results: readonly AbComparisonResult[];
  readonly report: AbBenchmarkReport;
  /** Queue entries not reached this run (cap or count) -- write these back to the queue file so nothing is silently dropped. */
  readonly remainingQueueEntries: readonly AbSampleEntry[];
  /** Commands-file lines that could not be measured (no JevCaller, or the call failed) -- reported, never silently ignored. */
  readonly directBatchSkipped: number;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

export async function runCompare(input: RunCompareInput): Promise<RunCompareOutput> {
  const queueEntries = parseSampleEntries(input.queueRaw);
  const takeFromQueue = Math.max(0, Math.min(queueEntries.length, input.cap));
  const fromQueue = queueEntries.slice(0, takeFromQueue);
  const remainingQueueEntries = queueEntries.slice(takeFromQueue);

  const directEntries: AbSampleEntry[] = [];
  let directBatchSkipped = 0;
  let budgetLeft = input.cap - fromQueue.length;

  for (const rawLine of input.commandLines) {
    if (budgetLeft <= 0) break;
    if (isBlankOrComment(rawLine)) continue;
    const command = rawLine.trim();
    if (input.jevCaller === null) {
      directBatchSkipped += 1;
      continue;
    }
    const jevResult = await input.jevCaller(command);
    if (jevResult === null) {
      directBatchSkipped += 1;
      continue;
    }
    directEntries.push({
      id: `direct-${directEntries.length}-${Date.now()}`,
      at: new Date().toISOString(),
      commandFamily: commandFamily(command),
      destinationKind: null,
      jevVerdict: jevResult.verdict,
      jevLatencyMs: jevResult.latencyMs,
      jevInputTokens: jevResult.inputTokens,
      jevOutputTokens: jevResult.outputTokens,
    });
    budgetLeft -= 1;
  }

  const allEntries = [...fromQueue, ...directEntries];
  const results: AbComparisonResult[] = [];
  for (let index = 0; index < allEntries.length; index++) {
    const entry = allEntries[index] as AbSampleEntry;
    const result = await compareOne(entry, { bigModelRunner: input.bigModelRunner });
    results.push(result);
    input.onSample?.(result, index + 1, allEntries.length);
  }

  return {
    results,
    report: buildReport(results, input.totalJevDecisions),
    remainingQueueEntries,
    directBatchSkipped,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing -- pure, hand-rolled (this plugin ships with zero
// dependencies -- see src/guards.ts's own module note for the same choice).
// ---------------------------------------------------------------------------

export type CliArgs =
  | { readonly command: "compare"; readonly cap: number | null; readonly commandsFile: string | null }
  | { readonly command: "config"; readonly enable: boolean | null; readonly sampleRate: number | null; readonly dailySampleCap: number | null }
  | { readonly command: "help" };

function readFlagValue(argv: readonly string[], index: number): string | null {
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command === "compare") {
    let cap: number | null = null;
    let commandsFile: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--cap") {
        const raw = readFlagValue(rest, i);
        if (raw !== null) cap = Number(raw);
      } else if (rest[i] === "--commands-file") {
        commandsFile = readFlagValue(rest, i);
      }
    }
    return { command: "compare", cap, commandsFile };
  }
  if (command === "config") {
    let enable: boolean | null = null;
    let sampleRate: number | null = null;
    let dailySampleCap: number | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--enable") enable = true;
      else if (rest[i] === "--disable") enable = false;
      else if (rest[i] === "--sample-rate") {
        const raw = readFlagValue(rest, i);
        if (raw !== null) sampleRate = Number(raw);
      } else if (rest[i] === "--daily-cap") {
        const raw = readFlagValue(rest, i);
        if (raw !== null) dailySampleCap = Number(raw);
      }
    }
    return { command: "config", enable, sampleRate, dailySampleCap };
  }
  return { command: "help" };
}

// ---------------------------------------------------------------------------
// Real IO: paths, the real large-model runner, the real Jev caller.
// ---------------------------------------------------------------------------

const PLATFORM = normalizePlatform(process.platform);
const HOME_PATHS = {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
};
const CACHE_DIR = resolveCacheDir(PLATFORM, HOME_PATHS);
const CONFIG_DIR = resolveConfigDir(PLATFORM, HOME_PATHS);

const CONFIG_PATH = join(CONFIG_DIR, "ab-benchmark-config.json");
const QUEUE_PATH = join(CACHE_DIR, "ab-benchmark-queue.jsonl");
const RESULTS_PATH = join(CACHE_DIR, "ab-benchmark-results.jsonl");
// The gate's own decision log (adapters/claude/gate-bash.ts's GATE_LOG_PATH)
// -- read-only from here, purely to count real "source":"jev" decisions for
// AbBenchmarkReport.decisionsBigModelSkipped. Never written by this CLI.
const GATE_LOG_PATH = join(CACHE_DIR, "gate-decisions.jsonl");

const execFileAsync = promisify(execFile);
const CLAUDE_TIMEOUT_MS = 60_000;

/** Spawns the real `claude` CLI. See src/core/ab_benchmark.ts's BigModelRunner for the outcome shape and why every test injects a fake one instead. */
export const realBigModelRunner: BigModelRunner = async (prompt) => {
  try {
    const { stdout } = await execFileAsync("claude", ["-p", "--output-format", "json", prompt], {
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { kind: "ok", stdout };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === "ENOENT") return { kind: "not-found" };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      // The process exited non-zero but still printed a JSON envelope
      // (`claude -p` does this for its own is_error:true case) -- let
      // parseClaudeCliEnvelope decide whether it is readable, rather than
      // discarding real data because the exit code was non-zero.
      return { kind: "ok", stdout: err.stdout };
    }
    return { kind: "error", message: err.message ?? String(error) };
  }
};

/** Real Jev, for direct-batch mode only -- queue-derived entries already carry Jev's real verdict/latency/tokens captured for free at sample time. */
export function makeRealJevCaller(apiKey: string): JevCaller {
  return async (command) => {
    const started = Date.now();
    try {
      const response = await callJev(apiKey, buildActionGateState(command, ""), buildActionGateQuestions());
      const latencyMs = Date.now() - started;
      const gate = decideAction(response.answers);
      return { verdict: gate.verdict, latencyMs, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    } catch {
      return null;
    }
  };
}

function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function countRealJevDecisions(): number | null {
  const raw = readTextOrEmpty(GATE_LOG_PATH);
  if (raw.length === 0) return null;
  return parseGateDecisionRecords(raw).filter((r) => r.source === "jev").length;
}

function formatLatency(stats: AbBenchmarkReport["jevLatency"]): string {
  return stats === null ? "no data" : `median ${stats.medianMs}ms, range ${stats.minMs}-${stats.maxMs}ms (n=${stats.count})`;
}

/** The real model id, exactly as the CLI reported it -- never a category. "model not reported" is the one allowed exception, and only when the CLI's envelope genuinely carried no id. */
function modelLabel(modelId: string | null): string {
  return modelId ?? "model not reported";
}

function printReport(report: AbBenchmarkReport): void {
  console.log("");
  console.log("=== AB benchmark: Jev vs. `claude -p` ===");
  console.log(`samples compared: ${report.sampleCount}`);
  console.log(`time to decide -- Jev: ${formatLatency(report.jevLatency)}`);
  console.log(`tokens -- Jev:         input ${report.jevTokens.input}, output ${report.jevTokens.output}`);
  console.log(
    report.decisionsBigModelSkipped === null
      ? "decisions no model had to make: n/a (no gate-decisions.jsonl to read)"
      : `decisions no model had to make: ${report.decisionsBigModelSkipped}`,
  );
  // Grouped by model id, never averaged across models: a median over two
  // different models is not a measurement of either one (see this file's
  // own module note and src/core/ab_benchmark.ts's BigModelGroupReport).
  if (report.byModel.length === 0) {
    console.log("");
    console.log("(no large-model comparison this run)");
  }
  for (const group of report.byModel) {
    console.log("");
    console.log(`--- ${modelLabel(group.modelId)} ---`);
    console.log(`samples: ${group.sampleCount} (${group.conclusiveCount} conclusive, ${group.inconclusiveCount} inconclusive)`);
    console.log(`time to decide: ${formatLatency(group.latency)}`);
    console.log(
      group.agreementRate === null
        ? "agreement rate vs. Jev: n/a (no conclusive comparison)"
        : `agreement rate vs. Jev: ${(group.agreementRate * 100).toFixed(1)}% (${group.agreeCount} agreed, ${group.disagreeCount} disagreed)`,
    );
    console.log(`tokens: input ${group.tokens.input}, output ${group.tokens.output}, cache-creation ${group.tokens.cacheCreation}, cache-read ${group.tokens.cacheRead}`);
  }
  console.log("");
  console.log("condition: every large-model call above is a FRESH `claude -p` invocation (no --resume) -- each one pays full session-bootstrap cache-creation cost, which is what a real always-on replacement for Jev would actually pay, not a warmed-up best case.");
}

async function runCompareCommand(args: Extract<CliArgs, { command: "compare" }>): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const config = parseAbBenchmarkConfig(readTextOrEmpty(CONFIG_PATH));
  const cap = args.cap ?? config.dailySampleCap;
  const commandLines = args.commandsFile !== null ? readTextOrEmpty(args.commandsFile).split("\n") : [];

  const apiKey = await resolveApiKey();
  if (apiKey === null && commandLines.some((l) => !isBlankOrComment(l))) {
    console.log("no Jev API key configured -- direct-batch commands will be reported skipped, not measured");
  }

  let completed = 0;
  const output = await runCompare({
    queueRaw: readTextOrEmpty(QUEUE_PATH),
    commandLines,
    config,
    cap,
    bigModelRunner: realBigModelRunner,
    jevCaller: apiKey === null ? null : makeRealJevCaller(apiKey),
    totalJevDecisions: countRealJevDecisions(),
    onSample: (result, index, total) => {
      completed = index;
      const label = modelLabel(result.bigModel.modelId);
      const verdictLine =
        result.bigModel.failureReason !== null
          ? `${label}: ${result.bigModel.failureReason}`
          : `${label}: ${result.bigModel.verdict} (${result.bigModel.latencyMs}ms)${result.agree === false ? " -- DISAGREES" : ""}`;
      console.log(`[${index}/${total}] ${result.commandFamily} -- Jev: ${result.jev.verdict} (${result.jev.latencyMs}ms) | ${verdictLine}`);
    },
  });

  writeFileSync(QUEUE_PATH, output.remainingQueueEntries.map(serializeSampleEntry).join(""));
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  for (const result of output.results) appendFileSync(RESULTS_PATH, `${JSON.stringify(result)}\n`);

  if (output.directBatchSkipped > 0) {
    console.log(`${output.directBatchSkipped} commands-file line(s) skipped (no API key, or the Jev call failed) -- not measured, not counted as a verdict`);
  }
  if (completed === 0 && output.directBatchSkipped === 0) {
    console.log("nothing to compare: the queue is empty and no --commands-file was given (or it was empty too)");
  }
  printReport(output.report);
  console.log(`results appended to ${RESULTS_PATH}`);
}

function runConfigCommand(args: Extract<CliArgs, { command: "config" }>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH) ? parseAbBenchmarkConfig(readTextOrEmpty(CONFIG_PATH)) : DEFAULT_AB_BENCHMARK_CONFIG;
  const next: AbBenchmarkConfig = {
    enabled: args.enable ?? current.enabled,
    sampleRate: args.sampleRate ?? current.sampleRate,
    dailySampleCap: args.dailySampleCap ?? current.dailySampleCap,
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${CONFIG_PATH}:`);
  console.log(JSON.stringify(next, null, 2));
}

function printHelp(): void {
  console.log("Usage:");
  console.log("  ab-benchmark compare [--cap N] [--commands-file PATH]");
  console.log("  ab-benchmark config --enable|--disable [--sample-rate N] [--daily-cap N]");
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "config") {
    runConfigCommand(args);
    return;
  }
  await runCompareCommand(args);
}

// Only run when invoked directly (`node ab_benchmark_cli.ts ...`), never
// when imported by ab_benchmark_cli.test.ts -- same guard shape as any
// other dual-purpose entry point in this codebase.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
