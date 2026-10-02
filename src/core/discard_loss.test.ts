import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { assessDiscard, discardPlan, judgeDiscardOutput, stashCommandFor, type DiscardLossDetail, type DiscardPlan, type GitReader } from "./discard_loss.ts";

const HOME = "/home/dev";
const RAW = /git\s+(reset(\s+-\S+)*\s+--hard|clean\s+(-\S*f\S*|--force))/;

const statusPlan = (plan: DiscardPlan | "unknown" | null) => {
  assert.ok(plan !== null && plan !== "unknown" && plan.kind === "status", `expected a status plan, got ${JSON.stringify(plan)}`);
  return plan;
};

test("reset --hard checks the index and the worktree of the whole tree, never untracked files", () => {
  const plan = statusPlan(discardPlan("reset", ["--hard", "origin/main"]));
  assert.deepEqual(plan.paths, []);
  assert.equal(plan.columns, "index-or-worktree");
  assert.equal(discardPlan("reset", ["--soft", "HEAD~1"]), null);
});

test("checkout and restore: which paths and which columns each form puts at risk", () => {
  assert.deepEqual(statusPlan(discardPlan("checkout", ["--", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("checkout", ["main", "--", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "index-or-worktree" });
  assert.deepEqual(statusPlan(discardPlan("checkout", ["."])), { kind: "status", paths: ["."], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("checkout", ["-f"])), { kind: "status", paths: [], columns: "index-or-worktree" });
  assert.deepEqual(statusPlan(discardPlan("checkout", ["--force", "main"])), { kind: "status", paths: [], columns: "index-or-worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["."])), { kind: "status", paths: ["."], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["--source=HEAD~1", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["-s", "HEAD~1", "--", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["--staged", "--worktree", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "index-or-worktree" });
  assert.deepEqual(statusPlan(discardPlan("restore", ["-SW", "src/a.ts"])), { kind: "status", paths: ["src/a.ts"], columns: "index-or-worktree" });
  assert.equal(discardPlan("restore", ["--staged", "src/a.ts"]), null);
  assert.equal(discardPlan("checkout", ["main"]), null);
});

test("forms the plan cannot read stay unknown, never guessed", () => {
  assert.equal(discardPlan("checkout", ["--pathspec-from-file=list.txt"]), "unknown");
  assert.equal(discardPlan("restore", ["--pathspec-from-file", "list.txt"]), "unknown");
  assert.equal(discardPlan("checkout", ["-b", "x", "."]), "unknown");
  assert.equal(discardPlan("checkout", ["main", "--"]), null);
  assert.equal(discardPlan("clean", ["-fi"]), "unknown");
  assert.equal(discardPlan("clean", ["--force", "--interactive"]), "unknown");
});

test("clean: the dry run replaces every force with -n, keeps -d, -x, -X and the pathspecs, and can never delete", () => {
  const cases: readonly (readonly [readonly string[], readonly string[], number])[] = [
    [["-f"], ["clean", "-n"], 1],
    [["-fd"], ["clean", "-n", "-d"], 1],
    [["-fdx"], ["clean", "-n", "-dx"], 1],
    [["-ffdx"], ["clean", "-n", "-dx"], 2],
    [["-f", "-X", "-d"], ["clean", "-n", "-X", "-d"], 1],
    [["--force", "-d", "src/"], ["clean", "-n", "-d", "src/"], 1],
    [["-d", "--force", "--", "-f", "a b"], ["clean", "-n", "-d", "--", "-f", "a b"], 1],
    [["-fq", "--quiet"], ["clean", "-n"], 1],
    [["-f", "-e", "keep.txt", "-d"], ["clean", "-n", "-e", "keep.txt", "-d"], 1],
    [["-fdekeep"], ["clean", "-n", "-dekeep"], 1],
    [["--for", "-d"], ["clean", "-n", "-d"], 1],
  ];
  for (const [args, expected, forceCount] of cases) {
    const plan = discardPlan("clean", args);
    assert.ok(plan !== null && plan !== "unknown" && plan.kind === "clean", `clean ${args.join(" ")}`);
    assert.deepEqual(plan.args, expected, `clean ${args.join(" ")}`);
    assert.equal(plan.forceCount, forceCount);
    const options = plan.args.slice(0, plan.args.includes("--") ? plan.args.indexOf("--") : undefined);
    assert.ok(options.includes("-n"), "the dry run carries -n");
    assert.ok(!options.some((word) => word === "--force" || /^-[a-zA-Z]*f/.test(word) && !/^-[a-zA-Z]*e/.test(word)), `no force survives in ${options.join(" ")}`);
  }
});

test("clean that already is a dry run discards nothing", () => {
  assert.deepEqual(discardPlan("clean", ["-nf"]), { kind: "nothing" });
  assert.deepEqual(discardPlan("clean", ["-f", "--dry-run"]), { kind: "nothing" });
  assert.equal(discardPlan("clean", ["-d"]), null);
});

test("porcelain status: staged and unstaged tracked changes count, untracked and ignored never do", () => {
  const output = [" M src/a.ts", "M  src/b.ts", "?? notes.txt", "!! dist/", "R  old.ts -> new.ts", " D gone.ts"].join("\n");
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "index-or-worktree" }, output, ""), { lost: true, count: 4, example: "src/a.ts", kind: "modified", paths: ["src/a.ts", "src/b.ts", "new.ts", "gone.ts"], ignoredToo: false });
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "worktree" }, output, ""), { lost: true, count: 2, example: "src/a.ts", kind: "modified", paths: ["src/a.ts", "gone.ts"], ignoredToo: false });
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "worktree" }, "M  staged.ts\n?? new.ts\n", ""), { lost: false });
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "index-or-worktree" }, "?? new.ts\n!! dist/\n", ""), { lost: false });
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "index-or-worktree" }, "", ""), { lost: false });
  assert.deepEqual(judgeDiscardOutput({ kind: "status", paths: [], columns: "worktree" }, 'R  "a b.ts" -> "c d.ts"\n M "e f.ts"\n', ""), { lost: true, count: 1, example: "e f.ts", kind: "modified", paths: ["e f.ts"], ignoredToo: false });
});

