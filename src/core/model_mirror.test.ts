import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODELS_MIRROR_FILE, parseModelsMirror } from "./model_mirror.ts";

const ENTRY = {
  id: "sonnet",
  provider: "anthropic",
  label: "Sonnet 5",
  rank: 1,
  agentModel: "sonnet",
  source: "https://example.test/doc",
  available: true,
};

test("the mirror file name is the worker's stable, documented filename", () => {
  assert.equal(MODELS_MIRROR_FILE, "models-catalog.json");
});

test("a well-formed mirror parses active/ready/models exactly", () => {
  const mirror = parseModelsMirror({ active: true, ready: true, models: [ENTRY] });
  assert.equal(mirror.active, true);
  assert.equal(mirror.ready, true);
  assert.equal(mirror.models.length, 1);
  assert.deepEqual(mirror.models[0], ENTRY);
});

test("a missing file (null) fails toward measurement: active and ready both read false", () => {
  const mirror = parseModelsMirror(null);
  assert.equal(mirror.active, false);
  assert.equal(mirror.ready, false);
  assert.deepEqual(mirror.models, []);
});

test("active/ready only read true for the literal boolean true -- a truthy string never counts", () => {
  const mirror = parseModelsMirror({ active: "true", ready: 1, models: [] });
  assert.equal(mirror.active, false);
  assert.equal(mirror.ready, false);
});

test("a malformed models array drops only the bad rows, same tolerant row parsing as parseModelCatalog", () => {
  const mirror = parseModelsMirror({ active: false, ready: false, models: [ENTRY, { not: "an entry" }] });
  assert.equal(mirror.models.length, 1);
});

test("a non-record value parses as the all-false, empty mirror", () => {
  const mirror = parseModelsMirror("not a record");
  assert.equal(mirror.active, false);
  assert.equal(mirror.ready, false);
  assert.deepEqual(mirror.models, []);
});
