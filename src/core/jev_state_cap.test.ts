// JEVADV-96 T5: a state too large for Jev is never sent.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildActionGateState } from "./decisions.ts";
import { fitJevState, jevStateExceedsCap, jevStateSize, MAX_JEV_STATE_CHARS } from "./jev_state_cap.ts";

test("the cap sits well above the largest real state measured (3,659 chars, p99 1,485) and well under Jev's own limit", () => {
  assert.ok(MAX_JEV_STATE_CHARS >= 10 * 1_485, "at least ten times the real p99");
  // Jev refuses at about 32k input tokens (HTTP 400 max_tokens_exceeded); dense text can cost a token per character.
  assert.ok(MAX_JEV_STATE_CHARS <= 20_000, "so even a state of one token per character stays below that limit");
});

test("the size is the serialized state, exactly what goes over the wire", () => {
  const state = buildActionGateState("ls -la", "");
  assert.equal(jevStateSize(state), JSON.stringify(state).length);
});

test("a state at the cap is sent; one character over it is not", () => {
  const fill = (n: number) => ({ proposed_command: "x".repeat(n) });
  const overhead = jevStateSize(fill(0));
  assert.equal(jevStateExceedsCap(fill(MAX_JEV_STATE_CHARS - overhead)), false);
  assert.equal(jevStateExceedsCap(fill(MAX_JEV_STATE_CHARS - overhead + 1)), true);
});

test("an ordinary command's state is far under the cap", () => {
  assert.equal(jevStateExceedsCap(buildActionGateState("git status", "no remote, unknown branch")), false);
});

const builder = (command: string) => (condensed: boolean) => buildActionGateState(command, "", undefined, undefined, undefined, { condense: condensed });

test("a state under the cap is sent as built, not condensed", () => {
  const fit = fitJevState(builder("git status"));
  assert.ok(fit !== null);
  assert.equal(fit.condensed, false);
});

test("a padded command is judged on its condensed state: the action stays, the padding goes", () => {
  const padding = "QUJD".repeat(6_000);
  const command = `printf ${padding} > f && git push origin main`;
  assert.equal(jevStateExceedsCap(builder(command)(false)), true, "the padding really does push it over the cap");
  const fit = fitJevState(builder(command));
  assert.ok(fit !== null);
  assert.equal(fit.condensed, true);
  const sent = JSON.stringify(fit.state);
  assert.match(sent, /git push origin main/);
  assert.match(sent, /‹24000 chars›/);
  assert.equal(sent.includes("QUJDQUJD"), false);
});

test("a command still over the cap after condensing is not sent at all", () => {
  const command = Array.from({ length: 4_000 }, (_, i) => `word${i}`).join(" ");
  assert.equal(fitJevState(builder(command)), null);
});
