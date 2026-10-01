// Unit tests for recordDecision's trimming. 0.6.19 M13 (JEVADV-72): an empty
// or zero cap saved from the config panel used to trim the whole history,
// the new entry included, on the next record.
//
// Run with:
//   node --test src/core/log.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { recordDecision } from "./log.ts";
import { getLog, type StorageHost } from "./store.ts";

function fakeHost(initial: Record<string, unknown> = {}): StorageHost {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key: string): Promise<unknown> {
      return data.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...data.keys()];
    },
  };
}

async function recordThree(host: StorageHost): Promise<void> {
  for (const judged of ["a", "b", "c"]) await recordDecision(host, { kind: "action", judged, rawAnswers: {}, verdict: "allow" });
}

test("recordDecision: a stored cap of 0 never wipes the history", async () => {
  const host = fakeHost({ config: { logMaxEntries: 0, jevBudgetMs: 4000 } });
  await recordThree(host);
  assert.deepEqual((await getLog(host)).map((entry) => entry.judged), ["a", "b", "c"]);
});

test("recordDecision: a valid cap still trims the oldest entries", async () => {
  const host = fakeHost({ config: { logMaxEntries: 2, jevBudgetMs: 4000 } });
  await recordThree(host);
  assert.deepEqual((await getLog(host)).map((entry) => entry.judged), ["b", "c"]);
});
