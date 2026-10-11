import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isModelPrices } from "./model_catalog.ts";
import type { ModelPrices } from "./model_catalog.ts";
import { LONG_PROMPT_TOKENS, promptTokens, ratesForPrompt, requestCostUsd } from "./model_cost.ts";
import { ANTHROPIC_PRICES } from "./model_router_accounts.ts";

const FLAT: ModelPrices = { input: 2, cacheWrite: 4, cacheRead: 0.1, output: 10 };
const TWO_CARDS: ModelPrices = {
  input: 0.1,
  cacheWrite: 0.2,
  cacheRead: 0.01,
  output: 0.5,
  longPrompt: { overTokens: LONG_PROMPT_TOKENS, input: 0.5, cacheWrite: 1, cacheRead: 0.05, output: 2.5 },
};

test("a prompt is every input token of the request: fresh input, cache reads and cache writes", () => {
  assert.equal(promptTokens({ input: 10, cacheRead: 200, cacheWrite: 30 }), 240);
  assert.equal(promptTokens({ input: null, cacheRead: null, cacheWrite: 5 }), 5, "an unreported field adds nothing");
});

test("a model with one card is priced the same at any prompt length", () => {
  assert.deepEqual(ratesForPrompt(FLAT, 5_000), FLAT);
  assert.deepEqual(ratesForPrompt(FLAT, 900_000), FLAT);
});

test("the over-100K card applies strictly above the threshold, never at it", () => {
  assert.equal(LONG_PROMPT_TOKENS, 100_000);
  assert.equal(ratesForPrompt(TWO_CARDS, 100_000).input, 0.1);
  assert.equal(ratesForPrompt(TWO_CARDS, 100_001).input, 0.5);
  assert.deepEqual(ratesForPrompt(TWO_CARDS, 150_000), { input: 0.5, cacheWrite: 1, cacheRead: 0.05, output: 2.5 });
});

test("a request is priced by its own prompt: cache reads count toward the threshold", () => {
  // 50K fresh + 40K cache read = 90K prompt: base card.
  const short = requestCostUsd(TWO_CARDS, { input: 50_000, cacheRead: 40_000, cacheWrite: 0, output: 1_000 });
  assert.ok(Math.abs(short - (50_000 * 0.1 + 40_000 * 0.01 + 1_000 * 0.5) / 1_000_000) < 1e-12);
  // 2K fresh + 148K cache read = 150K prompt: the whole request pays the long card, cache hit included.
  const long = requestCostUsd(TWO_CARDS, { input: 2_000, cacheRead: 148_000, cacheWrite: 0, output: 1_000 });
  assert.ok(Math.abs(long - (2_000 * 0.5 + 148_000 * 0.05 + 1_000 * 2.5) / 1_000_000) < 1e-12);
});

test("an unreported field costs nothing and a row with none is priced on the base card", () => {
  assert.equal(requestCostUsd(TWO_CARDS, { input: null, cacheRead: null, cacheWrite: null, output: null }), 0);
  assert.ok(Math.abs(requestCostUsd(FLAT, { input: 1_000_000, cacheRead: null, cacheWrite: null, output: null }) - 2) < 1e-12);
});

test("isModelPrices accepts the optional long-prompt card and rejects a malformed one", () => {
  assert.equal(isModelPrices(FLAT), true);
  assert.equal(isModelPrices(TWO_CARDS), true);
  assert.equal(isModelPrices({ ...FLAT, longPrompt: { overTokens: 100_000, input: 1 } }), false, "a card missing a price");
  assert.equal(isModelPrices({ ...FLAT, longPrompt: { overTokens: 0, input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } }), false, "a threshold of zero");
  assert.equal(isModelPrices({ ...FLAT, longPrompt: "expensive" }), false);
});

test("built-in table: Haiku 5.5 carries both published cards, and Haiku 4.5 keeps its own for past usage", () => {
  assert.deepEqual(ANTHROPIC_PRICES["claude-haiku-5-5"], TWO_CARDS);
  assert.deepEqual(ANTHROPIC_PRICES["claude-haiku-4-5-20251001"], { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 });
});

test("built-in table: the other models seen in real usage are priced at the 1-hour cache-write column", () => {
  assert.deepEqual(ANTHROPIC_PRICES["claude-opus-5"], { input: 5, cacheWrite: 10, cacheRead: 0.5, output: 25 });
  assert.deepEqual(ANTHROPIC_PRICES["claude-opus-4-8"], { input: 5, cacheWrite: 10, cacheRead: 0.5, output: 25 });
  assert.deepEqual(ANTHROPIC_PRICES["claude-fable-5"], { input: 10, cacheWrite: 20, cacheRead: 1, output: 50 });
  assert.deepEqual(ANTHROPIC_PRICES["claude-sonnet-4-6"], { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 });
});

test("built-in table: Sonnet 5.5 cache hits are 0.05x its input price, as the pricing page states", () => {
  assert.deepEqual(ANTHROPIC_PRICES["claude-sonnet-5-5"], { input: 2, cacheWrite: 4, cacheRead: 0.1, output: 10 });
});
