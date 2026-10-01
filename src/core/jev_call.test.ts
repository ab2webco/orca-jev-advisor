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
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ status: 503 }]).options)), { kind: "http5xx", status: 503 });
  assert.deepEqual(await failureOf(callJev("k", {}, {}, harness([{ throws: new Error("ECONNRESET") }]).options)), { kind: "network" });
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
