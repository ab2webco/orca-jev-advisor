// Unit tests for the delivery classes a Bash line belongs to -- pure input to
// pure output, no filesystem. Run with:
//   node --test --experimental-strip-types src/core/delivery_class.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { deliveryClassesOf } from "./delivery_class.ts";
import type { ImplicitPushDestination } from "./push_remote.ts";

const onBranch = (name: string) => (): ImplicitPushDestination => ({ kind: "branch", name });

test("a merge with its plumbing: a leading cd, the merge flags and a trailing fetch", () => {
  assert.deepEqual(deliveryClassesOf("cd /p && gh pr merge 45 --squash --delete-branch --author-email a@b && git fetch -q origin"), ["pr-merge"]);
});

test("a PR named by URL qualifies only when the caller confirms the URL is in this repository", () => {
  const sameRepo = { prUrlInRepository: (url: string) => url.startsWith("https://github.com/o/r/") };
  assert.equal(deliveryClassesOf("gh pr merge https://github.com/o/r/pull/7 --squash"), null, "no predicate: a URL fails closed");
  assert.deepEqual(deliveryClassesOf("gh pr merge https://github.com/o/r/pull/7 --rebase --auto", sameRepo), ["pr-merge"]);
  assert.equal(deliveryClassesOf("gh pr merge https://github.com/o/other/pull/7 --squash", sameRepo), null);
  assert.equal(deliveryClassesOf("gh pr comment https://github.com/o/other/pull/7 --body ok", sameRepo), null);
  assert.deepEqual(deliveryClassesOf("gh pr review https://github.com/o/r/pull/7 --approve", sameRepo), ["pr-update"]);
});

test("a merge by number or branch, with the other merge methods and value flags", () => {
  assert.deepEqual(deliveryClassesOf('gh pr merge feat/x --merge --subject "Release 1.2" --body "notes here"'), ["pr-merge"]);
  assert.deepEqual(deliveryClassesOf("gh pr merge 45 -s -d"), ["pr-merge"]);
});

test("a feature-branch push piped into an output filter", () => {
  assert.deepEqual(deliveryClassesOf("git push -u origin feat/x 2>&1 | tail -3"), ["push-branch"]);
});

test("a push of HEAD to a named feature branch", () => {
  assert.deepEqual(deliveryClassesOf("git push origin HEAD:feat/x"), ["push-branch"]);
});

test("a push whose destination is implicit follows the resolver, and is null without one", () => {
  assert.equal(deliveryClassesOf("git push -u origin HEAD"), null);
  assert.equal(deliveryClassesOf("git push origin"), null);
  assert.deepEqual(deliveryClassesOf("git push -u origin HEAD", { implicitPushDestination: onBranch("feat/x") }), ["push-branch"]);
  assert.equal(deliveryClassesOf("git push -u origin HEAD", { implicitPushDestination: onBranch("main") }), null);
  assert.equal(deliveryClassesOf("git push origin", { implicitPushDestination: () => ({ kind: "matching" }) }), null);
  assert.equal(deliveryClassesOf("git push origin", { implicitPushDestination: () => ({ kind: "unknown" }) }), null);
});

test("the resolver is told the leading cd directory", () => {
  const seen: (string | null)[] = [];
  deliveryClassesOf("cd ../wt && git push origin HEAD", {
    implicitPushDestination: (dir) => {
      seen.push(dir);
      return { kind: "branch", name: "feat/y" };
    },
  });
  assert.deepEqual(seen, ["../wt"]);
});

test("a release, a PR creation and PR updates", () => {
  assert.deepEqual(deliveryClassesOf("gh release create v1.2.3 --target 9735378 --notes x"), ["release-create"]);
  assert.deepEqual(deliveryClassesOf('gh pr create --title "feat: x" --body "why"'), ["pr-create"]);
  assert.deepEqual(deliveryClassesOf("gh pr edit 45 --add-label qa"), ["pr-update"]);
  assert.deepEqual(deliveryClassesOf('gh pr comment 45 --body "done"'), ["pr-update"]);
  assert.deepEqual(deliveryClassesOf("gh pr review 45 --approve"), ["pr-update"]);
  assert.deepEqual(deliveryClassesOf("gh pr ready 45"), ["pr-update"]);
});

test("several classes on one line are returned once each", () => {
  assert.deepEqual(deliveryClassesOf("git push -u origin feat/x && gh pr create --fill && gh pr merge --squash && gh pr merge 2 --squash"), ["push-branch", "pr-create", "pr-merge"]);
});

