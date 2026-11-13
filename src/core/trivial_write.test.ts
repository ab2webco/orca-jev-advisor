// Unit tests for trivial_write.ts: pure text in, write targets (or null) out.
// odd/tasks/gate-ignored-files-not-main.md. Run with:
//   node --test --experimental-strip-types src/core/trivial_write.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { trivialWriteTargets, type TrivialTarget } from "./trivial_write.ts";

const file = (word: string): TrivialTarget => ({ word, kind: "file" });

test("trivialWriteTargets: redirections and the named writers give their targets", () => {
  assert.deepEqual(trivialWriteTargets("printf 'x' > odd/tasks/x.md"), [file("odd/tasks/x.md")]);
  assert.deepEqual(trivialWriteTargets("printf x >> odd/notes.md"), [file("odd/notes.md")]);
  assert.deepEqual(trivialWriteTargets("cat > odd/tasks/x.md <<'EOF'\n- [x] done\nEOF"), [file("odd/tasks/x.md")]);
  assert.deepEqual(trivialWriteTargets("tee odd/a.md <<'EOF'\nnotes\nEOF"), [file("odd/a.md")]);
  assert.deepEqual(trivialWriteTargets("echo x | tee -a odd/a.md odd/b.md"), [file("odd/a.md"), file("odd/b.md")]);
  assert.deepEqual(trivialWriteTargets("cp src/a.ts odd/x"), [file("odd/x")]);
  assert.deepEqual(trivialWriteTargets("cp -fp src/a.ts odd/x"), [file("odd/x")]);
  assert.deepEqual(trivialWriteTargets("mv odd/tasks/x.md odd/tasks/y.md"), [{ word: "odd/tasks/x.md", kind: "removed" }, file("odd/tasks/y.md")]);
  assert.deepEqual(trivialWriteTargets("mkdir -p odd/dir"), [{ word: "odd/dir", kind: "dirs" }]);
  assert.deepEqual(trivialWriteTargets("mkdir -m 755 odd/dir"), [{ word: "odd/dir", kind: "dir" }]);
  assert.deepEqual(trivialWriteTargets("touch odd/a.md odd/b.md"), [file("odd/a.md"), file("odd/b.md")]);
  assert.deepEqual(trivialWriteTargets("install -m 644 src/a.ts odd/a.ts"), [file("odd/a.ts")]);
  assert.deepEqual(trivialWriteTargets("install -d odd/a/b"), [{ word: "odd/a/b", kind: "dirs" }]);
  assert.deepEqual(trivialWriteTargets("> odd/empty.md"), [file("odd/empty.md")]);
  assert.deepEqual(trivialWriteTargets("mkdir -p odd/qa/new && touch odd/qa/new/a.md"), [{ word: "odd/qa/new", kind: "dirs" }, file("odd/qa/new/a.md")]);
});

test("trivialWriteTargets: quoting is literal, /dev/null and fd duplications write no file", () => {
  assert.deepEqual(trivialWriteTargets(`printf x > "odd/my notes.md"`), [file("odd/my notes.md")]);
  assert.deepEqual(trivialWriteTargets("printf x > 'odd'/a.md 2>/dev/null"), [file("odd/a.md")]);
  assert.deepEqual(trivialWriteTargets("printf x > odd/a.md 2>&1"), [file("odd/a.md")]);
  assert.deepEqual(trivialWriteTargets("printf x 2> odd/err.log >&2"), [file("odd/err.log")]);
  assert.deepEqual(trivialWriteTargets("echo hi"), []);
  assert.deepEqual(trivialWriteTargets("cat src/a.ts < odd/in.md"), []);
});

test("trivialWriteTargets: a quoted heredoc body is data, whatever it says", () => {
  const command = "cat > odd/x.md <<'EOF'\n- ran `cd src && ln -s ../a b`, PATH=x $(rm -rf /) (eval) # done\nEOF\nprintf y >> odd/y.md";
  assert.deepEqual(trivialWriteTargets(command), [file("odd/x.md"), file("odd/y.md")]);
  assert.deepEqual(trivialWriteTargets("cat > odd/x.md <<-\"EOF\"\n\t$(x)\n\tEOF"), [file("odd/x.md")]);
  assert.deepEqual(trivialWriteTargets("cat > odd/x.md <<EOF\nplain notes, no expansion\nEOF"), [file("odd/x.md")]);
});

