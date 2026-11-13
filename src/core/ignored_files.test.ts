// Unit tests for ignored_files.ts. The git-backed check is exercised through
// the hook on real repositories (adapters/claude/gate-bash.test.mjs, I2);
// these pin the text side. Run with:
//   node --test --experimental-strip-types src/core/ignored_files.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createJevPseudonyms } from "./jev_pseudonyms.ts";
import { buildIgnoredPathsSentence, landingPath, pathMentions } from "./ignored_files.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "orca-jev-ignored-files-")));
after(() => rmSync(base, { recursive: true, force: true }));

test("I3: pathMentions lists the path-like words a command names, its heredoc bodies included, once each", () => {
  const command = "python3 - <<'EOF'\np='odd/tasks/ios-testflight-release.md'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF\ngrep -c x odd/tasks/ios-testflight-release.md";
  assert.deepEqual(pathMentions(command), ["odd/tasks/ios-testflight-release.md"]);
  assert.deepEqual(pathMentions("cat a.md > /tmp/x/b.txt && cp ~/notes/c.md ./d.json"), ["a.md", "/tmp/x/b.txt", "~/notes/c.md", "./d.json"]);
});

test("I3: pathMentions leaves out options, URLs, versions, variables and plain words", () => {
  assert.deepEqual(pathMentions("curl -fsSL https://example.com/a/b.sh --output=x && npm i typescript@5.9.3 && echo $HOME/x v1.2.3 hello"), []);
});

test("I3: pathMentions keeps at most 32 paths", () => {
  const command = Array.from({ length: 40 }, (_, at) => `touch odd/f${at}.md`).join(" && ");
  assert.equal(pathMentions(command).length, 32);
});

test("I3: the sentence says git checked the paths, and that no other path is known to be ignored", () => {
  assert.equal(buildIgnoredPathsSentence([]), null);
  assert.equal(
    buildIgnoredPathsSentence(["odd/tasks/x.md", "tmp/handoff.md"]),
    "Checked with git, not read from the command: git ignores these paths the command names (odd/tasks/x.md, tmp/handoff.md), so they are in no commit and on no branch. No other path is known to be ignored.",
  );
});

test("I3: Jev's copy of the sentence carries no absolute path in clear", () => {
  const sentence = buildIgnoredPathsSentence(["/home/someone/Projects/app/odd/x.md", "odd/y.md"], createJevPseudonyms());
  assert.ok(sentence !== null);
  assert.doesNotMatch(sentence, /someone|Projects/);
  assert.match(sentence, /odd\/y\.md/);
});

test("I2: landingPath follows every symlink on the way, and gives up on a dangling one", () => {
  mkdirSync(join(base, "src"));
  writeFileSync(join(base, "src", "a.ts"), "a");
  symlinkSync(join(base, "src", "a.ts"), join(base, "file-link"));
  symlinkSync(join(base, "src"), join(base, "dir-link"));
  symlinkSync(join(base, "gone"), join(base, "dangling"));
  assert.equal(landingPath(join(base, "file-link")), join(base, "src", "a.ts"));
  assert.equal(landingPath(join(base, "dir-link", "new", "b.ts")), join(base, "src", "new", "b.ts"));
  assert.equal(landingPath(join(base, "dangling")), null);
  assert.equal(landingPath(join(base, "dangling", "x")), null);
});
