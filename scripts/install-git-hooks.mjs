// Points this repository's git hooks at the tracked `.githooks` folder, so
// `.githooks/pre-push` runs the private-data check before every push. It sets
// the repository's own config (`git config --local`), never the global one.
// Run by `npm install` / `npm ci` through the `prepare` script, or by hand
// with `npm run prepare`. Outside a git work tree (an npm tarball) it does nothing.
import { execFileSync } from "node:child_process";

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let insideWorkTree = false;
try {
  insideWorkTree = git(["rev-parse", "--is-inside-work-tree"]) === "true";
} catch {
  insideWorkTree = false;
}

if (!insideWorkTree) {
  process.stdout.write("install-git-hooks: not a git work tree; no hooks installed\n");
} else {
  git(["config", "--local", "core.hooksPath", ".githooks"]);
  process.stdout.write("install-git-hooks: core.hooksPath = .githooks for this repository\n");
}
