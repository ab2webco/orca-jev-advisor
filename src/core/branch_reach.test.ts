// Unit tests for branch_reach.ts -- pure text in, facts out. Run with:
//   node --test --experimental-strip-types src/core/branch_reach.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { branchReachPlaces, namesProtectedBranch } from "./branch_reach.ts";

const PROTECTED: ReadonlySet<string> = new Set(["main", "master", "production", "develop", "staging"]);

test("namesProtectedBranch: a protected branch named as a word, a refspec side or a remote branch", () => {
  for (const command of [
    "git push origin main",
    'git push origin "main"',
    "git push origin HEAD:main",
    "git push origin +main",
    "git push origin refs/heads/main",
    "git checkout master",
    "git merge develop",
    "git rebase origin/main",
    "git switch Main",
    "git add x && git push origin staging 2>&1 | tail -3",
  ]) {
    assert.equal(namesProtectedBranch(command, PROTECTED), true, command);
  }
});

test("namesProtectedBranch: a file or a message that only contains the word does not name the branch", () => {
  for (const command of [
    "git add src/main.ts",
    "git add adapters/orca/main.mjs",
    'git commit -m "fix main menu"',
    "git add x",
    "git push origin feat/x",
    "node build.mjs --target=mainline",
  ]) {
    assert.equal(namesProtectedBranch(command, PROTECTED), false, command);
  }
});

test("namesProtectedBranch: a gh command that writes is read as reaching a protected branch, since its base is not in the text", () => {
  assert.equal(namesProtectedBranch("gh pr merge 12 --squash", PROTECTED), true);
  assert.equal(namesProtectedBranch("gh api -X PUT repos/o/r/pulls/12/merge", PROTECTED), true);
  assert.equal(namesProtectedBranch("gh pr view 12 --json state", PROTECTED), false);
});

test("namesProtectedBranch: an obviously safe segment never counts", () => {
  assert.equal(namesProtectedBranch("git log main..HEAD && git add x", PROTECTED), false);
});

test("branchReachPlaces: a plain write acts in the session's directory", () => {
  assert.deepEqual(branchReachPlaces("git add x", "/work/repo", "/Users/someone"), ["/work/repo"]);
});

test("branchReachPlaces: git -C and cd move the place, and the session no longer counts for that segment", () => {
  assert.deepEqual(branchReachPlaces("git -C /work/wt push origin feat/x", "/work/repo", "/Users/someone"), ["/work/wt"]);
  assert.deepEqual(branchReachPlaces("cd /work/wt && git commit -m x", "/work/repo", "/Users/someone"), ["/work/wt"]);
});

test("branchReachPlaces: a mixed command keeps the session's own place too", () => {
  assert.deepEqual([...branchReachPlaces("git commit -m x && git -C /work/wt push origin feat/x", "/work/repo", "/Users/someone")].sort(), ["/work/repo", "/work/wt"]);
});

test("branchReachPlaces: a place that cannot be known is null", () => {
  assert.deepEqual(branchReachPlaces('cd "$X" && git commit -m x', "/work/repo", "/Users/someone"), [null]);
});

test("branchReachPlaces: an obviously safe command reaches no place", () => {
  assert.deepEqual(branchReachPlaces("git status", "/work/repo", "/Users/someone"), []);
});

test("branchReachPlaces: a git command keeps its own directory even when it also writes a file", () => {
  assert.ok(branchReachPlaces("git commit -am x > /tmp/out.log 2>&1", "/work/repo", "/Users/someone").includes("/work/repo"));
  assert.ok(branchReachPlaces("git add x 2>/tmp/err", "/work/repo", "/Users/someone").includes("/work/repo"));
});

test("branchReachPlaces: a program that may edit files keeps its directory beside a redirect target", () => {
  assert.ok(branchReachPlaces("node scripts/edit.mjs > /tmp/log", "/work/repo", "/Users/someone").includes("/work/repo"));
});

test("branchReachPlaces: a plain delete or copy acts only where its files are", () => {
  assert.deepEqual(branchReachPlaces("rm /other/repo/f", "/work/repo", "/Users/someone"), ["/other/repo/f"]);
  assert.ok(branchReachPlaces("rm /other/repo/f $X", "/work/repo", "/Users/someone").includes(null));
});

test("namesProtectedBranch: a branch the text cannot name keeps the policy", () => {
  for (const command of [
    "git checkout - && git commit -m x",
    "git checkout @{-1}",
    'git checkout "$BASE" && git merge feat/x',
    'git push origin "$B"',
    "git push origin HEAD:`cat b`",
    "git switch -",
  ]) {
    assert.equal(namesProtectedBranch(command, PROTECTED), true, command);
  }
  assert.equal(namesProtectedBranch('git commit -m "$MSG"', PROTECTED), false);
});

