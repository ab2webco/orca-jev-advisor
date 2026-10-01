#!/usr/bin/env node
// 0.6.22 (JEVADV-97): health probes for Jev's judgment, one command each, so
// a Jev model update or an edit to a question can be checked on evidence.
//
// Usage (also `npm run jev-health -- <args>`):
//
//   node --experimental-strip-types adapters/cli/jev_health_cli.ts usage [--days N]
//   node --experimental-strip-types adapters/cli/jev_health_cli.ts flips [--commands-file F] [--runs N]
//
// `usage` only reads the router's and the steward's decision logs; it never
// calls Jev. `flips` calls the real Jev (never the `claude` CLI), runs x
// commands times, one call after another; without --commands-file it uses
// adapters/cli/fixtures/jev-health-corpus.txt. The logic lives in src/core/jev_health_*.ts and is unit-tested
// there; this file is the IO shell: argv, the cache directory, the files and
// the printing.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseCommandsFile } from "../../src/core/commands_file.ts";
import { callJev } from "../../src/core/jev.ts";
import { parseJevHealthArgs } from "../../src/core/jev_health_args.ts";
import type { JevHealthArgs } from "../../src/core/jev_health_args.ts";
import { formatFlipReport, runFlips } from "../../src/core/jev_health_flips.ts";
import type { AnswersCaller } from "../../src/core/jev_health_flips.ts";
import { formatUsageReport, parseJsonlRows, summarizeUsage, usageFilesToRead } from "../../src/core/jev_health_usage.ts";
import { normalizePlatform, resolveCacheDir } from "../../src/core/paths.ts";
import { resolveApiKey } from "../../src/core/secrets.ts";

function cacheDir(): string {
  return resolveCacheDir(normalizePlatform(process.platform), {
    home: homedir(),
    appDataDir: process.env.APPDATA,
    localAppDataDir: process.env.LOCALAPPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  });
}

function readRows(dir: string, names: readonly string[]): unknown[] {
  return names.flatMap((name) => {
    try {
      return parseJsonlRows(readFileSync(join(dir, name), "utf8"));
    } catch {
      return [];
    }
  });
}

function runUsage(args: Extract<JevHealthArgs, { command: "usage" }>): void {
  const dir = cacheDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // Nothing was ever recorded: the report says so.
  }
  const nowMs = Date.now();
  const files = usageFilesToRead(names, nowMs, args.days);
  const report = summarizeUsage(readRows(dir, files.router), readRows(dir, files.steward), nowMs, args.days);
  for (const line of formatUsageReport(report, args.days)) console.log(line);
}

const DEFAULT_CORPUS = new URL("./fixtures/jev-health-corpus.txt", import.meta.url);

/** The real Jev, for the probes: the answers of one call; it throws when the call fails. */
function realAnswersCaller(apiKey: string): AnswersCaller {
  return async (state, questions) => (await callJev(apiKey, state, questions)).answers;
}

async function runFlipsCommand(args: Extract<JevHealthArgs, { command: "flips" }>): Promise<void> {
  const apiKey = await resolveApiKey();
  if (apiKey === null) {
    console.error("no Jev API key configured: nothing to measure");
    process.exitCode = 2;
    return;
  }
  const commands = parseCommandsFile(readFileSync(args.commandsFile ?? DEFAULT_CORPUS, "utf8"));
  const report = await runFlips({
    commands,
    runs: args.runs,
    caller: realAnswersCaller(apiKey),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.error(`[${done}/${total}] calls`);
    },
  });
  for (const line of formatFlipReport(report)) console.log(line);
}

function printHelp(): void {
  console.log("Usage:");
  console.log("  jev-health usage [--days N]    how often Jev picks each option (default 7 days)");
  console.log("  jev-health flips [--commands-file F] [--runs N]    how often Jev's gate answers change (default 5 runs, the committed corpus)");
}

async function main(): Promise<void> {
  const args = parseJevHealthArgs(process.argv.slice(2));
  if (args.command === "usage") {
    runUsage(args);
    return;
  }
  if (args.command === "flips") {
    await runFlipsCommand(args);
    return;
  }
  if (args.command === "error") {
    console.error(args.message);
    process.exitCode = 2;
    return;
  }
  printHelp();
}

// Only run when invoked directly, never when imported (same guard as ab_benchmark_cli.ts).
function isEntryPoint(argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false;
  let real = argvPath;
  try {
    real = realpathSync(argvPath);
  } catch {
    // Not on disk under that name: compare it as given.
  }
  return import.meta.url === pathToFileURL(real).href;
}

if (isEntryPoint(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
