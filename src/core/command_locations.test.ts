import { strict as assert } from "node:assert";
import { test } from "node:test";

import { gitInvocation, locateCommandSegments } from "./command_locations.ts";

const HOME = "/home/dev";
const CWD = "/home/dev/Projects/app";

const located = (command: string, cwd = CWD) => locateCommandSegments(command, cwd, HOME).map(({ segment, dir }) => [segment, dir]);

test("cd and pushd carry to later segments; popd and variables make the directory unknown", () => {
  assert.deepEqual(located("cd ../other && git commit -m x"), [["git commit -m x", "/home/dev/Projects/other"]]);
  assert.deepEqual(located("pushd ~/w >/dev/null && git status && popd && ls"), [["git status", "/home/dev/w"], ["ls", null]]);
  assert.deepEqual(located("cd $REPO; git commit"), [["git commit", null]]);
  assert.deepEqual(located("cd /srv/a\ngit commit"), [["git commit", "/srv/a"]]);
});

test("a subshell and the script of bash -c, sh -c and eval are walked as their own command lines", () => {
  assert.deepEqual(located("(cd /srv/a && git commit) && git status"), [["git commit", "/srv/a"], ["git status", CWD]]);
  assert.deepEqual(located(`bash -c 'cd /srv/a && git commit -m "x"'`), [[`git commit -m "x"`, "/srv/a"]]);
  assert.deepEqual(located(`sh -c "cd /srv/a && git commit -m 'x'"`), [["git commit -m 'x'", "/srv/a"]]);
  assert.deepEqual(located(`eval "cd /srv/a && git commit"`), [["git commit", "/srv/a"]]);
});

test("gitInvocation reads past wrappers and global options to the subcommand and its directory", () => {
  assert.deepEqual(gitInvocation("env A=1 git -C ../other --no-pager push origin main", CWD, HOME), { subcommand: "push", args: ["origin", "main"], dir: "/home/dev/Projects/other" });
  assert.deepEqual(gitInvocation("git --git-dir=/srv/a/.git --work-tree=/srv/a commit -m x", CWD, HOME), { subcommand: "commit", args: ["-m", "x"], dir: "/srv/a" });
  assert.deepEqual(gitInvocation("GIT_AUTHOR_NAME=qa time git -C /srv/a -C b commit", CWD, HOME), { subcommand: "commit", args: [], dir: "/srv/a/b" });
  assert.equal(gitInvocation("echo git push", CWD, HOME), null);
});
