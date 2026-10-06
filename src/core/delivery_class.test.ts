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
