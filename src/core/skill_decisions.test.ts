// JEVADV-112: nothingFitsWellBelow, the rule that lets active mode leave the
// engine's skill listing out when no installed skill comes close.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FITS_THRESHOLD, DEFAULT_WITHHOLD_BELOW, decideSkill, nothingFitsWellBelow } from "./skill_decisions.ts";
import type { FitResult, WideResult } from "./skill_decisions.ts";

const WIDE: WideResult = { ranked: [{ name: "a", probability: 0.6 }, { name: "b", probability: 0.3 }], gate: 0.8, needsSkill: true };

function fit(fits: Record<string, number>): FitResult {
  return { winner: "a", fits };
}

test("the default bar is well below the fits threshold", () => {
  assert.equal(DEFAULT_WITHHOLD_BELOW, 0.15);
  assert.ok(DEFAULT_WITHHOLD_BELOW < DEFAULT_FITS_THRESHOLD);
});

test("every fit well below the bar withholds", () => {
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.08, b: 0.02 })), true);
  assert.match(decideSkill(WIDE, fit({ a: 0.08, b: 0.02 }), true).reason, /^nothing fits/);
});

test("a best fit near the threshold keeps the listing, though nothing is suggested", () => {
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.2, b: 0.02 })), false);
  assert.equal(decideSkill(WIDE, fit({ a: 0.2, b: 0.02 }), true).name, null);
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.15 })), false, "the bar itself keeps the listing");
});

test("a fit that clears the threshold never withholds through this rule", () => {
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.9 })), false);
});

test("a missing answer keeps the listing: no stage 1, no stage 2, an empty fits, or the gate said no skill", () => {
  assert.equal(nothingFitsWellBelow(null, fit({ a: 0.01 })), false);
  assert.equal(nothingFitsWellBelow(WIDE, null), false);
  assert.equal(nothingFitsWellBelow(WIDE, fit({})), false);
  assert.equal(nothingFitsWellBelow({ ...WIDE, gate: 0.05, needsSkill: false }, fit({ a: 0.01 })), false);
});

test("a bar of 0 turns the rule off, and the bar never rises above the fits threshold", () => {
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.0001 }), DEFAULT_FITS_THRESHOLD, 0), false);
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.25 }), 0.2, 0.5), false);
  assert.equal(nothingFitsWellBelow(WIDE, fit({ a: 0.1 }), 0.2, 0.5), true);
});
