// ---------------------------------------------------------------------------
// Prompt-cache warmth for the model router (odd/tasks/router-cold-switch.md,
// R0). A model or effort switch rewrites the whole context, because the
// cache is per model and per effort. After a gap longer than the cache TTL
// that rewrite happens anyway, so the switch costs nothing extra.
//
// The engine's step usage has no 1h/5m split, so the TTL is read the way
// cache-clock's `readTtl` reads it: the transcript tail's newest main-thread
// (`!isSidechain`) assistant row says which bucket it wrote
// (`message.usage.cache_creation.ephemeral_1h_input_tokens` or
// `ephemeral_5m_input_tokens`). A pure cache read says neither, so the walk
// looks further back.
//
// Unknown is warm: no TTL, no last request, or a malformed row keeps the
// router exactly as it was before this file.
//
// R5 (odd/tasks/router-cache-ttl.md): on Team and Enterprise accounts the
// built-in security plugin withholds `classic.*` events from installed
// plugins, so the TTL cannot wait for `classic.Stop`. The router reads the
// tail itself, from the session's transcript: `<config dir>/projects/<slug
// of where the session started>/<session id>.jsonl`, else wherever `find`
// finds `<session id>.jsonl` two levels under `<config dir>/projects`.
//
// Pure: no I/O, no clock (the caller passes `nowMs`).
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { projectSlug } from "./memory_detect.ts";

export const CACHE_TTL_1H_MS = 60 * 60_000;
export const CACHE_TTL_5M_MS = 5 * 60_000;

/** The main thread's cache TTL and the time of its last request; null where unknown. */
export interface CacheClock {
  readonly ttlMs: number | null;
  readonly lastMainAt: number | null;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The bucket one assistant row wrote, or null when it wrote none (a pure read, or no usage). */
function bucketOf(message: unknown): number | null {
  if (!isRecord(message) || !isRecord(message.usage) || !isRecord(message.usage.cache_creation)) return null;
  const creation = message.usage.cache_creation;
  if (positive(creation.ephemeral_1h_input_tokens)) return CACHE_TTL_1H_MS;
  if (positive(creation.ephemeral_5m_input_tokens)) return CACHE_TTL_5M_MS;
  return null;
}

/** Reads `tail -n <N> <transcript>`'s output, newest row last. */
export function readCacheTail(tail: string): CacheClock {
  let ttlMs: number | null = null;
  let lastMainAt: number | null = null;
  let sawMain = false;
  const rows = tail.split("\n").reverse();
  for (const row of rows) {
    if (!row.includes('"assistant"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "assistant" || parsed.isSidechain === true) continue;
    if (!sawMain) {
      sawMain = true;
      const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      lastMainAt = Number.isFinite(at) ? at : null;
    }
    ttlMs = bucketOf(parsed.message);
    if (ttlMs !== null) break;
  }
  return { ttlMs, lastMainAt };
}

/** R6: why `cacheWarmth` is null: the transcript read failed, no TTL was found, or no main request is known. */
export type CacheUnknown = "no-ttl" | "no-last-request" | "tail-failed";

/** R6: the reason a clock is unknown (`tailFailed`: a read was needed and none answered); null when it is known. */
export function cacheUnknownOf(clock: CacheClock, tailFailed: boolean): CacheUnknown | null {
  if (!cacheClockUnknown(clock)) return null;
  if (tailFailed) return "tail-failed";
  return clock.ttlMs === null ? "no-ttl" : "no-last-request";
}

/** true warm, false cold, null unknown (no TTL or no last request). */
export function cacheWarmth(clock: CacheClock, nowMs: number): boolean | null {
  if (clock.ttlMs === null || clock.lastMainAt === null) return null;
  return nowMs - clock.lastMainAt < clock.ttlMs;
}

/** Whether a switch now would forfeit a warm cache. Unknown counts as warm. */
export function cacheWarm(clock: CacheClock, nowMs: number): boolean {
  return cacheWarmth(clock, nowMs) ?? true;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A stored clock read back from `$.state`; anything malformed is unknown. */
export function parseCacheClock(raw: unknown): CacheClock {
  if (!isRecord(raw)) return { ttlMs: null, lastMainAt: null };
  return { ttlMs: finiteOrNull(raw.ttlMs), lastMainAt: finiteOrNull(raw.lastMainAt) };
}

/** R5: whether the clock still lacks its TTL or its last request, so the transcript is worth reading. */
export function cacheClockUnknown(clock: CacheClock): boolean {
  return clock.ttlMs === null || clock.lastMainAt === null;
}

/** A tail read into the stored clock: the tail's TTL when it has one, and the later of the two request times. */
export function mergeCacheTail(stored: CacheClock, tail: CacheClock): CacheClock {
  const lastMainAt = stored.lastMainAt === null ? tail.lastMainAt : tail.lastMainAt === null ? stored.lastMainAt : Math.max(stored.lastMainAt, tail.lastMainAt);
  return { ttlMs: tail.ttlMs ?? stored.ttlMs, lastMainAt };
}

function withoutTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/** R5: where Claude Code writes this session's transcript. `sessionRoot` is where the session started (`$.session.root()`). */
export function transcriptPathOf(input: { readonly configDir: string; readonly sessionRoot: string; readonly sessionId: string }): string {
  return `${withoutTrailingSlashes(input.configDir)}/projects/${projectSlug(input.sessionRoot)}/${input.sessionId}.jsonl`;
}

/** A session id plain enough to be a file name and never a `find` pattern. */
const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * R5: the argv that finds this session's transcript under any project folder (a moved root); null for an id that is not plain.
 * `-H` follows `projects` itself when it is a symlink, as it is on every Orca account (it points at the shared transcript store);
 * without it `find` lists the link and never descends, so the fallback found nothing there.
 */
export function transcriptFindArgv(configDir: string, sessionId: string): readonly string[] | null {
  if (!PLAIN_SESSION_ID.test(sessionId)) return null;
  return ["find", "-H", `${withoutTrailingSlashes(configDir)}/projects`, "-maxdepth", "2", "-type", "f", "-name", `${sessionId}.jsonl`];
}

/** R5: the first line of `find`'s output that is this session's transcript; null when there is none. */
export function foundTranscriptPath(stdout: string, sessionId: string): string | null {
  const suffix = `/${sessionId}.jsonl`;
  return stdout.split("\n").map((line) => line.trim()).find((line) => line.endsWith(suffix)) ?? null;
}