test("clean dry run: Would remove lines are the loss, with the example made relative to the repository root", () => {
  const plan: DiscardPlan = { kind: "clean", args: ["clean", "-n", "-d"], forceCount: 1 };
  assert.deepEqual(judgeDiscardOutput(plan, "Would remove notes/a.txt\nWould remove notes/b.txt\n", "pkg/"), { lost: true, count: 2, example: "pkg/notes/a.txt", kind: "untracked", paths: ["pkg/notes/a.txt", "pkg/notes/b.txt"], ignoredToo: false });
  assert.deepEqual(judgeDiscardOutput(plan, "", ""), { lost: false });
  assert.deepEqual(judgeDiscardOutput(plan, "Would skip repository vendor/x\n", ""), { lost: false });
  assert.deepEqual(judgeDiscardOutput({ ...plan, forceCount: 2 }, "Would skip repository vendor/x\n", ""), { lost: true, count: 1, example: "vendor/x", kind: "untracked", paths: ["vendor/x"], ignoredToo: false });
});

test("regenerated paths are no loss: tooling writes them back", () => {
  const status: DiscardPlan = { kind: "status", paths: [], columns: "worktree" };
  const output = [" M apps/web/next-env.d.ts", " M apps/web/CLAUDE.md"].join("\n");
  assert.deepEqual(judgeDiscardOutput(status, " M apps/web/next-env.d.ts\n", ""), { lost: false });
  // Only the built-in set is regenerated: CLAUDE.md is a change like any other.
  assert.deepEqual(judgeDiscardOutput(status, output, ""), { lost: true, count: 1, example: "apps/web/CLAUDE.md", kind: "modified", paths: ["apps/web/CLAUDE.md"], ignoredToo: false });
});

