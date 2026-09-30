// 0.6.13 T5 (JEVADV-68): the gate hook is one process per command. The
// budget timer callJev races the request against kept that process alive for
// the rest of the budget after the verdict was already written (measured: a
// median of 1.4 s between the verdict and the exit). The default sleep now
// clears its timer when its signal aborts, and callJev aborts the budget's
// sleep as soon as the race is settled. Real timers, no stand-ins: what is
// under test is exactly whether a timer is left behind.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { defaultSleep } from "./jev.ts";

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

test("the default sleep clears its timer when its signal aborts, so nothing keeps the process alive", async () => {
  const sleep = defaultSleep();
  assert.ok(sleep !== null);
  const before = activeTimers();
  const cut = new AbortController();
  const done = sleep(5_000, cut.signal);
  assert.equal(activeTimers(), before + 1, "the sleep holds one timer while it runs");
  cut.abort();
  let guard: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([done.then(() => "resolved"), new Promise<string>((resolve) => (guard = setTimeout(() => resolve("still waiting"), 200)))]);
  clearTimeout(guard);
  assert.equal(settled, "resolved", "an aborted sleep resolves at once");
  assert.equal(activeTimers(), before, "and leaves no timer behind");
});

test("the default sleep still waits its time when nothing aborts it", async () => {
  const sleep = defaultSleep();
  assert.ok(sleep !== null);
  const started = Date.now();
  await sleep(30);
  assert.ok(Date.now() - started >= 25);
});
