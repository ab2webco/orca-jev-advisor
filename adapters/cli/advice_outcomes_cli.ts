#!/usr/bin/env node
// JEVADV-111: which risk advices changed the next command, per family, and a
// replay of the silent-judgement rule over the recorded decisions.
//
// Usage (also `npm run measure-advice-outcomes -- <args>`):
//
//   node --experimental-strip-types adapters/cli/advice_outcomes_cli.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir <cache dir>] [--totals] [--json]
//
// Read-only: it reads gate-decisions*.jsonl from the cache directory and
// prints the totals and a table per advice key (or the replay as JSON). The
// per-key table names the commands that ran: keep it local, and use
// --totals for anything public. When no decision falls in the range, it says
// so and names the dates the files do hold. The logic lives in
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
    console.log("Usage: measure-advice-outcomes [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir <cache dir>] [--totals] [--json]");
    console.log("  Per advice key (program and subcommand): risk advices, how many were re-run unchanged, how many the");
    console.log("  silent-judgement rule would have let run, and how many of those were followed by a different command.");
    console.log("  --totals prints the totals only (the per-key table names the commands that ran: keep it local).");
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
  const files = gateDecisionFilesToRead(names);
  const all = files.flatMap((name) => {
    try {
      return [...parseGateDecisionRecords(readFileSync(join(dir, name), "utf8"))];
    } catch {
      return [];
    }
  });
  const times = all.map((record) => record.at).sort();
  const records = all.filter((record) => {
    const at = Date.parse(record.at);
    return (fromMs === null || at >= fromMs) && (toMs === null || at < toMs);
  });
  const coverage = {
    from: valueOf("--from") ?? null,
    to: valueOf("--to") ?? null,
    filesRead: files.length,
    recordsInRange: records.length,
    oldest: times[0] ?? null,
    newest: times.at(-1) ?? null,
  };
  const replay = replayAdviceOutcomes(records);
  if (argv.includes("--json")) {
    const totalsOnly = argv.includes("--totals");
    console.log(JSON.stringify({ coverage, ...replay, keys: totalsOnly ? undefined : replay.keys }, null, 2));
  } else {
    process.stdout.write(formatAdviceReplayMarkdown(replay, coverage, { totalsOnly: argv.includes("--totals") }));
  }
  if (records.length === 0) process.exitCode = 1;
}

main();
