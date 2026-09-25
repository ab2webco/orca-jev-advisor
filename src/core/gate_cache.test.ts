// Unit tests for the v2 gate cache: a versioned file, a pure text loader
// that distinguishes "reset the whole file" from "drop one malformed entry"
// from "drop one expired entry", and a pure prune/putVerdict pair with an
// injected clock (never Date.now() read from inside src/core -- see the
// grep test at the bottom).
//
// The defect this closes: the v1 cache was an unversioned flat map, so a
// schema change looked identical to file corruption (every entry silently
// failed its per-entry validator, one at a time, with no way to tell "this
// install just upgraded" from "this file is corrupt"). v2 makes a schema
// mismatch a single, observable, whole-file event instead.
//
// Run with: node --test src/core/gate_cache.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GATE_CACHE_SCHEMA_VERSION,
  GATE_CACHE_TTL_MS,
  isValidGateCacheEntry,
  loadGateCacheText,
  pruneGateCache,
  putVerdict,
  serializeGateCacheFile,
} from "./gate_cache.ts";
import type { GateCacheEntry } from "./gate_cache.ts";

const NOW = 1_000_000_000_000;

function entry(overrides: Partial<GateCacheEntry> = {}): GateCacheEntry {
  return {
    decision: "allow",
    reason: "reversible, local and cheap",
    at: NOW - 1000,
    expiresAt: NOW + GATE_CACHE_TTL_MS,
    source: "jev",
    learnable: true,
    score: 0.4,
    confidence: 0.9,
    shape: "npm test",
    project: "app",
    destinationId: "app",
    worktreePath: "/repo",
    learnedAt: null,
    ...overrides,
  };
}

