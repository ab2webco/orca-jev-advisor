import { strict as assert } from "node:assert";
import { test } from "node:test";

import { cannotScanWithConfidence, discardsUncommittedWork, someSegmentMatches, splitOnCommandSeparators, splitOutsideQuotes, startsWithGitDiscard } from "./git_discard.ts";

// Each of these overwrites the working tree from the index or a commit, and
// uncommitted changes to those paths are gone: no reflog, no stash, nothing
// to recover them from.
const DISCARDS: readonly string[] = [
  "git checkout -- src/app.ts",
  "git checkout -- .",
  "git checkout .",
  "git checkout ./",
  "git checkout main -- src/app.ts",
  "git checkout HEAD~2 -- README.md",
  "git checkout -f",
  "git checkout --force",
  "git checkout -f main",
  "git checkout --force feature/x",
  "git checkout -qf main",
  "git checkout --pathspec-from-file=paths.txt",
  "git restore src/app.ts",
  "git restore .",
  "git restore --worktree src/app.ts",
  "git restore -W src/app.ts",
  "git restore --staged --worktree src/app.ts",
  "git restore -SW src/app.ts",
  "git restore --source=HEAD~1 src/app.ts",
  "git restore -s HEAD~1 src/app.ts",
  "git -C ../other checkout -- .",
  "git -c core.pager=cat restore src/app.ts",
  "git --no-pager checkout .",
  "cd repo && git checkout -- src/app.ts",
  "npm test; git restore .",
  "bash -c \"git checkout -- src/app.ts\"",
  "(git restore .)",
  // Two positionals with no -b/-B/--orphan is git's <tree-ish> <pathspec> form.
  "git checkout HEAD src/app.ts",
  "git checkout main src/app.ts README.md",
  "/usr/bin/git checkout -- src/app.ts",
  "sudo git restore .",
  "env GIT_DIR=.git git restore .",
  "echo $(git restore .)",
  "eval \"git checkout -- src/app.ts\"",
  "git ls-files -m | xargs git restore",
  // Wrapper options that take a separate value, and wrappers that are not a
  // shell keyword: the value must never be read as the program.
  "sudo -u root git restore .",
  "nice -n 10 git checkout -- src/app.ts",
  "env -u VAR git restore .",
  "xargs -n 1 git restore",
  "timeout 60 git checkout -- .",
  "doas git restore .",
  "sudo -u root bash -c \"git restore .\"",
  // odd/tasks/release-0.5.1.md T8 (JEVADV-24): reset/clean used to be
  // matched by a separate, quote-blind regex in gate-bash.ts. Folding them
  // in here gives them the same tokenizer, wrapper/eval/-c recursion and
  // command-position discipline checkout/restore already have.
  "git reset --hard",
  "git reset --hard HEAD~3",
  // Not the OLD regex's literal form (it required `--hard` immediately
  // after `reset`), but still a hard reset -- the args, not their order,
  // decide it, same as checkoutDiscards already does.
  "git reset --quiet --hard",
  "git clean -fd",
  "git clean --force",
  "bash -c \"git reset --hard\"",
  "eval \"git reset --hard\"",
  "env A=1 git reset --hard",
  "git -C ../repo reset --hard",
  // A bare `--` with nothing after it is what `xargs` leaves in the static
  // text -- the real pathspecs only exist once xargs appends them at
  // runtime, so a command that is actually fed by xargs still discards.
  "find . | xargs git checkout --",
  // odd/tasks/release-0.5.1.md T10 (JEVADV-28), R1-002: reset/clean must
  // stay caught through ssh's remote command and `su -c`, the same way
  // `bash -c`/`eval` already were -- these run a real shell on the far end
  // (ssh) or right here (su), not descriptive text.
  'ssh host "git reset --hard"',
  'su -c "git reset --hard"',
  'su root -c "git clean -fd"',
  'script -c "git reset --hard"',
  'watch "git reset --hard"',
];

