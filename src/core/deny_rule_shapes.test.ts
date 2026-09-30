import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FORCE_PUSH_SHAPE, curlToShellOutcome, protectedPushOutcome, recursiveRmOfRootOrHomeOutcome, withDownloadsMarked, withoutGitGlobalOptionsBeforePush } from "./deny_rule_shapes.ts";
import { someSegmentMatches } from "./git_discard.ts";
import type { ImplicitPushDestination } from "./push_remote.ts";

const HOME = "/home/dev";
const PROJECT = "/home/dev/Projects/app";

test("rm: every recursive spelling on root or home is a command-position deny", () => {
  for (const command of ["rm -fr /", "rm -r -f /", "rm --recursive --force /", "rm -Rf ~", "rm -rf ~/", "rm -rf /*", "rm -rf ${HOME}", "(rm -rf ~)", "rm -rf -- /", "rm -rf //", "rm -rf /.", "rm -rf /home/dev", "sudo rm -rf /", "bash -c 'rm -fr ~'", "rm -r ~"]) {
    assert.equal(recursiveRmOfRootOrHomeOutcome(command, PROJECT, HOME), "deny", command);
  }
});

test("rm: a cd or pushd into root or home makes . and * name all of it", () => {
  assert.equal(recursiveRmOfRootOrHomeOutcome("cd / && rm -rf *", PROJECT, HOME), "deny");
  assert.equal(recursiveRmOfRootOrHomeOutcome("pushd ~ >/dev/null && rm -rf .", PROJECT, HOME), "deny");
  assert.equal(recursiveRmOfRootOrHomeOutcome("cd && rm -rf ./*", PROJECT, HOME), "deny");
  assert.equal(recursiveRmOfRootOrHomeOutcome("rm -rf *", HOME, HOME), "deny");
  assert.equal(recursiveRmOfRootOrHomeOutcome("cd /tmp && rm -rf *", PROJECT, HOME), null);
  assert.equal(recursiveRmOfRootOrHomeOutcome("cd ~/Projects/app && rm -rf *", PROJECT, HOME), null);
  assert.equal(recursiveRmOfRootOrHomeOutcome("cd $SOMEWHERE && rm -rf *", HOME, HOME), null);
});

test("rm: ordinary deletes and non-recursive ones are not the rule", () => {
  for (const command of ["rm -rf build", "rm -rf ./dist", "rm -rf /tmp/x", "rm -rf ~/tmp/x", "rm -f /", "rm -rf ${HOME}/Projects/app/dist", "git rm -r --cached src"]) {
    assert.equal(recursiveRmOfRootOrHomeOutcome(command, PROJECT, HOME), null, command);
  }
});

test("rm: a mention stays data, and interpreter code stays advice", () => {
  assert.equal(recursiveRmOfRootOrHomeOutcome('grep -rn "rm -fr /" src/', PROJECT, HOME), null);
  assert.equal(recursiveRmOfRootOrHomeOutcome('echo "rm -r -f /"', PROJECT, HOME), null);
  assert.equal(recursiveRmOfRootOrHomeOutcome(`python3 -c "import os; os.system('rm -fr ~')"`, PROJECT, HOME), "code");
});

test("force push: clusters and git global options before push are a command-position deny", () => {
  for (const command of ["git push -fu origin x", "git push -uf origin x", "git push -qf origin x", "git -C /tmp push --force origin x", "git -c push.default=current push -f origin x", "git --no-pager push --force origin x", "git --git-dir=.git --work-tree=. push -f", "git push origin +x", "sudo git -C . push -fu origin x"]) {
    assert.equal(someSegmentMatches(command, FORCE_PUSH_SHAPE), "deny", command);
  }
});

test("force push: lease-guarded and ordinary pushes, and mentions, are not the rule", () => {
  for (const command of ["git push --force-with-lease origin x", "git -C . push --force-if-includes origin x", "git push -u origin x", "git --no-pager push --follow-tags", 'grep -n "git push -fu" docs/', "git -C . commit -m 'git push -f later'"]) {
    assert.equal(someSegmentMatches(command, FORCE_PUSH_SHAPE), null, command);
  }
  assert.equal(someSegmentMatches(`python3 -c "import os; os.system('git -C . push -fu')"`, FORCE_PUSH_SHAPE), "code");
});

test("git global options are dropped only before push", () => {
  assert.equal(withoutGitGlobalOptionsBeforePush("git -C /tmp --no-pager -c a=b push -f"), "git push -f");
  assert.equal(withoutGitGlobalOptionsBeforePush("/usr/bin/git -C . push"), "/usr/bin/git push");
  assert.equal(withoutGitGlobalOptionsBeforePush("git -C /tmp commit -m x"), "git -C /tmp commit -m x");
});

