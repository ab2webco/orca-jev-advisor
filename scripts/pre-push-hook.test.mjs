// End-to-end tests for the local privacy guard: `.githooks/pre-push` runs the
// private-data check on what a push would send, and `install-git-hooks.mjs`
// points one repository at that folder. Every case builds its own throwaway
// repository, bare remote, HOME and git config under the OS temp dir, so the
// owner's real private-terms list and global git config are never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, ".githooks", "pre-push");
const CHECK = join(REPO_ROOT, "scripts", "private-data.test.mjs");
const INSTALLER = join(REPO_ROOT, "scripts", "install-git-hooks.mjs");

const TERM = "acme-secret-term";
const SKIP_LINE = "private-term check is skipped";
// Built at run time so this file does not itself trip the check it tests.
const PRIVATE_EMAIL = ["someone", "private-mail.net"].join("@");

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} RunResult
 * @typedef {{
 *   root: string,
 *   repo: string,
 *   globalConfig: string,
 *   env: NodeJS.ProcessEnv,
 *   run: (command: string, args: string[]) => RunResult,
 *   git: (...args: string[]) => string,
 *   commit: (file: string, content: string, message: string) => void,
 *   push: (ref?: string) => RunResult,
 *   remoteHas: (ref: string) => boolean,
 * }} Sandbox
 */

/**
 * @param {string} root  an empty temp dir the caller removes
 * @param {{ terms: string[] | null }} options  null leaves the terms file absent
 * @returns {Sandbox}
 */
function sandbox(root, { terms }) {
  const home = join(root, "home");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const globalConfig = join(root, "global.gitconfig");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(globalConfig, "");
  if (terms !== null) {
    const configDir = join(home, ".config", "orca-supervisor");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "private-terms.txt"), `${terms.join("\n")}\n`);
  }

  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("PRIVATE_DATA_")) env[key] = value;
  }
  env.HOME = home;
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  delete env.XDG_CONFIG_HOME;

  /** @type {Sandbox["run"]} */
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: repo, env, encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  /** @type {Sandbox["git"]} */
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout.trim();
  };

  spawnSync("git", ["init", "--bare", "-q", remote], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "author@example.com");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);

  mkdirSync(join(repo, ".githooks"));
  mkdirSync(join(repo, "scripts"));
  copyFileSync(HOOK, join(repo, ".githooks", "pre-push"));
  chmodSync(join(repo, ".githooks", "pre-push"), 0o755);
  copyFileSync(CHECK, join(repo, "scripts", "private-data.test.mjs"));
  const installed = run(process.execPath, [INSTALLER]);
  assert.equal(installed.status, 0, `installer failed:\n${installed.stderr}`);

  return {
    root,
    repo,
    globalConfig,
    env,
    run,
    git,
    commit(file, content, message) {
      writeFileSync(join(repo, file), content);
      git("add", "--", file);
      git("commit", "-q", "-m", message);
    },
    push(ref = "main") {
      return run("git", ["push", "-q", "origin", ref]);
    },
    remoteHas(ref) {
      const result = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", ref], {
        env,
        encoding: "utf8",
      });
      return result.status === 0;
    },
  };
}

/**
 * @param {(box: Sandbox) => void} body
 * @param {{ terms: string[] | null }} [options]
 */
