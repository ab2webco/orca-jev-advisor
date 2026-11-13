// Unit tests for ignored_files.ts on real git repositories, with the git
// runner injected so a failure or a timeout can be forced at every call.
// odd/tasks/gate-ignored-files-not-main.md. Run with:
//   node --test --experimental-strip-types src/core/ignored_files.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createJevPseudonyms } from "./jev_pseudonyms.ts";
import { buildIgnoredPathsSentence, gitSubprocessEnv, verifyIgnoredTargets, type GitRunner } from "./ignored_files.ts";
import type { TrivialTarget } from "./trivial_write.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixtureGit(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull } });
  assert.equal(result.status, 0, `git ${args.join(" ")}`);
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  fixtureGit(["init", "-q", "-b", "main"], root);
  fixtureGit(["config", "user.email", "test@test.com"], root);
  fixtureGit(["config", "user.name", "test"], root);
}

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly git: GitRunner;
}

/** A repository with a tracked src/a.ts, `odd/` in .git/info/exclude, `tmp/` in a tracked .gitignore, `notes/` in the home's global excludes file, and a force-added odd/kept.md. */
function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orca-jev-ignored-files-")));
  roots.push(base);
  const repo = join(base, "repo");
  const home = join(base, "home");
  initRepo(repo);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "odd", "tasks"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "a\n");
  writeFileSync(join(repo, ".gitignore"), "tmp/\n");
  writeFileSync(join(repo, "odd", "kept.md"), "kept\n");
  writeFileSync(join(repo, "odd", "tasks", "x.md"), "x\n");
  writeFileSync(join(repo, ".git", "info", "exclude"), "odd/\n");
  fixtureGit(["add", "src/a.ts", ".gitignore"], repo);
  fixtureGit(["add", "-f", "odd/kept.md"], repo);
  fixtureGit(["commit", "-q", "-m", "files"], repo);
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  writeFileSync(join(home, ".config", "git", "ignore"), "notes/\n");
  const git: GitRunner = (args, cwd, input) => {
    const result = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { ...gitSubprocessEnv(process.env), HOME: home } });
    return result.status === null ? null : { status: result.status, stdout: result.stdout };
  };
  return { repo, home, git };
}

const file = (word: string): TrivialTarget => ({ word, kind: "file" });

function verify(fx: Fixture, targets: readonly TrivialTarget[], git: GitRunner = fx.git, cwd: string = fx.repo) {
  return verifyIgnoredTargets(targets, cwd, { home: fx.home, xdgConfigHome: undefined }, git);
}

test("verifyIgnoredTargets: every target ignored by exclude, .gitignore or the global excludes file, nothing tracked there", () => {
  const fx = fixture();
  assert.deepEqual(verify(fx, [file("odd/tasks/x.md"), file("tmp/a.md"), file("notes/b.md"), file("./odd/new.md")]), {
    allIgnored: true,
    ignored: ["odd/tasks/x.md", "tmp/a.md", "notes/b.md", "odd/new.md"],
  });
  assert.deepEqual(verify(fx, [file("tasks/x.md")], fx.git, join(fx.repo, "odd")), { allIgnored: true, ignored: ["odd/tasks/x.md"] });
  assert.deepEqual(verify(fx, [file(join(fx.repo, "odd", "abs.md"))]), { allIgnored: true, ignored: ["odd/abs.md"] });
});

test("verifyIgnoredTargets: a tracked file, a new file git would track, or a tracked file in an ignored directory is not ignored", () => {
  const fx = fixture();
  assert.deepEqual(verify(fx, [file("odd/tasks/x.md"), file("src/a.ts")]), { allIgnored: false, ignored: ["odd/tasks/x.md"] });
  assert.deepEqual(verify(fx, [file("src/new.ts")]), { allIgnored: false, ignored: [] });
  assert.deepEqual(verify(fx, [file("odd/kept.md")]), { allIgnored: false, ignored: [] });
  assert.deepEqual(verify(fx, [file("ODD/KEPT.md")]), { allIgnored: false, ignored: [] });
  assert.deepEqual(verify(fx, [{ word: "src/a.ts", kind: "removed" }, file("odd/a.ts")]), { allIgnored: false, ignored: ["odd/a.ts"] });
});

