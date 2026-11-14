#!/usr/bin/env node
// JEVADV-111: which risk advices changed the next command, per family, and a
// replay of the silent-judgement rule over the recorded decisions.
//
// Usage (also `npm run measure-advice-outcomes -- <args>`):
//
//   node --experimental-strip-types adapters/cli/advice_outcomes_cli.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir <cache dir>] [--json]
//
// Read-only: it reads gate-decisions*.jsonl from the cache directory and
// prints a Markdown table (or the replay as JSON). The logic lives in
// src/core/gate_advice_outcomes.ts and is unit-tested there.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatAdviceReplayMarkdown, replayAdviceOutcomes } from "../../src/core/gate_advice_outcomes.ts";
import { parseGateDecisionRecords } from "../../src/core/gate_measurement.ts";
import { gateDecisionFilesToRead } from "../../src/core/measurement_files.ts";
import { normalizePlatform, resolveCacheDir } from "../../src/core/paths.ts";

function defaultCacheDir(): string {
  return resolveCacheDir(normalizePlatform(process.platform), {
    home: homedir(),
    appDataDir: process.env.APPDATA,
    localAppDataDir: process.env.LOCALAPPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  });
}

function day(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms)) throw new Error(`${flag} needs a date like 2026-10-15`);
  return ms;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: measure-advice-outcomes [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir <cache dir>] [--json]");
    console.log("  Per command family: risk advices, how many were re-run unchanged, and how many the silent-judgement rule would have let run.");
    return;
  }
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  let fromMs: number | null;
  let toMs: number | null;
  try {
    fromMs = day(valueOf("--from"), "--from");
    toMs = day(valueOf("--to"), "--to");
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const dir = valueOf("--dir") ?? defaultCacheDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // Nothing recorded: an empty table.
  }
  const records = gateDecisionFilesToRead(names).flatMap((name) => {
    try {
      return [...parseGateDecisionRecords(readFileSync(join(dir, name), "utf8"))];
    } catch {
      return [];
    }
  }).filter((record) => {
    const at = Date.parse(record.at);
    return (fromMs === null || at >= fromMs) && (toMs === null || at < toMs);
  });
  const replay = replayAdviceOutcomes(records);
  if (argv.includes("--json")) console.log(JSON.stringify(replay, null, 2));
  else process.stdout.write(formatAdviceReplayMarkdown(replay));
}

main();