test("a mixed discard names only the real work", () => {
  const status: DiscardPlan = { kind: "status", paths: [], columns: "index-or-worktree" };
  const output = [" M apps/web/next-env.d.ts", " M apps/web/page.tsx", "M  tsconfig.tsbuildinfo", " M src/build/config.ts"].join("\n");
  assert.deepEqual(judgeDiscardOutput(status, output, ""), { lost: true, count: 2, example: "apps/web/page.tsx", kind: "modified", paths: ["apps/web/page.tsx", "src/build/config.ts"], ignoredToo: false });
});

test("a tracked change in a folder named like build output is source: the folder names apply to untracked files only", () => {
  const status: DiscardPlan = { kind: "status", paths: [], columns: "worktree" };
  for (const path of ["src/build/config.ts", "tmp/notes.md", "out/report.md", "packages/dist/index.ts"]) {
    assert.equal(judgeDiscardOutput(status, ` M ${path}\n`, "").lost, true, path);
  }
  const clean: DiscardPlan = { kind: "clean", args: ["clean", "-n", "-d"], forceCount: 1 };
  assert.deepEqual(judgeDiscardOutput(clean, "Would remove dist/\nWould remove node_modules/\nWould remove apps/web/.next/\n", ""), { lost: false });
  assert.equal(judgeDiscardOutput(clean, "Would remove dist/\nWould remove notes.md\n", "").lost, true);
});

test("a secret is never regenerated, even inside an output folder", () => {
  const clean: DiscardPlan = { kind: "clean", args: ["clean", "-n", "-d"], forceCount: 1 };
  assert.deepEqual(judgeDiscardOutput(clean, "Would remove dist/.env\nWould remove build/server.pem\n", ""), { lost: true, count: 2, example: "dist/.env", kind: "untracked", paths: ["dist/.env", "build/server.pem"], ignoredToo: false });
});

test("a clean that also removes ignored files says so, because a stash would need to keep them too", () => {
  const plan = discardPlan("clean", ["-fdx"]);
  assert.ok(plan !== null && plan !== "unknown" && plan.kind === "clean");
  const wide = judgeDiscardOutput(plan, "Would remove local.db\n", "");
  assert.ok(wide.lost);
  assert.equal(wide.ignoredToo, true);
  const plain = discardPlan("clean", ["-fd"]);
  assert.ok(plain !== null && plain !== "unknown" && plain.kind === "clean");
  const found = judgeDiscardOutput(plain, "Would remove notes.md\n", "");
  assert.ok(found.lost);
  assert.equal(found.ignoredToo, false);
});

const detail = (over: Partial<DiscardLossDetail> = {}): DiscardLossDetail => ({ count: 2, example: "src/a.ts", kind: "modified", paths: ["src/a.ts", "src/b c.ts"], ignoredToo: false, prefix: "", segment: "git restore .", ...over });

test("stashCommandFor: a reversible stash of exactly the paths that would be lost, quoted, tagged", () => {
  assert.equal(stashCommandFor(detail(), "jev-discard-x1"), "git stash push -m 'jev-discard-x1' -- 'src/a.ts' 'src/b c.ts'");
  assert.equal(stashCommandFor(detail({ kind: "untracked", paths: ["notes.md"] }), "t"), "git stash push -u -m 't' -- 'notes.md'");
  assert.equal(stashCommandFor(detail({ kind: "untracked", paths: ["local.db"], ignoredToo: true }), "t"), "git stash push -a -m 't' -- 'local.db'");
  assert.equal(stashCommandFor(detail({ paths: ["it's.ts"] }), "t"), "git stash push -m 't' -- 'it'\\''s.ts'");
});

test("stashCommandFor: from a subdirectory the paths are repository-root relative, so they carry the top magic", () => {
  assert.equal(stashCommandFor(detail({ prefix: "apps/web/", paths: ["apps/web/page.tsx"] }), "t"), "git stash push -m 't' -- ':/apps/web/page.tsx'");
});