// None of these touches uncommitted work in the working tree.
const KEEPS: readonly string[] = [
  "git checkout main",
  "git checkout feature/login",
  "git checkout -b new-branch",
  "git checkout -b new-branch origin/main",
  // `-B` moves a branch pointer; like any checkout it carries local changes
  // over (or refuses on a conflict) rather than overwriting them.
  "git checkout -B rebuilt origin/main",
  "git checkout -q main",
  "git checkout -",
  // Branch-or-path ambiguity: git resolves a bare name as a branch first.
  // Left to the ordinary path on purpose -- see git_discard.ts.
  "git checkout src/app.ts",
  "git switch main",
  "git switch -c new-branch",
  "git restore --staged src/app.ts",
  "git restore -S src/app.ts",
  "git restore --staged .",
  "git status",
  "git log --oneline -- .",
  "git diff -- src/app.ts",
  "git checkout main && ls .",
  "grep -rn restore src",
  "echo git",
  "",
  // A mention inside an argument is not a run: commit messages, PR bodies
  // and search patterns name these commands all the time.
  "git commit -m \"note: use git restore src/app.ts to undo\"",
  "git commit -m 'git checkout -- . discarded work'",
  "gh pr create --body \"never run git restore .\"",
  "node scripts/x.mjs \"git checkout -f\"",
  "git checkout -b feature origin/main",
  "sudo -u root git commit -m \"git restore src/app.ts\"",
  "timeout 60 npm test",
  // --soft/--mixed (the default) never touch the working tree, and a dry
  // run never touches anything at all.
  "git reset",
  "git reset --soft HEAD~1",
  "git reset --mixed",
  "git clean -n",
  "git clean --dry-run",
  // odd/tasks/release-0.5.1.md T10 (JEVADV-28), R3-checkout-trailing-dashdash:
  // a bare `--` with a real branch before it is an ordinary, non-destructive
  // branch switch that merely signals "no more flags" -- it only means a
  // discard when xargs is about to append the actual pathspecs after it
  // (see "find . | xargs git checkout --" above).
  "git checkout main --",
];

for (const command of DISCARDS) {
  test(`discards uncommitted work: ${command}`, () => {
    assert.equal(discardsUncommittedWork(command), true);
  });
}

for (const command of KEEPS) {
  test(`does not discard uncommitted work: ${JSON.stringify(command)}`, () => {
    assert.equal(discardsUncommittedWork(command), false);
  });
}

// splitOutsideQuotes / someSegmentMatches -- exported for gate-bash.ts's
// NEVER_SILENTLY loop (M4): a `scope: 'segment'` rule must test each
// segment independently, so a `.*` inside the rule's own pattern can never
// span a separator and falsely implicate an unrelated segment.
test("splitOutsideQuotes: a quoted && stays inside one segment", () => {
  assert.deepEqual(splitOutsideQuotes('git commit -m "build && test"'), ['git commit -m "build && test"']);
});

test("splitOutsideQuotes: an unquoted && splits into two segments", () => {
  assert.deepEqual(splitOutsideQuotes("git status && git push --force"), ["git status", "git push --force"]);
});

test("splitOutsideQuotes: an unquoted ; splits into two segments", () => {
  assert.deepEqual(splitOutsideQuotes("git status; git push --force"), ["git status", "git push --force"]);
});

test("splitOutsideQuotes: an unquoted || splits into two segments", () => {
  assert.deepEqual(splitOutsideQuotes("git status || git push --force"), ["git status", "git push --force"]);
});

test("splitOutsideQuotes: an unquoted | splits into two segments", () => {
  assert.deepEqual(splitOutsideQuotes("git status | git push --force"), ["git status", "git push --force"]);
});

test("splitOutsideQuotes: an unquoted newline splits into two segments", () => {
  assert.deepEqual(splitOutsideQuotes("git status\ngit push --force"), ["git status", "git push --force"]);
});

test("splitOutsideQuotes: unquoted parens split into segments", () => {
  assert.deepEqual(splitOutsideQuotes("(git status)"), ["git status"]);
});

test("someSegmentMatches: a pattern matching one segment does not match a command whose only match is in another segment", () => {
  const pattern = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git push origin --delete x && git branch -f main origin/main", pattern), null);
});

test("splitOnCommandSeparators: a substitution stays inside the command it feeds", () => {
  assert.deepEqual(splitOnCommandSeparators("git push $(echo x; echo y) origin && git status"), [
    "git push $(echo x; echo y) origin",
    "git status",
  ]);
  assert.deepEqual(splitOnCommandSeparators("git push `echo a | cat` origin; ls"), ["git push `echo a | cat` origin", "ls"]);
});

test("splitOnCommandSeparators: a quoted paren inside a substitution does not close it", () => {
  assert.deepEqual(splitOnCommandSeparators('git push $(echo ")"; echo --force) origin'), ['git push $(echo ")"; echo --force) origin']);
});