function humanApprovalEntry(overrides: Partial<GateCacheEntry> = {}): GateCacheEntry {
  return entry({
    decision: "allow",
    source: "human-approval",
    learnable: true,
    learnedAt: NOW - 1000,
    expiresAt: NOW + GATE_CACHE_TTL_MS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// loadGateCacheText
// ---------------------------------------------------------------------------

test("loadGateCacheText: no file at all is absent, distinct from a reset", () => {
  const result = loadGateCacheText(null, NOW);
  assert.equal(result.kind, "absent");
  assert.deepEqual(result.entries, {});
});

test("loadGateCacheText: a legacy v1 flat-map file (no version field) is an explicit reset, not a partial load", () => {
  const legacy = JSON.stringify({
    somekey: { decision: "allow", reason: "x", at: NOW - 1000 },
  });
  const result = loadGateCacheText(legacy, NOW);
  assert.equal(result.kind, "reset");
  if (result.kind === "reset") {
    assert.equal(result.reason, "unversioned");
    assert.equal(result.foundVersion, null);
  }
  assert.deepEqual(result.entries, {}, "no v1 entry survives into the reset result");
});

test("loadGateCacheText: version 1 is a whole-file reset, reporting the found version", () => {
  const v1 = JSON.stringify({ version: 1, entries: { k: { decision: "allow", reason: "x", at: NOW } } });
  const result = loadGateCacheText(v1, NOW);
  assert.equal(result.kind, "reset");
  if (result.kind === "reset") {
    assert.equal(result.reason, "version-mismatch");
    assert.equal(result.foundVersion, 1);
  }
});

test("loadGateCacheText: unparseable text is a reset with no found version", () => {
  const result = loadGateCacheText("{not valid json", NOW);
  assert.equal(result.kind, "reset");
  if (result.kind === "reset") {
    assert.equal(result.reason, "unparseable");
    assert.equal(result.foundVersion, null);
  }
});

test("loadGateCacheText: valid JSON that is not an object (an array) is a reset", () => {
  const result = loadGateCacheText("[1,2,3]", NOW);
  assert.equal(result.kind, "reset");
  if (result.kind === "reset") assert.equal(result.reason, "not-an-object");
});

test("loadGateCacheText: a current-version file with only valid entries loads cleanly, with zero drops", () => {
  const fresh = entry();
  const raw = JSON.stringify({ version: GATE_CACHE_SCHEMA_VERSION, entries: { k: fresh } });
  const result = loadGateCacheText(raw, NOW);
  assert.equal(result.kind, "loaded");
  if (result.kind === "loaded") {
    assert.deepEqual(result.entries, { k: fresh });
    assert.equal(result.droppedMalformed, 0);
    assert.equal(result.droppedExpired, 0);
  }
});

test("loadGateCacheText: a v2 file with one malformed entry among valid ones drops only that entry -- this is 'loaded', never 'reset'", () => {
  const good = entry();
  const raw = JSON.stringify({
    version: GATE_CACHE_SCHEMA_VERSION,
    entries: { good, bad: { decision: "allow", reason: "missing everything else" } },
  });
  const result = loadGateCacheText(raw, NOW);
  assert.equal(result.kind, "loaded", "a malformed entry must never widen into a whole-file reset");
  if (result.kind === "loaded") {
    assert.deepEqual(Object.keys(result.entries), ["good"]);
    assert.equal(result.droppedMalformed, 1);
  }
});

test("loadGateCacheText: an entry exactly at its expiresAt boundary is dropped as expired, not kept", () => {
  const stale = entry({ at: NOW - GATE_CACHE_TTL_MS, expiresAt: NOW });
  const raw = JSON.stringify({ version: GATE_CACHE_SCHEMA_VERSION, entries: { k: stale } });
  const result = loadGateCacheText(raw, NOW);
  assert.equal(result.kind, "loaded");
  if (result.kind === "loaded") {
    assert.deepEqual(result.entries, {});
    assert.equal(result.droppedExpired, 1);
    assert.equal(result.droppedMalformed, 0, "expiry and malformed shape are reported separately");
  }
});

// ---------------------------------------------------------------------------
// pruneGateCache
// ---------------------------------------------------------------------------

test("pruneGateCache: keeps only fresh, valid entries and reports both drop counts independently", () => {
  const raw = {
    fresh: entry(),
    stale: entry({ at: NOW - GATE_CACHE_TTL_MS - 1000, expiresAt: NOW - 1 }),
    malformed: { decision: "not-a-decision" },
    nullish: null,
  };
  const result = pruneGateCache(raw, NOW);
  assert.deepEqual(Object.keys(result.fresh), ["fresh"]);
  assert.equal(result.droppedExpired, 1);
  assert.equal(result.droppedMalformed, 2);
});

test("pruneGateCache on an empty object drops nothing", () => {
  const result = pruneGateCache({}, NOW);
  assert.deepEqual(result.fresh, {});
  assert.equal(result.droppedMalformed, 0);
  assert.equal(result.droppedExpired, 0);
});

// ---------------------------------------------------------------------------
// isValidGateCacheEntry
// ---------------------------------------------------------------------------

test("isValidGateCacheEntry: a well-shaped jev entry is valid", () => {
  assert.equal(isValidGateCacheEntry(entry()), true);
});

test("isValidGateCacheEntry: a well-shaped human-approval entry is valid", () => {
  assert.equal(isValidGateCacheEntry(humanApprovalEntry()), true);
});

test("isValidGateCacheEntry: 'deny' is never a valid v2 decision -- v2 never writes it", () => {
  assert.equal(isValidGateCacheEntry(entry({ decision: "deny" as unknown as "allow" })), false);
});

test("isValidGateCacheEntry: missing expiresAt is invalid", () => {
  const { expiresAt: _drop, ...rest } = entry();
  assert.equal(isValidGateCacheEntry(rest), false);
});

test("isValidGateCacheEntry: expiresAt not after at is invalid", () => {
  assert.equal(isValidGateCacheEntry(entry({ at: NOW, expiresAt: NOW })), false);
});

test("isValidGateCacheEntry: a human-approval entry must carry a non-null learnedAt", () => {
  assert.equal(isValidGateCacheEntry(humanApprovalEntry({ learnedAt: null })), false);
});

test("isValidGateCacheEntry: a policy-sourced entry must be 'ask' and non-learnable", () => {
  assert.equal(isValidGateCacheEntry(entry({ source: "policy", decision: "ask", learnable: false })), true);
  assert.equal(isValidGateCacheEntry(entry({ source: "policy", decision: "allow", learnable: false })), false);
  assert.equal(isValidGateCacheEntry(entry({ source: "policy", decision: "ask", learnable: true })), false);
});

test("isValidGateCacheEntry: null confidence is valid, never a fabricated number", () => {
  assert.equal(isValidGateCacheEntry(entry({ confidence: null })), true);
});

// ---------------------------------------------------------------------------
// putVerdict: a human approval outranks the model (ADR-9)
// ---------------------------------------------------------------------------

test("putVerdict: a fresh human-approval entry is never overwritten by a jev verdict", () => {
  const humanEntry = humanApprovalEntry();
  const entries = { k: humanEntry };
  const result = putVerdict(entries, "k", entry({ decision: "ask", source: "jev" }), NOW);
  assert.deepEqual(result.k, humanEntry);
});

test("putVerdict: an expired human-approval entry no longer blocks a fresh jev verdict", () => {
  const expiredHuman = humanApprovalEntry({ expiresAt: NOW - 1 });
  const entries = { k: expiredHuman };
  const freshJev = entry({ decision: "ask", source: "jev" });
  const result = putVerdict(entries, "k", freshJev, NOW);
  assert.deepEqual(result.k, freshJev);
});

test("putVerdict: an ordinary jev/policy entry is overwritten normally", () => {
  const entries = { k: entry({ decision: "allow", source: "jev" }) };
  const next = entry({ decision: "ask", source: "jev", reason: "updated" });
  const result = putVerdict(entries, "k", next, NOW);
  assert.deepEqual(result.k, next);
});

test("putVerdict: writing a brand-new key never touches unrelated entries", () => {
  const existing = entry();
  const entries = { existing };
  const result = putVerdict(entries, "new-key", entry({ shape: "new" }), NOW);
  assert.deepEqual(result.existing, existing);
  assert.ok(result["new-key"] !== undefined);
});

// ---------------------------------------------------------------------------
// serializeGateCacheFile round-trips through loadGateCacheText
// ---------------------------------------------------------------------------

test("serializeGateCacheFile round-trips through loadGateCacheText as the current version", () => {
  const entries = { k: entry() };
  const raw = serializeGateCacheFile(entries);
  const result = loadGateCacheText(raw, NOW);
  assert.equal(result.kind, "loaded");
  if (result.kind === "loaded") assert.deepEqual(result.entries, entries);
});

// ---------------------------------------------------------------------------
// Purity: no direct Date.now() inside this module (ADR-12) -- every wall
// clock read must be injected by the caller (the adapter), never read here.
// ---------------------------------------------------------------------------

test("gate_cache.ts contains no direct Date.now() call -- every clock read is injected", () => {
  const source = readFileSync(new URL("./gate_cache.ts", import.meta.url), "utf8");
  assert.equal(source.includes("Date.now()"), false);
});
