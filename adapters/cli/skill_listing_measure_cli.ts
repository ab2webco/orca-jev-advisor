#!/usr/bin/env node
// JEVADV-112: how often the engine's skill listing is re-read, and what
// withholding it keeps out.
//
// Usage (also `npm run measure-skill-listing -- <args>`):
//
//   node --experimental-strip-types adapters/cli/skill_listing_measure_cli.ts [--transcripts DIR]... [--json]
//
// Read-only. `--transcripts` points at a Claude Code `projects` folder (or
// any folder of transcript .jsonl files, searched recursively); without it,
// `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`) is read. The
// mod's own mod-skills and turn-usage rows come from the cache directory.
// The logic lives in src/core/skill_listing_measure.ts.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { measurementFilesToRead } from "../../src/core/measurement_files.ts";
import { parseJsonlCounted } from "../../src/core/member_routing_measure.ts";
import { normalizePlatform, resolveCacheDir } from "../../src/core/paths.ts";
import { measureTranscript, summarizeTranscripts, summarizeWithholds } from "../../src/core/skill_listing_measure.ts";

function cacheDir(): string {
  return resolveCacheDir(normalizePlatform(process.platform), {
    home: homedir(),
    appDataDir: process.env.APPDATA,
    localAppDataDir: process.env.LOCALAPPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  });
}

function transcriptFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) transcriptFiles(path, out, depth + 1);
    else if (name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function readRows(path: string): unknown[] {
  try {
    return parseJsonlCounted(readFileSync(path, "utf8")).rows;
  } catch {
    return [];
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: measure-skill-listing [--transcripts DIR]... [--json]");
    return;
  }
  const json = argv.includes("--json");
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--transcripts" && argv[i + 1] !== undefined) dirs.push(argv[i + 1] as string);
  if (dirs.length === 0) dirs.push(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"));

  const transcripts = summarizeTranscripts(dirs.flatMap((dir) => transcriptFiles(dir)).map((file) => measureTranscript(readRows(file))));

  const cache = cacheDir();
  const names = existsSync(cache) ? readdirSync(cache) : [];
  const skillRows = measurementFilesToRead("mod-skills", names).flatMap((name) => readRows(join(cache, name)));
  const usageRows = names.filter((name) => /^turn-usage-.*\.jsonl$/.test(name)).flatMap((name) => readRows(join(cache, name)));
  const withholds = summarizeWithholds(skillRows, usageRows);

  if (json) {
    console.log(JSON.stringify({ transcripts, withholds: { listingsAsked: withholds.listingsAsked, byReason: withholds.byReason, sessions: withholds.withheld.length } }, null, 2));
    return;
  }
  const n = (value: number | null): string => (value === null ? "n/a" : value.toLocaleString("en-US"));
  console.log("## Skill listing, from transcripts");
  console.log(`- Sessions: ${n(transcripts.sessions)}; with a listing: ${n(transcripts.sessionsWithListing)}`);
  console.log(`- Listing rows per session: ${transcripts.listingsPerSession === null ? "n/a" : transcripts.listingsPerSession.join("-")} (${n(transcripts.initialListings)} initial)`);
  console.log(`- Median: ${n(transcripts.medianPrompts)} prompts, ${n(transcripts.medianListingChars)} listing chars, ${n(transcripts.medianRequestsCarrying)} requests carrying it`);
  console.log(`- Listing tokens re-read in a median session: ${n(transcripts.medianSessionReReadTokens)}`);
  console.log("");
  console.log("## Withheld listings, from the mod's rows");
  console.log(`- Listings asked about: ${n(withholds.listingsAsked)}`);
  for (const [reason, entry] of Object.entries(withholds.byReason)) {
    console.log(`- ${reason}: ${n(entry.sessions)} sessions, ${n(entry.tokensKeptOut)} tokens kept out, ${n(entry.skillUsesAfter)} skills used after`);
  }
}

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