test("splitOnCommandSeparators: a redirection never splits its command", () => {
  assert.deepEqual(splitOnCommandSeparators("git push 2>&1 origin"), ["git push 2>&1 origin"]);
  assert.deepEqual(splitOnCommandSeparators("git push &>/dev/null origin"), ["git push &>/dev/null origin"]);
  assert.deepEqual(splitOnCommandSeparators("git push 0<&3 origin"), ["git push 0<&3 origin"]);
  assert.deepEqual(splitOnCommandSeparators("git push >|log origin"), ["git push >|log origin"]);
  assert.deepEqual(splitOnCommandSeparators("git push 2>&1 && ls"), ["git push 2>&1", "ls"]);
});

test("splitOnCommandSeparators: parentheses never split", () => {
  assert.deepEqual(splitOnCommandSeparators("(git status) && ls"), ["(git status)", "ls"]);
});

test("splitOnCommandSeparators: separators split outside quotes only", () => {
  assert.deepEqual(splitOnCommandSeparators('git commit -m "a && b" || ls\nls'), ['git commit -m "a && b"', "ls", "ls"]);
});

test("someSegmentMatches: a flag produced by a substitution still matches its push", () => {
  const pattern = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git push $(echo --force) origin", pattern), "deny");
  assert.equal(someSegmentMatches("git push `echo -f` origin", pattern), "deny");
});

test("someSegmentMatches: 'deny' when a segment matches in command position", () => {
  const pattern = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git status && git push --force origin main", pattern), "deny");
});

test("startsWithGitDiscard only looks at the start of one segment", () => {
  assert.equal(startsWithGitDiscard("git checkout -- src/app.ts"), true);
  assert.equal(startsWithGitDiscard("git restore ."), true);
  assert.equal(startsWithGitDiscard("git checkout main"), false);
  // A mention inside another program's arguments is not a family match.
  assert.equal(startsWithGitDiscard("bash -c \"git restore .\""), false);
  // Same tokenizer as the deny tier: a quoted whole-tree pathspec is still one.
  assert.equal(startsWithGitDiscard("git checkout \".\""), true);
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T8 (JEVADV-24): forcePush/pushProtected are
// someSegmentMatches' only `scope: 'segment'` callers (see gate-bash.ts's
// NEVER_SILENTLY). Observed live: a `printf` whose double-quoted argument
// merely SPELLED OUT a destructive git command was refused as if that
// command had run. Quoted DATA -- an argument with whitespace in it, like a
// commit message or a PR body -- must now be opaque to the pattern; a real
// command a shell would execute must stay exactly as visible as before.
// ---------------------------------------------------------------------------

test("someSegmentMatches: a quoted sentence naming the pattern is not a match -- it is data, not a run", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('gh pr comment 1 --body "we avoided git push --force"', forcePush), null);
  assert.equal(someSegmentMatches('git commit -m "build && test git push --force later"', forcePush), null);
});

test("someSegmentMatches: a quoted PROTECTED BRANCH sentence is not a match either", () => {
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  assert.equal(someSegmentMatches('gh pr comment 1 --body "please do not push straight to main"', pushProtected), null);
});

test("someSegmentMatches: a single quoted WORD still matches, in command position -- it is one word, never a sentence", () => {
  // `git push origin "main"` is still a push to main: quoting a bare branch
  // name or flag is ordinary shell usage, not descriptive text, and no
  // `\s`-spanning pattern can ever be spelled with one word alone.
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('git push origin "main"', pushProtected), "deny");
  assert.equal(someSegmentMatches('git push origin "-f"', forcePush), "deny");
});

test("someSegmentMatches: the script argument of bash -c / sh -c / eval still matches, quoted or not -- command position", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('bash -c "git push --force"', forcePush), "deny");
  assert.equal(someSegmentMatches('sh -c "git push --force origin main"', forcePush), "deny");
  assert.equal(someSegmentMatches('eval "git push --force"', forcePush), "deny");
  // Wrapping in a subshell must not defeat the -c/eval recognition.
  assert.equal(someSegmentMatches("(bash -c 'git push --force')", forcePush), "deny");
});