function withSandbox(body, options = { terms: [TERM] }) {
  const root = mkdtempSync(join(tmpdir(), "privacy-guard-"));
  try {
    body(sandbox(root, options));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {RunResult} result */
const output = (result) => `${result.stdout}${result.stderr}`;

test("the installer sets core.hooksPath for this repository only", () => {
  withSandbox((box) => {
    assert.equal(box.git("config", "--local", "--get", "core.hooksPath"), ".githooks");
    assert.equal(readFileSync(box.globalConfig, "utf8"), "");
  });
});

test("a clean commit is pushed", () => {
  withSandbox((box) => {
    box.commit("README.md", "hello\n", "docs: add a readme");
    const result = box.push();
    assert.equal(result.status, 0, output(result));
    assert.ok(box.remoteHas("refs/heads/main"));
  });
});

test("a commit whose file holds a private term is blocked, without echoing the term", () => {
  withSandbox((box) => {
    box.commit("notes.md", `line one\nbranch ${TERM}/feature\n`, "docs: add notes");
    const result = box.push();
    assert.notEqual(result.status, 0, "push should be blocked");
    assert.ok(!box.remoteHas("refs/heads/main"), "nothing should reach the remote");
    assert.match(output(result), /notes\.md:2/);
    assert.ok(!output(result).includes(TERM), "the verdict must not print the term itself");
  });
});

test("a commit whose message holds a private term is blocked", () => {
  withSandbox((box) => {
    box.commit("README.md", "hello\n", `docs: add a readme for ${TERM}`);
    const result = box.push();
    assert.notEqual(result.status, 0, "push should be blocked");
    assert.ok(!box.remoteHas("refs/heads/main"));
    assert.match(output(result), /message:1/);
    assert.ok(!output(result).includes(TERM));
  });
});

test("a private email in a commit message is blocked", () => {
  withSandbox((box) => {
    box.commit("README.md", "hello\n", `docs: add a readme\n\nReported-by: ${PRIVATE_EMAIL}`);
    const result = box.push();
    assert.notEqual(result.status, 0, "push should be blocked");
    assert.match(output(result), /message:3/);
  });
});

test("a term added and removed again inside the pushed range is still blocked", () => {
  withSandbox((box) => {
    box.commit("notes.md", `${TERM}\n`, "docs: add notes");
    box.commit("notes.md", "clean now\n", "docs: clean the notes");
    const result = box.push();
    assert.notEqual(result.status, 0, "an intermediate commit still carries the term");
    assert.ok(!box.remoteHas("refs/heads/main"));
  });
});

test("only the new commits of a branch the remote already has are judged", () => {
  withSandbox((box) => {
    box.commit("README.md", "hello\n", "docs: add a readme");
    assert.equal(box.push().status, 0);
    box.commit("README.md", `hello ${TERM}\n`, "docs: extend the readme");
    const result = box.push();
    assert.notEqual(result.status, 0, "the second push should be blocked");
    assert.match(output(result), /README\.md:1/);
  });
});

test("without a private-terms file the push is allowed and says the term check was skipped", () => {
  withSandbox(
    (box) => {
      box.commit("notes.md", `${TERM}\n`, `docs: mention ${TERM}`);
      const result = box.push();
      assert.equal(result.status, 0, output(result));
      assert.ok(box.remoteHas("refs/heads/main"));
      assert.equal(output(result).split(SKIP_LINE).length - 1, 1, output(result));
    },
    { terms: null },
  );
});

test("without a private-terms file the other checks still block", () => {
  withSandbox(
    (box) => {
      box.commit("notes.md", `mail ${PRIVATE_EMAIL}\n`, "docs: add notes");
      const result = box.push();
      assert.notEqual(result.status, 0, "an email outside the allowed domains should block");
    },
    { terms: null },
  );
});

test("when the check itself cannot run, the push is blocked with its error", () => {
  withSandbox((box) => {
    rmSync(join(box.repo, "scripts", "private-data.test.mjs"));
    box.commit("README.md", "hello\n", "docs: add a readme");
    const result = box.push();
    assert.notEqual(result.status, 0, "an error of the guard's own must block, not allow");
    assert.ok(!box.remoteHas("refs/heads/main"));
    assert.match(output(result), /blocked/);
  });
});

test("deleting a remote branch sends no content and is allowed", () => {
  withSandbox((box) => {
    box.commit("README.md", "hello\n", "docs: add a readme");
    assert.equal(box.push().status, 0);
    box.git("branch", "extra");
    assert.equal(box.push("extra").status, 0);
    const result = box.push(":extra");
    assert.equal(result.status, 0, output(result));
    assert.ok(!box.remoteHas("refs/heads/extra"));
  });
});
