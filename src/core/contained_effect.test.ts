// Unit tests for contained_effect.ts -- pure: the filesystem is a fake
// realpath over a list of paths and symlinks, the environment a plain
// object. Run with:
//   node --test --experimental-strip-types src/core/contained_effect.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { isContainedToTempRoots, tempRootsFromEnvironment } from "./contained_effect.ts";
import type { ContainedEffectInput } from "./contained_effect.ts";

const HOME = "/home/someone";
const PROJECT = "/home/someone/project";
const MAC_TMP = "/var/folders/ab/cd/T";
const CLAUDE_ROOT = "/claude-tmp/claude-501";

/**
 * A realpath over `dirs` (every existing directory or file) and `links`
 * (symlink -> target): each component is followed through the links, and a
 * component that does not exist answers null, like realpathSync throwing.
 */
function fakeRealpath(dirs: readonly string[], links: Readonly<Record<string, string>>): (path: string) => string | null {
  const existing = new Set(dirs);
  return (path: string): string | null => {
    let current = "";
    for (const part of path.split("/").filter((p) => p.length > 0)) {
      current = `${current}/${part}`;
      for (let hops = 0; links[current] !== undefined; hops += 1) {
        if (hops > 8) return null;
        current = links[current] ?? current;
      }
      if (!existing.has(current)) return null;
    }
    return current.length === 0 ? "/" : current;
  };
}

const DIRS = [
  "/home", HOME, PROJECT, `${HOME}/.ssh`, `${HOME}/.ssh/id_rsa`, `${HOME}/.zshrc`,
  "/private", "/private/tmp", "/private/tmp/x", "/private/tmp/x/a", "/private/tmp/proj", "/private/tmp/wt",
  "/private/var", "/private/var/folders", "/private/var/folders/ab", "/private/var/folders/ab/cd", "/private/var/folders/ab/cd/T",
  "/claude-tmp", CLAUDE_ROOT, `${CLAUDE_ROOT}/proj`, `${CLAUDE_ROOT}/proj/sess`, `${CLAUDE_ROOT}/proj/sess/scratchpad`,
];
const LINKS = { "/tmp": "/private/tmp", "/var": "/private/var", "/private/tmp/x/link": HOME };

function input(overrides: Partial<ContainedEffectInput> = {}): ContainedEffectInput {
  return {
    tempRoots: ["/tmp", "/private/tmp", "/var/folders", MAC_TMP, CLAUDE_ROOT],
    cwd: PROJECT,
    env: { HOME, TMPDIR: `${MAC_TMP}/` },
    realpath: fakeRealpath(DIRS, LINKS),
    sessionRepoRoot: PROJECT,
    isLinkedWorktree: () => false,
    ...overrides,
  };
}

function contained(command: string, overrides: Partial<ContainedEffectInput> = {}): boolean {
  return isContainedToTempRoots(command, input(overrides));
}

test("contained: a scratch directory rebuilt and initialised through one assignment", () => {
  assert.equal(contained("S=/tmp/x/scratch; rm -rf $S && mkdir -p $S && cd $S && git init -q"), true);
});

test("contained: a quoted heredoc written into a temp file is data, whatever it says", () => {
  assert.equal(contained("S=/tmp/x/scratch; cat > \"$S/notes.md\" <<'EOF'\nhello $(rm -rf ~) `id`\nEOF"), true);
});

test("contained: $TMPDIR, ${VAR}, export and the Claude scratchpad", () => {
  assert.equal(contained('rm -rf "$TMPDIR/build"'), true);
  assert.equal(contained('export S=/tmp/x/s && mkdir -p "${S}/a" && touch "${S}/a/f"'), true);
  assert.equal(contained(`rm -rf ${CLAUDE_ROOT}/proj/sess/scratchpad/out`), true);
});

test("contained: redirections, tee, cp, mv, a symlink created inside, a cd into a temp directory", () => {
  assert.equal(contained("echo hi >> /tmp/x/log.txt 2>&1"), true);
  assert.equal(contained("printf '%s\\n' a b | tee -a /tmp/x/out >/dev/null"), true);
  assert.equal(contained("cp -r /tmp/x/a /tmp/x/b && mv /tmp/x/b /tmp/x/c"), true);
  assert.equal(contained(`ln -sf ${PROJECT} /tmp/x/proj-link`), true);
  assert.equal(contained("cd /tmp/x && rm -rf build && mkdir build"), true);
  assert.equal(contained("rm -rf /tmp/x/*"), true);
});

test("must stop: home, the project, an escape, an unknown variable", () => {
  assert.equal(contained("rm -rf ~"), false);
  assert.equal(contained("rm -rf ~/x"), false);
  assert.equal(contained(`rm -rf ${PROJECT}`), false);
  assert.equal(contained("rm -rf /tmp/../home/x"), false);
  assert.equal(contained("rm -rf /tmp/x/../../home/someone"), false);
  assert.equal(contained("rm -rf $UNSET/x"), false);
  assert.equal(contained("rm -rf build"), false);
});

test("must stop: a symlink in a temp root that points at home", () => {
  assert.equal(contained("rm -rf /tmp/x/link/y"), false);
  assert.equal(contained("rm -rf /tmp/x/link"), false);
  assert.equal(contained("echo x > /tmp/x/link/.zshrc"), false);
});

test("must stop: a symlink or hard link made in the same command and then written through", () => {
  assert.equal(contained("ln -s ~ /tmp/x/l && rm -rf /tmp/x/l/y"), false);
  assert.equal(contained(`ln ${HOME}/.zshrc /tmp/x/h`), false);
  assert.equal(contained("cp -a /tmp/x/a /tmp/x/b && rm -rf /tmp/x/b/c"), false);
});

