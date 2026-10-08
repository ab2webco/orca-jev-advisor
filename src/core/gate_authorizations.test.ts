// Unit tests for the remembered delivery authorizations -- pure input to pure
// output, no filesystem, no clock. Run with:
//   node --test --experimental-strip-types src/core/gate_authorizations.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_TTL_MS,
  authorizationRows,
  EMPTY_AUTHORIZATIONS,
  forgetAuthorization,
  isAuthorized,
  parseAuthorizations,
  pruneExpired,
  recordAuthorization,
  repoIdentity,
  repoSpecIdentity,
  touchAuthorization,
} from "./gate_authorizations.ts";

const REPO = "github.com/acme/widgets";
const T0 = "2026-10-06T10:00:00.000Z";
const T0_MS = Date.parse(T0);
const DAY_MS = 24 * 60 * 60 * 1000;

test("repoIdentity normalizes https, ssh and scp-like URLs of one repository to the same identity", () => {
  const spellings = [
    "https://github.com/acme/widgets.git",
    "https://github.com/Acme/Widgets",
    "https://x-access-token:secret@github.com/acme/widgets.git/",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets",
    "git@github.com:acme/widgets.git",
    "git@github.com:acme/widgets.git\n",
  ];
  for (const url of spellings) assert.equal(repoIdentity(url, "/somewhere"), REPO, url);
});

test("repoIdentity falls back to the repository root without a usable remote, and is null without either", () => {
  assert.equal(repoIdentity(null, "/home/dev/repo"), "path:/home/dev/repo");
  assert.equal(repoIdentity("", "/home/dev/repo"), "path:/home/dev/repo");
  assert.equal(repoIdentity("/srv/git/repo.git", "/home/dev/repo"), "path:/home/dev/repo");
  assert.equal(repoIdentity("file:///srv/git/repo.git", "/home/dev/repo"), "path:/home/dev/repo");
  assert.equal(repoIdentity(null, null), null);
  assert.equal(repoIdentity("", ""), null);
});

test("parseAuthorizations never throws and drops anything malformed", () => {
  for (const raw of [null, undefined, 3, "x", [], {}, { version: 2, repos: {} }, { version: 1, repos: [] }]) {
    assert.deepEqual(parseAuthorizations(raw), EMPTY_AUTHORIZATIONS);
  }
  const parsed = parseAuthorizations({
    version: 1,
    repos: {
      [REPO]: {
        "pr-merge": { firstAt: T0, lastAt: T0, uses: 2 },
        "not-a-class": { firstAt: T0, lastAt: T0, uses: 1 },
        "pr-create": { firstAt: T0, lastAt: 5, uses: 1 },
        "push-branch": { firstAt: T0, lastAt: "not a date", uses: 1 },
      },
      broken: "x",
    },
  });
  assert.deepEqual(parsed, { version: 1, repos: { [REPO]: { "pr-merge": { firstAt: T0, lastAt: T0, uses: 2 } } } });
});

test("a recorded class is authorized for that repository only, and only while every asked class is present", () => {
  const store = recordAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0);
  assert.equal(isAuthorized(store, REPO, ["pr-merge"], T0_MS), true);
  assert.equal(isAuthorized(store, "github.com/other/repo", ["pr-merge"], T0_MS), false);
  assert.equal(isAuthorized(store, REPO, ["pr-merge", "push-branch"], T0_MS), false);
  assert.equal(isAuthorized(store, REPO, [], T0_MS), false, "an empty list authorizes nothing");
  assert.equal(isAuthorized(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0_MS), false);
});

test("recording is pure, and a second record keeps firstAt and counts the use", () => {
  const once = recordAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0);
  const later = "2026-10-07T10:00:00.000Z";
  const twice = recordAuthorization(once, REPO, ["pr-merge", "push-branch"], later);
  assert.deepEqual(EMPTY_AUTHORIZATIONS, { version: 1, repos: {} });
  assert.deepEqual(once.repos[REPO]?.["pr-merge"], { firstAt: T0, lastAt: T0, uses: 1 });
  assert.deepEqual(twice.repos[REPO]?.["pr-merge"], { firstAt: T0, lastAt: later, uses: 2 });
  assert.deepEqual(twice.repos[REPO]?.["push-branch"], { firstAt: later, lastAt: later, uses: 1 });
});

