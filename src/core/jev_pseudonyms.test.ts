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
  assert.equal(names.name("path", "/home/dev/acme-shop"), "<path-1>");
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
  names.name("path", "/home/dev/acme-shop");
  names.name("repo", "acme-shop");
  names.name("branch", "feat/login");
  assert.equal(
    names.redactText("Never touch /home/dev/acme-shop/dist of acme-shop on feat/login; acme-shopper is someone else."),
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

// Measured on the local prompt logs (1,275 prompts): every replacement that hit
// an ordinary word came from a repository name under four characters.
test("redactText leaves a repository name shorter than four characters alone (a repo called `app` must not turn `npm run app` into `npm run <repo-1>`)", () => {
  const names = createJevPseudonyms();
  names.name("repo", "app");
  names.name("repo", "acme-shop");
  assert.equal(names.redactText("npm run app in acme-shop"), "npm run app in <repo-2>");
});

test("redactText still replaces a branch or path of three characters", () => {
  const names = createJevPseudonyms();
  names.name("branch", "fix");
  names.name("path", "/tm");
  assert.equal(names.redactText("git push origin fix; ls /tm"), "git push origin <branch-1>; ls <path-1>");
});

// 0.6.13 T4 (F-06): no path reaches Jev in clear unless it is a system
// location whose name carries the risk. A path under the home directory or on
// another volume becomes a stable placeholder whether or not the gate
// registered it; the home directory itself reads `~`.
// The macOS home root is assembled so no literal home path is tracked.
const MAC_HOME = ["", "Users", "dev"].join("/");
test("redactText turns an unregistered home or volume path into a stable placeholder", () => {
  const names = createJevPseudonyms();
  assert.equal(names.redactText("cp /etc/hosts /Volumes/Data/jev-live-check/demo-app/hosts.txt"), "cp /etc/hosts <path-1>");
  assert.equal(names.redactText(`cat ${MAC_HOME}/Projects/secret-client/notes.md && ls ${MAC_HOME}/Projects/secret-client/notes.md`), "cat <path-2> && ls <path-2>");
  assert.equal(names.redactText("cd /home/dev/work/acme && git status"), "cd <path-3> && git status");
  assert.equal(names.redactText("rm -rf ~/Projects/acme-shop/dist"), "rm -rf <path-4>");
  assert.equal(names.redactText("ls $HOME/.ssh ${HOME}/.aws"), "ls <path-5> <path-6>");
  assert.equal(names.redactText(`echo x > ${MAC_HOME}/out.txt; cmd --dir=/mnt/backup/db`), "echo x > <path-7>; cmd --dir=<path-8>");
});

test("redactText keeps a backslash-escaped space inside the path it redacts", () => {
  const names = createJevPseudonyms();
  assert.equal(names.redactText(`wc -l ${MAC_HOME}/Library/Application\\ Support/x.json`), "wc -l <path-1>");
});

test("redactText keeps the home directory as ~ and system locations in clear", () => {
  const names = createJevPseudonyms();
  assert.equal(names.redactText(`rm -rf ${MAC_HOME}`), "rm -rf ~");
  assert.equal(names.redactText("rm -rf /home/dev/"), "rm -rf ~");
  assert.equal(names.redactText("rm -rf ~ && rm -rf ~/"), "rm -rf ~ && rm -rf ~/");
  for (const clear of ["rm -rf /", "cat /etc/hosts", "ls /usr/local/bin", "cat /var/log/system.log", "cp x /tmp/x.mjs", "echo > /dev/null", "ls /System/Library", "ls /Library/LaunchDaemons", "ls /private/tmp", "ls /Volumes", "awk '/error/ {print}' log.txt"]) {
    assert.equal(names.redactText(clear), clear, clear);
  }
});

test("redactText leaves a URL, a registered path's own remainder and relative paths alone", () => {
  const names = createJevPseudonyms();
  names.name("path", `${MAC_HOME}/Projects/acme`);
  assert.equal(names.redactText(`rm -rf ${MAC_HOME}/Projects/acme/build`), "rm -rf <path-1>/build");
  assert.equal(names.redactText("git clone https://github.com/acme/app.git src/app"), "git clone https://github.com/acme/app.git src/app");
});