test("branchReachPlaces: a move out of the checkout writes the checkout too", () => {
  assert.ok(branchReachPlaces("mv src/a.ts /tmp/x", "/work/repo", "/Users/someone").includes("/work/repo/src/a.ts"));
});

// odd/tasks/branch-reach-places.md B1: in a session on main, `pgrep`, `head`,
// `mkdir -p /tmp/x` and `rm -rf ~/Library/a && ln -s ~/b ~/Library/a` were
// asked about never_write_to_main, because every program not on a short list
// counted its own directory as a place it writes.
const REPO = "/work/repo";
const HOME = "/Users/someone";

test("B1: a program that writes no file adds no place", () => {
  for (const command of [
    "pgrep -f x",
    "ps aux | grep node",
    "lsof -i :3000",
    "kill 123",
    "pkill -f vite",
    "ps aux | head -5",
    "git log --oneline | head -3",
    "tail -n 20 log.txt | wc -l",
    "uname -a",
    "id -u",
    "hostname",
    "readlink -f x",
    "find . -name '*.ts'",
    "sed 's/a/b/' src/x",
    "sed -n -e 's/a/b/p' src/x",
    "sort -u src/x",
    "uniq src/x",
    "ls -la src",
    "rg foo src",
  ]) {
    assert.deepEqual(branchReachPlaces(command, REPO, HOME), [], command);
  }
});

test("B1: a program that writes no file still counts its redirect targets", () => {
  assert.deepEqual(branchReachPlaces("ps aux > /tmp/ps.txt", REPO, HOME), ["/tmp/ps.txt"]);
  assert.deepEqual(branchReachPlaces("head -5 a > out.txt", REPO, HOME), ["/work/repo/out.txt"]);
  assert.deepEqual(branchReachPlaces("cat a > ~/notes.txt", REPO, HOME), [`${HOME}/notes.txt`]);
  assert.deepEqual(branchReachPlaces("cd /other && grep x y > z", REPO, HOME), ["/other/z"]);
  assert.deepEqual(branchReachPlaces("cat a > $OUT", REPO, HOME), [null]);
});

test("B1: a conditional reader that writes keeps its directory", () => {
  for (const command of [
    "find . -delete",
    "find . -name x -exec rm {} +",
    "find . -execdir touch x ;",
    "find . -ok rm {} ;",
    "find . -okdir rm {} ;",
    "find . -fprint out",
    "find . -fprint0 out",
    "find . -fprintf out %p",
    "find . -fls out",
    "sed -i s/a/b/ src/x",
    "sed -i'' s/a/b/ src/x",
    "sed -i.bak s/a/b/ src/x",
    "sed -ni s/a/b/p src/x",
    "sed --in-place s/a/b/ src/x",
    "sed --in-place=.bak s/a/b/ src/x",
    "sed -f script.sed src/x",
    "sed 's/a/b/w out' src/x",
    "sed -n 'w out' src/x",
    "sed '1e touch x' src/x",
    "sort -o out src/x",
    "sort -uo out src/x",
    "sort --output=out src/x",
    "sort --compress-program=gzip src/x",
    "rg --pre ./run.sh foo",
    "uniq in out",
    "file -C -m magic",
  ]) {
    assert.ok(branchReachPlaces(command, REPO, HOME).some((place) => place === null || place === REPO || place.startsWith(`${REPO}/`)), command);
  }
});

test("B1: programs that may write files they do not name still count their directory", () => {
  for (const command of ["awk 'BEGIN { system(\"touch x\") }'", "curl -O https://x", "wget https://x", "env A=1 head x", "xargs rm", "python3 x.py", "make", "npm install", "node x.mjs"]) {
    assert.ok(branchReachPlaces(command, REPO, HOME).includes(REPO), command);
  }
});

