// JEVADV-112: the listing measurement's pure half.

import assert from "node:assert/strict";
import test from "node:test";

import { measureTranscript, summarizeTranscripts, summarizeWithholds } from "./skill_listing_measure.ts";

const listing = (content: string, isInitial = true): unknown => ({ type: "attachment", attachment: { type: "skill_listing", content, isInitial } });
const prompt = (text: string): unknown => ({ type: "user", message: { role: "user", content: text } });
const step = (id: string, sidechain = false): unknown => ({ type: "assistant", isSidechain: sidechain, message: { id } });

test("one initial listing is re-read by every main request after it, counted once per message id, not by subagents", () => {
  const measure = measureTranscript([prompt("hi"), listing("x".repeat(400)), step("m1"), step("m1"), step("m2"), step("s1", true), prompt("next"), step("m3")]);
  assert.equal(measure.prompts, 2);
  assert.equal(measure.requests, 3);
  assert.deepEqual(measure.listings, [{ chars: 400, isInitial: true, requestsCarrying: 3 }]);
});

test("a compaction ends what the listing before it carries", () => {
  const measure = measureTranscript([listing("abcd"), step("m1"), { type: "system", subtype: "compact_boundary" }, step("m2"), listing("ab", false), step("m3")]);
  assert.deepEqual(measure.listings.map((l) => l.requestsCarrying), [1, 1]);
  assert.equal(measure.compactions, 1);
});

test("the summary gives the listing rows per session and a median session's re-read tokens", () => {
  const a = measureTranscript([prompt("a"), listing("x".repeat(4000)), step("1"), step("2")]);
  const b = measureTranscript([prompt("b"), listing("x".repeat(4000)), step("1"), step("2"), step("3"), step("4")]);
  const summary = summarizeTranscripts([a, b, measureTranscript([prompt("c")])]);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.sessionsWithListing, 2);
  assert.deepEqual(summary.listingsPerSession, [1, 1]);
  assert.equal(summary.medianRequestsCarrying, 3);
  assert.equal(summary.medianSessionReReadTokens, 3000);
});

test("withholds join the main steps after them and the skills used after, by session", () => {
  const summary = summarizeWithholds(
    [
      { type: "listing", at: "2026-11-01T00:00:00.000Z", sessionId: "s1", decisionId: "d1", chars: 8000, withheld: "nothing-fits" },
      { type: "listing", at: "2026-11-01T00:00:00.000Z", sessionId: "s2", decisionId: "d2", chars: 8000, withheld: null },
      { type: "withheld-use", at: "2026-11-01T01:00:00.000Z", sessionId: "s1", skill: "orca-cli", reason: "nothing-fits" },
    ],
    [
      { agent: "main", sessionId: "s1", at: "2026-11-01T00:00:01.000Z" },
      { agent: "main", sessionId: "s1", at: "2026-11-01T00:00:02.000Z" },
      { agent: "subagent", sessionId: "s1", at: "2026-11-01T00:00:03.000Z" },
      { agent: "main", sessionId: "s2", at: "2026-11-01T00:00:01.000Z" },
    ],
  );
  assert.equal(summary.listingsAsked, 2);
  assert.deepEqual(summary.byReason, { "nothing-fits": { sessions: 1, tokensKeptOut: 4000, skillUsesAfter: 1 } });
});
