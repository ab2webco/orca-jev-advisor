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
  assert.equal(someSegmentMatches("git push origin --delete x && git branch -f main origin/main", pattern), false);
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
  assert.equal(someSegmentMatches("git push $(echo --force) origin", pattern), true);
  assert.equal(someSegmentMatches("git push `echo -f` origin", pattern), true);
});

test("someSegmentMatches: true when a segment matches", () => {
  const pattern = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git status && git push --force origin main", pattern), true);
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
  assert.equal(someSegmentMatches('gh pr comment 1 --body "we avoided git push --force"', forcePush), false);
  assert.equal(someSegmentMatches('git commit -m "build && test git push --force later"', forcePush), false);
});

test("someSegmentMatches: a quoted PROTECTED BRANCH sentence is not a match either", () => {
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  assert.equal(someSegmentMatches('gh pr comment 1 --body "please do not push straight to main"', pushProtected), false);
});

test("someSegmentMatches: a single quoted WORD still matches -- it is one word, never a sentence", () => {
  // `git push origin "main"` is still a push to main: quoting a bare branch
  // name or flag is ordinary shell usage, not descriptive text, and no
  // `\s`-spanning pattern can ever be spelled with one word alone.
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('git push origin "main"', pushProtected), true);
  assert.equal(someSegmentMatches('git push origin "-f"', forcePush), true);
});

test("someSegmentMatches: the script argument of bash -c / sh -c / eval still matches, quoted or not", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('bash -c "git push --force"', forcePush), true);
  assert.equal(someSegmentMatches('sh -c "git push --force origin main"', forcePush), true);
  assert.equal(someSegmentMatches('eval "git push --force"', forcePush), true);
  // Wrapping in a subshell must not defeat the -c/eval recognition.
  assert.equal(someSegmentMatches("(bash -c 'git push --force')", forcePush), true);
});

test("cannotScanWithConfidence: an unbalanced quote fails CLOSED onto the raw segment text", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(cannotScanWithConfidence('git commit -m "git push --force'), true);
  // Today's (quote-blind) behaviour: the raw text still matches.
  assert.equal(someSegmentMatches('git commit -m "git push --force', forcePush), true);
  assert.equal(cannotScanWithConfidence("git push --force origin main"), false);
});

test("someSegmentMatches: a DOUBLE-QUOTED substitution still runs, so it stays visible", () => {
  // Review finding R3: splicing the scanned body back in BEFORE tokenizing
  // left it inside the surrounding quotes, where the data placeholder
  // swallowed it -- a deny-tier bypass the old raw match never had.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  const pushProtected = /git\s+push\b.*\b(main|master|develop)\b/;
  assert.equal(someSegmentMatches('git push origin "$(echo --force)"', forcePush), true);
  assert.equal(someSegmentMatches('echo "$(git push --force origin main)"', forcePush), true);
  assert.equal(someSegmentMatches('echo "`git push --force origin main`"', forcePush), true);
  assert.equal(someSegmentMatches('echo "now: $(git push --force origin main) done"', forcePush), true);
  assert.equal(someSegmentMatches('git push origin "$(printf main)"', pushProtected), true);
  assert.equal(someSegmentMatches('bash -c "echo \\"$(git push --force)\\""', forcePush), true);
  // The sentence around a substitution is still data; only the body is a run.
  assert.equal(someSegmentMatches('gh pr comment 1 --body "we avoided git push --force on $(date)"', forcePush), false);
});

test("someSegmentMatches: substitution and redirection tests above still hold with the new sanitizer", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches("git push $(echo x; echo --force) origin", forcePush), true);
  assert.equal(someSegmentMatches("git push 2>&1 --force origin", forcePush), true);
});

// ---------------------------------------------------------------------------
// odd/tasks/release-0.5.1.md T10 (JEVADV-28): opacity is now an ALLOWLIST of
// known DATA positions, not every quoted multi-word argument. A command run
// by ANOTHER program -- a remote shell, a login shell, an interpreter -- must
// stay exactly as visible as it was in 0.5.0; only the specific arguments
// listed in git_discard.ts's module note (printf/echo text, git's own commit
// message flags, gh's text flags, a grep-family PATTERN, jq's filter) go
// opaque. Review findings R1-001/R3-wrapper-remote-command-opaque/
// R4-quoted-remote-command-opaque.
// ---------------------------------------------------------------------------

test("someSegmentMatches: a quoted command run by another program stays visible, not opaque", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  const pushProtected = /git\s+push\b.*\b(main|master|production)\b/;
  assert.equal(someSegmentMatches('ssh host "git push --force origin main"', forcePush), true);
  assert.equal(someSegmentMatches('ssh host "git push origin main"', pushProtected), true);
  assert.equal(someSegmentMatches('su -c "git push -f origin main"', forcePush), true);
  assert.equal(someSegmentMatches(`python3 -c "import os; os.system('git push --force origin main')"`, forcePush), true);
  assert.equal(someSegmentMatches('watch "git push -f"', forcePush), true);
  assert.equal(someSegmentMatches('script -c "git push -f"', forcePush), true);
  assert.equal(someSegmentMatches(`node -e "require('child_process').execSync('git push --force origin main')"`, forcePush), true);
});

test("someSegmentMatches: a DATA position nested inside a real remote/login command still goes opaque", () => {
  // The recursive scan into ssh's remote command / su's -c argument must
  // still apply the same allowlist to what THAT command runs -- otherwise
  // making the outer wrapper visible would newly refuse an innocent commit
  // whose message happens to name this rule.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('ssh host \'git commit -m "git push --force"\'', forcePush), false);
  assert.equal(someSegmentMatches('su -c \'git commit -m "git push --force"\'', forcePush), false);
});

test("someSegmentMatches: printf/echo text stays opaque (unchanged from T8)", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('printf \'%s\' "we should never git push --force"', forcePush), false);
  assert.equal(someSegmentMatches("echo 'git push --force is not allowed here'", forcePush), false);
});

test("someSegmentMatches: a grep-family PATTERN argument stays opaque", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('grep -n "git push --force" README.md', forcePush), false);
  assert.equal(someSegmentMatches('rg "git push --force" src', forcePush), false);
  assert.equal(someSegmentMatches('grep -e "git push --force" README.md', forcePush), false);
  // The FILE argument of grep is not a data position, but it is never
  // quoted-multiword in practice, so this never matters in the other
  // direction; a grep MENTION with no match still stands.
  assert.equal(someSegmentMatches('grep -rn "restore" "git push --force src"', forcePush), true);
});

test("someSegmentMatches: a data position is still recognised behind a leading subshell paren", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('(git commit -m "git push --force")', forcePush), false);
});

test("someSegmentMatches: ripgrep's own -t/-g/etc. value flags do not swallow the real pattern", () => {
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('rg -t ts "git push --force" src', forcePush), false);
});

test("someSegmentMatches: an unrecognised program's quoted argument fails CLOSED (visible), matching 0.5.0", () => {
  // The whole point of the allowlist inversion: an unknown program gets NO
  // benefit of the doubt, exactly like 0.5.0.
  const forcePush = /git\s+push\b.*(--force|-f)\b/;
  assert.equal(someSegmentMatches('some-unknown-tool "please never git push --force"', forcePush), true);
});
