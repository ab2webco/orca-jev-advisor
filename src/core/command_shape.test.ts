// The cases that matter here are the ones measured against the live API,
// where one command family held opposite verdicts depending only on where
// its target pointed. A shape that merges those two is not a cache, it is a
// way to authorise the second command with the first one's answer.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { commandShape } from "./command_shape.ts";
import type { ShapeContext } from "./command_shape.ts";

const CTX: ShapeContext = {
  cwd: "/Users/dev/Projects/app",
  home: "/Users/dev",
  destinationId: "app",
  repoContext: "repository app, branch feature/x, this is a working branch, clean",
};

const shape = (command: string, over: Partial<ShapeContext> = {}): string | null =>
  commandShape(command, { ...CTX, ...over });

test("commands that differ only by an in-tree filename share one entry", () => {
  // This is the whole point: 702 real decisions covered 49 shapes, and a
  // literal-text key hit 3.1% of the time.
  assert.equal(shape("rm -rf dist"), shape("rm -rf build"));
  assert.equal(shape("node --test src/core/a.test.ts"), shape("node --test src/core/b.test.ts"));
  assert.equal(shape("cat README.md"), shape("cat package.json"));
});

test("a target outside the tree NEVER shares an entry with one inside it", () => {
  // Measured: rm -rf dist scored 1.37 (allow) and rm -rf ../other-project
  // scored 2.13 (ask). Merging them would let the first authorise the second.
  assert.notEqual(shape("rm -rf dist"), shape("rm -rf ../other-project"));
  assert.notEqual(shape("rm -rf dist"), shape("rm -rf ~/Documents/contracts"));
  assert.notEqual(shape("rm -rf dist"), shape("rm -rf /etc/nginx"));
  // Both are simply out of the tree, and both measured 2.13 against the live
  // API, so sharing an entry costs nothing and buys reach.
  assert.equal(shape("rm -rf ../other-project"), shape("rm -rf ~/Documents/contracts"));
});

test("a relative path that climbs out of the tree is recognised as outside it", () => {
  assert.equal(shape("rm -rf ./dist"), shape("rm -rf dist"));
  assert.notEqual(shape("rm -rf src/../../sibling"), shape("rm -rf src/../dist"));
});

test("adding a flag opens a new entry, so a dangerous one never inherits a safe answer", () => {
  assert.notEqual(shape("git push origin main"), shape("git push --force origin main"));
  assert.notEqual(shape("gh pr merge 1"), shape("gh pr merge 1 --admin"));
  // Flag order is not meaning.
  assert.equal(shape("rm -r -f dist"), shape("rm -f -r dist"));
});

test("a remote is its own class, however it is written", () => {
  const https = shape("git clone https://example.com/x.git");
  const ssh = shape("git clone git@example.com:org/x.git");
  assert.equal(https, ssh);
  assert.notEqual(https, shape("git clone ./local-copy"));
});

test("two different repositories never share an answer", () => {
  assert.notEqual(shape("rm -rf dist"), shape("rm -rf dist", { destinationId: "client-site" }));
  assert.notEqual(shape("rm -rf dist"), shape("rm -rf dist", { destinationId: null }));
});

test("a different repository state never shares an answer", () => {
  // Measured: the same merge scored 1.50 with no remote and 2.06 on a
  // client's main branch. The state is part of the question.
  assert.notEqual(shape("gh pr merge 1"), shape("gh pr merge 1", { repoContext: "repository app, branch main, this is the shared main branch, clean" }));
});

test("an env assignment contributes its name but never its value", () => {
  const a = shape("TOKEN=ghp_secret1 gh pr merge 1");
  const b = shape("TOKEN=ghp_secret2 gh pr merge 1");
  assert.equal(a, b, "two secrets must not produce two cache entries");
  assert.ok(a !== null && !a.includes("ghp_secret1"), "the key leaked the secret");
  assert.notEqual(a, shape("gh pr merge 1"), "setting a variable is not the same command");
});

test("every segment of a compound command is shaped, so a dangerous tail is never hidden", () => {
  assert.notEqual(shape("cd src && ls"), shape("cd src && rm -rf ../../elsewhere"));
  assert.equal(shape("cd src && ls"), shape("cd lib && ls"));
});

test("a verb is kept verbatim so sibling subcommands never share an answer", () => {
  assert.notEqual(shape("git push origin"), shape("git pull origin"));
  assert.notEqual(shape("docker build ."), shape("docker push ."));
  assert.notEqual(shape("npm run build"), shape("npm run deploy"));
});

test("a program given by path is shaped by its name", () => {
  assert.equal(shape("/usr/local/bin/node app.js"), shape("node app.js"));
});

test("anything that cannot be known without running it is NOT cached", () => {
  // Fails closed: reusing a verdict for a command whose meaning is unknown
  // is how a safe answer gets borrowed by an unsafe command.
  assert.equal(shape("rm -rf $(cat target.txt)"), null);
  assert.equal(shape("rm -rf `cat target.txt`"), null);
  assert.equal(shape("rm -rf ${TARGET}"), null);
  assert.equal(shape("rm -rf build/*"), null);
  assert.equal(shape('echo "unterminated'), null);
  assert.equal(shape(""), null);
  assert.equal(shape("   "), null);
});

test("the same command in a different working directory is judged apart", () => {
  const here = shape("rm -rf ../sibling");
  const deeper = shape("rm -rf ../sibling", { cwd: "/Users/dev/Projects/app/packages/web", treeRoot: "/Users/dev/Projects/app" });
  assert.notEqual(here, deeper, "../sibling leaves the project from one of these and stays inside from the other");
});