test("cannotScanWithConfidence: an unbalanced quote fails CLOSED onto the raw segment text", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(cannotScanWithConfidence('git commit -m "git push --force'), true);
  // Unparseable input can never be resolved to the mention-only 'ask' tier
  // (there is no reliable position to reason about at all): it fails CLOSED
  // to 'deny', same discipline as before this task, just expressed as the
  // stricter half of the new two-value outcome instead of a bare boolean.
  assert.equal(someSegmentMatches('git commit -m "git push --force', forcePush), "deny");
  assert.equal(cannotScanWithConfidence("git push --force origin main"), false);
});

test("someSegmentMatches: a DOUBLE-QUOTED substitution still runs, so it stays visible, in command position", () => {
  // Review finding R3: splicing the scanned body back in BEFORE tokenizing
  // left it inside the surrounding quotes, where the data placeholder
  // swallowed it -- a deny-tier bypass the old raw match never had.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  const pushProtected = /git\s+push\b.*\b(main|master|develop)\b/;
  assert.equal(someSegmentMatches('git push origin "$(echo --force)"', forcePush), "deny");
  assert.equal(someSegmentMatches('echo "$(git push --force origin main)"', forcePush), "deny");
  assert.equal(someSegmentMatches('echo "`git push --force origin main`"', forcePush), "deny");
  assert.equal(someSegmentMatches('echo "now: $(git push --force origin main) done"', forcePush), "deny");
  assert.equal(someSegmentMatches('git push origin "$(printf main)"', pushProtected), "deny");
  assert.equal(someSegmentMatches('bash -c "echo \\"$(git push --force)\\""', forcePush), "deny");
  // The sentence around a substitution is still data; only the body is a run.
  assert.equal(someSegmentMatches('gh pr comment 1 --body "we avoided git push --force on $(date)"', forcePush), null);
});