const NEVER: readonly string[] = [
  "gh pr merge 45 --admin --squash",
  "gh pr merge 45 --squash --repo other/repo",
  "gh pr merge 45 -R other/repo",
  "gh pr create --repo other/repo --fill",
  "gh release create v1 --repo=other/repo",
  "git push --delete origin feat/x",
  "git push -d origin feat/x",
  "git push origin :feat/x",
  "git push origin +feat/x",
  "git push origin +HEAD:feat/x",
  "git push --force origin feat/x",
  "git push -f origin feat/x",
  "git push -uf origin feat/x",
  "git push --force-with-lease origin feat/x",
  "git push --mirror origin",
  "git push --all origin",
  "git push --tags origin",
  "git push origin main",
  "git push origin master",
  "git push origin production",
  "git push origin HEAD:main",
  "git push origin feat/x:refs/heads/main",
  "git push upstream feat/x",
  "git push https://github.com/o/r feat/x",
  "git branch -D x",
  "rm -rf x",
  "ssh host",
  "cat > f <<EOF\nhello\nEOF",
  "gh pr merge 45 --squash && rm -rf dist",
  "rm -rf dist; git push origin feat/x",
  "gh pr merge 45 --squash || git push origin feat/x",
  "gh pr merge 45 --squash &",
  "gh pr merge $(gh pr list -q .[0].number) --squash",
  "git push origin feat/x > out.txt",
  "git status",
  "gh pr view 45",
  "gh pr close 45",
  "gh api repos/o/r/pulls/45/merge -X PUT",
  "git push origin feat/x | sh",
  "git fetch origin && cd /tmp && gh pr merge 1",
];

for (const command of NEVER) {
  test(`never a delivery line: ${JSON.stringify(command)}`, () => {
    assert.equal(deliveryClassesOf(command, { implicitPushDestination: onBranch("feat/x") }), null);
  });
}

// ---------------------------------------------------------------------------
// T1b: widened on 489 real delivery lines -- a quoted-heredoc body as an
// argument, read-only gh, local git that destroys nothing, output filters.
// ---------------------------------------------------------------------------

const PR_BODY = "gh pr create --title \"feat: x\" --body \"$(cat <<'EOF'\n## Summary\n\nDo not run rm -rf / here; git push --force origin main && echo $(whoami) | sh\n\nEOF\n)\"";

test("T1b: a quoted-delimiter heredoc substitution is literal text: the classes come from the outer command only", () => {
  assert.deepEqual(deliveryClassesOf(PR_BODY), ["pr-create"]);
  assert.deepEqual(deliveryClassesOf(PR_BODY.replace("<<'EOF'", '<<"EOF"')), ["pr-create"]);
  assert.deepEqual(deliveryClassesOf("gh pr comment 45 --body \"$(cat <<'EOF'\nfixed; see a | b\nEOF\n)\" && gh pr view 45 --json state"), ["pr-update"]);
  assert.deepEqual(deliveryClassesOf("git add -A && git commit -q -m \"$(cat <<'EOF'\nfeat: x\n\nbody\nEOF\n)\" && git push -u origin feat/x 2>&1 | tail -2"), ["push-branch"]);
});

test("T1b: an unquoted heredoc, any other substitution or backticks stay null", () => {
  assert.equal(deliveryClassesOf(PR_BODY.replace("<<'EOF'", "<<EOF")), null);
  assert.equal(deliveryClassesOf('gh pr create --title x --body "$(cat notes.md)"'), null);
  assert.equal(deliveryClassesOf("gh pr create --title x --body `cat notes.md`"), null);
  assert.equal(deliveryClassesOf("gh pr merge 45 --squash && echo \"$(git rev-parse HEAD)\""), null);
  assert.equal(deliveryClassesOf("\"$(cat <<'EOF'\nrm -rf /\nEOF\n)\" && gh pr merge 45"), null, "the heredoc text is never a command");
  assert.equal(deliveryClassesOf("gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n)\" | sh"), null);
  assert.equal(deliveryClassesOf("gh pr merge -m \"$(cat <<'EOF'\nhttps://github.com/o/other/pull/1\nEOF\n)\""), null, "-m is a switch for gh pr merge: the text would name the PR");
  assert.equal(deliveryClassesOf("git push origin \"$(cat <<'EOF'\nmain\nEOF\n)\""), null, "the text never names a branch");
});

test("T1b: read-only gh segments sit next to a delivery", () => {
  assert.deepEqual(deliveryClassesOf("gh pr merge 832 --squash 2>&1 | tail -3; gh pr view 832 --json state,mergedAt --jq '.state'"), ["pr-merge"]);
  assert.deepEqual(deliveryClassesOf("gh pr checks 5 && gh pr merge 5 --squash && gh run list --limit 3 && gh run watch 9 && gh release view v1 && gh repo view && gh pr diff 5 && gh pr status && gh release list && gh run view 9"), ["pr-merge"]);
});