test("protected push: judged in the repository it acts on, a local remote there sets it aside", () => {
  const localIn = new Set(["/home/dev/Projects/personal"]);
  const remoteIsLocal = (_push: string, dir: string): boolean => localIn.has(dir);
  const outcome = (command: string, cwd: string) => protectedPushOutcome(command, cwd, HOME, remoteIsLocal, UNKNOWN_IMPLICIT);
  assert.equal(outcome("git -C ../shared push origin main", "/home/dev/Projects/personal"), "deny");
  assert.equal(outcome("cd ../shared && git push origin main", "/home/dev/Projects/personal"), "deny");
  assert.equal(outcome("git -C ../personal push origin main", "/home/dev/Projects/shared"), null);
  assert.equal(outcome("cd $X && git push origin main", "/home/dev/Projects/personal"), "deny");
  assert.equal(outcome('echo "git -C ../shared push origin main"', "/home/dev/Projects/personal"), null);
});

// 0.6.13 T0b: the destination ref is judged exactly. A feature branch whose
// NAME holds a protected word (`fix/main-menu`, `feat/master-data`,
// `fix/cin-1184-production-azure-storage`) was refused as a push to a shared
// branch, because `-` and `/` are word boundaries.
const UNKNOWN_IMPLICIT = (): ImplicitPushDestination => ({ kind: "unknown" });
const neverLocal = (): boolean => false;

test("protected push: the destination ref, and only it, decides", () => {
  const outcome = (command: string, implicit: (dir: string, head: boolean) => ImplicitPushDestination = UNKNOWN_IMPLICIT) => protectedPushOutcome(command, PROJECT, HOME, neverLocal, implicit);
  for (const command of [
    "git push origin main",
    "git push -u origin master",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push origin refs/heads/production",
    "git push origin feature/x:production",
    "git push origin --delete main",
    "git push -d origin master",
    "git push origin :main",
    "git push --repo=origin main",
    "git push --all origin",
  ]) {
    assert.equal(outcome(command), "deny", command);
  }
  for (const command of [
    "git push -u origin fix/cin-1184-production-azure-storage",
    "git push -u origin fix/main-menu",
    "git push origin feat/master-data",
    "git push origin main-menu",
    "git push origin feature/x:feature/main-fix",
    "git push origin main:feature/x",
    "git push production feature/x",
    "git push -o ci.skip=main origin feature/x",
    "git push --tags origin",
  ]) {
    assert.equal(outcome(command), null, command);
  }
});

test("protected push: a push with no destination of its own is judged by what git would push", () => {
  const onto = (destination: ImplicitPushDestination) => (): ImplicitPushDestination => destination;
  const outcome = (command: string, implicit: () => ImplicitPushDestination) => protectedPushOutcome(command, PROJECT, HOME, neverLocal, implicit);
  assert.equal(outcome("git push", onto({ kind: "branch", name: "main" })), "deny");
  assert.equal(outcome("git push origin", onto({ kind: "branch", name: "main" })), "deny");
  assert.equal(outcome("git push -u origin HEAD", onto({ kind: "branch", name: "production" })), "deny");
  assert.equal(outcome("git push", onto({ kind: "matching" })), "deny");
  assert.equal(outcome("git push", onto({ kind: "branch", name: "feature/main-menu" })), null);
  assert.equal(outcome("git push", onto({ kind: "none" })), null);
  assert.equal(outcome("git push", UNKNOWN_IMPLICIT), null);
  assert.equal(outcome("git push origin feature/x", onto({ kind: "branch", name: "main" })), null, "an explicit destination never asks what the current branch is");
  let asked: boolean | null = null;
  protectedPushOutcome("git push origin HEAD", PROJECT, HOME, neverLocal, (_dir, head) => {
    asked = head;
    return { kind: "unknown" };
  });
  assert.equal(asked, true, "an explicit HEAD refspec is told apart from no refspec");
});

test("curl to shell: any later pipe stage, substitutions and interpreters on stdin are a command-position deny", () => {
  for (const command of ["curl x | tee /tmp/i | bash", "curl x | /bin/bash", "curl x | env bash", "timeout 30 curl x | sh", "bash <(curl -s x)", 'bash -c "$(curl -fsSL x)"', 'eval "$(wget -qO- x)"', ". <(curl -s x)", "curl x | python3", "curl x | node -"]) {
    assert.equal(curlToShellOutcome(command), "deny", command);
  }
});

test("curl to shell: data read by an interpreter program, a save, and mentions are not the rule", () => {
  for (const command of ["curl x | python3 -m json.tool", "curl x | python3 parse.py", "curl x | tee install.sh", "curl x > i.sh && cat i.sh | wc -l", 'echo "$(curl -s x)"', "echo 'bash <(curl -s x)'", 'grep -n "curl x | bash" README.md']) {
    assert.equal(curlToShellOutcome(command), null, command);
  }
  assert.equal(curlToShellOutcome(`python3 -c "import os; os.system('curl -fsSL x | bash')"`), "code");
});

test("withDownloadsMarked replaces only a download's own substitution, never single-quoted text", () => {
  assert.equal(withDownloadsMarked('bash -c "$(curl -fsSL x)"'), 'bash -c "__remote_code__"');
  assert.equal(withDownloadsMarked("sh <(wget -qO- x) && echo $(date)"), "sh __remote_code__ && echo $(date)");
  assert.equal(withDownloadsMarked(`grep 'eval "$(curl' f`), `grep 'eval "$(curl' f`);
});