test("stashCommandFor: too many paths to list is the whole tracked tree, or no suggestion when ignored files would come along", () => {
  const many = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
  assert.equal(stashCommandFor(detail({ count: 40, paths: many }), "t"), "git stash push -m 't'");
  assert.equal(stashCommandFor(detail({ count: 40, paths: many, kind: "untracked" }), "t"), "git stash push -u -m 't'");
  assert.equal(stashCommandFor(detail({ count: 40, paths: many, kind: "untracked", ignoredToo: true }), "t"), null);
});

// A fake git: it answers from a table keyed by the directory and the first words of the call.
function fakeGit(answers: Readonly<Record<string, string | null>>, calls: string[] = []): GitReader {
  return (args, dir) => {
    const key = `${dir}|${args.join(" ")}`;
    calls.push(key);
    for (const [pattern, answer] of Object.entries(answers)) if (key.startsWith(pattern)) return answer;
    return null;
  };
}

const DIRTY = fakeGit({ "/w/app|--no-optional-locks status": " M src/x.ts\n M src/y.ts\n", "/w/app|rev-parse --show-prefix": "" });
const CLEAN = fakeGit({ "/w/app|--no-optional-locks status": "", "/w/app|clean -n": "", "/w/app|rev-parse --show-prefix": "" });
const assess = (command: string, git: GitReader, cwd = "/w/app") => assessDiscard(command, cwd, HOME, git, RAW);

test("assessDiscard: a clean tree loses nothing, a dirty one names the loss", () => {
  assert.deepEqual(assess("git reset --hard origin/main", CLEAN), { severity: null, loss: null });
  assert.deepEqual(assess("git reset --hard origin/main", DIRTY), { severity: "deny", loss: { count: 2, example: "src/x.ts", kind: "modified", paths: ["src/x.ts", "src/y.ts"], ignoredToo: false, prefix: "", segment: "git reset --hard origin/main" } });
  assert.deepEqual(assess("git clean -fd", CLEAN), { severity: null, loss: null });
  assert.deepEqual(assess("git fetch && git reset --hard origin/main", CLEAN), { severity: null, loss: null });
});

test("assessDiscard: the directory is the one the command acts on: a leading cd, then git -C", () => {
  const both = fakeGit({
    "/w/clean|--no-optional-locks status": "",
    "/w/clean|rev-parse": "",
    "/w/dirty|--no-optional-locks status": " M a.ts\n",
    "/w/dirty|rev-parse": "",
  });
  assert.deepEqual(assess("cd /w/clean && git reset --hard", both, "/w/dirty"), { severity: null, loss: null });
  assert.equal(assess("cd /w/dirty && git reset --hard", both, "/w/clean").loss?.count, 1);
  assert.deepEqual(assess("git -C /w/clean reset --hard", both, "/w/dirty"), { severity: null, loss: null });
  assert.equal(assess("git -C /w/dirty reset --hard", both, "/w/clean").loss?.count, 1);
  assert.equal(assess("git -C ../dirty reset --hard", both, "/w/clean").loss?.count, 1);
});

test("assessDiscard: files tooling rewrites are not a loss; any other file is", () => {
  const rewritten = fakeGit({ "/w/app|--no-optional-locks status": " M apps/web/next-env.d.ts\n M tsconfig.tsbuildinfo\n", "/w/app|rev-parse --show-prefix": "" });
  assert.deepEqual(assess("git restore apps/web/next-env.d.ts tsconfig.tsbuildinfo", rewritten), { severity: null, loss: null });
  const notes = fakeGit({ "/w/app|--no-optional-locks status": " M apps/web/CLAUDE.md\n", "/w/app|rev-parse --show-prefix": "" });
  assert.equal(assess("git restore apps/web/CLAUDE.md", notes).loss?.count, 1, "CLAUDE.md is a change like any other");
});