test("B1: the owner's refused command, outside the repository, reaches no place in it", () => {
  assert.deepEqual(branchReachPlaces("rm -rf ~/Library/a && ln -s ~/b ~/Library/a", REPO, HOME), [`${HOME}/Library/a`]);
  assert.deepEqual(branchReachPlaces("mkdir -p /tmp/x", REPO, HOME), ["/tmp/x"]);
  assert.deepEqual(branchReachPlaces("mkdir -p /tmp/x 2>/dev/null", REPO, HOME), ["/tmp/x", "/dev/null"]);
  assert.deepEqual(branchReachPlaces("mkdir -m 755 /tmp/x", REPO, HOME), ["/tmp/x"]);
  assert.deepEqual(branchReachPlaces("touch -t 202601010000 /tmp/y", REPO, HOME), ["/tmp/y"]);
  assert.deepEqual(branchReachPlaces("chmod +x /tmp/run.sh", REPO, HOME), ["/tmp/run.sh"]);
  assert.deepEqual(branchReachPlaces("chmod 755 /tmp/run.sh", REPO, HOME), ["/tmp/run.sh"]);
  assert.deepEqual(branchReachPlaces("chown me:staff /tmp/f", REPO, HOME), ["/tmp/f"]);
  assert.deepEqual(branchReachPlaces("echo hi | tee -a /tmp/log", REPO, HOME), ["/tmp/log"]);
  assert.deepEqual(branchReachPlaces("mv /tmp/a /tmp/b", REPO, HOME), ["/tmp/a", "/tmp/b"]);
  assert.deepEqual(branchReachPlaces("ln -sf /x -t /tmp/links", REPO, HOME), ["/tmp/links"]);
  assert.deepEqual(branchReachPlaces("cp src/a /tmp/a", REPO, HOME), ["/tmp/a"]);
});

test("B1: a named file inside the checkout still resolves into it, after cd and -C", () => {
  assert.deepEqual(branchReachPlaces("mkdir src/x", REPO, HOME), ["/work/repo/src/x"]);
  assert.deepEqual(branchReachPlaces("touch src/x", REPO, HOME), ["/work/repo/src/x"]);
  assert.deepEqual(branchReachPlaces("mv src/a.ts /tmp/a.ts", REPO, HOME), ["/work/repo/src/a.ts", "/tmp/a.ts"]);
  assert.deepEqual(branchReachPlaces("mv -t /tmp src/a.ts", REPO, HOME), ["/tmp", "/work/repo/src/a.ts"]);
  assert.deepEqual(branchReachPlaces("echo hi | tee src/x", REPO, HOME), ["/work/repo/src/x"]);
  assert.deepEqual(branchReachPlaces("chmod -R u+w src", REPO, HOME), ["/work/repo/src"]);
  assert.deepEqual(branchReachPlaces("chmod -x src/run.sh", REPO, HOME), ["/work/repo/src/run.sh"]);
  assert.deepEqual(branchReachPlaces("ln -s /tmp/a src/a", REPO, HOME), ["/work/repo/src/a"]);
  assert.deepEqual(branchReachPlaces("cd /other && mkdir x", REPO, HOME), ["/other/x"]);
  assert.deepEqual(branchReachPlaces("rm -rf ~/x", `${HOME}/repo`, HOME), [`${HOME}/x`]);
  assert.deepEqual(branchReachPlaces('rm -rf "$HOME/x" ${HOME}/y', `${HOME}/repo`, HOME), [`${HOME}/x`, `${HOME}/y`]);
  assert.deepEqual(branchReachPlaces("rm -rf ~/repo/src", `${HOME}/repo`, HOME), [`${HOME}/repo/src`]);
  assert.deepEqual(branchReachPlaces("mkdir /tmp/$(echo ../work/repo/x)", REPO, HOME), [null]);
  assert.deepEqual(branchReachPlaces("rm src/{a,b}", REPO, HOME), [null]);
});

test("B1: a link with one operand lands in the directory it runs in", () => {
  assert.deepEqual(branchReachPlaces("ln -s /tmp/a", REPO, HOME), [REPO]);
});

test("B1: a named file that cannot be resolved is a place nobody knows", () => {
  for (const command of ["mkdir $X", "touch src/*.ts", "ln -s /a $(cat f)", "mv /tmp/a $DEST", "tee $LOG", "chmod +x $F"]) {
    assert.ok(branchReachPlaces(command, REPO, HOME).includes(null), command);
  }
});

test("B1: a delete or a move of a directory holding the checkout reaches the checkout", () => {
  assert.ok(branchReachPlaces("rm -rf /work", REPO, HOME).includes(REPO));
  assert.ok(branchReachPlaces("mv /work /tmp/w", REPO, HOME).includes(REPO));
  assert.ok(branchReachPlaces("chmod -R 700 /work", REPO, HOME).includes(REPO));
});

test("B1: a wrapper or a program path keeps the directory, as before", () => {
  assert.ok(branchReachPlaces("sudo mkdir /tmp/x", REPO, HOME).includes(REPO));
  assert.ok(branchReachPlaces("/usr/bin/pgrep x", REPO, HOME).includes(REPO));
});
