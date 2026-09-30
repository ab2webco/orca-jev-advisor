import { strict as assert } from "node:assert";
import { test } from "node:test";

import { withDataTextAsPlaceholders, withoutHeredocBodies, withoutLineContinuations } from "./command_text.ts";

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

test("a backslash-newline continuation is joined the way the shell joins it, except inside single quotes", () => {
  assert.equal(withoutLineContinuations("git push \\\norigin main"), "git push origin main");
  assert.equal(withoutLineContinuations('echo "a \\\nb"'), 'echo "a b"');
  assert.equal(withoutLineContinuations("echo 'a \\\nb'"), "echo 'a \\\nb'");
  assert.equal(withoutLineContinuations("printf '%s\\n' x\ngit status"), "printf '%s\\n' x\ngit status");
  assert.equal(withoutLineContinuations("echo a\\\\\ngit status"), "echo a\\\\\ngit status");
});

// 0.6.13 T1 (F-09/N-03): the commit message spelled the way Claude Code writes
// it -- `-m "$(cat <<'EOF' ... EOF)"` -- opens a real heredoc inside the
// substitution, even though the substitution sits inside double quotes. Its
// body is the message, read by `cat`, and was refused as a force push.
test("a heredoc opened inside a double-quoted substitution is a heredoc too, and its cat body is stripped", () => {
  const body = phrase("git", "push", "--force", "origin", "main");
  const command = `git commit -m "$(cat <<'EOF'\nfix: never ${body}\nEOF\n)"`;
  const inspected = withoutHeredocBodies(command);
  assert.ok(!inspected.includes(body), "the message body must not reach the rules");
  assert.ok(inspected.startsWith("git commit -m"), "the command line itself must survive");
});