test("assessDiscard: a clean tree costs the one status call", () => {
  const calls: string[] = [];
  assess("git reset --hard", fakeGit({ "/w/app|--no-optional-locks status": "" }, calls));
  assert.equal(calls.length, 1, calls.join("\n"));
});

test("assessDiscard: real work next to regenerated files is still refused, naming only the real work", () => {
  const git = fakeGit({ "/w/app|--no-optional-locks status": " M apps/web/next-env.d.ts\n M apps/web/page.tsx\n", "/w/app|rev-parse --show-prefix": "" });
  const assessment = assess("git restore apps/web/next-env.d.ts apps/web/page.tsx", git);
  assert.equal(assessment.loss?.count, 1);
  assert.deepEqual(assessment.loss?.paths, ["apps/web/page.tsx"]);
});

test("assessDiscard: a repository-relative prefix is applied before the built-in set is read", () => {
  const git = fakeGit({ "/w/app/apps/web|clean -n": "Would remove next-env.d.ts\n", "/w/app/apps/web|rev-parse --show-prefix": "apps/web/\n" });
  assert.deepEqual(assess("git clean -f next-env.d.ts", git, "/w/app/apps/web"), { severity: null, loss: null });
  const real = fakeGit({ "/w/app/apps/web|clean -n": "Would remove notes.md\n", "/w/app/apps/web|rev-parse --show-prefix": "apps/web/\n" });
  assert.equal(assess("git clean -f notes.md", real, "/w/app/apps/web").loss?.example, "apps/web/notes.md");
});

test("assessDiscard: an unreadable prefix fails closed rather than guessing where the paths are", () => {
  const git = fakeGit({ "/w/app|--no-optional-locks status": " M apps/web/next-env.d.ts\n" });
  assert.deepEqual(assess("git restore apps/web/next-env.d.ts", git), { severity: "deny", loss: null });
});

test("assessDiscard: a directory the dry run collapses is searched for secrets before it is excused", () => {
  const base = { "/w/app|clean -n": "Would remove dist/\n", "/w/app|rev-parse --show-prefix": "" };
  const withSecret = fakeGit({ ...base, "/w/app|ls-files -o --exclude-standard": "dist/.env\n" });
  const found = assess("git clean -fd", withSecret).loss;
  assert.equal(found?.kind, "untracked");
  assert.deepEqual(found?.paths, ["dist/.env"]);
  assert.deepEqual(assess("git clean -fd", fakeGit({ ...base, "/w/app|ls-files -o --exclude-standard": "" })), { severity: null, loss: null });
  // -x also removes ignored files, so the search covers them too.
  const ignored = fakeGit({ ...base, "/w/app|ls-files -o -i --exclude-standard": "dist/server.pem\n" });
  assert.deepEqual(assess("git clean -fdx", ignored).loss?.paths, ["dist/server.pem"]);
  // A search that cannot run is today's refusal; so is a directory name git would read as a glob.
  assert.deepEqual(assess("git clean -fd", fakeGit(base)), { severity: "deny", loss: null });
  assert.deepEqual(assess("git clean -fd", fakeGit({ "/w/app|clean -n": "Would remove build/[1]/\n", "/w/app|rev-parse --show-prefix": "" })), { severity: "deny", loss: null });
});

test("assessDiscard: a single excused file needs no search for secrets, and the search only ever names untracked files", () => {
  const calls: string[] = [];
  assess("git clean -fd", fakeGit({ "/w/app|clean -n": "Would remove .next/trace\n", "/w/app|rev-parse --show-prefix": "" }, calls));
  assert.ok(calls.every((call) => !call.includes("ls-files")), calls.join("\n"));
});

