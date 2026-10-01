import assert from "node:assert/strict";
import test from "node:test";

import { isTeammateCall, matchTeammateTask, rememberTeammateTask, TEAMMATE_TASKS_MAX } from "./teammate_route.ts";
import type { TeammateTask } from "./teammate_route.ts";

function task(name: string, overrides: Partial<TeammateTask> = {}): TeammateTask {
  return { name, subagentType: null, description: `task ${name}`, prompt: `do ${name}`, model: null, ...overrides };
}

test("0.6.20 T3 isTeammateCall: a named Agent call, not a fork, with no isolation, makes a teammate", () => {
  assert.equal(isTeammateCall({ name: "researcher" }), true);
  assert.equal(isTeammateCall({ name: "researcher", subagent_type: "general-purpose" }), true);
  assert.equal(isTeammateCall({}), false, "no name: an ordinary subagent");
  assert.equal(isTeammateCall({ name: "" }), false);
  assert.equal(isTeammateCall({ name: "researcher", isolation: "worktree" }), false);
  assert.equal(isTeammateCall({ name: "researcher", subagent_type: "fork" }), false);
});

test("0.6.20 T3 rememberTeammateTask: the latest call for a name wins, and the stash stays bounded", () => {
  let stash: readonly TeammateTask[] = [];
  stash = rememberTeammateTask(stash, task("a"));
  stash = rememberTeammateTask(stash, task("a", { prompt: "again" }));
  assert.deepEqual(stash.map((t) => t.prompt), ["again"]);
  for (let i = 0; i < TEAMMATE_TASKS_MAX + 5; i += 1) stash = rememberTeammateTask(stash, task(`t${i}`));
  assert.equal(stash.length, TEAMMATE_TASKS_MAX);
  assert.equal(stash.at(-1)?.name, `t${TEAMMATE_TASKS_MAX + 4}`, "the oldest go first");
});

test("0.6.20 T3 matchTeammateTask: by the name the host lists, else by the id the engine builds from it", () => {
  const stash = [task("lister"), task("reviewer")];
  assert.equal(matchTeammateTask(stash, { id: "x-1", name: "reviewer" })?.name, "reviewer");
  assert.equal(matchTeammateTask(stash, { id: "alister-9f3c" })?.name, "lister", "the probe's id: 'a' + name + '-' + hex");
  assert.equal(matchTeammateTask(stash, { id: "alister-9f3c-extra" })?.name, undefined, "only a hex tail counts");
  assert.equal(matchTeammateTask(stash, { id: "aother-9f3c" }), null);
  assert.equal(matchTeammateTask(stash, { id: "x-1", name: "unknown" }), null, "a listed name that matches nothing is not guessed from the id");
});
