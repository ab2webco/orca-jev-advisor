// Unit tests for claude_integration_rescan.ts -- pure input to pure output.
//   node --test --experimental-strip-types src/core/claude_integration_rescan.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { RESCAN_INTERVAL_MS, decideRescanInstall, isRescanDue } from "./claude_integration_rescan.ts";
import type { RescanStatus, RescanTarget } from "./claude_integration_rescan.ts";

function family(installed: boolean, pathMatches: boolean) {
  return { installed, pathMatches };
}

const OK = { hook: family(true, true), outcomeHook: family(true, true), agentModelHook: family(true, true) };
const NOT_INSTALLED = { hook: family(false, false), outcomeHook: family(false, false), agentModelHook: family(false, false) };

function status(targets: Record<string, Omit<RescanTarget, "id">>): RescanStatus {
  return { ok: true, targets: Object.entries(targets).map(([id, families]) => ({ id, ...families })) };
}

test("isRescanDue: the first look is due at once, later ones once the interval has passed", () => {
  assert.equal(RESCAN_INTERVAL_MS, 60_000);
  assert.equal(isRescanDue(1_000, null), true);
  assert.equal(isRescanDue(1_000 + RESCAN_INTERVAL_MS - 1, 1_000), false);
  assert.equal(isRescanDue(1_000 + RESCAN_INTERVAL_MS, 1_000), true);
});

test("everything installed and current: no install", () => {
  const decision = decideRescanInstall(status({ home: OK, "account:a": OK }), null);
  assert.deepEqual(decision, { install: false, signature: null });
});

test("an account added after Configure (nothing installed there, the rest installed): install", () => {
  const decision = decideRescanInstall(status({ home: OK, "account:a": OK, "account:new": NOT_INSTALLED }), null);
  assert.equal(decision.install, true);
  assert.equal(decision.signature, "account:new:missing");
});

test("nothing is installed anywhere (never configured, or reverted): never install on its own", () => {
  const decision = decideRescanInstall(status({ home: NOT_INSTALLED, "account:a": NOT_INSTALLED }), null);
  assert.deepEqual(decision, { install: false, signature: null });
});

test("a hook that points at a stale plugin root: install", () => {
  const stale = { ...OK, agentModelHook: family(true, false) };
  const decision = decideRescanInstall(status({ home: OK, "account:a": stale }), null);
  assert.equal(decision.install, true);
  assert.equal(decision.signature, "account:a:stale-path");
});

test("a family missing on an otherwise installed target counts as missing", () => {
  const partial = { ...OK, outcomeHook: family(false, false) };
  assert.equal(decideRescanInstall(status({ home: partial }), null).signature, "home:missing");
});

test("the same unresolved set is attempted once, then left alone until it changes", () => {
  const stuck = status({ home: OK, "account:new": NOT_INSTALLED });
  const first = decideRescanInstall(stuck, null);
  assert.equal(first.install, true);
  const second = decideRescanInstall(stuck, first.signature);
  assert.equal(second.install, false);
  assert.equal(second.signature, first.signature);
  const third = decideRescanInstall(status({ home: OK, "account:new": NOT_INSTALLED, "account:newer": NOT_INSTALLED }), second.signature);
  assert.equal(third.install, true);
});

test("once resolved, the memory is cleared so a later change installs again", () => {
  const resolved = decideRescanInstall(status({ home: OK, "account:new": OK }), "account:new:missing");
  assert.deepEqual(resolved, { install: false, signature: null });
});

test("a status that could not be read decides nothing and keeps what was remembered", () => {
  const decision = decideRescanInstall({ ok: false, targets: [] }, "account:new:missing");
  assert.deepEqual(decision, { install: false, signature: "account:new:missing" });
});
