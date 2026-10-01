// 0.6.22 T2 (JEVADV-97): the --commands-file format shared by the CLIs.

import assert from "node:assert/strict";
import test from "node:test";

import { isBlankOrComment, parseCommandsFile } from "./commands_file.ts";

test("one command per line, trimmed; blank lines and # comments are skipped", () => {
  assert.deepEqual(parseCommandsFile("# header\n\n  git status  \n#git push\nnpm test\n"), ["git status", "npm test"]);
});

test("isBlankOrComment", () => {
  assert.equal(isBlankOrComment("   "), true);
  assert.equal(isBlankOrComment(" # x"), true);
  assert.equal(isBlankOrComment("ls # not a comment"), false);
});
