// 0.6.8 T2: whether a command stays inside the team, decided from facts.
//
// A `requires_human` policy ("anything that touches a client's product gets
// confirmed with a human") used to be judged by Jev from the sentence alone,
// and Jev also asked about pushing a work branch or opening a pull request in
// the team's own repository. classifyClientReach reads each segment against
// facts the adapter passes in -- the team owners, the cwd repository's
// remotes, its current branch -- and calls a segment `internal` only for the
// short list of shapes that provably never leave the team. Everything else
// is `unknown`, and an `unknown` segment changes nothing: the policy is asked
// exactly as before.
//
// Pure: every case here is text plus facts, no repository and no network.
//
// Run with: node --test --experimental-strip-types src/core/client_reach.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { classifyClientReach, remoteOwner } from "./client_reach.ts";
import type { ClientReachFacts } from "./client_reach.ts";

const TEAM: ClientReachFacts = {
  teamOwners: ["acme-team"],
  remotes: [{ name: "origin", url: "git@github.com:acme-team/app.git", pushUrl: null }],
  currentBranch: "feature/x",
};

/** A fork workflow: the team's fork is `origin`, the client's repository is `upstream`. */
const FORK: ClientReachFacts = {
  ...TEAM,
  remotes: [...TEAM.remotes, { name: "upstream", url: "https://github.com/acme-client/app.git", pushUrl: null }],
};

const CLIENT_ORIGIN: ClientReachFacts = {
  ...TEAM,
  remotes: [{ name: "origin", url: "https://github.com/acme-client/app.git", pushUrl: null }],
};

function inside(command: string, facts: ClientReachFacts = TEAM): boolean {
  return classifyClientReach(command, facts).staysInsideTeam;
}

// Dangerous words are built from parts, as elsewhere in this repository's
// tests, so a search for them finds the rules rather than the fixtures.
const FORCE = ["--", "force"].join("");
const MERGE = ["mer", "ge"].join("");

// ---------------------------------------------------------------------------
// remoteOwner
// ---------------------------------------------------------------------------

test("remoteOwner reads the owner from https, ssh and scp-like remotes, case-insensitively", () => {
  assert.equal(remoteOwner("https://github.com/acme-team/app.git"), "acme-team");
  assert.equal(remoteOwner("https://github.com/Acme-Team/app"), "acme-team");
  assert.equal(remoteOwner("https://user@github.com/acme-team/app.git"), "acme-team");
  assert.equal(remoteOwner("ssh://git@github.com:22/acme-team/app.git"), "acme-team");
  assert.equal(remoteOwner("git@github.com:Acme-Team/app.git"), "acme-team");
  assert.equal(remoteOwner("github.com:acme-team/app.git"), "acme-team");
  assert.equal(remoteOwner("https://gitlab.com/acme-team/group/app.git"), "acme-team");
});

test("remoteOwner answers null for anything that is not a hosted owner/repository", () => {
  assert.equal(remoteOwner("file:///srv/git/app.git"), null);
  assert.equal(remoteOwner("/srv/git/app.git"), null);
  assert.equal(remoteOwner("../app.git"), null);
  assert.equal(remoteOwner("C:/repos/app.git"), null);
  assert.equal(remoteOwner("https://github.com/acme-team"), null);
  assert.equal(remoteOwner(""), null);
});

// ---------------------------------------------------------------------------
// Owners, and the empty default
// ---------------------------------------------------------------------------

test("with no team owners nothing stays inside the team -- every decision is as before", () => {
  assert.equal(inside("git push -u origin feature/x", { ...TEAM, teamOwners: [] }), false);
});

test("an empty command is never inside the team", () => {
  assert.equal(inside("   "), false);
});

// ---------------------------------------------------------------------------
// Tier-1a-safe segments and local git
// ---------------------------------------------------------------------------

test("segments tier 1a already calls safe are internal", () => {
  assert.equal(inside("git status"), true);
  assert.equal(inside("ls -la && git log --oneline -3"), true);
});

test("local git that never touches a remote is internal", () => {
  for (const command of [
    "git add -A",
    'git commit -m "feat: add the thing"',
    "git switch -c feature/y",
    "git switch feature/y",
    "git checkout -b feature/y",
    "git checkout feature/y",
    "git branch feature/y",
    "git stash",
    "git stash push -m wip",
    "git restore --staged src/app.ts",
  ]) {
    assert.equal(inside(command), true, command);
  }
});

test("local git that discards work, rewrites history or touches a remote stays unknown", () => {
  for (const command of [
    "git checkout -- src/app.ts",
    "git checkout .",
    "git checkout -f feature/y",
    "git restore src/app.ts",
    "git branch -D feature/y",
    "git branch -m feature/z",
    "git stash drop",
    "git stash pop",
    "git reset --hard HEAD~1",
    `git ${MERGE} feature/y`,
    "git rebase main",
    "git fetch origin",
    "git pull",
    "git switch --discard-changes feature/y",
    "git -C ../other commit -m x",
    "git tag v1",
  ]) {
    assert.equal(inside(command), false, command);
  }
});

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

