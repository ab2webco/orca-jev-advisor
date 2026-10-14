import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, cacheClockUnknown, cacheUnknownOf, cacheWarm, cacheWarmth, foundTranscriptPath, mergeCacheTail, parseCacheClock, readCacheTail, transcriptFindArgv, transcriptPathOf } from "./cache_warmth.ts";

const AT = "2026-10-12T10:00:00.000Z";
const AT_MS = Date.parse(AT);

function assistantRow(fields: { timestamp?: string; isSidechain?: boolean; usage?: unknown }): string {
  return JSON.stringify({ type: "assistant", timestamp: fields.timestamp ?? AT, isSidechain: fields.isSidechain ?? false, message: { role: "assistant", ...(fields.usage === undefined ? {} : { usage: fields.usage }) } });
}

function usage(oneHour: number, fiveMinutes: number): unknown {
  return { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: oneHour + fiveMinutes, cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: fiveMinutes }, output_tokens: 10 };
}

test("a main row that wrote the 1h bucket reads a 1h TTL and its own time", () => {
  const tail = [JSON.stringify({ type: "user", timestamp: AT }), assistantRow({ usage: usage(500, 0) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("a main row that wrote the 5m bucket reads a 5m TTL", () => {
  assert.deepEqual(readCacheTail(assistantRow({ usage: usage(0, 500) })), { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS });
});

test("the newest main row decides; a pure cache read looks further back for the bucket", () => {
  const later = "2026-10-12T10:05:00.000Z";
  const tail = [assistantRow({ usage: usage(0, 500) }), assistantRow({ timestamp: later, usage: usage(0, 0) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_5M_MS, lastMainAt: Date.parse(later) });
});

test("a subagent (sidechain) row is never the main thread's", () => {
  const later = "2026-10-12T10:05:00.000Z";
  const tail = [assistantRow({ usage: usage(500, 0) }), assistantRow({ timestamp: later, isSidechain: true, usage: usage(0, 500) })].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("missing usage is unknown, never a guessed TTL", () => {
  assert.deepEqual(readCacheTail(assistantRow({})), { ttlMs: null, lastMainAt: AT_MS });
  assert.deepEqual(readCacheTail(""), { ttlMs: null, lastMainAt: null });
});

test("a malformed row is skipped, and the rows around it still read", () => {
  const tail = [assistantRow({ usage: usage(500, 0) }), '{"type":"assistant","message":{"usage":{"cache_creation"', "not json at all"].join("\n");
  assert.deepEqual(readCacheTail(tail), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
});

test("a row with an unreadable timestamp gives no time, but its bucket still counts", () => {
  assert.deepEqual(readCacheTail(assistantRow({ timestamp: "yesterday", usage: usage(500, 0) })), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: null });
});

test("cacheWarm: warm while now - last < ttl, cold from the TTL on", () => {
  const clock = { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS };
  assert.equal(cacheWarm(clock, AT_MS + CACHE_TTL_5M_MS - 1), true);
  assert.equal(cacheWarm(clock, AT_MS + CACHE_TTL_5M_MS), false);
  assert.equal(cacheWarmth(clock, AT_MS + CACHE_TTL_5M_MS), false);
  assert.equal(cacheWarm({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS }, AT_MS + CACHE_TTL_5M_MS), true);
});

test("unknown is warm: no TTL or no last request keeps today's behaviour", () => {
  const late = AT_MS + 10 * CACHE_TTL_1H_MS;
  assert.equal(cacheWarmth({ ttlMs: null, lastMainAt: AT_MS }, late), null);
  assert.equal(cacheWarmth({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }, late), null);
  assert.equal(cacheWarm({ ttlMs: null, lastMainAt: AT_MS }, late), true);
  assert.equal(cacheWarm({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }, late), true);
});

test("parseCacheClock keeps only finite numbers, else unknown", () => {
  assert.deepEqual(parseCacheClock({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS }), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
  assert.deepEqual(parseCacheClock({ ttlMs: "1h", lastMainAt: Number.NaN }), { ttlMs: null, lastMainAt: null });
  assert.deepEqual(parseCacheClock(undefined), { ttlMs: null, lastMainAt: null });
});

// ---------------------------------------------------------------------------
// R5 (odd/tasks/router-cache-ttl.md): the router reads the transcript tail
// itself, since `classic.Stop` never arrives on Team/Enterprise accounts.
// ---------------------------------------------------------------------------

test("R5: the transcript sits under the config dir's projects, in the slug of where the session started", () => {
  assert.equal(
    transcriptPathOf({ configDir: "/home/dev/.claude", sessionRoot: "/home/dev/Projects/my.app", sessionId: "4f1c-9a" }),
    "/home/dev/.claude/projects/-home-dev-Projects-my-app/4f1c-9a.jsonl",
  );
  assert.equal(transcriptPathOf({ configDir: "/acc/auth/", sessionRoot: "/w", sessionId: "s1" }), "/acc/auth/projects/-w/s1.jsonl");
});

test("R5: the fallback looks the session up by id two levels under projects, with no shell", () => {
  assert.deepEqual(transcriptFindArgv("/home/dev/.claude", "4f1c-9a"), ["find", "-H", "/home/dev/.claude/projects", "-maxdepth", "2", "-type", "f", "-name", "4f1c-9a.jsonl"]);
});

test("R5: the fallback finds the transcript when projects is a symlink, as on every Orca account", () => {
  const root = mkdtempSync(join(tmpdir(), "cache-warmth-find-"));
  try {
    mkdirSync(join(root, "shared", "-old-worktree"), { recursive: true });
    writeFileSync(join(root, "shared", "-old-worktree", "4f1c-9a.jsonl"), "{}\n");
    mkdirSync(join(root, "account"));
    symlinkSync(join(root, "shared"), join(root, "account", "projects"));
    const argv = transcriptFindArgv(join(root, "account"), "4f1c-9a");
    assert.notEqual(argv, null);
    const [program, ...args] = argv ?? [];
    const stdout = execFileSync(program ?? "find", args, { encoding: "utf8" });
    assert.equal(foundTranscriptPath(stdout, "4f1c-9a"), join(root, "account", "projects", "-old-worktree", "4f1c-9a.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R5: a session id that is not a plain id is never handed to find as a pattern", () => {
  for (const id of ["", "*", "a/b", "../x", "s?1", "s[1]"]) assert.equal(transcriptFindArgv("/c", id), null, id);
});

test("R5: find's first line that is this session's transcript is the one read", () => {
  assert.equal(foundTranscriptPath("/c/projects/-w/s1.jsonl\n/c/projects/-v/s1.jsonl\n", "s1"), "/c/projects/-w/s1.jsonl");
  assert.equal(foundTranscriptPath("\n/c/projects/-w/other.jsonl\n", "s1"), null);
  assert.equal(foundTranscriptPath("", "s1"), null);
});

test("R5: the clock is read while its TTL or its last request is unknown", () => {
  assert.equal(cacheClockUnknown({ ttlMs: null, lastMainAt: AT_MS }), true);
  assert.equal(cacheClockUnknown({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }), true);
  assert.equal(cacheClockUnknown({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS }), false);
});

test("R5: a tail merges into the stored clock: its TTL when it has one, the later request time", () => {
  const stored = { ttlMs: null, lastMainAt: AT_MS + 500 };
  assert.deepEqual(mergeCacheTail(stored, { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS }), { ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS + 500 });
  assert.deepEqual(mergeCacheTail({ ttlMs: CACHE_TTL_1H_MS, lastMainAt: null }, { ttlMs: null, lastMainAt: AT_MS }), { ttlMs: CACHE_TTL_1H_MS, lastMainAt: AT_MS });
  assert.deepEqual(mergeCacheTail({ ttlMs: null, lastMainAt: null }, { ttlMs: null, lastMainAt: null }), { ttlMs: null, lastMainAt: null });
});

test("R6: an unknown cache says why: the tail read failed, else no TTL, else no last request; a known one says nothing", () => {
  assert.equal(cacheUnknownOf({ ttlMs: null, lastMainAt: null }, true), "tail-failed");
  assert.equal(cacheUnknownOf({ ttlMs: null, lastMainAt: AT_MS }, false), "no-ttl");
  assert.equal(cacheUnknownOf({ ttlMs: null, lastMainAt: null }, false), "no-ttl");
  assert.equal(cacheUnknownOf({ ttlMs: CACHE_TTL_5M_MS, lastMainAt: null }, false), "no-last-request");
  assert.equal(cacheUnknownOf({ ttlMs: CACHE_TTL_5M_MS, lastMainAt: AT_MS }, false), null);
});