test("assessDiscard fails closed, to today's deny with no loss to name", () => {
  const closed = { severity: "deny", loss: null };
  for (const command of [
    'ssh host "git reset --hard"',
    'eval "git reset --hard"',
    'bash -c "git reset --hard"',
    'sh -c "git clean -fd"',
    'su -c "git reset --hard"',
    'watch git reset --hard',
    'script -c "git reset --hard" /dev/null',
    'echo "$(git reset --hard)"',
    "echo `git reset --hard`",
    "find . | xargs git checkout --",
    "git --git-dir=/w/x/.git reset --hard",
    "git --work-tree=/w/x reset --hard",
    "HOME=/w/other git reset --hard",
    "GIT_DIR=/w/x/.git git reset --hard",
    "GIT_WORK_TREE=/w/x git reset --hard",
    "cd $REPO && git reset --hard",
    "git checkout --pathspec-from-file=list.txt",
  ]) assert.deepEqual(assess(command, CLEAN), closed, command);
  // Not a repository, git failing and a timeout all read as null.
  assert.deepEqual(assess("git reset --hard", fakeGit({})), closed);
  assert.deepEqual(assess("git reset --hard", fakeGit({ "/w/app|--no-optional-locks status": null })), closed);
});

test("assessDiscard: an earlier command that may change the tree makes a clean reading untrustworthy", () => {
  assert.deepEqual(assess("git stash pop && git reset --hard", CLEAN), { severity: "deny", loss: null });
  assert.deepEqual(assess("sed -i s/a/b/ f.txt && git reset --hard", CLEAN), { severity: "deny", loss: null });
  assert.deepEqual(assess("echo hi > f.txt && git reset --hard", CLEAN), { severity: "deny", loss: null });
  assert.deepEqual(assess("git status && git log -1 && git checkout main && git reset --hard", CLEAN), { severity: null, loss: null });
});

test("assessDiscard: every discard in the line is checked, and a later one still refuses", () => {
  assert.equal(assess("git reset --hard && git clean -fd", fakeGit({ "/w/app|--no-optional-locks status": "", "/w/app|clean -n": "Would remove x\n", "/w/app|rev-parse": "" })).loss?.kind, "untracked");
  assert.deepEqual(assess("git reset --hard && git clean -fd", CLEAN), { severity: null, loss: null });
});

test("assessDiscard: a clean discard next to an interpreter-code match keeps that match's own severity", () => {
  assert.equal(assess(`git reset --hard && python3 -c "import os; os.system('git clean -fd')"`, CLEAN).severity, "code");
});

test("assessDiscard never spawns anything that could delete: every call is a status or a dry run", () => {
  const calls: string[] = [];
  const git = fakeGit({ "/w/app|": "" }, calls);
  assess("git clean -ffdx src/", git);
  assess("git reset --hard", git);
  assess("git restore -SW .", git);
  assert.ok(calls.length >= 3);
  for (const call of calls) assert.match(call, /\|(--no-optional-locks status --porcelain|clean -n|rev-parse --show-prefix|config --get remote\.origin\.url|ls-files -o)/, call);
  assert.ok(calls.every((call) => !/\s(-f|--force)(\s|$)/.test(call.split("|")[1] ?? "")), "no call carries a force");
});

// Real repositories: the dry run really leaves the untracked file in place.
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
test("the clean dry run, run for real, leaves every untracked file in place", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "discard-loss-")));
  dirs.push(repo);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  git("init", "-q");
  writeFileSync(join(repo, "tracked.txt"), "t\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  mkdirSync(join(repo, "scratch"));
  writeFileSync(join(repo, "scratch", "keep.txt"), "k\n");
  writeFileSync(join(repo, "loose.txt"), "l\n");
  const plan = discardPlan("clean", ["-ffdx"]);
  assert.ok(plan !== null && plan !== "unknown" && plan.kind === "clean");
  const out = git(...plan.args);
  assert.match(out, /Would remove loose\.txt/);
  assert.match(out, /Would remove scratch\//);
  assert.ok(existsSync(join(repo, "loose.txt")) && existsSync(join(repo, "scratch", "keep.txt")));
});
