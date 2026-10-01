// Unit tests for resolveCommandTargetDirs -- pure input to pure output.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolveCommandTargetDirs } from "./command_targets.ts";

const CWD = "/home/dev/Projects/orca-supervisor";

test("rm: every non-flag argument resolves against cwd", () => {
  const targets = resolveCommandTargetDirs("rm -rf /tmp/scratch.tmp", CWD);
  assert.deepEqual(targets, ["/tmp/scratch.tmp"]);
});

test("rm: a relative target resolves against cwd", () => {
  const targets = resolveCommandTargetDirs("rm notes.txt", CWD);
  assert.deepEqual(targets, [join(CWD, "notes.txt")]);
});

test("rm: several targets are all named, deduplicated", () => {
  const targets = resolveCommandTargetDirs("rm a.txt b.txt a.txt", CWD);
  assert.deepEqual(targets, [join(CWD, "a.txt"), join(CWD, "b.txt")]);
});

test("mv/cp: only the destination is named, never the source", () => {
  assert.deepEqual(resolveCommandTargetDirs("mv src.txt /elsewhere/dest.txt", CWD), ["/elsewhere/dest.txt"]);
  assert.deepEqual(resolveCommandTargetDirs("cp src.txt /elsewhere/dest.txt", CWD), ["/elsewhere/dest.txt"]);
});

test("a redirection to a file names the file that follows it", () => {
  assert.deepEqual(resolveCommandTargetDirs("echo hi > /tmp/out.log", CWD), ["/tmp/out.log"]);
  assert.deepEqual(resolveCommandTargetDirs("echo hi >> /tmp/out.log", CWD), ["/tmp/out.log"]);
});

test("a file-descriptor redirection (2>&1, &>) never names a path", () => {
  assert.deepEqual(resolveCommandTargetDirs("some-tool 2>&1", CWD), []);
  assert.deepEqual(resolveCommandTargetDirs("some-tool >&2", CWD), []);
});

test("0.6.19 M12: a redirection written without a space names its file, as the spaced form does", () => {
  const other = join(CWD, "..", "other-repo", "x");
  assert.deepEqual(resolveCommandTargetDirs("echo hi >../other-repo/x", CWD), [other]);
  assert.deepEqual(resolveCommandTargetDirs("echo hi >>../other-repo/x", CWD), [other]);
  assert.deepEqual(resolveCommandTargetDirs("echo hi 1>../other-repo/x", CWD), [other]);
  assert.deepEqual(resolveCommandTargetDirs("some-tool 2>>err.log", CWD), [join(CWD, "err.log")]);
});

test("0.6.19 M12: a numbered redirection followed by a space names the next token", () => {
  assert.deepEqual(resolveCommandTargetDirs("echo hi 1> /tmp/out.log", CWD), ["/tmp/out.log"]);
  assert.deepEqual(resolveCommandTargetDirs("some-tool 2>> /tmp/err.log", CWD), ["/tmp/err.log"]);
});

test("0.6.21 T2: `&>`, `&>>` and a redirection glued to a word name their file, as the spaced form does", () => {
  const other = join(CWD, "..", "other-repo", "x");
  for (const command of [
    "echo hi > ../other-repo/x",
    "echo hi &>../other-repo/x",
    "echo hi &> ../other-repo/x",
    "echo hi &>>../other-repo/x",
    "echo hi>../other-repo/x",
    "echo hi>>../other-repo/x",
    "echo hi>../other-repo/x 2>&1",
  ]) {
    assert.deepEqual(resolveCommandTargetDirs(command, CWD), [other], command);
  }
});

test("0.6.21 T2: a descriptor copy and quoted text still name nothing", () => {
  for (const command of ["some-tool 2>&1", "some-tool >&2", 'echo "a>b"', "echo 'a > ../other-repo/x'", 'echo "x &> ../other-repo/x"']) {
    assert.deepEqual(resolveCommandTargetDirs(command, CWD), [], command);
  }
});

test("git -C <dir>: the named directory is THIS segment's own target, never persisted to a later segment", () => {
  const targets = resolveCommandTargetDirs('git -C /other/repo rm tracked.txt && rm untracked.txt', CWD)
  assert.deepEqual(targets, [join(CWD, "untracked.txt")], "git rm is not one of the recognised shapes, but the later rm must resolve against cwd, not /other/repo")
})

test("cd <dir> && rm <file>: the target resolves against the cd'd directory, and persists to later segments", () => {
  const targets = resolveCommandTargetDirs("cd /other/repo && rm a.txt && rm b.txt", CWD);
  assert.deepEqual(targets, ["/other/repo/a.txt", "/other/repo/b.txt"]);
});

test("cd with a relative directory resolves against the previous resolve directory", () => {
  const targets = resolveCommandTargetDirs("cd sub && rm a.txt", CWD);
  assert.deepEqual(targets, [join(CWD, "sub", "a.txt")]);
});

test("an unresolvable target (a shell variable or a glob) is never guessed at", () => {
  assert.deepEqual(resolveCommandTargetDirs("rm $FILE", CWD), []);
  assert.deepEqual(resolveCommandTargetDirs("rm *.tmp", CWD), []);
  assert.deepEqual(resolveCommandTargetDirs("rm file.txt $FILE", CWD), [join(CWD, "file.txt")]);
});

test("a command with no recognised shape resolves no targets at all", () => {
  assert.deepEqual(resolveCommandTargetDirs("npm test", CWD), []);
  assert.deepEqual(resolveCommandTargetDirs("git status", CWD), []);
});

test("an absolute rm target is never re-resolved against cwd", () => {
  assert.deepEqual(resolveCommandTargetDirs("rm /var/tmp/scratch", CWD), ["/var/tmp/scratch"]);
});
