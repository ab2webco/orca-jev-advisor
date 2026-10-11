import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ENGINE_REQUIREMENTS,
  ENGINE_VERSION_FILE,
  engineFallbackFor,
  engineSupports,
  engineVersionRecord,
  parseEngineVersion,
  parseEngineVersionRecord,
} from "./engine_support.ts";

test("the table names Haiku 5.5's minimum engine and the model an older engine keeps", () => {
  assert.deepEqual(ENGINE_REQUIREMENTS["claude-haiku-5-5"], { minVersion: "2.1.293", fallback: "claude-haiku-4-5-20251001" });
  assert.equal(engineFallbackFor("claude-haiku-5-5"), "claude-haiku-4-5-20251001");
  assert.equal(engineFallbackFor("claude-sonnet-5-5"), null);
});

test("engineSupports: older is refused, equal and newer are accepted", () => {
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.292"), false);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.283"), false);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.293"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.296"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.2.0"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "3.0.0"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.0.999"), false);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.1000"), true, "compared as numbers, not text");
});

test("engineSupports: a development build is compared on its semantic core", () => {
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.292-dev.20260920.t101500.sha1a2b3c4"), false);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.293-dev.20260920.t101500.sha1a2b3c4"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.293-dev"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1.299-dev.20260920"), true);
});

test("engineSupports: a version that is unknown or cannot be read supports the model, so nobody is silently downgraded", () => {
  assert.equal(engineSupports("claude-haiku-5-5", null), true);
  assert.equal(engineSupports("claude-haiku-5-5", undefined), true);
  assert.equal(engineSupports("claude-haiku-5-5", ""), true);
  assert.equal(engineSupports("claude-haiku-5-5", "not-a-version"), true);
  assert.equal(engineSupports("claude-haiku-5-5", "2.1"), true);
});

test("engineSupports: a model with no entry runs on any engine; a context suffix names the same model", () => {
  assert.equal(engineSupports("claude-sonnet-5-5", "1.0.0"), true);
  assert.equal(engineSupports("some-gateway-model", "1.0.0"), true);
  assert.equal(engineSupports("claude-haiku-5-5[1m]", "2.1.292"), false);
});

test("parseEngineVersion: the semantic core of a release, a dev build or a v-prefixed string; null otherwise", () => {
  assert.deepEqual(parseEngineVersion("2.1.296"), [2, 1, 296]);
  assert.deepEqual(parseEngineVersion("2.1.280-dev.20260920.t101500.sha1a2b3c4"), [2, 1, 280]);
  assert.deepEqual(parseEngineVersion("v2.1.293"), [2, 1, 293]);
  assert.equal(parseEngineVersion("2.1"), null);
  assert.equal(parseEngineVersion("x2.1.3"), null);
  assert.equal(parseEngineVersion("2.1.3.4"), null, "a fourth component is not a Claude Code version");
});

test("the engine version record the mod writes and the hook reads: version, base, the time; anything malformed reads as unknown", () => {
  assert.equal(ENGINE_VERSION_FILE, "engine-version.json");
  const record = engineVersionRecord({ version: "2.1.296", base: "2.1.296" }, "2026-10-11T12:00:00.000Z");
  assert.deepEqual(record, { version: "2.1.296", base: "2.1.296", at: "2026-10-11T12:00:00.000Z" });
  assert.equal(parseEngineVersionRecord(JSON.parse(JSON.stringify(record))), "2.1.296");
  assert.equal(engineVersionRecord({ version: "2.1.296" }, "2026-10-11T12:00:00.000Z").base, undefined);
  assert.equal(parseEngineVersionRecord({ version: "2.1.280-dev.20260920.t101500.sha1a2b3c4", base: "2.1.280-dev" }), "2.1.280-dev.20260920.t101500.sha1a2b3c4");
  for (const bad of [null, undefined, "2.1.296", 5, {}, { version: 3 }, { version: "" }]) assert.equal(parseEngineVersionRecord(bad), null);
});