test("pushing a work branch to a team-owned remote is internal", () => {
  assert.equal(inside("git push -u origin feature/x"), true);
  assert.equal(inside("git push origin feature/y"), true);
  assert.equal(inside("git push origin HEAD"), true);
  assert.equal(inside("git push"), true);
  assert.equal(inside("git push -u origin feature/x 2>&1 | tail -3"), true);
  assert.equal(inside("git push https://github.com/acme-team/app.git feature/x"), true);
});

test("a push to a protected or shared branch is never internal", () => {
  assert.equal(inside("git push origin main"), false);
  assert.equal(inside("git push origin master"), false);
  assert.equal(inside("git push origin production"), false);
  assert.equal(inside("git push origin develop"), false);
  assert.equal(inside("git push origin Main"), false);
  assert.equal(inside("git push", { ...TEAM, currentBranch: "main" }), false);
  assert.equal(inside("git push origin HEAD", { ...TEAM, currentBranch: "main" }), false);
});

test("a force push, a delete or a src:dst refspec is never internal", () => {
  assert.equal(inside(`git push ${FORCE} origin feature/x`), false);
  assert.equal(inside("git push -f origin feature/x"), false);
  assert.equal(inside(`git push ${FORCE}-with-lease origin feature/x`), false);
  assert.equal(inside("git push origin +feature/x"), false);
  assert.equal(inside("git push --delete origin feature/x"), false);
  assert.equal(inside("git push origin :feature/x"), false);
  assert.equal(inside("git push origin feature/x:main"), false);
  assert.equal(inside("git push --tags origin"), false);
});

test("a push to a remote whose owner is not a team owner is never internal", () => {
  assert.equal(inside("git push -u origin feature/x", CLIENT_ORIGIN), false);
  assert.equal(inside("git push upstream feature/x", FORK), false);
  assert.equal(inside("git push https://github.com/acme-client/app.git feature/x"), false);
  assert.equal(inside("git push somewhere feature/x"), false);
});

test("a bare push is internal only when every remote is the team's -- git may pick any of them", () => {
  assert.equal(inside("git push", FORK), false);
  assert.equal(inside("git push origin feature/x", FORK), true);
});

test("the push URL decides, not the fetch URL", () => {
  const facts: ClientReachFacts = { ...TEAM, remotes: [{ name: "origin", url: "git@github.com:acme-team/app.git", pushUrl: "git@github.com:acme-client/app.git" }] };
  assert.equal(inside("git push origin feature/x", facts), false);
});

test("a push resolving the current branch needs one: a detached HEAD stays unknown", () => {
  assert.equal(inside("git push", { ...TEAM, currentBranch: null }), false);
});

// ---------------------------------------------------------------------------
// gh pr
// ---------------------------------------------------------------------------

test("gh pr create, comment and edit in a team-owned repository are internal", () => {
  assert.equal(inside('gh pr create --title "feat: x" --body "Adds x."'), true);
  assert.equal(inside('gh pr comment 12 --body "Fixed in the last commit."'), true);
  assert.equal(inside("gh pr edit 12 --add-label ready"), true);
  assert.equal(inside("gh pr diff 12"), true);
});

test("gh pr create with the usual quoted-heredoc body is internal", () => {
  const command = [
    'gh pr create --title "feat: x" --body "$(cat <<\'EOF\'',
    "## Summary",
    "- runs $(rm -rf build) only as text, the delimiter is quoted",
    "EOF",
    ')"',
  ].join("\n");
  assert.equal(inside(command), true);
});

test("a heredoc body with an unquoted delimiter expands, so it stays unknown", () => {
  const command = ['gh pr create --title x --body "$(cat <<EOF', "text $(whoami)", "EOF", ')"'].join("\n");
  assert.equal(inside(command), false);
});

test("any other command substitution stays unknown", () => {
  assert.equal(inside('gh pr create --title x --body "$(git log -1 --format=%B)"'), false);
  assert.equal(inside("git push origin `git branch --show-current`"), false);
});

test("text after a heredoc's closing delimiter is still judged", () => {
  const command = ['gh pr create --title x --body "$(cat <<\'EOF\'', "text", "EOF", ')" && rm -rf build'].join("\n");
  assert.equal(inside(command), false);
});

test("merging or closing a pull request is never internal", () => {
  assert.equal(inside(`gh pr ${MERGE} 12 --squash`), false);
  assert.equal(inside("gh pr close 12"), false);
  assert.equal(inside("gh pr review 12 --approve"), false);
});