test("must stop: a write to a dotfile in home", () => {
  assert.equal(contained("> ~/.zshrc"), false);
  assert.equal(contained("echo x >> ~/.zshrc"), false);
  assert.equal(contained("printf x | tee ~/.zshrc"), false);
});

test("must stop: an interpreter fed code, even from a temp directory", () => {
  assert.equal(contained("cd /tmp/x && python3 - <<EOF\nimport os\nEOF"), false);
  assert.equal(contained("cd /tmp/x && python3 -c 'print(1)'"), false);
  assert.equal(contained("node -e 'require(\"fs\")'"), false);
  assert.equal(contained("bash <<'EOF'\nrm -rf /tmp/x/a\nEOF"), false);
});

test("must stop: a copy whose source is outside the temp roots", () => {
  assert.equal(contained(`cp ${HOME}/.ssh/id_rsa /tmp/x`), false);
  assert.equal(contained(`cat ${HOME}/.ssh/id_rsa > /tmp/x/k`), false);
  assert.equal(contained(`cat ${HOME}/.ssh/id_rsa | tee /tmp/x/k`), false);
  assert.equal(contained(`mv ${PROJECT}/src /tmp/x/src`), false);
});

test("must stop: a temp root itself, or every entry of one", () => {
  assert.equal(contained("rm -rf /tmp"), false);
  assert.equal(contained('rm -rf "$TMPDIR"'), false);
  assert.equal(contained("rm -rf /tmp/*"), false);
  assert.equal(contained("rm -rf /tmp/x/a?"), false);
});

test("must stop: a cd that may fail before a relative delete", () => {
  assert.equal(contained("cd /tmp/nope; rm -rf src"), false);
  assert.equal(contained("cd /tmp/nope || rm -rf src"), false);
});

test("must stop: assignments that change what a variable means", () => {
  assert.equal(contained("HOME=/tmp/x rm -rf $HOME"), false);
  assert.equal(contained("TMPDIR=~; rm -rf $TMPDIR/x"), false);
  assert.equal(contained('S="/tmp/x/a b"; rm -rf $S'), false);
  assert.equal(contained("S=~; rm -rf /tmp/x/a || S=/tmp/x/b; rm -rf $S/y"), false);
});

test("must stop: assignments that steer the shell or the programs it runs", () => {
  assert.equal(contained("S=/tmp/x/a; IFS=/; rm -rf $S"), false);
  assert.equal(contained("PATH=/tmp/x:$PATH; rm -rf /tmp/x/a"), false);
  assert.equal(contained("HOME=/tmp/x; rm -rf ~/a"), false);
  assert.equal(contained(`export GIT_DIR=${PROJECT}/.git && git init /tmp/x/r`), false);
});

test("contained: a read-only git command beside a contained write", () => {
  assert.equal(contained("rm -rf /tmp/x/a && git status"), true);
});

test("must stop: substitutions, unquoted heredocs that expand, subshells, background", () => {
  assert.equal(contained("rm -rf $(echo /tmp/x)"), false);
  assert.equal(contained("rm -rf `echo /tmp/x`"), false);
  assert.equal(contained("cat > /tmp/x/f <<EOF\n$(rm -rf ~)\nEOF"), false);
  assert.equal(contained("(rm -rf /tmp/x/a)"), false);
  assert.equal(contained("rm -rf /tmp/x/a &"), false);
  assert.equal(contained("sudo rm -rf /tmp/x/a"), false);
});

test("must stop: the session's repository, a linked worktree, and a root that holds home", () => {
  assert.equal(contained("rm -rf /tmp/proj/src", { cwd: "/tmp/proj", sessionRepoRoot: "/private/tmp/proj" }), false);
  assert.equal(contained("rm -rf /tmp/wt/src", { isLinkedWorktree: (path) => path.startsWith("/private/tmp/wt") }), false);
  assert.equal(contained("rm -rf /tmp/x/a", { env: { HOME: "/tmp/x" } }), false);
  assert.equal(contained("rm -rf /tmp/x/a", { env: { HOME: "/private/tmp" } }), false);
});

test("must stop: git init outside a temp root", () => {
  assert.equal(contained("git init -q"), false);
  assert.equal(contained(`git init ${HOME}/x`), false);
  assert.equal(contained("git -C /tmp/x init"), false);
});

test("tempRootsFromEnvironment: the system roots, TMPDIR and Claude's per-user root, never a hardcoded volume", () => {
  const roots = tempRootsFromEnvironment({ TMPDIR: `${MAC_TMP}/`, CLAUDE_CODE_TMPDIR: "/claude-tmp" }, MAC_TMP, 501);
  assert.deepEqual([...roots].sort(), [CLAUDE_ROOT, "/private/tmp", "/tmp", "/var/folders", MAC_TMP].sort());
  assert.deepEqual([...tempRootsFromEnvironment({ TMPDIR: "relative/dir" }, "/tmp", null)].sort(), ["/private/tmp", "/tmp", "/var/folders"]);
});

// The Bash tool runs the owner's zsh: its expansions must not read as bash's.
test("must stop: zsh modifiers, subscripts, =cmd and the clobber redirect", () => {
  assert.equal(contained("S=/tmp/x/a; rm -rf $S:h:h:h"), false);
  assert.equal(contained('S=/tmp/x/a; rm -rf "$S:t"'), false);
  assert.equal(contained('S=/tmp/x/a; rm -rf "$S[1]"'), false);
  assert.equal(contained("cd /tmp/x && cp /tmp/x/evil =git"), false);
  assert.equal(contained("cd /tmp/x && echo x >! ~/.zshrc"), false);
});

test("must stop: a relative cd, which CDPATH or zsh's cdpath can send anywhere", () => {
  assert.equal(contained("cd /tmp/x && cd sub && rm -rf build"), false);
});
