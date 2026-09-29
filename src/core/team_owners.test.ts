// 0.6.8 T1: the "Repositories your team owns" setting -- the GitHub/GitLab
// owners (users or organisations) whose repositories never reach a client.
// parseTeamOwners is the one reader every side uses: the worker's mirror
// (write-secret-mirror.mjs's team-owners-save), store.ts's getTeamOwners and
// gate-bash.ts's own read of team-owners.json. Empty is the default and the
// safe answer: an empty list changes no decision at all.
//
// Run with: node --test --experimental-strip-types src/core/team_owners.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TEAM_OWNERS, TEAM_OWNERS_MIRROR_FILE, normalizeTeamOwner, parseTeamOwners } from "./team_owners.ts";

test("the mirror file name is team-owners.json", () => {
  assert.equal(TEAM_OWNERS_MIRROR_FILE, "team-owners.json");
});

test("a plain owner is kept, lowercased", () => {
  assert.equal(normalizeTeamOwner("Acme-Team"), "acme-team");
});

test("surrounding whitespace and a leading @ are dropped", () => {
  assert.equal(normalizeTeamOwner("  @acme-team  "), "acme-team");
});

test("an owner pasted as a profile URL or host path resolves to the owner itself", () => {
  assert.equal(normalizeTeamOwner("https://github.com/acme-team"), "acme-team");
  assert.equal(normalizeTeamOwner("https://github.com/acme-team/"), "acme-team");
  assert.equal(normalizeTeamOwner("github.com/acme-team"), "acme-team");
  assert.equal(normalizeTeamOwner("https://gitlab.com/acme-team/tools/app.git"), "acme-team");
});

test("an owner pasted as a repository (owner/repo) keeps only the owner", () => {
  assert.equal(normalizeTeamOwner("acme-team/app"), "acme-team");
});

test("an scp-like remote resolves to its owner", () => {
  assert.equal(normalizeTeamOwner("git@github.com:acme-team/app.git"), "acme-team");
});

test("GitLab-style dots and underscores are valid owner characters", () => {
  assert.equal(normalizeTeamOwner("acme.team_tools"), "acme.team_tools");
});

test("anything that is not an owner name is dropped, never guessed", () => {
  assert.equal(normalizeTeamOwner(""), null);
  assert.equal(normalizeTeamOwner("   "), null);
  assert.equal(normalizeTeamOwner("acme team"), null);
  assert.equal(normalizeTeamOwner("-acme"), null);
  assert.equal(normalizeTeamOwner("acme$team"), null);
  assert.equal(normalizeTeamOwner("https://github.com/"), null);
});

test("parseTeamOwners normalizes, drops invalid rows and removes duplicates, keeping first-seen order", () => {
  assert.deepEqual(parseTeamOwners(["acme-team", "  ", "ACME-TEAM", "@acme-tools", "not valid", "acme-tools"]), ["acme-team", "acme-tools"]);
});

test("parseTeamOwners reads anything that is not an array of strings as empty", () => {
  assert.deepEqual(parseTeamOwners(null), []);
  assert.deepEqual(parseTeamOwners(undefined), []);
  assert.deepEqual(parseTeamOwners("acme-team"), []);
  assert.deepEqual(parseTeamOwners({ owners: ["acme-team"] }), []);
  assert.deepEqual(parseTeamOwners([1, true, null, "acme-team"]), ["acme-team"]);
});

test("parseTeamOwners keeps at most MAX_TEAM_OWNERS entries", () => {
  const many = Array.from({ length: MAX_TEAM_OWNERS + 5 }, (_, index) => `acme-${index}`);
  assert.equal(parseTeamOwners(many).length, MAX_TEAM_OWNERS);
});