test("--repo decides the repository when it is given", () => {
  assert.equal(inside("gh pr create --repo acme-client/app --title x --body y"), false);
  assert.equal(inside("gh pr create -R acme-client/app --title x --body y"), false);
  assert.equal(inside("gh pr create --repo acme-team/app --title x --body y", CLIENT_ORIGIN), true);
  assert.equal(inside("gh pr create --repo=github.com/acme-team/app --title x --body y", CLIENT_ORIGIN), true);
});

test("without --repo, gh may pick any remote, so every remote must be the team's", () => {
  assert.equal(inside("gh pr create --title x --body y", CLIENT_ORIGIN), false);
  assert.equal(inside("gh pr create --title x --body y", FORK), false);
});

test("a pull request named by URL is judged by that URL's owner", () => {
  assert.equal(inside("gh pr comment https://github.com/acme-team/app/pull/3 --body done"), true);
  assert.equal(inside("gh pr comment https://github.com/acme-client/app/pull/3 --body done"), false);
});

// ---------------------------------------------------------------------------
// gh api
// ---------------------------------------------------------------------------

test("a graphql call whose only mutations reply to or resolve review threads is internal", () => {
  const reply = "gh api graphql -f query='mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }' -f id=PRRT_1 -f body=done";
  const resolve = "gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"PRRT_1\"}) { thread { isResolved } } }'";
  const aliased = "gh api graphql -f query='mutation { a: resolveReviewThread(input: {threadId: \"1\"}) { thread { id } } b: addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: \"2\", body: \"see mergePullRequest(x) docs # not a comment\"}) { comment { id } } }' --jq .data";
  assert.equal(inside(reply), true);
  assert.equal(inside(resolve), true);
  assert.equal(inside(aliased), true);
});

test("a graphql call with any other mutation, no mutation, or a query from a file stays unknown", () => {
  const mixed = "gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"1\"}) { thread { id } } mergePullRequest(input: {pullRequestId: \"2\"}) { pullRequest { id } } }'";
  const readOnly = "gh api graphql -f query='query { viewer { login } }'";
  const fromFile = "gh api graphql -F query=@mutation.graphql";
  const unknownFlag = "gh api graphql --hostname example.com -f query='mutation { resolveReviewThread(input: {threadId: \"1\"}) { thread { id } } }'";
  for (const command of [mixed, readOnly, fromFile, unknownFlag]) assert.equal(inside(command), false, command);
});

test("a graphql review reply is internal only when every remote is the team's", () => {
  const resolve = "gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"1\"}) { thread { id } } }'";
  assert.equal(inside(resolve, FORK), false);
  assert.equal(inside(resolve, CLIENT_ORIGIN), false);
});

test("REST calls through gh api stay unknown", () => {
  assert.equal(inside("gh api -X PUT repos/acme-client/app/actions/permissions -f enabled=true"), false);
  assert.equal(inside("gh api repos/acme-team/app/pulls/1/comments -f body=x"), false);
});

// ---------------------------------------------------------------------------
// Compound commands
// ---------------------------------------------------------------------------

test("a command stays inside the team only when EVERY segment does", () => {
  assert.equal(inside('git add -A && git commit -m "x" && git push -u origin feature/x && gh pr create --title x --body y'), true);
  assert.equal(inside("git push -u origin feature/x && rm -rf build"), false);
  assert.equal(inside("git push -u origin feature/x; npm publish"), false);
});

test("each segment is reported with its own reach", () => {
  const result = classifyClientReach("git push -u origin feature/x && rm -rf build", TEAM);
  assert.deepEqual(result.segments.map((s) => s.reach), ["internal", "unknown"]);
});

test("after a cd, the cwd's facts no longer describe where the push goes", () => {
  assert.equal(inside("cd ../other && git push origin feature/x"), false);
  assert.equal(inside("cd ../other && gh pr create --title x --body y"), false);
});

test("an unbalanced quote cannot be read with confidence and stays unknown", () => {
  assert.equal(inside('git commit -m "oops && git push origin feature/x'), false);
});

test("a leading environment assignment is not read through", () => {
  assert.equal(inside("GH_REPO=acme-client/app gh pr create --title x --body y"), false);
});

test("a segment that changes the remotes makes the facts stale for every later push or pull request", () => {
  assert.equal(inside("git remote set-url origin https://github.com/acme-client/app.git && git push origin feature/x"), false);
  assert.equal(inside("git remote add other https://github.com/acme-client/app.git && gh pr create --title x --body y"), false);
  assert.equal(inside("git config remote.origin.pushurl https://github.com/acme-client/app.git && git push origin feature/x"), false);
  assert.equal(inside("gh repo set-default acme-client/app && gh pr create --title x --body y"), false);
  assert.equal(inside("git remote -v && git push origin feature/x"), true);
});

test("a branch switch makes the current branch stale, but not an explicit refspec", () => {
  assert.equal(inside("git checkout main && git push"), false);
  assert.equal(inside("git switch main && git push origin HEAD"), false);
  assert.equal(inside("git checkout -b feature/y && git push -u origin feature/y"), true);
});
