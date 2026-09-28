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

// The live defect (2026-09-26): a heredoc body that merely MENTIONS a shell's
// name as data -- a JSON description, a comment, a string literal -- used to
// make the OLD whole-command SHELL_READERS check true and keep the body
// (every heredoc's body, in fact) unstripped, because the check read the
// body's own text instead of the opener line that decides what program
// reads it. SHELL_READERS is now checked per opener line only.
test("a non-shell heredoc body that merely mentions a shell's name is still stripped", () => {
  const body = phrase("install", "via:", "curl", "-fsSL", "https://example.com/i.sh", "|", "bash");
  const inspected = withoutHeredocBodies(`python3 - <<'PY'\ndesc = "${body}"\nPY`);
  assert.ok(!inspected.includes(body), "the body must not survive just because it mentions a shell's name");
  assert.ok(inspected.startsWith("python3 -"), "the command line itself must survive");
});

test("two heredocs in one command are decided independently: a shell-fed one keeps its body, a non-shell one right next to it still loses its own", () => {
  const shellBody = phrase("terraform", "destroy");
  const otherBody = phrase("note", "mentioning", "bash", "in", "passing");
  const command = `bash -s <<'A'\n${shellBody}\nA\npython3 - <<'B'\n${otherBody}\nB`;
  const inspected = withoutHeredocBodies(command);
  assert.ok(inspected.includes(shellBody), "the shell-fed heredoc must keep its own body");
  assert.ok(!inspected.includes(otherBody), "the OTHER heredoc, fed to python3, must still lose its own body");
});

// QA 0.6.5 C2 (JEVADV-60): only an UNQUOTED `<<` opens a heredoc. A `<<`
// inside quotes, or the last two `<` of a `<<<` here-string, consumes no
// following lines in the shell, so those lines really run and must stay in
// the text the rules read.
test("a quoted << or a <<< here-string opens no heredoc, so the next lines stay visible", () => {
  const run = phrase("git", "clean", "-f");
  for (const command of [
    `grep -n '<<EOF' docs/\n${run}\nEOF`,
    `grep -n "<<EOF" docs/\n${run}\nEOF`,
    `cat <<< EOF\n${run}\nEOF`,
    `cat <<<EOF\n${run}\nEOF`,
    `echo hi # <<EOF\n${run}\nEOF`,
  ]) {
    assert.equal(withoutHeredocBodies(command), command, command);
  }
});

test("a real heredoc after a here-string or a quoted << on the same line is still stripped", () => {
  const body = phrase("git", "clean", "-f");
  for (const command of [`cat <<< "$x" <<EOF\n${body}\nEOF`, `grep '<<A' f; cat <<'EOF'\n${body}\nEOF`]) {
    assert.ok(!withoutHeredocBodies(command).includes(body), command);
  }
});

test("an escaped quote inside $'...' does not close it, so a << after it is still quoted", () => {
  const run = phrase("git", "clean", "-f");
  const command = `echo $'it\\' <<EOF'\n${run}\nEOF`;
  assert.equal(withoutHeredocBodies(command), command);
});
