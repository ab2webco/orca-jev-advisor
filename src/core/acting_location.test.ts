// Release 0.6.12 T5 (F-05, F-07): a command is judged in the repository it
// acts on. Every shape below is a row of the 0.6.11 QA gate table (B-*, D-*,
// E-*, G-*), with the session in one repository and the write in another.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveActingDirectory } from "./acting_location.ts";

const HOME = "/home/dev";
const SESSION = "/w/orca";
const DEMO = "/w/demo-app";
const FEAT = "/w/feat-app";

/** Every directory under /w/<name> belongs to the repository /w/<name>. */
const repoRootOf = (dir: string): string | null => /^\/w\/[^/]+/.exec(dir)?.[0] ?? null;

const acting = (command: string, cwd = SESSION): string => resolveActingDirectory(command, cwd, HOME, repoRootOf);

const INTO_DEMO = [
  "cd ../demo-app && git commit -m 'qa: 1'",
  "cd /w/demo-app; git commit -m 'qa: 2'",
  "cd /w/demo-app || exit 1; git commit -m 'qa: 3'",
  "pushd /w/demo-app && git commit -m 'qa: 4'",
  "pushd /w/demo-app >/dev/null && git commit -m 'qa: 5' && popd",
  "(cd /w/demo-app && git commit -m 'qa: 6')",
  `bash -c 'cd /w/demo-app && git commit -m "qa: 7"'`,
  `sh -c "cd /w/demo-app && git commit -m 'qa: 8'"`,
  "git -C /w/demo-app commit -m 'qa: 9'",
  "git -C /w/demo-app add -A && git -C /w/demo-app commit -m 'qa: 10'",
  "GIT_AUTHOR_NAME=qa git -C /w/demo-app commit -m 'qa: 11'",
  "env GIT_AUTHOR_NAME=qa git -C /w/demo-app commit -m 'qa: 12'",
  "time git -C /w/demo-app commit -m 'qa: 13'",
  "cd /w/demo-app\ngit commit -m 'qa: 14'",
  "cd /w/demo-app && git commit -m 'qa: 15' | tail -1",
  "echo 'qa: 16' | xargs -I{} git -C /w/demo-app commit -m {}",
  "echo $(git -C /w/demo-app commit -m 'qa: 17')",
  "echo `git -C /w/demo-app commit -m 'qa: 18'`",
  "git --git-dir=/w/demo-app/.git --work-tree=/w/demo-app commit -m 'qa: 19'",
  "cd /w/demo-app && echo hi && git status -s && git commit -m 'qa: 20'",
  "cd /w/demo-app && git merge feature/x",
  "cd /w/demo-app && git commit --amend -m 'qa: 109'",
  "cd /w/demo-app && echo x > math.js",
  "cd /w/demo-app && sed -i '' 's/a/b/' math.js",
  "cd /w/demo-app && echo x | tee math.js",
  "cd /w/demo-app && touch newfile.txt",
  "cd /w/demo-app && git cherry-pick abc123",
  "cd /w/demo-app && git commit -m 'qa: 123' && cd /w/feat-app",
  `eval "cd /w/demo-app && git commit -m 'qa: 125'"`,
  "git -C /w/demo-app checkout -q main && git -C /w/demo-app commit -m 'qa: 126'",
  "echo x > /w/demo-app/math.js",
  "rm /w/demo-app/math.js",
  "cp /etc/hosts /w/demo-app/hosts.txt",
  "cat README.md > /w/demo-app/copy-403.md",
  "printf 'x 404' > /w/demo-app/x.txt",
];

for (const command of INTO_DEMO) {
  test(`acts in the other repository: ${JSON.stringify(command)}`, () => {
    assert.equal(acting(command), DEMO);
  });
}

test("the reverse (F-07): from a main-branch session, a commit reached in a feature repository acts there", () => {
  assert.equal(acting("cd /w/feat-app && git commit -m 'qa: 1'", DEMO), FEAT);
  assert.equal(acting("git -C ../feat-app commit -m 'qa: 17'", DEMO), FEAT);
});

test("a relative cd and a $HOME-based cd are resolved", () => {
  assert.equal(acting("cd ../demo-app && git commit -m 'qa: 121'", FEAT), DEMO);
  assert.equal(acting("cd $HOME/../../w/demo-app && git commit -m 'qa: 122'", FEAT), DEMO);
});

test("the session's own directory stays when the command acts there, in several places, or somewhere unknown", () => {
  assert.equal(acting("git commit -m x"), SESSION);
  assert.equal(acting("git status && ls"), SESSION);
  assert.equal(acting("cd src && git commit -m x"), "/w/orca");
  assert.equal(acting("git -C /w/demo-app commit -m a && git -C /w/feat-app commit -m b"), SESSION);
  assert.equal(acting("cd $REPO && git commit -m x"), SESSION);
});

test("a directory outside any repository is where the command acts, when every write lands there", () => {
  assert.equal(acting("cd /tmp && touch x"), "/tmp");
});
