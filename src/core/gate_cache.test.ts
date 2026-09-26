// Unit tests for pruneGateCache/isValidGateCacheEntry/isFreshGateCacheEntry
// -- pure input to pure output, no filesystem, no process. Run with:
//   node --test src/core/gate_cache.test.ts
//
// The defect this closes: adapters/claude/gate-bash.ts wrote `at: Date.now()`
// into every cache entry and nothing ever read it back, so a verdict cached
// months ago was reused forever regardless of whether the model, the repo's
// policy mirror, or the command's surrounding context had changed since.

import assert from "node:assert/strict";
import test from "node:test";

import { GATE_CACHE_TTL_MS, isFreshGateCacheEntry, isValidGateCacheEntry, pruneGateCache } from "./gate_cache.ts";

test("a well-shaped entry is valid", () => {
  assert.equal(isValidGateCacheEntry({ decision: "allow", reason: "reversible, local and cheap", at: Date.now() }), true);
  assert.equal(isValidGateCacheEntry({ decision: "deny", reason: "x", at: 0 }), true);
  assert.equal(isValidGateCacheEntry({ decision: "ask", reason: "x", at: 1 }), true);
  assert.equal(isValidGateCacheEntry({ decision: "advise", reason: "it can't be undone", at: 1 }), true, "advise is cacheable, never as a silent allow");
});

test("malformed entries are never valid -- a corrupt cache is just a smaller cache, never a crash", () => {
  assert.equal(isValidGateCacheEntry(null), false);
  assert.equal(isValidGateCacheEntry(undefined), false);
  assert.equal(isValidGateCacheEntry("allow"), false);
  assert.equal(isValidGateCacheEntry({ decision: "maybe", reason: "x", at: 1 }), false, "decision outside the closed set");
  assert.equal(isValidGateCacheEntry({ decision: "allow", reason: 5, at: 1 }), false, "reason must be a string");
  assert.equal(isValidGateCacheEntry({ decision: "allow", reason: "x", at: "yesterday" }), false, "at must be a number");
  assert.equal(isValidGateCacheEntry({ decision: "allow", reason: "x" }), false, "missing at");
  assert.equal(isValidGateCacheEntry({ decision: "allow", reason: "x", at: Number.NaN }), false, "at must be finite");
});

test("an entry younger than the TTL is fresh", () => {
  const now = 1_000_000_000_000;
  const entry = { decision: "allow" as const, reason: "x", at: now - 1 };
  assert.equal(isFreshGateCacheEntry(entry, now), true);
});

test("an entry older than the TTL is stale", () => {
  const now = 1_000_000_000_000;
  const entry = { decision: "allow" as const, reason: "x", at: now - GATE_CACHE_TTL_MS - 1 };
  assert.equal(isFreshGateCacheEntry(entry, now), false);
});

test("an entry exactly at the TTL boundary is stale, not fresh -- the window is strictly less-than", () => {
  const now = 1_000_000_000_000;
  const entry = { decision: "allow" as const, reason: "x", at: now - GATE_CACHE_TTL_MS };
  assert.equal(isFreshGateCacheEntry(entry, now), false);
});

test("pruneGateCache keeps only fresh, valid entries and reports whether anything was dropped", () => {
  const now = 1_000_000_000_000;
  const raw = {
    fresh: { decision: "allow", reason: "x", at: now - 1000 },
    stale: { decision: "deny", reason: "x", at: now - GATE_CACHE_TTL_MS - 1 },
    malformed: { decision: "not-a-decision", reason: "x", at: now },
    nullish: null,
  };
  const result = pruneGateCache(raw, now);
  assert.deepEqual(Object.keys(result.fresh), ["fresh"]);
  assert.equal(result.changed, true);
});

test("pruneGateCache reports no change when every entry is already fresh and valid", () => {
  const now = 1_000_000_000_000;
  const raw = { a: { decision: "allow", reason: "x", at: now - 1 } };
  const result = pruneGateCache(raw, now);
  assert.deepEqual(result.fresh, raw);
  assert.equal(result.changed, false);
});

test("pruneGateCache on an empty object returns an empty, unchanged cache", () => {
  const result = pruneGateCache({}, Date.now());
  assert.deepEqual(result.fresh, {});
  assert.equal(result.changed, false);
});
