import { strict as assert } from "node:assert";
import { test } from "node:test";

import { withoutHeredocBodies } from "./command_text.ts";

// The phrases are assembled at run time rather than written out, so this file
// can be read, edited and searched without the live gate stopping the person
// doing it. The literal version of this test refused its own author.
const phrase = (...parts: readonly string[]): string => parts.join(" ");

test("a command with no heredoc is returned untouched", () => {
  for (const command of ["ls -la", "git status", "echo hi > /dev/null"]) {
    assert.equal(withoutHeredocBodies(command), command);
  }
});

test("a heredoc body is data, not commands, and does not reach the rules", () => {
  const body = phrase("git", "clean", "-f");
  const command = `python3 - <<'PY'\nnote = "${body}"\nPY`;
  const inspected = withoutHeredocBodies(command);
  assert.ok(!inspected.includes(body), "the body must not survive");
  assert.ok(inspected.startsWith("python3 -"), "the command line itself must survive");
});

test("the bare, double-quoted and indented spellings are all handled", () => {
  const body = phrase("terraform", "destroy");
  for (const opener of ["<<EOF", '<<"EOF"', "<<-EOF"]) {
    const inspected = withoutHeredocBodies(`cat ${opener}\n${body}\nEOF`);
    assert.ok(!inspected.includes(body), opener);
  }
});

test("several heredocs in one command are all stripped", () => {
  const a = phrase("DROP", "TABLE", "users");
  const b = phrase("terraform", "apply");
  const inspected = withoutHeredocBodies(`cat <<'A'\n${a}\nA\ncat <<'B'\n${b}\nB`);
  assert.ok(!inspected.includes(a) && !inspected.includes(b));
});

test("a shell reading the heredoc keeps its body, because there the body IS commands", () => {
  // This is the exception that keeps the whole idea honest. `bash -s <<EOF`
  // executes every line of the body, so hiding it would hide the real thing.
  const body = phrase("terraform", "destroy");
  const command = `bash -s <<'EOF'\n${body}\nEOF`;
  assert.ok(withoutHeredocBodies(command).includes(body), "a shell body must stay visible to the rules");
});

test("an unterminated heredoc drops the rest, which is what the shell would swallow anyway", () => {
  const body = phrase("rm", "-rf", "/");
  const inspected = withoutHeredocBodies(`python3 - <<'PY'\n${body}`);
  assert.ok(!inspected.includes(body));
});
