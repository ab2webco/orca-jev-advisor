// Unit tests for the own-working-tree reading of contained_effect.ts
// (0.6.28 T6) -- pure: a fake realpath and a fake repository lookup. Run with:
//   node --test --experimental-strip-types src/core/own_tree_effect.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { isOwnTreeWork } from "./contained_effect.ts";
import type { ContainedEffectInput, OwnTree } from "./contained_effect.ts";

const HOME = "/home/someone";
const PROJECT = `${HOME}/project`;
const WORKTREE = `${HOME}/project-wt`;
const OTHER_MAIN = `${HOME}/other`;
const SIDE = `${HOME}/side`;

const TREES: readonly OwnTree[] = [
  { root: PROJECT, branch: "feat/x", commonDir: `${PROJECT}/.git` },
  { root: WORKTREE, branch: "feat/y", commonDir: `${PROJECT}/.git` },
  { root: OTHER_MAIN, branch: "main", commonDir: `${OTHER_MAIN}/.git` },
  { root: SIDE, branch: "feat/z", commonDir: `${SIDE}/.git` },
];

const DIRS = [
  "/home", HOME, PROJECT, `${PROJECT}/.git`, `${PROJECT}/.git/config`, `${PROJECT}/src`, `${PROJECT}/src/a.ts`, `${PROJECT}/package.json`, `${PROJECT}/docs`,
  WORKTREE, `${WORKTREE}/src`, OTHER_MAIN, `${OTHER_MAIN}/src`, SIDE, "/private", "/private/tmp", "/private/tmp/x",
];
const LINKS: Readonly<Record<string, string>> = { "/tmp": "/private/tmp", [`${PROJECT}/home-link`]: HOME };

function fakeRealpath(path: string): string | null {
  let current = "";
  for (const part of path.split("/").filter((p) => p.length > 0)) {
    current = `${current}/${part}`;
    for (let hops = 0; LINKS[current] !== undefined; hops += 1) {
      if (hops > 8) return null;
      current = LINKS[current] ?? current;
    }
    if (!DIRS.includes(current)) return null;
  }
  return current.length === 0 ? "/" : current;
}

function treesWith(overrides: Readonly<Record<string, string | null>>): (path: string) => OwnTree | null {
  return (path: string): OwnTree | null => {
    const tree = [...TREES].sort((a, b) => b.root.length - a.root.length).find((t) => path === t.root || path.startsWith(`${t.root}/`));
    if (tree === undefined) return null;
    return tree.root in overrides ? { ...tree, branch: overrides[tree.root] ?? null } : tree;
  };
}

function own(command: string, { cwd = PROJECT, branches = {} }: { readonly cwd?: string; readonly branches?: Readonly<Record<string, string | null>> } = {}): boolean {
  const input: ContainedEffectInput = {
    tempRoots: ["/tmp", "/private/tmp"],
    cwd,
    env: { HOME },
    realpath: fakeRealpath,
    sessionRepoRoot: cwd === PROJECT ? PROJECT : null,
    isLinkedWorktree: () => false,
  };
  return isOwnTreeWork(command, input, { treeOf: treesWith(branches), protectedBranches: new Set(["main", "master", "production", "develop", "staging"]) });
}

test("own tree: a heredoc written into a source file on a working branch", () => {
  assert.equal(own("cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF"), true);
});

test("own tree: a substitution-only sed, then add and commit", () => {
  assert.equal(own("sed -i '' 's/v1/v2/' package.json && git add package.json && git commit -qm \"chore: bump\""), true);
  assert.equal(own("sed -i -e 's/a/b/g' -e '/x/s|c|d|' src/a.ts"), true);
});

test("own tree: git -C into the tree, and mkdir with printf", () => {
  assert.equal(own(`git -C ${PROJECT} add -A && git -C ${PROJECT} commit -qm x`, { cwd: HOME }), true);
  assert.equal(own("mkdir -p docs/x && printf '%s\\n' a > docs/x/a.md"), true);
});

test("own tree: a linked worktree of the session repository, and a tree entered with cd", () => {
  assert.equal(own(`echo x > ${WORKTREE}/src/b.ts`), true);
  assert.equal(own(`cd ${SIDE} && echo x > notes.md && git add notes.md`), true);
});

test("own tree: plain local git", () => {
  for (const command of ["git checkout -b feat/new", "git switch -c feat/new", "git switch feat/other", "git stash push -m wip", "git stash", "git restore --staged src/a.ts", "git commit --amend --no-edit", "rm -f src/a.ts"]) {
    assert.equal(own(command), true, command);
  }
});