test("a heredoc inside a quoted substitution whose output may run keeps its body", () => {
  const body = phrase("git", "push", "--force", "origin", "main");
  for (const command of [
    `eval "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    `echo "$(cat <<'EOF'\n${body}\nEOF\n)" | bash`,
    `x="$(cat <<'EOF'\n${body}\nEOF\n)"`,
  ]) {
    assert.ok(withoutHeredocBodies(command).includes(body), command);
  }
});

test("the line after a substitution heredoc's closing paren is read again as a command", () => {
  const run = phrase("git", "clean", "-f");
  const command = `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)" && ${run}`;
  assert.ok(withoutHeredocBodies(command).includes(run));
});

// 0.6.13 T1: the copy of the command Jev reads carries a placeholder where a
// known CLI takes text it never runs, and where a heredoc body is written to a
// file. What runs keeps its text.
const PLACEHOLDER = "‹text›";

test("a message or body flag of a known CLI reaches Jev as a placeholder", () => {
  const text = phrase("git", "push", "origin", "main", "and", "rm", "-rf", "/");
  const cases: readonly [string, string][] = [
    [`orca terminal send --terminal t --enter --text '${text}'`, `orca terminal send --terminal t --enter --text ${PLACEHOLDER}`],
    [`git commit -m "${text}"`, `git commit -m ${PLACEHOLDER}`],
    [`git commit --message="${text}"`, `git commit --message=${PLACEHOLDER}`],
    [`git tag -a v1 -m '${text}'`, `git tag -a v1 -m ${PLACEHOLDER}`],
    [`git -C ../app commit -m '${text}'`, `git -C ../app commit -m ${PLACEHOLDER}`],
    [`gh pr create --title 'a title' --body '${text}'`, `gh pr create --title ${PLACEHOLDER} --body ${PLACEHOLDER}`],
    [`gh issue comment 4 -b '${text}'`, `gh issue comment 4 -b ${PLACEHOLDER}`],
    [`gh release create v1 --notes '${text}'`, `gh release create v1 --notes ${PLACEHOLDER}`],
    [`gh pr edit 3 --body='${text}'`, `gh pr edit 3 --body=${PLACEHOLDER}`],
  ];
  for (const [command, expected] of cases) assert.equal(withDataTextAsPlaceholders(command), expected, command);
});

test("a heredoc body written to a file, or read as a message, reaches Jev as a placeholder", () => {
  const text = phrase("git", "push", "--force", "origin", "main");
  const cases: readonly [string, string][] = [
    [`cat > /tmp/x.mjs <<'EOF'\nconst s = '${text}'\nEOF`, `cat > /tmp/x.mjs <<'EOF'\n${PLACEHOLDER}\nEOF`],
    [`mkdir -p d && cat <<EOF >> d/notes.md\n${text}\nEOF`, `mkdir -p d && cat <<EOF >> d/notes.md\n${PLACEHOLDER}\nEOF`],
    [`tee -a notes.md <<'EOF'\n${text}\nEOF`, `tee -a notes.md <<'EOF'\n${PLACEHOLDER}\nEOF`],
    [`git commit -F - <<'EOF'\n${text}\nEOF`, `git commit -F - <<'EOF'\n${PLACEHOLDER}\nEOF`],
    [`gh pr create --title t --body-file - <<'EOF'\n${text}\nEOF`, `gh pr create --title ${PLACEHOLDER} --body-file - <<'EOF'\n${PLACEHOLDER}\nEOF`],
    [`git commit -m "$(cat <<'EOF'\nfix: ${text}\n\nsecond paragraph\nEOF\n)"`, `git commit -m "$(cat <<'EOF'\n${PLACEHOLDER}\nEOF\n)"`],
  ];
  for (const [command, expected] of cases) assert.equal(withDataTextAsPlaceholders(command), expected, command);
});

test("text that runs, or that a script may run, keeps its text for Jev", () => {
  const text = phrase("git", "push", "--force", "origin", "main");
  for (const command of [
    `bash <<'EOF'\n${text}\nEOF`,
    `python3 - <<'PY'\nimport os; os.system('${text}')\nPY`,
    `cat <<'EOF' | bash\n${text}\nEOF`,
    `tee run.sh <<'EOF' | sh\n${text}\nEOF`,
    `bash -c '${text}'`,
    `git commit -m "$(${text})"`,
    `git commit -m "\`${text}\`"`,
    `git commit -m "$(printf '%s' x; ${text})"`,
    `ssh host '${text}'`,
    text,
  ]) {
    assert.equal(withDataTextAsPlaceholders(command), command, command);
  }
});

// 0.6.13 T2: the one shipped prohibition that reads a message's text
// (no_ai_attribution) must still see an attribution line; the rest of the
// text stays a placeholder.
test("an AI attribution line in data text is carried in the placeholder, nothing else is", () => {
  const trailer = phrase("Co-Authored-By:", "Claude", "<assistant@example.com>");
  const run = phrase("git", "push", "--force", "origin", "main");
  assert.equal(
    withDataTextAsPlaceholders(`git commit -m "feat: x (${run})\n\n${trailer}"`),
    `git commit -m ‹text with the line: ${trailer}›`,
  );
  const generated = phrase("Generated", "with", "Claude", "Code");
  assert.equal(
    withDataTextAsPlaceholders(`gh pr create --title t --body-file - <<'EOF'\nAdds x.\n\n${generated}\nEOF`),
    `gh pr create --title ${PLACEHOLDER} --body-file - <<'EOF'\n‹text with the line: ${generated}›\nEOF`,
  );
});

test("a real command next to data text keeps its own text", () => {
  const run = phrase("git", "push", "origin", "main");
  assert.equal(
    withDataTextAsPlaceholders(`orca terminal send --terminal t --text 'say hi' && ${run}`),
    `orca terminal send --terminal t --text ${PLACEHOLDER} && ${run}`,
  );
  assert.equal(
    withDataTextAsPlaceholders(`cat > f.txt <<'EOF'\nhello there\nEOF\n${run}`),
    `cat > f.txt <<'EOF'\n${PLACEHOLDER}\nEOF\n${run}`,
  );
});

// 0.6.13 T5 (JEVADV-63): a heredoc body fed to an interpreter is a program.
// What it hands a shell -- the string given to os.system, subprocess,
// execSync, system, backticks -- reaches the rules as a command line; the
// rest of the program (a print, a string it only holds) stays out of view.
test("the commands an interpreter heredoc runs reach the rules, its other text does not", () => {
  const run = phrase("git", "push", "--force", "origin", "x");
  const cases: readonly [string, string][] = [
    [`python3 - <<'PY'\nimport os\nos.system('${run}')\nPY`, run],
    [`python3 <<'PY'\nimport subprocess\nsubprocess.run(["git", "push", "--force", "origin", "x"], check=True)\nPY`, run],
    [`node <<'JS'\nconst { execSync } = require('child_process')\nexecSync("${run}")\nJS`, run],
    [`node - <<'JS'\nrequire('child_process').spawnSync('git', ['push', '--force', 'origin', 'x'])\nJS`, run],
    [`perl <<'PL'\nsystem "${run}";\nPL`, run],
    [`ruby <<'RB'\nout = \`${run}\`\nRB`, run],
  ];
  for (const [command, expected] of cases) {
    const inspected = withoutHeredocBodies(command);
    assert.ok(inspected.split("\n").includes(expected), `${command}\n=> ${inspected}`);
  }
});

test("an interpreter heredoc that only prints or holds the text keeps it out of the rules", () => {
  const text = phrase("git", "push", "--force", "origin", "x");
  for (const command of [
    `python3 - <<'PY'\nprint('${text}')\nPY`,
    `node <<'JS'\nconst note = "${text}"\nconsole.log(note)\nJS`,
  ]) {
    assert.ok(!withoutHeredocBodies(command).includes(text), command);
  }
});

// 0.6.14 T3 (N-09, qa-0.6.13): 0.6.13 T5 found the calls by their text, so a
// call spelled inside a string literal -- a document the program writes,
// quoting `os.system('git push --force ...')` -- was read as one and the
// write was refused as a force push. Only a call in the program's code runs.
test("a call spelled inside a string literal or a comment of an interpreter heredoc is data", () => {
  const force = phrase("git", "push", "--force", "origin", "feature/qa-work");
  const rm = phrase("rm", "-rf", "~");
  const cases: readonly [string, string][] = [
    // The reproduction: a doc-editing script whose NEW text quotes the call.
    [
      [
        "python3 - <<'EOF'",
        "from pathlib import Path",
        'p = Path("odd/qa/qa-0.6.13.md")',
        "text = p.read_text()",
        `new = """| K-py | \`os.system('${force}')\` | refuse |`,
        `| K-mirror | \`${phrase("git", "push", "--mirror")}\` | refuse |"""`,
        'text = text.replace("<!-- rows -->", new)',
        "p.write_text(text)",
        "EOF",
      ].join("\n"),
      force,
    ],
    [`python3 - <<'PY'\nopen("notes.md", "w").write("run os.system('${force}') to see it refused")\nPY`, force],
    [`python3 - <<'PY'\nrow = 'subprocess.run("${force}", shell=True)'\nPY`, force],
    [`python3 - <<'PY'\n# os.system('${force}')\nprint("ok")\nPY`, force],
    [`python3 - <<'PY'\ndoc = r'''os.system("${force}")'''\nPY`, force],
    [`node <<'JS'\nconst doc = \`execSync('${rm}')\`\nrequire('fs').writeFileSync('n.md', doc)\nJS`, rm],
    [`node <<'JS'\nconst doc = 'execSync("${rm}")'\nJS`, rm],
    [`node <<'JS'\n// execSync('${rm}')\n/* spawnSync('${rm}') */\nJS`, rm],
    [`perl <<'PL'\nprint "system '${rm}' and \`${rm}\`\\n";\nPL`, rm],
    [`ruby <<'RB'\nputs 'system("${rm}") or \`${rm}\`'\n# \`${rm}\`\nRB`, rm],
  ];
  for (const [command, text] of cases) {
    const inspected = withoutHeredocBodies(command);
    assert.ok(!inspected.includes(text), `${command}\n=> ${inspected}`);
  }
});

test("a call in code still runs wherever it sits: assigned, nested, after a string, inside a template's ${}", () => {
  const force = phrase("git", "push", "--force", "origin", "x");
  const rm = phrase("rm", "-rf", "~");
  const cases: readonly [string, string][] = [
    [`python3 - <<'PY'\nimport os\nx = os.system('${force}')\nPY`, force],
    [`python3 - <<'PY'\nimport subprocess\nif True:\n    code = subprocess.call("${force}", shell=True)\nPY`, force],
    [`python3 - <<'PY'\nnote = "it's fine"; import os; os.system('${force}')\nPY`, force],
    [`python3 - <<'PY'\ndoc = """a quoted os.system('x')"""\nimport os\nos.system("${force}")\nPY`, force],
    [`node <<'JS'\nconst { execSync } = require('child_process')\nconsole.log(\`\${execSync('${rm}')}\`)\nJS`, rm],
    [`node <<'JS'\nconst s = "a \\"quote\\""; require('child_process').execSync('${rm}')\nJS`, rm],
    [`perl <<'PL'\nmy $n = "x"; system "${rm}";\nPL`, rm],
    [`perl <<'PL'\nmy $last = $#ARGV; system "${rm}";\nPL`, rm],
    [`ruby <<'RB'\nlabel = "x"\nout = \`${rm}\`\nRB`, rm],
  ];
  for (const [command, expected] of cases) {
    const inspected = withoutHeredocBodies(command);
    assert.ok(inspected.split("\n").includes(expected), `${command}\n=> ${inspected}`);
  }
});

// 0.6.15 T1 (JEVADV-83): Jev reads the words in command position. Every other
// quoted text -- a script's argument, a loop's strings, a search pattern, the
// source handed to an interpreter -- is a placeholder, unless the program is
// known to run it. 0.6.13 T1 listed the data positions instead, so every
// unlisted one (`node probe.mjs '<json>'`, a `for` list) reached Jev as if it
// were the command.
test("a quoted argument of any program reaches Jev as a placeholder", () => {
  const force = phrase("git", "push", "--force", "origin", "main");
  const k8s = phrase("kubectl", "--context", "prod", "get", "pods");
  const cases: readonly [string, string][] = [
    [`node probe.mjs '[["O","${force}"]]'`, `node probe.mjs ${PLACEHOLDER}`],
    [`for c in '${k8s}' 'terraform plan'; do echo "$c"; done`, `for c in ${PLACEHOLDER} ${PLACEHOLDER}; do echo "$c"; done`],
    [`orca orchestration ask --question 'did you ${force}?'`, `orca orchestration ask --question ${PLACEHOLDER}`],
    [`grep -rn "${force}" src | head -3`, `grep -rn ${PLACEHOLDER} src | head -3`],
    [`echo "${force}" > notes.md && git add notes.md`, `echo ${PLACEHOLDER} > notes.md && git add notes.md`],
    [`R="${force}"; make approve F=x R="$R"`, `R=${PLACEHOLDER}; make approve F=x R="$R"`],
  ];
  for (const [command, expected] of cases) assert.equal(withDataTextAsPlaceholders(command), expected, command);
});

test("the paths and refs a command acts on stay readable, quoted or not", () => {
  for (const command of [
    `rm -rf "$HOME/Library/Application Support/app/cache"`,
    `cd "/Volumes/My Disk/app" && git push origin main`,
    `git push -u origin 'feature/x'`,
    `docker volume rm prod_pgdata`,
    `S=~/Library/Application\\ Support/app/state.json; cp "$S" /tmp/state.json`,
  ]) {
    assert.equal(withDataTextAsPlaceholders(command), command, command);
  }
});

test("a program that runs its argument keeps it, read again as a command line", () => {
  const force = phrase("git", "push", "--force", "origin", "main");
  const drop = phrase("DROP", "TABLE", "users");
  for (const command of [
    `eval "${force}"`,
    `watch -n 5 '${force}'`,
    `xargs -I{} sh -c '${force} {}'`,
    `find . -name '*.tmp' -exec sh -c 'rm -rf "$1"' _ {} \;`,
    `docker exec app sh -c 'psql -c "${drop}"'`,
    `psql -c "${drop}"`,
    `mysql -e "${drop}"`,
    `sqlite3 app.db "${drop}"`,
    `awk 'BEGIN { system("rm -rf ~") }'`,
    `python3 -c "import os; os.system('${force}')"`,
    `docker exec db psql -U app -c "${drop}"`,
    `kubectl exec -it pg-0 -- psql -c "${drop}"`,
    `bin/rails runner 'User.destroy_all; puts User.count'`,
    `bundle exec rails runner "Order.delete_all"`,
  ]) {
    assert.equal(withDataTextAsPlaceholders(command), command, command);
  }
  // What the run command line itself holds as text is a placeholder again.
  assert.equal(withDataTextAsPlaceholders(`sh -c 'echo "a b c"; ${force}'`), `sh -c 'echo ${PLACEHOLDER}; ${force}'`);
  assert.equal(withDataTextAsPlaceholders(`ssh host 'grep -rn "${force}" /srv'`), `ssh host 'grep -rn ${PLACEHOLDER} /srv'`);
});

// N-10, N-11 (qa-0.6.14): the source handed to an interpreter is read the way
// its language reads it. Code stays; a string it only holds or writes is a
// placeholder; a string it runs stays; a comment is dropped.
test("interpreter source reaches Jev as code, its text as placeholders", () => {
  const force = phrase("git", "push", "--force", "origin", "main");
  const rm = phrase("execSync('rm", "-rf", "~')", "is", "refused");
  const cases: readonly [string, string][] = [
    [`python3 -c "print('${force}')"`, `python3 -c "print('${PLACEHOLDER}')"`],
    [`node -e "console.log('${force}')"`, `node -e "console.log('${PLACEHOLDER}')"`],
    [
      `python3 - <<'PY'\np = 'notes.md'\n# ${force}\nopen(p, 'w').write('${force}')\nPY`,
      `python3 - <<'PY'\np = 'notes.md'\n\nopen(p, 'w').write('${PLACEHOLDER}')\nPY`,
    ],
    [
      `node - <<'EOF'\nconst fs = require("fs")\nfs.writeFileSync("notes.md", "${rm}")\nEOF`,
      `node - <<'EOF'\nconst fs = require("fs")\nfs.writeFileSync("notes.md", "${PLACEHOLDER}")\nEOF`,
    ],
    [`python3 - <<'PY'\nimport os\nos.system('${force}')\nPY`, `python3 - <<'PY'\nimport os\nos.system('${force}')\nPY`],
    [`python3 - <<'PY'\nname = 'x'\nprint(f"hello {name} and ${force}")\nPY`, `python3 - <<'PY'\nname = 'x'\nprint(f"${PLACEHOLDER}{name}${PLACEHOLDER}")\nPY`],
  ];
  for (const [command, expected] of cases) assert.equal(withDataTextAsPlaceholders(command), expected, command);
});

test("a heredoc fed to a program that does not run it reaches Jev as a placeholder; one fed to ssh or a SQL client stays", () => {
  const force = phrase("git", "push", "--force", "origin", "main");
  const drop = phrase("DROP", "TABLE", "users;");
  assert.equal(withDataTextAsPlaceholders(`jq -s . <<'EOF'\n{"note": "${force}"}\nEOF`), `jq -s . <<'EOF'\n${PLACEHOLDER}\nEOF`);
  for (const command of [`ssh host <<'EOF'\n${force}\nEOF`, `psql app <<'EOF'\n${drop}\nEOF`]) {
    assert.equal(withDataTextAsPlaceholders(command), command, command);
  }
});

// N-10 (qa-0.6.14): an f-string's {…} is code, so a call placed in one runs.
test("a call inside a Python f-string's braces reaches the rules; the f-string's text does not", () => {
  const force = phrase("git", "push", "--force", "origin", "x");
  const inspected = withoutHeredocBodies(`python3 - <<'PY'\nimport os\nprint(f"done: {os.system('${force}')}")\nPY`);
  assert.ok(inspected.split("\n").includes(force), inspected);
  const quoted = withoutHeredocBodies(`python3 - <<'PY'\nprint(f"never os.system('${force}') {1 + 1}")\nPY`);
  assert.ok(!quoted.includes(force), quoted);
});

// What a pipe or a here-string feeds a shell, an interpreter or a SQL client
// is run by it, so Jev keeps reading it; fed to anything else it is text.
test("text piped or here-stringed into a program that runs it keeps its text for Jev", () => {
  const drop = phrase("DROP", "TABLE", "users;");
  const force = phrase("git", "push", "--force", "origin", "main");
  for (const command of [
    `echo "${drop}" | psql`,
    `psql <<< "${drop}"`,
    `printf '%s\\n' "${force}" | bash`,
    `echo "${force}" | tee run.sh | sh`,
    `echo "${drop}" | ssh db 'mysql app'`,
  ]) {
    assert.equal(withDataTextAsPlaceholders(command), command, command);
  }
  assert.equal(withDataTextAsPlaceholders(`echo "${force}" | grep push`), `echo ${PLACEHOLDER} | grep push`);
  assert.equal(withDataTextAsPlaceholders(`jq -r . <<< "${force}"`), `jq -r . <<< ${PLACEHOLDER}`);
});

// A `$( )` runs, so its command line is read again as one, inside quotes too.
test("a command substitution is read again as a command line, its own text a placeholder", () => {
  const force = phrase("git", "push", "--force", "origin", "main");
  assert.equal(withDataTextAsPlaceholders(`node probe.mjs "$(printf '%s' '${force} is refused')"`), `node probe.mjs "$(printf '%s' ${PLACEHOLDER})"`);
  assert.equal(withDataTextAsPlaceholders(`echo "$(${force})"`), `echo "$(${force})"`);
});
