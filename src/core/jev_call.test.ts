// JEVADV-96 T3/T4: why a Jev call failed, and the one retry a transient
// failure earns. Every wait and every clock reading is injected, so nothing
// here depends on real time.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { callJev, jevFailureOf, JevRequestError, JevTimeoutError, type CallJevOptions, type JevFetch, type JevFetchResponse, type JevFailure } from "./jev.ts";

const OK_BODY = JSON.stringify({ model: "jev-latest", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });

interface Step {
  readonly status?: number;
  readonly body?: string;
  readonly retryAfter?: string;
  readonly throws?: Error;
  readonly takesMs?: number;
}

interface Harness {
  readonly options: CallJevOptions;
  readonly fetchCalls: () => number;
  readonly waits: () => readonly number[];
}

/** A scripted transport: each fetch consumes one step and advances the fake clock by its `takesMs`. */
function harness(steps: readonly Step[], budgetMs = 4_000): Harness {
  let clock = 0;
  let index = 0;
  const waits: number[] = [];
  const fetchImpl: JevFetch = async () => {
    const step = steps[index++];
    if (step === undefined) throw new Error("script ran out");
    clock += step.takesMs ?? 100;
    if (step.throws !== undefined) throw step.throws;
    const status = step.status ?? 200;
    const response: JevFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => step.body ?? (status === 200 ? OK_BODY : ""),
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (step.retryAfter ?? null) : null) },
    };
    return response;
  };
  return {
    options: {
      budgetMs,
      fetchImpl,
      // Backoff waits (no signal) resolve at once and advance the clock; the budget wait (with a signal) never fires.
      sleepImpl: (ms, signal) => {
        if (signal === undefined) {
          waits.push(ms);
          clock += ms;
          return Promise.resolve();
        }
        return new Promise<void>(() => undefined);
      },
      nowImpl: () => clock,
    },
    fetchCalls: () => index,
    waits: () => waits,
  };
}

async function failureOf(run: Promise<unknown>): Promise<JevFailure> {
  try {
    await run;
  } catch (error) {
    const failure = jevFailureOf(error);
    assert.ok(failure !== null, "the error carries a class");
    return failure;
  }
  throw new Error("expected the call to fail");
}

test("a clean answer is returned untouched", async () => {
  const h = harness([{}]);
  const response = await callJev("k", {}, {}, h.options);
  assert.equal(response.usage.input_tokens, 1);
  assert.equal(h.fetchCalls(), 1);
});

test("each failure names its class", async () => {
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ status: 400 }]).options)), { kind: "http4xx", status: 400 });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ status: 401 }]).options)), { kind: "http4xx", status: 401 });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ status: 429 }, { status: 529 }]).options)), { kind: "overload", status: 529 });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ status: 502 }, { status: 503 }]).options)), { kind: "http5xx", status: 503 });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ throws: new Error("ECONNRESET") }, { throws: new Error("ECONNRESET") }]).options)), { kind: "network" });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ body: "<html>" }]).options)), { kind: "malformed" });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ body: JSON.stringify({ nope: true }) }]).options)), { kind: "malformed" });
});

test("a call that outlives its budget is a timeout and is never retried", async () => {
  const h = harness([{ throws: Object.assign(new Error("aborted"), { name: "AbortError" }) }]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "timeout" });
  assert.equal(h.fetchCalls(), 1);
});

test("the class survives the existing error types", () => {
  assert.deepEqual(jevFailureOf(new JevTimeoutError(4000)), { kind: "timeout" });
  assert.deepEqual(jevFailureOf(new JevRequestError("x", null)), { kind: "network" });
  assert.deepEqual(jevFailureOf(new JevRequestError("x", 403)), { kind: "http4xx", status: 403 });
  assert.equal(jevFailureOf(new Error("other")), null);
});

test("a 5xx is retried once and the retry's answer is used", async () => {
  const h = harness([{ status: 503 }, {}]);
  const response = await callJev("k", {}, {}, h.options);
  assert.equal(response.usage.output_tokens, 1);
  assert.equal(h.fetchCalls(), 2);
  assert.equal(h.waits().length, 1);
});

test("a network failure is retried once", async () => {
  const h = harness([{ throws: new Error("ECONNRESET") }, {}]);
  await callJev("k", {}, {}, h.options);
  assert.equal(h.fetchCalls(), 2);
});

test("a second transient failure is not retried again", async () => {
  const h = harness([{ status: 500 }, { status: 500 }, {}]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "http5xx", status: 500 });
  assert.equal(h.fetchCalls(), 2);
});

test("a 4xx, a timeout and a malformed answer are not transient", async () => {
  for (const step of [{ status: 404 }, { body: "nope" }] satisfies Step[]) {
    const h = harness([step, {}]);
    await failureOf(callJev("k", {}, {}, h.options));
    assert.equal(h.fetchCalls(), 1);
  }
});

test("one retry in total: a 429 retry uses it up", async () => {
  const h = harness([{ status: 429 }, { status: 500 }, {}]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "http5xx", status: 500 });
  assert.equal(h.fetchCalls(), 2);
});

test("one retry in total: a transient retry uses it up", async () => {
  const h = harness([{ status: 500 }, { status: 429 }, {}]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "overload", status: 429 });
  assert.equal(h.fetchCalls(), 2);
});

test("Retry-After is honoured when the retry still fits", async () => {
  const h = harness([{ status: 503, retryAfter: "1" }, {}]);
  await callJev("k", {}, {}, h.options);
  assert.deepEqual(h.waits(), [1_000]);
});

test("a Retry-After that leaves no room for the retry skips it", async () => {
  const h = harness([{ status: 503, retryAfter: "3" }, {}]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "http5xx", status: 503 });
  assert.equal(h.fetchCalls(), 1);
});

test("a retry that cannot finish in what is left of the budget is not started", async () => {
  // The first attempt used 2.6 s of 4 s; after the default wait 1.15 s remain, under the 1.5 s a call needs.
  const h = harness([{ status: 500, takesMs: 2_600 }, {}]);
  assert.deepEqual(await failureOf(callJev("k", {}, {}, h.options)), { kind: "http5xx", status: 500 });
  assert.equal(h.fetchCalls(), 1);
});

test("a retry that fits is given only what is left of the budget", async () => {
  const budgets: number[] = [];
  const h = harness([{ status: 500, takesMs: 1_000 }, {}]);
  const sleepImpl = h.options.sleepImpl;
  assert.ok(sleepImpl !== undefined);
  await callJev("k", {}, {}, {
    ...h.options,
    sleepImpl: (ms, signal) => {
      if (signal !== undefined) budgets.push(ms);
      return sleepImpl(ms, signal);
    },
  });
  assert.equal(budgets[0], 4_000);
  assert.equal(budgets[1], 4_000 - 1_000 - 250);
});
