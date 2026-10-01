// 0.6.21 T2 (JEVADV-98): the files a command's output redirections write, read
// from the segment's text the way the shell reads it. Pure input to output.

import assert from "node:assert/strict";
import test from "node:test";

import { outputRedirectionTargets } from "./redirections.ts";

test("T2: a redirection names the same file spaced, unspaced or glued to the word before it", () => {
  for (const [segment, targets] of [
    ["echo hi > x", ["x"]],
    ["echo hi >x", ["x"]],
    ["echo hi>x", ["x"]],
    ["echo hi >> ../x", ["../x"]],
    ["echo hi>>../x", ["../x"]],
    ["echo hi 1>x", ["x"]],
    ["echo hi 1> x", ["x"]],
    ["some-tool 2>>err.log", ["err.log"]],
    ["some-tool 2>> err.log", ["err.log"]],
    ["echo hi >|x", ["x"]],
  ] as const) {
    assert.deepEqual(outputRedirectionTargets(segment), targets, segment);
  }
});

test("T2: `&>` and `&>>` send both streams to a file, with or without a space, glued or not", () => {
  for (const [segment, targets] of [
    ["some-tool &>out.log", ["out.log"]],
    ["some-tool &> out.log", ["out.log"]],
    ["some-tool &>>../out.log", ["../out.log"]],
    ["some-tool &>> ../out.log", ["../out.log"]],
    ["some-tool arg&>out.log", ["out.log"]],
  ] as const) {
    assert.deepEqual(outputRedirectionTargets(segment), targets, segment);
  }
});

test("T2: a descriptor copy or close names no file", () => {
  for (const segment of ["some-tool 2>&1", "some-tool >&2", "some-tool 1>&2", "some-tool 2>&-", "some-tool >/dev/null 2>&1"]) {
    assert.ok(!outputRedirectionTargets(segment).some((target) => /^[\d-]$|&/.test(target)), segment);
  }
  assert.deepEqual(outputRedirectionTargets("some-tool 2>&1"), []);
  assert.deepEqual(outputRedirectionTargets("some-tool >&2"), []);
  assert.deepEqual(outputRedirectionTargets("some-tool >/dev/null 2>&1"), ["/dev/null"]);
});

test("T2: quoted or escaped text is data, never a redirection", () => {
  for (const segment of ['echo "a>b"', "echo 'a>b'", "echo 'a > b'", 'echo "x &> y"', "echo a\\>b", 'git commit -m "fix: a>b and c >> d"']) {
    assert.deepEqual(outputRedirectionTargets(segment), [], segment);
  }
});

test("T2: input, heredocs, process substitution, arithmetic and comments write nothing", () => {
  for (const segment of ["sort <in.txt", "cat <<EOF", "cat <<<'a>b'", "tee >(cat)", "diff <(ls a) <(ls b)", "echo $((1>2))", "(( a > b ))", "ls # see a>b", "cat <>rw.txt"]) {
    assert.deepEqual(outputRedirectionTargets(segment), [], segment);
  }
});

test("T2: every redirection of a segment, in order; a quoted target loses its quotes", () => {
  assert.deepEqual(outputRedirectionTargets("some-tool >a 2>b"), ["a", "b"]);
  assert.deepEqual(outputRedirectionTargets('echo hi>"my file"'), ["my file"]);
  assert.deepEqual(outputRedirectionTargets("echo hi> '../x'"), ["../x"]);
  assert.deepEqual(outputRedirectionTargets("echo hi >$(pwd)/x"), ["$(pwd)/x"]);
  assert.deepEqual(outputRedirectionTargets("cat <<EOF >out.txt"), ["out.txt"]);
  assert.deepEqual(outputRedirectionTargets("echo hi >"), []);
});
