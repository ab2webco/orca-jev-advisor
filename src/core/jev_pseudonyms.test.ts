// 0.6.11 T3: a repo name, branch or path never reaches Jev in clear. These
// pin the pseudonym table every Jev-facing builder shares. Run with:
//   node --test --experimental-strip-types src/core/jev_pseudonyms.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { CLEAR_BRANCH_NAMES, createJevPseudonyms, IDENTITY_NAMES } from "./jev_pseudonyms.ts";
import { PROTECTED_BRANCH_NAMES } from "./push_remote.ts";

test("the branch names kept in clear are exactly the protected ones push_remote.ts knows", () => {
  assert.deepEqual([...CLEAR_BRANCH_NAMES].sort(), [...PROTECTED_BRANCH_NAMES].sort());
});

test("the same value always gets the same placeholder, and different values get different ones", () => {
  const names = createJevPseudonyms();
  assert.equal(names.name("repo", "acme-shop"), "<repo-1>");
  assert.equal(names.name("repo", "acme-shop"), "<repo-1>");
  assert.equal(names.name("repo", "other"), "<repo-2>");
  assert.equal(names.name("branch", "feat/login"), "<branch-1>");
  assert.equal(names.name("path", "/Users/me/acme-shop"), "<path-1>");
});

test("a protected branch name stays in clear: it carries risk meaning and identifies nobody", () => {
  const names = createJevPseudonyms();
  assert.equal(names.name("branch", "main"), "main");
  assert.equal(names.name("branch", "master"), "master");
  assert.equal(names.name("branch", "production"), "production");
});

test("the identity table leaves everything as it is (the local, cache-key rendering)", () => {
  assert.equal(IDENTITY_NAMES.name("repo", "acme-shop"), "acme-shop");
  assert.equal(IDENTITY_NAMES.redactText("acme-shop on feat/login"), "acme-shop on feat/login");
});

test("redactText swaps every registered value in free text, longest first, on token boundaries", () => {
  const names = createJevPseudonyms();
  names.name("path", "/Users/me/acme-shop");
  names.name("repo", "acme-shop");
  names.name("branch", "feat/login");
  assert.equal(
    names.redactText("Never touch /Users/me/acme-shop/dist of acme-shop on feat/login; acme-shopper is someone else."),
    "Never touch <path-1>/dist of <repo-1> on <branch-1>; acme-shopper is someone else.",
  );
});

test("redactText leaves a registered value shorter than three characters alone in free text (it would eat ordinary words)", () => {
  const names = createJevPseudonyms();
  names.name("branch", "a");
  assert.equal(names.redactText("this is a working branch"), "this is a working branch");
});

test("a derived destination label (a name, or `name (dir)`) is replaced whole; a written description only loses the known names", () => {
  const names = createJevPseudonyms();
  assert.equal(names.destinationDescription("acme-shop"), "<repo-1>");
  assert.equal(names.destinationDescription("acme-shop (acme-shop-hotfix)"), "<repo-1> (<repo-2>)");
  assert.equal(names.destinationDescription("the production storefront of acme-shop"), "the production storefront of <repo-1>");
});