test("someSegmentMatches: substitution and redirection tests above still hold with the new sanitizer", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git push $(echo x; echo --force) origin", forcePush), "deny");
  assert.equal(someSegmentMatches("git push 2>&1 --force origin", forcePush), "deny");
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T10 (JEVADV-28): opacity is an ALLOWLIST of
// known DATA positions, not every quoted multi-word argument. A command run
// by ANOTHER program -- a remote shell, a login shell, an interpreter -- must
// stay exactly as visible as it was in 0.5.0; only the specific arguments
// listed in git_discard.ts's module note (printf/echo text, git's own commit
// message flags, gh's text flags, a grep-family PATTERN, jq's filter) go
// opaque. Review findings R1-001/R3-wrapper-remote-command-opaque/
// R4-quoted-remote-command-opaque.
// ---------------------------------------------------------------------------

test("someSegmentMatches: a real shell/login/watch wrapper's command still denies -- command position", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  assert.equal(someSegmentMatches('ssh host "git push --force origin main"', forcePush), "deny");
  assert.equal(someSegmentMatches('ssh host "git push origin main"', pushProtected), "deny");
  assert.equal(someSegmentMatches('su -c "git push -f origin main"', forcePush), "deny");
  assert.equal(someSegmentMatches('watch "git push -f"', forcePush), "deny");
  assert.equal(someSegmentMatches('script -c "git push -f"', forcePush), "deny");
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T10 (JEVADV-36): interpreter CODE strings
// (python/node/ruby/perl/php/osascript's own "run this string" flag) commonly
// shell out (os.system, execSync, `do shell script`, ...), so they stay
// CODE, never data, even under the strictest ("command position only") scan
// -- unlike a plain visible argument of some other, non-executing program,
// which now resolves to the mention-only 'ask' tier instead (see below).
// ---------------------------------------------------------------------------

test("someSegmentMatches: interpreter code strings deny -- they are code, not data, even though they are not shell syntax", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches(`python3 -c "import os; os.system('git push --force origin main')"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`python -c "import os; os.system('git push --force origin main')"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`node -e "require('child_process').execSync('git push --force origin main')"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`ruby -e "system('git push --force origin main')"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`perl -e "system('git push --force origin main')"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`php -r "system('git push --force origin main');"`, forcePush), "deny");
  assert.equal(someSegmentMatches(`osascript -e "do shell script \\"git push --force origin main\\""`, forcePush), "deny");
});

test("someSegmentMatches: a DATA position nested inside a real remote/login command still goes opaque", () => {
  // The recursive scan into ssh's remote command / su's -c argument must
  // still apply the same allowlist to what THAT command runs -- otherwise
  // making the outer wrapper visible would newly refuse an innocent commit
  // whose message happens to name this rule.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('ssh host \'git commit -m "git push --force"\'', forcePush), null);
  assert.equal(someSegmentMatches('su -c \'git commit -m "git push --force"\'', forcePush), null);
});

test("someSegmentMatches: printf/echo text stays opaque (unchanged from T8)", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('printf \'%s\' "we should never git push --force"', forcePush), null);
  assert.equal(someSegmentMatches("echo 'git push --force is not allowed here'", forcePush), null);
});

test("someSegmentMatches: a grep-family PATTERN argument stays opaque", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('grep -n "git push --force" README.md', forcePush), null);
  assert.equal(someSegmentMatches('rg "git push --force" src', forcePush), null);
  assert.equal(someSegmentMatches('grep -e "git push --force" README.md', forcePush), null);
  // The FILE argument of grep is not a data position, and (odd/tasks/
  // release-0.5.1.md JEVADV-36) is no longer command position either: it is
  // a mention, so it now asks instead of denying.
  assert.equal(someSegmentMatches('grep -rn "restore" "git push --force src"', forcePush), "ask");
});

test("someSegmentMatches: a data position is still recognised behind a leading subshell paren", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('(git commit -m "git push --force")', forcePush), null);
});

test("someSegmentMatches: ripgrep's own -t/-g/etc. value flags do not swallow the real pattern", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('rg -t ts "git push --force" src', forcePush), null);
});

test("someSegmentMatches: an unrecognised program's quoted argument now ASKS instead of denying -- JEVADV-36", () => {
  // Before this task, the allowlist inversion alone left an unknown program
  // no benefit of the doubt and denied outright. That hard-denied a mention
  // sitting in an argument nobody was ever going to run -- e.g. `git grep
  // "git reset --hard"`, `sed -i 's/git reset --hard//' f` -- so it now
  // resolves to the mention-only 'ask' tier: a person decides, instead of
  // the model being refused outright.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('some-unknown-tool "please never git push --force"', forcePush), "ask");
});

test("someSegmentMatches: sed's own script argument is a mention, not a run -- asks, JEVADV-36", () => {
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches("sed -i 's/git reset --hard//' f", resetClean), "ask");
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-36, item 1's second half: new known DATA
// positions -- `git grep`'s pattern, `git log -S`/`-G`/`--grep`'s value, and
// a generic set of text flags (--body/--title/--message/--description/
// --comment/--text/--subject/--summary/--note, including their `=value`
// forms) for ANY program, not just gh's own. `-m` stays scoped to where it
// was already allowlisted (git commit/tag/notes, gh) -- it is far too
// overloaded a flag letter to safely generalise.
//
// SPEC NOTE: this makes `git grep "git reset --hard"` and `git log -S
// "git reset --hard"` resolve to ALLOW-or-Jev (no local-rule match at all),
// not to the 'ask' tier -- see this task's own report for why: making them
// a known data position and also asking about them is not a coherent
// combination (a known-safe position is, by definition, never visible to
// the pattern at all), and a bare top-level `grep`'s pattern already
// resolved the same way before this task (see the "grep-family PATTERN
// argument stays opaque" test above) -- treating `git grep` differently
// from `grep` would have been the inconsistency.
// ---------------------------------------------------------------------------

test("someSegmentMatches: git grep's pattern is a known data position -- no match at all, not even ask", () => {
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('git grep "git reset --hard"', resetClean), null);
});

test("someSegmentMatches: git log -S/-G/--grep's value is a known data position", () => {
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('git log -S "git reset --hard"', resetClean), null);
  assert.equal(someSegmentMatches('git log -G "git reset --hard"', resetClean), null);
  assert.equal(someSegmentMatches('git log --grep "git reset --hard"', resetClean), null);
});

test("someSegmentMatches: a generic text flag on ANY program is a known data position, space-separated or =value", () => {
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('orca plane create --body "plan: run git reset --hard origin/main next"', resetClean), null);
  assert.equal(someSegmentMatches('orca plane create --body="plan: run git reset --hard origin/main next"', resetClean), null);
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('gh issue create --title "avoid a force push"', forcePush), null);
  for (const flag of ["--description", "--comment", "--text", "--subject", "--summary", "--note"]) {
    assert.equal(
      someSegmentMatches(`some-tool ${flag} "reminder: never git reset --hard here"`, resetClean),
      null,
      `expected ${flag} to be a known data position`,
    );
  }
});