test("an authorization expires 30 days after its last use, and a use refreshes it", () => {
  assert.equal(AUTHORIZATION_TTL_MS, 30 * DAY_MS);
  const store = recordAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0);
  assert.equal(isAuthorized(store, REPO, ["pr-merge"], T0_MS + 30 * DAY_MS - 1), true);
  assert.equal(isAuthorized(store, REPO, ["pr-merge"], T0_MS + 30 * DAY_MS + 1), false);

  const usedAt = new Date(T0_MS + 20 * DAY_MS).toISOString();
  const touched = touchAuthorization(store, REPO, ["pr-merge"], usedAt);
  assert.deepEqual(touched.repos[REPO]?.["pr-merge"], { firstAt: T0, lastAt: usedAt, uses: 2 });
  assert.equal(isAuthorized(touched, REPO, ["pr-merge"], T0_MS + 45 * DAY_MS), true);
});

test("touching never creates an authorization that was not recorded", () => {
  const store = recordAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0);
  const touched = touchAuthorization(store, REPO, ["pr-merge", "release-create"], T0);
  assert.equal(touched.repos[REPO]?.["release-create"], undefined);
  assert.deepEqual(touchAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge"], T0), EMPTY_AUTHORIZATIONS);
});

test("forget removes one class, or the whole repository", () => {
  const store = recordAuthorization(EMPTY_AUTHORIZATIONS, REPO, ["pr-merge", "push-branch"], T0);
  const oneGone = forgetAuthorization(store, REPO, "pr-merge");
  assert.equal(isAuthorized(oneGone, REPO, ["pr-merge"], T0_MS), false);
  assert.equal(isAuthorized(oneGone, REPO, ["push-branch"], T0_MS), true);
  assert.deepEqual(forgetAuthorization(oneGone, REPO, "push-branch"), EMPTY_AUTHORIZATIONS, "a repository with nothing left is dropped");
  assert.deepEqual(forgetAuthorization(store, REPO), EMPTY_AUTHORIZATIONS);
  assert.equal(isAuthorized(store, REPO, ["pr-merge"], T0_MS), true, "forgetting is pure");
});

test("pruneExpired drops expired classes and empty repositories", () => {
  const old = recordAuthorization(EMPTY_AUTHORIZATIONS, "github.com/a/old", ["pr-merge"], T0);
  const mixed = recordAuthorization(recordAuthorization(old, REPO, ["pr-merge"], T0), REPO, ["push-branch"], new Date(T0_MS + 25 * DAY_MS).toISOString());
  const pruned = pruneExpired(mixed, T0_MS + 31 * DAY_MS);
  assert.deepEqual(Object.keys(pruned.repos), [REPO]);
  assert.deepEqual(Object.keys(pruned.repos[REPO] ?? {}), ["push-branch"]);
});

test("T1c: repoSpecIdentity reads gh's --repo value as the same identity as the remote", () => {
  assert.equal(repoSpecIdentity("acme/widgets"), "github.com/acme/widgets");
  assert.equal(repoSpecIdentity("Acme/Widgets"), "github.com/acme/widgets");
  assert.equal(repoSpecIdentity("github.com/acme/widgets"), "github.com/acme/widgets");
  assert.equal(repoSpecIdentity("ghe.example.com/acme/widgets"), "ghe.example.com/acme/widgets");
  assert.equal(repoSpecIdentity("https://github.com/acme/widgets.git"), "github.com/acme/widgets");
  for (const bad of ["", "widgets", "/acme/widgets", "acme/", "a/b/c/d", "acme/wid gets", "../x/y"]) assert.equal(repoSpecIdentity(bad), null, bad);
});

test("T4: authorizationRows lists each live repository with its classes, last use and expiry, for the panel", () => {
  const store = recordAuthorization(
    recordAuthorization(recordAuthorization(EMPTY_AUTHORIZATIONS, "github.com/zeta/app", ["pr-merge"], T0), REPO, ["release-create", "pr-merge"], T0),
    "github.com/old/gone",
    ["push-branch"],
    new Date(T0_MS - 40 * DAY_MS).toISOString(),
  );
  const rows = authorizationRows(store, T0_MS + DAY_MS);
  assert.deepEqual(rows.map((row) => row.repo), [REPO, "github.com/zeta/app"], "sorted, and the expired repository is left out");
  assert.deepEqual(rows[0]?.classes, [
    { cls: "pr-merge", firstAt: T0, lastAt: T0, uses: 1, expiresAt: new Date(T0_MS + AUTHORIZATION_TTL_MS).toISOString() },
    { cls: "release-create", firstAt: T0, lastAt: T0, uses: 1, expiresAt: new Date(T0_MS + AUTHORIZATION_TTL_MS).toISOString() },
  ]);
  assert.deepEqual(authorizationRows(EMPTY_AUTHORIZATIONS, T0_MS), []);
});
