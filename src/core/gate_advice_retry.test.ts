// Unit tests for the advice retry-pass state -- pure input to pure output,
// no filesystem, no clock. Run with:
//   node --test --experimental-strip-types src/core/gate_advice_retry.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVICE_RETRY_WINDOW_MS,
  adviceRetryKey,
  isAdviceRetryFresh,
  pruneAdviceRetryState,
} from "./gate_advice_retry.ts";

test("adviceRetryKey is a stable sha256 hex digest, and differs when session or command differ", () => {
  const a = adviceRetryKey("session-1", "rm -rf dist");
  const b = adviceRetryKey("session-1", "rm -rf dist");
  const differentSession = adviceRetryKey("session-2", "rm -rf dist");
  const differentCommand = adviceRetryKey("session-1", "rm -rf other");
  assert.equal(a, b, "same inputs must hash identically");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, differentSession);
  assert.notEqual(a, differentCommand);
});

test("adviceRetryKey never collides session/command across the separator -- 's1'+'2x' must differ from 's12'+'x'", () => {
  const a = adviceRetryKey("s1", "2x");
  const b = adviceRetryKey("s12", "x");
  assert.notEqual(a, b, "the NUL separator must stop a session/command boundary from being ambiguous");
});

test("isAdviceRetryFresh: an entry stamped just now is fresh", () => {
  const now = 1_000_000_000_000;
  assert.equal(isAdviceRetryFresh(now - 1, now), true);
});

test("isAdviceRetryFresh: exactly at the window boundary is stale, not fresh -- strictly less-than, same discipline as the verdict cache", () => {
  const now = 1_000_000_000_000;
  assert.equal(isAdviceRetryFresh(now - ADVICE_RETRY_WINDOW_MS, now), false);
});

test("isAdviceRetryFresh: one millisecond past the window is stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isAdviceRetryFresh(now - ADVICE_RETRY_WINDOW_MS - 1, now), false);
});

test("ADVICE_RETRY_WINDOW_MS is exactly 10 minutes", () => {
  assert.equal(ADVICE_RETRY_WINDOW_MS, 10 * 60 * 1000);
});

test("pruneAdviceRetryState keeps only fresh, well-shaped (string -> finite number) entries", () => {
  const now = 1_000_000_000_000;
  const raw = {
    fresh: now - 1000,
    stale: now - ADVICE_RETRY_WINDOW_MS - 1,
    malformed: "not-a-number",
    alsoMalformed: Number.NaN,
    nullish: null,
  };
  const result = pruneAdviceRetryState(raw, now);
  assert.deepEqual(Object.keys(result.fresh), ["fresh"]);
  assert.equal(result.changed, true);
});

test("pruneAdviceRetryState reports no change when every entry is already fresh and valid", () => {
  const now = 1_000_000_000_000;
  const raw = { a: now - 1 };
  const result = pruneAdviceRetryState(raw, now);
  assert.deepEqual(result.fresh, raw);
  assert.equal(result.changed, false);
});

test("pruneAdviceRetryState on an empty object returns an empty, unchanged state", () => {
  const result = pruneAdviceRetryState({}, Date.now());
  assert.deepEqual(result.fresh, {});
  assert.equal(result.changed, false);
});

test("pruneAdviceRetryState never throws on a non-object payload -- returns empty, changed", () => {
  // @ts-expect-error -- exercising the fail-open guard against malformed input
  const result = pruneAdviceRetryState(null, Date.now());
  assert.deepEqual(result.fresh, {});
});