test("must stop: the same work on main, master or a detached HEAD", () => {
  for (const branch of ["main", "master", null]) {
    assert.equal(own("cat > src/a.ts <<'EOF'\nx\nEOF", { branches: { [PROJECT]: branch } }), false, String(branch));
    assert.equal(own("git add x && git commit -qm x", { branches: { [PROJECT]: branch } }), false, String(branch));
  }
});

test("must stop: recursive deletes, .git, the tree root, a path that leaves the tree", () => {
  assert.equal(own("rm -r src"), false);
  assert.equal(own("rm -rf src/a.ts"), false);
  assert.equal(own("rm .git/config"), false);
  assert.equal(own("echo x > .git/HEAD"), false);
  assert.equal(own(`rm -f ${PROJECT}`), false);
  assert.equal(own("cat > ../other/x"), false);
  assert.equal(own("echo x > home-link/.zshrc"), false);
  assert.equal(own("rm -f src/*.ts"), false);
});

test("must stop: a sed that runs or writes elsewhere", () => {
  assert.equal(own("sed -i 's/a/b/e' src/a.ts"), false);
  assert.equal(own("sed -i '1w /etc/x' src/a.ts"), false);
  assert.equal(own("sed -i 's/a/b/w /etc/x' src/a.ts"), false);
  assert.equal(own("sed -i '1r /etc/passwd' src/a.ts"), false);
  assert.equal(own("sed -i 'e id' src/a.ts"), false);
  assert.equal(own("sed -i -f script.sed src/a.ts"), false);
});

test("must stop: git that discards, rewrites or reaches a protected branch", () => {
  for (const command of [
    "git reset --hard",
    "git checkout -- .",
    "git restore src/a.ts",
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git checkout main && echo x > f",
    "git switch main",
    "git checkout -b feat/y origin/main",
    "git rebase origin/main",
    "git merge feat/y",
    "git cherry-pick abc",
    "git branch -D feat/y",
    "git push origin feat/x",
    "git clean -fd",
    "git stash drop",
    "git -c core.hooksPath=/tmp/x commit -m x",
  ]) {
    assert.equal(own(command), false, command);
  }
});

test("must stop: a sibling repository not entered with cd, or entered on main", () => {
  assert.equal(own(`echo x > ${SIDE}/notes.md`), false);
  assert.equal(own(`echo x > ${OTHER_MAIN}/src/x`), false);
  assert.equal(own(`cd ${OTHER_MAIN} && echo x > notes.md`), false);
});

test("must stop: interpreter code and scripts, even in the tree", () => {
  assert.equal(own("python3 - <<'EOF'\nprint(1)\nEOF"), false);
  assert.equal(own("node -e 'require(\"fs\").writeFileSync(\"x\", \"y\")'"), false);
  assert.equal(own("./scripts/build.sh"), false);
});

test("probe: more shapes, each read the way the rule says", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["git add x && git push origin feat/x", false],
    ["echo x > src/a.ts && python3 x.py", false],
    [`git -C ${OTHER_MAIN} add .`, false],
    ['git commit -m "fix" && git checkout main', false],
    [`sed -i 's/a/b/' ${HOME}/.zshrc`, false],
    [`cp ${HOME}/.ssh/id_rsa src/k`, false],
    ["mv src/a.ts /tmp/x/a", true],
    ["ln -s ~ src/l && rm -f src/l/.zshrc", false],
    ["touch .git/hooks/pre-commit", false],
    ["echo x > .gitignore", true],
    ["sed -i 's/a/b/;w /x' src/a.ts", false],
    ["sed -i '' -e 's/a/b/' src/a.ts", true],
    ["sed -i 's/a/b/' src/a.ts > src/b.ts", true],
    ["git switch -", false],
    ["git checkout -b feat/a && cat > src/x.ts <<'EOF'\nx\nEOF", true],
    ["git status && git add -A && git commit -qm x", true],
    ["git add -A; git commit -qm x || true", true],
  ];
  for (const [command, expected] of cases) assert.equal(own(command), expected, command);
});

// 0.6.28 pre-release C: the agent must never rewrite its own harness through
// a local allow -- Claude Code's settings and hooks, its agents, the MCP list.
test("must stop: Claude Code's own configuration, in the tree or anywhere else", () => {
  for (const command of [
    "echo '{}' > .claude/settings.json",
    "sed -i 's/a/b/' .claude/settings.local.json",
    "mkdir -p .claude/hooks && cat > .claude/hooks/pre.sh <<'EOF'\nexit 0\nEOF",
    "cp /tmp/x/a .claude/agents/a.md",
    "rm -f .claude/settings.json",
    "echo '{}' > .mcp.json",
    "echo '{}' > src/.claude/settings.json",
  ]) {
    assert.equal(own(command), false, command);
  }
});