test("verifyIgnoredTargets: mkdir -p counts every directory it creates", () => {
  const fx = fixture();
  assert.deepEqual(verify(fx, [{ word: "odd/new/deep", kind: "dirs" }]), { allIgnored: true, ignored: ["odd/new/deep"] });
  assert.deepEqual(verify(fx, [{ word: "odd/tasks", kind: "dirs" }]), { allIgnored: true, ignored: ["odd/tasks"] });
  // `tmp/` matches directories only: a tmp/ git has not seen is not known to be ignored.
  assert.deepEqual(verify(fx, [{ word: "tmp/x", kind: "dirs" }]), { allIgnored: false, ignored: [] });
});

test("verifyIgnoredTargets: a symlink, a hard link, a nested repository or the wrong kind of file fails closed", () => {
  const fx = fixture();
  symlinkSync(join(fx.repo, "src"), join(fx.repo, "odd", "s"));
  symlinkSync(join(fx.repo, "src", "a.ts"), join(fx.repo, "odd", "l.ts"));
  symlinkSync(join(fx.repo, "odd", "tasks", "x.md"), join(fx.repo, "odd", "to-ignored.md"));
  linkSync(join(fx.repo, "src", "a.ts"), join(fx.repo, "odd", "h"));
  writeFileSync(join(fx.repo, "odd", "solo"), "x");
  linkSync(join(fx.repo, "odd", "solo"), join(fx.repo, "odd", "solo-twin"));
  initRepo(join(fx.repo, "odd", "inner"));
  assert.equal(verify(fx, [file("odd/s/new.ts")]), null);
  assert.equal(verify(fx, [file("odd/l.ts")]), null);
  assert.equal(verify(fx, [file("odd/to-ignored.md")]), null);
  assert.equal(verify(fx, [file("odd/h")]), null);
  assert.equal(verify(fx, [file("odd/solo")]), null);
  assert.equal(verify(fx, [file("odd/inner/a.ts")]), null);
  assert.equal(verify(fx, [file("odd/tasks")]), null);
  assert.equal(verify(fx, [{ word: "odd/tasks/x.md", kind: "dir" }]), null);
  // One bad target fails the whole command: no partial facts.
  assert.equal(verify(fx, [file("odd/tasks/x.md"), file("odd/h")]), null);
});

test("verifyIgnoredTargets: an ignore source, a path in .git, the root or a path outside it fails closed", () => {
  const fx = fixture();
  fixtureGit(["config", "core.excludesFile", join(fx.repo, "odd", "rules")], fx.repo);
  writeFileSync(join(fx.repo, "odd", "rules"), "scratch/\n");
  assert.equal(verify(fx, [file("odd/rules")]), null);
  assert.equal(verify(fx, [file("odd/.gitignore")]), null);
  assert.equal(verify(fx, [file(".gitignore")]), null);
  assert.equal(verify(fx, [file(".git/info/exclude")]), null);
  assert.equal(verify(fx, [file(join(fx.home, ".config", "git", "ignore"))]), null);
  assert.equal(verify(fx, [file("/tmp/outside.md")]), null);
  assert.equal(verify(fx, [{ word: ".", kind: "dirs" }]), null);
  assert.equal(verify(fx, [file("odd/../src/a.ts")]), null);
  assert.equal(verify(fx, []), null);
});

test("verifyIgnoredTargets: a non-ASCII target fails closed (APFS folds case and normalization, git icase folds ASCII only)", () => {
  const fx = fixture();
  fixtureGit(["config", "core.ignorecase", "true"], fx.repo);
  fixtureGit(["config", "core.precomposeunicode", "true"], fx.repo);
  writeFileSync(join(fx.repo, "odd", "\u00d1.md"), "n");
  fixtureGit(["add", "-f", "odd/\u00d1.md"], fx.repo);
  assert.equal(verify(fx, [file("odd/\u00f1.md")]), null);
  assert.equal(verify(fx, [file("odd/e\u0301.md")]), null);
  assert.equal(verify(fx, [{ word: "odd/\u00fcber/x", kind: "dirs" }]), null);
  assert.deepEqual(verify(fx, [file("odd/plain.md")]), { allIgnored: true, ignored: ["odd/plain.md"] });
});

test("verifyIgnoredTargets: .git/info/exclude reached through a symlink into the worktree is an ignore source", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, "odd", "exclude-rules"), "odd/\n");
  rmSync(join(fx.repo, ".git", "info", "exclude"));
  symlinkSync(join(fx.repo, "odd", "exclude-rules"), join(fx.repo, ".git", "info", "exclude"));
  assert.equal(verify(fx, [file("odd/exclude-rules")]), null);
  assert.deepEqual(verify(fx, [file("odd/tasks/x.md")]), { allIgnored: true, ignored: ["odd/tasks/x.md"] });
});

