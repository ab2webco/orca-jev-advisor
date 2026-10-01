// The largest state the gate puts to Jev (JEVADV-96 T5).
//
// Jev refuses a request over about 32k input tokens with HTTP 400
// `max_tokens_exceeded` (measured live: 31,686 tokens answered, 35,000 did
// not). That limit is not documented; it was found by sending growing states.
// Measured over 10,715 real Bash commands from the last seven days, the state
// the gate builds (buildActionGateState) had a median of 320 characters, a p99
// of 1,485 and a maximum of 3,659 (about 915 tokens at chars/4).
//
// The cap is 16,000 characters: more than four times the largest real state,
// ten times its p99, and low enough that even text costing a token per
// character (base64, hex, minified code) stays at about half of Jev's limit.
// Above it the gate first condenses the state (blob words replaced by a marker
// with their length, so padding cannot hide an action or push it out of
// Jev's sight) and judges that. Only a state still over the cap is not sent:
// a call certain to fail would only spend the time budget before failing open.

import type { JsonValue } from "./jev.ts";

export const MAX_JEV_STATE_CHARS = 16_000;

/** The size of `state` as it goes over the wire, in characters. */
export function jevStateSize(state: JsonValue): number {
  return JSON.stringify(state).length;
}

export function jevStateExceedsCap(state: JsonValue): boolean {
  return jevStateSize(state) > MAX_JEV_STATE_CHARS;
}

/**
 * The state to send: as built, else condensed, else null when even that is
 * over the cap. `condensed` tells the measurement row which one was judged.
 */
export function fitJevState<State extends JsonValue>(build: (condensed: boolean) => State): { readonly state: State; readonly condensed: boolean } | null {
  const full = build(false);
  if (!jevStateExceedsCap(full)) return { state: full, condensed: false };
  const condensed = build(true);
  return jevStateExceedsCap(condensed) ? null : { state: condensed, condensed: true };
}