test("T1b: local git that destroys nothing sits next to a delivery", () => {
  const ok = [
    "git add src/a.ts docs && git commit -m x && git push origin feat/x",
    "git add -A && git commit -qam x && git push origin feat/x",
    "git commit --amend --no-edit && git push origin feat/x",
    "git switch -c feat/x && git push -u origin feat/x",
    "git switch feat/x && git push origin feat/x",
    "git checkout -q -b feat/x && git push -u origin feat/x",
    "git pull -q --ff-only && git push origin feat/x",
    "git stash push -q -m 'generated files' -- apps/web/CLAUDE.md && git push origin feat/x",
    "git stash && git push origin feat/x",
    "git tag v1.2.3 && git push origin v1.2.3",
    "git tag -a v1.2.3 -m 'release' && gh release create v1.2.3 --notes x",
    "git fetch -q origin && git checkout -q -b feat/y origin/main && git push -u origin feat/y",
  ];
  for (const command of ok) assert.notEqual(deliveryClassesOf(command), null, command);
});

test("T1b: checking out an existing name qualifies only when the caller confirms it is a local branch", () => {
  const command = "git checkout -q feat/x && git push origin feat/x";
  assert.equal(deliveryClassesOf(command), null, "without the check, the name may be a path whose changes it would discard");
  assert.deepEqual(deliveryClassesOf(command, { isLocalBranch: (name) => name === "feat/x" }), ["push-branch"]);
  assert.equal(deliveryClassesOf("git checkout src && git push origin feat/x", { isLocalBranch: () => false }), null);
});

test("T1b: output filters between segments", () => {
  for (const filter of ["tail -3", "head -5", "grep -v x", "sed -n 1p", "grep -v \"^remote:\""]) {
    assert.deepEqual(deliveryClassesOf(`gh pr merge 1 --squash 2>&1 | ${filter}; gh pr view 1 && git fetch -q origin`), ["pr-merge"], filter);
  }
  assert.equal(deliveryClassesOf("gh pr merge 1 --squash 2>&1 | sed -i s/a/b/ f"), null);
  assert.equal(deliveryClassesOf("gh pr merge 1 --squash; sed -i s/a/b/ f"), null);
});

const NEVER_T1B: readonly string[] = [
  "gh pr view 5 --repo other/r && gh pr merge 5",
  "gh pr view 5 -R other/r; gh pr merge 5",
  "gh pr view 5 --web && gh pr merge 5",
  "gh run rerun 9 && gh pr merge 5",
  "gh run cancel 9 && gh pr merge 5",
  "gh api repos/o/r/pulls/5 && gh pr merge 5",
  "gh api -X DELETE repos/o/r/git/refs/heads/x && gh pr merge 5",
  "git checkout -- file && git push origin feat/x",
  "git checkout . && git push origin feat/x",
  "git checkout -f feat/x && git push origin feat/x",
  "git checkout -B feat/x && git push origin feat/x",
  "git switch -f feat/x && git push origin feat/x",
  "git switch --discard-changes feat/x && git push origin feat/x",
  "git stash drop && git push origin feat/x",
  "git stash clear && git push origin feat/x",
  "git stash pop && git push origin feat/x",
  "git tag -d v1 && git push origin feat/x",
  "git tag -f v1 && git push origin feat/x",
  "git add -f secret && git push origin feat/x",
  "git add --force secret && git push origin feat/x",
  "git commit --no-verify -m x && git push origin feat/x",
  "git pull && git push origin feat/x",
  "git pull --rebase && git push origin feat/x",
  "git worktree remove ../wt && git push origin feat/x",
  "git branch -D x && git push origin feat/x",
  "git reset --hard && git push origin feat/x",
  "git clean -fd && git push origin feat/x",
  "SKIP_PREFLIGHT=1 git push origin feat/x",
  "git push 2>&1 | tail -2",
  "git push -u origin feat/x > out.txt",
  "N=1 && gh pr merge 5",
  "for p in 1 2; do gh pr merge $p; done",
  "git push --force-with-lease origin feat/x",
];

for (const command of NEVER_T1B) {
  test(`T1b: never a delivery line: ${JSON.stringify(command)}`, () => {
    assert.equal(deliveryClassesOf(command, { implicitPushDestination: onBranch("feat/x"), isLocalBranch: () => true }), null);
  });
}

test("T1b: a newline between commands joins them like `;`, each line still checked", () => {
  assert.deepEqual(deliveryClassesOf("git add -A && git commit -qm x\ngit push -q origin feat/x 2>&1 | tail -1\ngh pr create --fill"), ["push-branch", "pr-create"]);
  assert.deepEqual(deliveryClassesOf("gh pr merge 5 --squash &&\n  git fetch -q origin"), ["pr-merge"]);
  assert.equal(deliveryClassesOf("gh pr merge 5 --squash\nrm -rf dist"), null);
  assert.equal(deliveryClassesOf("gh pr merge 5 --squash &\ngit fetch"), null);
  assert.equal(deliveryClassesOf("cat > f <<'EOF'\ngh pr merge 5\nEOF\ngh pr merge 5"), null);
});
