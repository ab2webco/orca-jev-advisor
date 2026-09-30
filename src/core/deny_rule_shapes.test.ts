import { strict as assert } from "node:assert";
import { test } from "node:test";

import { recursiveRmOfRootOrHomeOutcome } from "./deny_rule_shapes.ts";

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
