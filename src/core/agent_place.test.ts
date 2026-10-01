import assert from "node:assert/strict";
import test from "node:test";

import { PENDING_ISOLATION_PLACE, PLACE_CACHE_MAX, agentPlace, cachedGitPlace, callDirectory, newPlaceCache, resolveGitPlace, samePlace } from "./agent_place.ts";
import type { ProcessRun, RunResult } from "./orca_context.ts";

const BASE = "/repo/app";
const HOME = "/home/dev";

test("0.6.23 T1 callDirectory: a file tool works in its file's directory", () => {
  assert.equal(callDirectory("Edit", { file_path: "/repo/app-feature/src/login.ts", old_string: "a", new_string: "b" }, BASE, HOME), "/repo/app-feature/src");
  assert.equal(callDirectory("Write", { file_path: "/repo/app-feature/README.md", content: "x" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("NotebookEdit", { notebook_path: "/repo/app-feature/notes/a.ipynb", new_source: "x" }, BASE, HOME), "/repo/app-feature/notes");
  assert.equal(callDirectory("Write", { file_path: "src/new.ts", content: "x" }, BASE, HOME), "/repo/app/src", "a relative path, against the base");
  assert.equal(callDirectory("Edit", { file_path: "~/notes/todo.md" }, BASE, HOME), "/home/dev/notes");
  assert.equal(callDirectory("Edit", { file_path: "/repo/app-feature/../app/src/x.ts" }, BASE, HOME), "/repo/app/src", "normalised");
});

test("0.6.23 T1 callDirectory: reading never moves an agent", () => {
  assert.equal(callDirectory("Read", { file_path: "/repo/app-feature/odd/plan.md" }, BASE, HOME), null);
  assert.equal(callDirectory("Grep", { pattern: "x", path: "/repo/app-feature" }, BASE, HOME), null);
  assert.equal(callDirectory("Glob", { pattern: "**/*.ts", path: "/repo/app-feature" }, BASE, HOME), null);
  assert.equal(callDirectory("WebFetch", { url: "https://example.com" }, BASE, HOME), null);
  assert.equal(callDirectory("Edit", {}, BASE, HOME), null, "no file_path");
  assert.equal(callDirectory("Edit", { file_path: 3 }, BASE, HOME), null);
});

test("0.6.23 T1 callDirectory: Bash `cd`, alone or leading, and the last one wins", () => {
  assert.equal(callDirectory("Bash", { command: "cd /repo/app-feature" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "cd /repo/app-feature && npm test" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "cd /repo/app-feature; git status" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "cd /repo && cd app-feature" }, BASE, HOME), "/repo/app-feature", "`cd a && cd b` gives b, b seen from a");
  assert.equal(callDirectory("Bash", { command: "cd ../app-feature && ls" }, BASE, HOME), "/repo/app-feature", "relative, against the base");
  assert.equal(callDirectory("Bash", { command: "cd ~/x && ls" }, BASE, HOME), "/home/dev/x");
  assert.equal(callDirectory("Bash", { command: "cd $HOME/x" }, BASE, HOME), "/home/dev/x");
  assert.equal(callDirectory("Bash", { command: "cd ${HOME}/x" }, BASE, HOME), "/home/dev/x");
  assert.equal(callDirectory("Bash", { command: 'cd "/repo/app feature" && ls' }, BASE, HOME), "/repo/app feature", "quoted");
});

test("0.6.23 T1 callDirectory: Bash `git -C`, seen from the directory before it", () => {
  assert.equal(callDirectory("Bash", { command: "git -C /repo/app-feature status" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "git -C ../app-feature log --oneline" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "cd /repo && git -C app-feature diff" }, BASE, HOME), "/repo/app-feature");
  assert.equal(callDirectory("Bash", { command: "git -C /repo/app-feature status && cd /repo/app" }, BASE, HOME), "/repo/app", "the last one");
  assert.equal(callDirectory("Bash", { command: "GIT_PAGER=cat git -c core.pager=cat -C /repo/app-feature log" }, BASE, HOME), "/repo/app-feature");
});

test("0.6.23 T1 callDirectory: a Bash call that names no directory, or one only running it would tell, is not counted", () => {
  assert.equal(callDirectory("Bash", { command: "npm test" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "git status" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cat /repo/app-feature/odd/plan.md" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd $(git rev-parse --show-toplevel)" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd `pwd`/x" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd $WORKTREE && ls" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "git -C $DIR status" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd $(mktemp -d) && cd sub" }, BASE, HOME), null, "seen from an unknown directory");
  assert.equal(callDirectory("Bash", { command: "cd -" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd" }, BASE, HOME), null);
  assert.equal(callDirectory("Bash", { command: "cd ~/x" }, BASE, null), null, "no home known");
  assert.equal(callDirectory("Bash", { command: "cd sub" }, null, HOME), null, "a relative path with no base");
  assert.equal(callDirectory("Bash", {}, BASE, HOME), null);
});

/** A fake runner: answers by the argv joined with spaces; anything else exits 128. Records every call. */
function fakeRun(answers: Record<string, RunResult | Error>): { run: ProcessRun; calls: string[] } {
  const calls: string[] = [];
  const run: ProcessRun = async (argv) => {
    const key = argv.join(" ");
    calls.push(key);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return answer ?? { exitCode: 128, stdout: "" };
  };
  return { run, calls };
}

test("0.6.23 T1 resolveGitPlace: the worktree's top level and its branch", async () => {
  const { run } = fakeRun({
    "git -C /repo/app-feature/src rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo/app-feature\n" },
    "git -C /repo/app-feature/src branch --show-current": { exitCode: 0, stdout: "feature/login\n" },
  });
  assert.deepEqual(await resolveGitPlace(run, "/repo/app-feature/src"), { toplevel: "/repo/app-feature", branch: "feature/login" });
});

test("0.6.23 T1 resolveGitPlace: a detached HEAD, or a branch git cannot tell, is a null branch", async () => {
  const detached = fakeRun({
    "git -C /repo/app rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo/app\n" },
    "git -C /repo/app branch --show-current": { exitCode: 0, stdout: "\n" },
  });
  assert.deepEqual(await resolveGitPlace(detached.run, "/repo/app"), { toplevel: "/repo/app", branch: null });
  const failing = fakeRun({
    "git -C /repo/app rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo/app\n" },
    "git -C /repo/app branch --show-current": new Error("git didn't respond"),
  });
  assert.deepEqual(await resolveGitPlace(failing.run, "/repo/app"), { toplevel: "/repo/app", branch: null });
});

test("0.6.23 T1 resolveGitPlace: no repository, or a failing git, is null and never throws", async () => {
  assert.equal(await resolveGitPlace(fakeRun({}).run, "/repo/none"), null);
  const throwing = fakeRun({ "git -C /repo/app rev-parse --show-toplevel": new Error("no git") });
  assert.equal(await resolveGitPlace(throwing.run, "/repo/app"), null);
  const empty = fakeRun({ "git -C /repo/app rev-parse --show-toplevel": { exitCode: 0, stdout: "  \n" } });
  assert.equal(await resolveGitPlace(empty.run, "/repo/app"), null);
});

test("0.6.23 T1 cachedGitPlace: a directory runs git once, a failure included, and the cache stays bounded", async () => {
  const { run, calls } = fakeRun({
    "git -C /repo/app rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo/app\n" },
    "git -C /repo/app branch --show-current": { exitCode: 0, stdout: "main\n" },
  });
  const cache = newPlaceCache();
  const [first, second] = await Promise.all([cachedGitPlace(cache, run, "/repo/app"), cachedGitPlace(cache, run, "/repo/app")]);
  assert.deepEqual(first, { toplevel: "/repo/app", branch: "main" });
  assert.deepEqual(second, first);
  assert.deepEqual(await cachedGitPlace(cache, run, "/repo/app"), first);
  assert.equal(calls.length, 2, "rev-parse and branch, once");
  assert.equal(await cachedGitPlace(cache, run, "/repo/none"), null);
  assert.equal(await cachedGitPlace(cache, run, "/repo/none"), null);
  assert.equal(calls.filter((call) => call.includes("/repo/none")).length, 2, "a failure is kept too");
  for (let index = 0; index < PLACE_CACHE_MAX + 10; index += 1) await cachedGitPlace(cache, run, `/repo/dir-${index}`);
  assert.equal(cache.entries.size, PLACE_CACHE_MAX);
  assert.equal(cache.entries.has("/repo/app"), false, "the oldest go first");
});

test("0.6.23 T1 agentPlace: the worktree's name, its branch, and whether it is the lead's", () => {
  assert.deepEqual(agentPlace({ toplevel: "/repo/app-feature", branch: "feature/login" }, "/repo/app"), { worktree: "app-feature", branch: "feature/login", apart: true });
  assert.deepEqual(agentPlace({ toplevel: "/repo/app", branch: "main" }, "/repo/app"), { worktree: "app", branch: "main", apart: false });
  assert.deepEqual(agentPlace({ toplevel: "/repo/app", branch: null }, null), { worktree: "app", branch: null, apart: true }, "a lead in no repository");
  assert.deepEqual(PENDING_ISOLATION_PLACE, { worktree: null, branch: null, apart: true, pendingIsolation: true });
});

test("0.6.23 T1 samePlace: equal by value, absent equal only to absent", () => {
  assert.equal(samePlace({ worktree: "app", branch: "main", apart: false }, { worktree: "app", branch: "main", apart: false }), true);
  assert.equal(samePlace({ worktree: "app", branch: "main", apart: false }, { worktree: "app", branch: null, apart: false }), false);
  assert.equal(samePlace(PENDING_ISOLATION_PLACE, { worktree: null, branch: null, apart: true }), false);
  assert.equal(samePlace(undefined, undefined), true);
  assert.equal(samePlace(undefined, PENDING_ISOLATION_PLACE), false);
});
