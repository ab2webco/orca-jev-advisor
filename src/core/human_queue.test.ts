import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  HUMAN_QUEUE_FILE,
  QUEUED_COMMAND_MAX_CHARS,
  WAITING_MAX_AGE_MS,
  buildAskedEntry,
  buildQueuedItem,
  humanQueueKey,
  isQueuedInSession,
  parseHumanQueue,
  serializeHumanQueueEntry,
  waitingItems,
} from "./human_queue.ts";

const AT = "2026-09-28T20:00:00.000Z";
const NOW = Date.parse(AT);

function queued(overrides: Partial<Parameters<typeof buildQueuedItem>[0]> = {}) {
  return buildQueuedItem({
    id: "q1",
    at: AT,
    sessionId: "s1",
    command: "gh pr merge 12 --squash",
    project: "acme-app",
    policyId: "client_always_asks",
    ...overrides,
  });
}

test("the queue file name is one constant for the writer and the reader", () => {
  assert.equal(HUMAN_QUEUE_FILE, "human-queue.jsonl");
});

test("humanQueueKey: same session and command give the same key, anything else a different one", () => {
  assert.equal(humanQueueKey("s1", "gh pr merge 12"), humanQueueKey("s1", "gh pr merge 12"));
  assert.notEqual(humanQueueKey("s1", "gh pr merge 12"), humanQueueKey("s2", "gh pr merge 12"));
  assert.notEqual(humanQueueKey("s1", "gh pr merge 12"), humanQueueKey("s1", "gh pr merge 13"));
  assert.notEqual(humanQueueKey("s1", "2x"), humanQueueKey("s12", "x"), "the separator keeps the two fields apart");
});

test("buildQueuedItem: carries what the board shows, keyed by session and command", () => {
  const item = queued();
  assert.equal(item.type, "queued");
  assert.equal(item.id, "q1");
  assert.equal(item.at, AT);
  assert.equal(item.project, "acme-app");
  assert.equal(item.policyId, "client_always_asks");
  assert.equal(item.command, "gh pr merge 12 --squash");
  assert.equal(item.key, humanQueueKey("s1", "gh pr merge 12 --squash"));
});

test("buildQueuedItem: a credential in the command never reaches the file", () => {
  const item = queued({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://api.example.com/deploy" });
  assert.doesNotMatch(item.command, /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(item.command, /\[REDACTED\]/);
  assert.equal(item.key, humanQueueKey("s1", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://api.example.com/deploy"), "the key still identifies the real command, hashed");
});

test("buildQueuedItem: a long command is cut to a readable length, with a marker", () => {
  const item = queued({ command: `echo ${"x".repeat(500)}` });
  assert.ok(item.command.length <= QUEUED_COMMAND_MAX_CHARS, `got ${item.command.length}`);
  assert.ok(item.command.endsWith("…"));
});

test("serialize + parse round-trip both entry types, one per line", () => {
  const raw = serializeHumanQueueEntry(queued()) + serializeHumanQueueEntry(buildAskedEntry({ key: queued().key, at: AT }));
  assert.equal(raw.split("\n").filter((line) => line.length > 0).length, 2);
  const entries = parseHumanQueue(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.type, "queued");
  assert.equal(entries[1]?.type, "asked");
});

test("parseHumanQueue: malformed, partial and foreign lines are skipped, never thrown on", () => {
  const raw = [
    "{not json",
    JSON.stringify({ type: "queued", id: "x" }),
    JSON.stringify({ type: "other" }),
    "",
    serializeHumanQueueEntry(queued()).trim(),
  ].join("\n");
  const entries = parseHumanQueue(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "queued");
});

test("isQueuedInSession: true once queued, false again once the retry was put to the person", () => {
  const item = queued();
  assert.equal(isQueuedInSession([], item.key), false);
  assert.equal(isQueuedInSession([item], item.key), true);
  assert.equal(isQueuedInSession([item, buildAskedEntry({ key: item.key, at: AT })], item.key), false);
  assert.equal(isQueuedInSession([item], humanQueueKey("s2", item.command)), false, "another session is its own queue");
});

test("waitingItems: newest first, without the ones already put to a person", () => {
  const first = queued({ id: "a", at: "2026-09-28T18:00:00.000Z", command: "gh pr merge 1" });
  const second = queued({ id: "b", at: "2026-09-28T19:00:00.000Z", command: "gh pr merge 2" });
  const released = queued({ id: "c", at: "2026-09-28T19:30:00.000Z", command: "gh pr merge 3" });
  const entries = [first, second, released, buildAskedEntry({ key: released.key, at: AT })];
  assert.deepEqual(waitingItems(entries, NOW).map((item) => item.id), ["b", "a"]);
});

test("waitingItems: an item queued again after it was asked is waiting again", () => {
  const item = queued({ id: "a", at: "2026-09-28T18:00:00.000Z" });
  const again = queued({ id: "b", at: "2026-09-28T19:00:00.000Z" });
  const entries = [item, buildAskedEntry({ key: item.key, at: "2026-09-28T18:30:00.000Z" }), again];
  assert.deepEqual(waitingItems(entries, NOW).map((entry) => entry.id), ["b"]);
});

test("waitingItems: an item older than the age limit is no longer waiting", () => {
  const old = queued({ id: "old", at: new Date(NOW - WAITING_MAX_AGE_MS - 1000).toISOString() });
  assert.deepEqual(waitingItems([old], NOW), []);
});
