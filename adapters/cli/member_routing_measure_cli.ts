#!/usr/bin/env node
// JEVADV-118 T7: the acceptance measurement, per Orca member session.
//
// Usage (also `npm run measure-member-routing -- <args>`):
//
//   node --experimental-strip-types adapters/cli/member_routing_measure_cli.ts --from YYYY-MM-DD --to YYYY-MM-DD [--json]
//
// Read-only: it reads the router's decision rows, the turn-usage rows and the
// CI watch rows from the cache directory and prints a Markdown table (or the
// report as JSON). The logic lives in src/core/member_routing_measure.ts and
// is unit-tested there; this file is the IO shell.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { formatMemberRoutingMarkdown, measureMemberRouting, memberRoutingFilesToRead, parseJsonlCounted, parseMemberRoutingArgs } from "../../src/core/member_routing_measure.ts";
import { normalizePlatform, resolveCacheDir } from "../../src/core/paths.ts";

function cacheDir(): string {
  return resolveCacheDir(normalizePlatform(process.platform), {
    home: homedir(),
    appDataDir: process.env.APPDATA,
    localAppDataDir: process.env.LOCALAPPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  });
}

function readRows(dir: string, names: readonly string[]): { rows: unknown[]; malformed: number } {
  const rows: unknown[] = [];
  let malformed = 0;
  for (const name of names) {
    try {
      const parsed = parseJsonlCounted(readFileSync(join(dir, name), "utf8"));
      rows.push(...parsed.rows);
      malformed += parsed.malformed;
    } catch {
      // A file gone between the listing and the read: nothing to count.
    }
  }
  return { rows, malformed };
}

function printHelp(): void {
  console.log("Usage:");
  console.log("  measure-member-routing --from YYYY-MM-DD --to YYYY-MM-DD [--json]");
  console.log("    Orca member sessions whose first start fell in the window (UTC days, end exclusive):");
  console.log("    steps, tokens, step mix, who chose the start, escalations and CI watches.");
}

function main(): void {
  const args = parseMemberRoutingArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "error") {
    console.error(args.message);
    process.exitCode = 2;
    return;
  }
  const dir = cacheDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // Nothing was ever recorded: the report says 0 member sessions.
  }
  const files = memberRoutingFilesToRead(names, args.fromMs);
  const decisions = readRows(dir, files.decisions);
  const usage = readRows(dir, files.usage);
  const ci = readRows(dir, files.ci);
  const report = measureMemberRouting({
    decisions: decisions.rows,
    usage: usage.rows,
    ciWatches: ci.rows,
    fromMs: args.fromMs,
    toMs: args.toMs,
    malformedLines: decisions.malformed + usage.malformed + ci.malformed,
  });
  if (args.json) {
    console.log(JSON.stringify({ from: args.from, to: args.to, ...report }, null, 2));
    return;
  }
  for (const line of formatMemberRoutingMarkdown(report, args.from, args.to)) console.log(line);
}

// Only run when invoked directly, never when imported (same guard as jev_health_cli.ts).
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

if (isEntryPoint(process.argv[1])) main();
