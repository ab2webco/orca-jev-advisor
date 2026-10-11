// ---------------------------------------------------------------------------
// What a request costs at list price.
//
// Most models have one rate card. Claude Haiku 5.5 is priced by prompt
// length: a request whose prompt is over 100,000 tokens pays a higher card
// for ALL of its tokens, cache hits included, and earlier requests keep the
// card they were billed at (platform.claude.com/docs/en/about-claude/pricing,
// "Long context pricing"). So the card is chosen per request, from that
// request's own prompt -- never from a total over many requests.
//
// Pure: no I/O.
// ---------------------------------------------------------------------------

import type { ModelPrices, RateCard } from "./model_catalog.ts";

/** The prompt length above which a model priced by prompt length charges its higher card. */
export const LONG_PROMPT_TOKENS = 100_000;

export interface PromptUsage {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

export interface RequestUsage extends PromptUsage {
  readonly output: number | null;
}

/** A request's prompt length: every input token it sent, fresh or cached. A field the log did not report adds nothing. */
export function promptTokens(usage: PromptUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** The rate card a request with a prompt of `prompt` tokens pays: the long-prompt card strictly above its threshold, else the base one. */
export function ratesForPrompt(prices: ModelPrices, prompt: number): RateCard {
  const long = prices.longPrompt;
  if (long !== undefined && prompt > long.overTokens) return { input: long.input, cacheWrite: long.cacheWrite, cacheRead: long.cacheRead, output: long.output };
  return { input: prices.input, cacheWrite: prices.cacheWrite, cacheRead: prices.cacheRead, output: prices.output };
}

/** One request's list-price cost in USD. A row that reported no token field has a prompt of zero and is priced on the base card. */
export function requestCostUsd(prices: ModelPrices, usage: RequestUsage): number {
  const rates = ratesForPrompt(prices, promptTokens(usage));
  return ((usage.input ?? 0) * rates.input + (usage.cacheWrite ?? 0) * rates.cacheWrite + (usage.cacheRead ?? 0) * rates.cacheRead + (usage.output ?? 0) * rates.output) / 1_000_000;
}