test("verifyIgnoredTargets: the global excludes file under the home's config dir is an ignore source even inside the repository", () => {
  const fx = fixture();
  const xdg = join(fx.repo, "odd", "xdg");
  mkdirSync(join(xdg, "git"), { recursive: true });
  writeFileSync(join(xdg, "git", "ignore"), "scratch/\n");
  assert.equal(verifyIgnoredTargets([file("odd/xdg/git/ignore")], fx.repo, { home: fx.home, xdgConfigHome: xdg }, fx.git), null);
  assert.equal(verifyIgnoredTargets([{ word: "odd/xdg", kind: "dirs" }], fx.repo, { home: fx.home, xdgConfigHome: xdg }, fx.git), null);
});

test("verifyIgnoredTargets: inside a submodule fails closed", () => {
  const fx = fixture();
  const origin = join(fx.repo, "..", "origin");
  initRepo(origin);
  writeFileSync(join(origin, "a.ts"), "a\n");
  fixtureGit(["add", "a.ts"], origin);
  fixtureGit(["commit", "-q", "-m", "a"], origin);
  fixtureGit(["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub"], fx.repo);
  assert.equal(verify(fx, [file("sub/a.ts")]), null);
  assert.equal(verify(fx, [file("a.ts")], fx.git, join(fx.repo, "sub")), null);
});

test("verifyIgnoredTargets: any git call that fails, exits wrong or times out fails closed", () => {
  const fx = fixture();
  const targets = [file("odd/tasks/x.md")];
  assert.deepEqual(verify(fx, targets), { allIgnored: true, ignored: ["odd/tasks/x.md"] });
  const calls: string[] = [];
  const recording: GitRunner = (args, cwd, input) => {
    calls.push(args[0] ?? "");
    return fx.git(args, cwd, input);
  };
  verify(fx, targets, recording);
  assert.deepEqual(calls, ["rev-parse", "config", "check-ignore", "ls-files"]);
  for (const failing of calls) {
    const timedOut: GitRunner = (args, cwd, input) => (args[0] === failing ? null : fx.git(args, cwd, input));
    const fatal: GitRunner = (args, cwd, input) => (args[0] === failing ? { status: 128, stdout: "" } : fx.git(args, cwd, input));
    const garbage: GitRunner = (args, cwd, input) => (args[0] === failing ? { status: 0, stdout: "odd/tasks/x.md\0src/a.ts\0\n/elsewhere\n" } : fx.git(args, cwd, input));
    assert.equal(verify(fx, targets, timedOut), null, `${failing} timed out`);
    assert.equal(verify(fx, targets, fatal), null, `${failing} exited 128`);
    if (failing !== "check-ignore") assert.notDeepEqual(verify(fx, targets, garbage), { allIgnored: true, ignored: ["odd/tasks/x.md"] }, `${failing} answered garbage`);
  }
  const throwing: GitRunner = () => {
    throw new Error("spawn failed");
  };
  assert.equal(verify(fx, targets, throwing), null);
});

test("gitSubprocessEnv: no variable that moves git's repository, index or config survives; the ceiling does", () => {
  const env = gitSubprocessEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    GIT_DIR: "/decoy/.git",
    GIT_WORK_TREE: "/decoy",
    GIT_INDEX_FILE: "/decoy/index",
    GIT_COMMON_DIR: "/decoy/common",
    GIT_OBJECT_DIRECTORY: "/decoy/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/decoy/alt",
    GIT_CONFIG: "/decoy/config",
    GIT_CONFIG_GLOBAL: "/decoy/global",
    GIT_CONFIG_SYSTEM: "/decoy/system",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/decoy/ignore",
    GIT_CONFIG_PARAMETERS: "'core.excludesfile'='/decoy'",
    GIT_CEILING_DIRECTORIES: "/home",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", GIT_CEILING_DIRECTORIES: "/home", GIT_OPTIONAL_LOCKS: "0" });
});

test("buildIgnoredPathsSentence: repository paths git verified, and no other path known to be ignored", () => {
  assert.equal(buildIgnoredPathsSentence([]), null);
  assert.equal(
    buildIgnoredPathsSentence(["odd/tasks/x.md", "tmp/handoff.md"]),
    "Checked with git, not read from the command: git ignores these repository paths the command writes (odd/tasks/x.md, tmp/handoff.md), so they are in no commit and on no branch. No other path is known to be ignored.",
  );
  const sentence = buildIgnoredPathsSentence(["odd/y.md"], createJevPseudonyms());
  assert.ok(sentence !== null);
  assert.match(sentence, /odd\/y\.md/);
});