test("someSegmentMatches: -m stays scoped to where it was already allowlisted -- not generalised to every program", () => {
  // some-tool's -m is NOT one of git commit/tag/notes' or gh's own message
  // flags, so it must stay visible (and therefore a mention, not silence).
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('some-tool -m "reminder: never git reset --hard here"', resetClean), "ask");
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md JEVADV-36, item 2: a wrapper name (`ssh`,
// `watch`, `su`, `script`, a shell, `eval`) must be recognised only at a
// segment's COMMAND position (the resolved program, following wrappers like
// `sudo`/`env`) -- never as an arbitrary LATER token, e.g. a plain word
// inside some other program's own argument.
// ---------------------------------------------------------------------------

test("someSegmentMatches: a wrapper NAME appearing only as another program's own argument is not treated as that wrapper", () => {
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  // "watch" here is grep's own (unquoted) search pattern argument, not a
  // command -- it must not make grep's FOLLOWING argument (the actual
  // destructive-looking text) look like watch's own command line. It is
  // still a visible mention of the phrase, though, so this asks rather than
  // silently allowing.
  assert.equal(someSegmentMatches('grep -n watch "…git reset --hard…" f', resetClean), "ask");
});

test("someSegmentMatches: a shell reached through an exec-ing program still runs, so it still denies", () => {
  // Review finding R3-wrapper-only-at-resolved-program: find -exec, xargs and
  // a `--` hand-off run the program after them, exactly like a wrapper.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('find . -exec sh -c "git push --force" \\;', forcePush), "deny");
  assert.equal(someSegmentMatches('find . -name x -execdir bash -c "git push -f origin main" {} +', forcePush), "deny");
  assert.equal(someSegmentMatches('xargs sh -c "git push -f origin main"', forcePush), "deny");
  assert.equal(someSegmentMatches('docker exec web -- sh -c "git push --force"', forcePush), "deny");
  assert.equal(someSegmentMatches("kubectl exec pod -- git push --force", forcePush), "deny");
  // A `--` that hands over arguments, not a program, changes nothing.
  assert.equal(someSegmentMatches('npm test -- --grep "git push --force"', forcePush), "ask");
});

// ---------------------------------------------------------------------------
// JEVADV-37 item 3 (odd/tasks/release-0.5.1.md): a real `sh -c`/`bash -c`/
// `zsh -c`/`dash -c`/`ksh -c` pair still runs its script whichever program
// precedes it, not only a modelled wrapper (WRAPPERS) or a known hand-off
// (execHandOffIndex's `find -exec`/`--`). `parallel`, `flock` and `chroot`
// are not modelled anywhere in this file, so before this fix the shell pair
// they precede was read as a plain, visible argument -- a mention, not a run.
// ---------------------------------------------------------------------------

test("someSegmentMatches: a shell -c pair behind an unmodelled exec-ing program still runs, so it still denies", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('parallel sh -c "git push --force"', forcePush), "deny");
  assert.equal(someSegmentMatches('flock /tmp/l sh -c "git reset --hard"', resetClean), "deny");
  // `nice`/`ionice` are already-modelled WRAPPERS, so a shell behind BOTH of
  // them together was already denying before this fix (resolveProgram's own
  // forward search already jumps past an unrecognised token like `ionice`'s
  // own numeric flag value to find the shell) -- kept here as a regression
  // guard, not a new case this fix introduces.
  assert.equal(someSegmentMatches('nice -n 5 ionice sh -c "git push --force"', forcePush), "deny");
  // A completely unmodelled wrapper, same shape.
  assert.equal(someSegmentMatches('chroot / sh -c "git push --force"', forcePush), "deny");
});

test("someSegmentMatches: ssh/watch/su/script stay limited to command position or a known hand-off -- the new shell-anywhere case never widens THEM", () => {
  // Review-3 R3: a bare, later mention of one of these names inside some
  // OTHER program's own argument must stay a mention, not a run -- the new
  // fallback only ever recognises a REAL shell name (sh/bash/zsh/dash/ksh)
  // immediately followed by a `-c`-style flag, never ssh/watch/su/script.
  const resetClean = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;
  assert.equal(someSegmentMatches('grep -n watch "…git reset --hard…" f', resetClean), "ask");
});