test("trivialWriteTargets: an unquoted heredoc that would expand anything, or one never closed, is not trivial", () => {
  for (const command of [
    "cat > odd/x.md <<EOF\n$(printf x > src/a.ts)\nEOF",
    "cat > odd/x.md <<EOF\n`printf x > src/a.ts`\nEOF",
    "cat > odd/x.md <<EOF\n$HOME\nEOF",
    "cat > odd/x.md <<EOF\na \\\nEOF",
    "cat > odd/x.md <<'EOF'\nnever closed",
  ]) assert.equal(trivialWriteTargets(command), null, command);
});

test("trivialWriteTargets: links, cd and its kin, assignments, eval and the like are never trivial", () => {
  for (const command of [
    "ln -s ../src odd/s && printf x > odd/s/a.ts",
    "ln src/a.ts odd/h && printf x > odd/h",
    "cp -l src/a.ts odd/h",
    "cp -al src odd/copy",
    "cp --link src/a.ts odd/h",
    "cp -s src/a.ts odd/h",
    "cp --symbolic-link src/a.ts odd/h",
    "cp -r src odd/copy",
    "cp -t odd src/a.ts",
    "mv -t odd src/a.ts",
    "install -t odd src/a.ts",
    "install -o root src/a.ts odd/a.ts",
    "cd odd/missing; printf x > src/a.ts",
    "cd -P odd/s && printf x > a.ts",
    "pushd odd && printf x > x.md",
    "popd; printf x > x.md",
    "builtin cd odd; printf x > x.md",
    "PATH=odd:/usr/bin cat > odd/x.md",
    "HOME=/x; printf x > odd/a.md",
    "CDPATH=src; printf x > odd/a.md",
    "export FOO=1; printf y > odd/x.md",
    "eval 'printf x > src/a.ts'",
    "exec 3> src/a.ts",
    "env printf x > odd/x.md",
    "source odd/x.sh",
    ". odd/x.sh",
    "command printf x > odd/x.md",
    "(printf x > odd/x.md)",
    "{ printf x; } > odd/x.md",
    "f() { printf x > src/a.ts; }; f > odd/x.md",
    "function f { :; }",
    "printf x > odd/x.md; tee odd/y.md < <(printf x)",
    "printf x > >(tee src/a.ts)",
    "echo `printf x > src/a.ts` > odd/x.md",
    "echo $(printf x > src/a.ts) > odd/x.md",
    "printf x > $HOME/a.md",
    "printf x > ~/a.md",
    "printf x > odd/*.md",
    "printf x > odd/{a,b}.md",
    "printf x > odd/../src/a.ts",
    "printf x > .git/info/exclude",
    "printf x > odd/.GIT/config",
    "printf x &> odd/a.md",
    "printf x <> odd/a.md",
    "printf x >& odd/a.md",
    "printf x > odd/a.md &",
    "printf x |& tee odd/a.md",
    "# a comment\nprintf x > odd/a.md",
    "printf x > odd/a.md \\\n  && echo y",
    "printf \"$x\" > odd/a.md",
    "sed -i '' 's/x/y/' odd/x.md",
    "python3 - <<'EOF'\nopen('odd/x.md','w')\nEOF",
    "/bin/cp src/a.ts odd/x",
    "'cp' src/a.ts odd/x",
    "if true; then printf x > odd/a.md; fi",
    "! printf x > odd/a.md",
    "printf 'multi\nline' > odd/a.md",
    "tee - < odd/a.md",
    "cp src/a.ts",
    "touch -r src/a.ts odd/a.md",
    "printf x >",
    // printf -v assigns a variable (PATH here), and zsh expands =name from PATH.
    "printf -v PATH odd:/usr/bin; cat > odd/x.md",
    "printf -vPATH odd; cat > odd/x.md",
    "printf -- x > odd/x.md",
    "cat =ls > odd/x.md",
    "printf x > =odd",
  ]) assert.equal(trivialWriteTargets(command), null, command);
});
