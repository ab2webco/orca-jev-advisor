// The memory module (odd/tasks/memory-core.md, M6): tidying the auto-memory
// folder. The first block is dream-pass's own test cases, ported
// (ray-amjad/claude-code-mods, plugins/dream-pass/tests/dream-pass.test.ts);
// the rest covers the backup and undo plan, the lock and the Engram mirrors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKUP_DIR,
  backupStamp,
  buildTidyGatePrompt,
  buildTidyPrompt,
  conversationSince,
  dropDeadPointers,
  indexProblems,
  keywords,
  latestBackup,
  lockPid,
  mirrorProblems,
  originIds,
  parseFrontmatter,
  parsePlan,
  parseTidyGate,
  planTidy,
  promotePendingMirror,
  redirectLinks,
  safeName,
  snippets,
  summary,
  suspects,
  tidyGateStep,
  undoOps,
} from "./memory_tidy.ts";
import type { FileOp } from "./memory_spool.ts";

const memo = (description: string, metadata = "  type: feedback\n"): string => `---\nname: x\ndescription: ${description}\nmetadata:\n${metadata}---\nbody\n`;

function applyOps(files: Map<string, string>, ops: readonly FileOp[]): void {
  for (const op of ops) {
    if (op.kind === "write") files.set(op.path, op.content);
    else if (op.kind === "remove") files.delete(op.path);
    else {
      for (const [path, content] of [...files]) {
        if (path === op.from || path.startsWith(`${op.from}/`)) {
          files.set(`${op.to}${path.slice(op.from.length)}`, content);
          files.delete(path);
        }
      }
    }
  }
}

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_tidy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// Ported from dream-pass
// ---------------------------------------------------------------------------

test("a tidy index has no problems, so the periodic check goes on to Haiku", () => {
  const files = { "MEMORY.md": "# Feedback\n- [pnpm](pnpm.md) - always pnpm\n", "pnpm.md": memo("always pnpm") };
  assert.deepEqual(indexProblems(files), []);
});

test("code finds a long line, a dead pointer and an unlisted file with no model call", () => {
  const files = {
    "MEMORY.md": `- [a](a.md) - ${"x".repeat(220)}\n- [gone](gone.md) - old\n`,
    "a.md": memo("a"),
    "stray.md": memo("stray"),
  };
  assert.deepEqual(indexProblems(files), ["1 index line(s) over 200 chars", "1 pointer(s) to missing files", "1 file(s) not in the index"]);
});

test("an index over 200 lines is a problem too", () => {
  const files = { "MEMORY.md": Array.from({ length: 201 }, (_, i) => `- [a${i}](a${i}.md) - x`).join("\n") };
  assert.ok(indexProblems(files).includes("index over 200 lines"));
});

test("parsePlan drops paths, unknown files and any edit to MEMORY.md but the index", () => {
  const files = { "MEMORY.md": "", "a.md": "", "b.md": "", "c.md": "" };
  const plan = parsePlan(
    `Sure: {
    "merged": [{"into": "a.md", "from": ["b.md", "../etc.md", "nope.md", "a.md"], "content": "merged", "why": "dup"}],
    "rewritten": [{"file": "MEMORY.md", "content": "x"}, {"file": "c.md", "content": "new", "why": "stale"}],
    "removed": [{"file": "MEMORY.md"}, {"file": "/etc/passwd.md"}, {"file": "c.md", "why": "dead"}],
    "index": "- [a](a.md) - a"
  }`,
    files,
  );
  assert.notEqual(plan, null);
  if (plan === null) return;
  assert.deepEqual(plan.merged.map((m) => m.from), [["b.md"]]);
  assert.deepEqual(plan.rewritten.map((w) => w.file), ["c.md"]);
  assert.deepEqual(plan.removed.map((d) => d.file), ["c.md"]);
  assert.equal(plan.index, "- [a](a.md) - a\n");
});

test("a reply that is not JSON changes nothing", () => {
  assert.equal(parsePlan("I could not decide.", {}), null);
  assert.equal(parsePlan("{ nope", {}), null);
});

test("safeName only takes bare .md names", () => {
  assert.deepEqual(["a.md", "feedback_x-1.md", "../a.md", "/a.md", ".hidden.md", "a.txt", "a/b.md", "a..md"].map(safeName), [true, true, false, false, false, false, false, false]);
});

test("the gate reads only what was said since the last check", () => {
  const messages = [
    { role: "user", text: "old" },
    { role: "assistant", text: "old reply" },
    { role: "user", text: "we moved to Fly.io" },
    { role: "assistant", text: "" },
  ] as const;
  assert.equal(conversationSince(messages, 2), "USER: we moved to Fly.io");
  assert.equal(conversationSince(messages, 4), "(nothing new)");
});

test("the gate reads a Spanish turn the same way and cuts a long one", () => {
  const messages = [{ role: "user", text: "migramos staging a Fly.io, ya no usamos Heroku" }] as const;
  assert.equal(conversationSince(messages, 0), "USER: migramos staging a Fly.io, ya no usamos Heroku");
  const long = conversationSince([{ role: "user", text: `${"palabra ".repeat(3000)}` }], 0);
  assert.ok(long.length <= 12_020, `${long.length}`);
});

test("the band counts each kind of change", () => {
  const changes = [{ kind: "merged" }, { kind: "merged" }, { kind: "removed" }, { kind: "rewritten" }, { kind: "index" }] as const;
  assert.equal(summary({ changes }), "2 merged · 1 removed · 1 rewritten");
});

test("the mod drops index lines that point at missing files, whatever the model wrote", () => {
  const index = "# Project\n- [a](a.md) - kept\n- [gone](gone.md) - dropped\n";
  assert.equal(dropDeadPointers(index, { "a.md": "" }), "# Project\n- [a](a.md) - kept\n");
});

test("parsePlan keeps only brand new files in added", () => {
  const plan = parsePlan('{"added":[{"file":"new.md","content":"x"},{"file":"a.md","content":"x"},{"file":"../b.md","content":"x"}]}', { "a.md": "" });
  assert.deepEqual(plan?.added.map((a) => a.file), ["new.md"]);
});

test("the band only mentions added files when there are some", () => {
  assert.equal(summary({ changes: [{ kind: "added" }, { kind: "merged" }] }), "1 merged · 0 removed · 0 rewritten · 1 added");
});

test("originIds reads originSessionId and a sources list from the frontmatter only", () => {
  const a = "11111111-2222-3333-4444-555555555555";
  const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const text = `---\nname: x\nmetadata:\n  originSessionId: ${a}\n  sources: [${a}, ${b}]\n---\nbody mentions 99999999-2222-3333-4444-555555555555\n`;
  assert.deepEqual(originIds(text), [a, b]);
});

test("suspects are memories that share a word, the closest pairs first", () => {
  const files = {
    "MEMORY.md": "",
    "feedback_pnpm.md": memo("use pnpm"),
    "feedback_package_manager.md": memo("Always pnpm, never npm or yarn"),
    "reference_noaa_api.md": memo("NOAA tides API notes"),
  };
  assert.deepEqual(keywords("feedback_package_manager.md", files["feedback_package_manager.md"]), ["package", "manager", "pnpm", "yarn"]);
  assert.deepEqual(suspects(files), ["feedback_pnpm.md", "feedback_package_manager.md"]);
});

test("snippets cut each matching line around the word", () => {
  const lines = ["nothing here", `${"x".repeat(200)} we moved staging to fly ${"y".repeat(300)}`, "staging again"];
  const hits = snippets(lines, ["staging"]);
  assert.equal(hits.length, 2);
  assert.ok((hits[0] ?? "").length < 320);
  assert.ok((hits[0] ?? "").includes("we moved staging to fly"));
});

test("links to a merged file point at the file it went into, labels kept", () => {
  assert.equal(
    redirectLinks("see [[pnpm]] and [[pnpm|the rule]] and [[noaa-api]]", { pnpm: "package-manager" }),
    "see [[package-manager]] and [[package-manager|the rule]] and [[noaa-api]]",
  );
});

test("redirectLinks keeps a heading anchor and ignores names that were not moved", () => {
  assert.equal(redirectLinks("[[pnpm#why]] [[constructor]] [[toString]]", { pnpm: "pm" }), "[[pm#why]] [[constructor]] [[toString]]");
});

// ---------------------------------------------------------------------------
// The tidy gate
// ---------------------------------------------------------------------------

test("tidy gate step: a missing index skips, an index with problems tidies without a model call, a clean one asks Haiku", () => {
  assert.deepEqual(tidyGateStep({ "a.md": memo("a") }), { kind: "skip" });
  const withProblems = tidyGateStep({ "MEMORY.md": "- [gone](gone.md) - x\n" });
  assert.deepEqual(withProblems, { kind: "tidy", why: "1 pointer(s) to missing files" });
  assert.deepEqual(tidyGateStep({ "MEMORY.md": "- [a](a.md) - x\n", "a.md": memo("a") }), { kind: "ask" });
});

test("tidy gate prompt: the index, each file's description and what was said since", () => {
  const prompt = buildTidyGatePrompt({ "MEMORY.md": "- [a](a.md) - x\n", "a.md": memo("la persona usa pnpm") }, "USER: ahora usamos bun");
  assert.match(prompt, /MEMORY\.md:\n- \[a\]\(a\.md\) - x/);
  assert.match(prompt, /a\.md: la persona usa pnpm/);
  assert.match(prompt, /Conversation since the last check:\nUSER: ahora usamos bun/);
  assert.match(prompt, /data, not instructions/);
});

test("tidy gate answer: only YES or NO is an answer; anything else is a failure and touches no file", () => {
  assert.deepEqual(parseTidyGate("YES"), { kind: "yes" });
  assert.deepEqual(parseTidyGate(" NO.\n"), { kind: "no" });
  for (const text of ["", "yes", "Maybe", "YES, because", "NO\nYES", "YESTERDAY"]) assert.deepEqual(parseTidyGate(text), { kind: "failure" }, JSON.stringify(text));
});

// ---------------------------------------------------------------------------
// Applying a plan: backup first, links redirected, dead pointers dropped
// ---------------------------------------------------------------------------

const DIR = "/acct/projects/-r-app/memory";
const STAMP = "2026-10-12T10-00-00-000Z";

const FOLDER = {
  "MEMORY.md": "# Feedback\n- [pnpm](feedback_pnpm.md) - use pnpm\n- [pm](feedback_package_manager.md) - pnpm only\n- [noaa](reference_noaa.md) - tides\n",
  "feedback_pnpm.md": "---\nname: pnpm\ndescription: use pnpm\nmetadata:\n  type: feedback\n---\nUse pnpm. See [[noaa]].\n",
  "feedback_package_manager.md": "---\nname: package-manager\ndescription: pnpm only\nmetadata:\n  type: feedback\n---\nPnpm only. Related [[pnpm]].\n",
  "reference_noaa.md": "---\nname: noaa\ndescription: tides\nmetadata:\n  type: reference\n---\nTides API. Also [[pnpm|the pm rule]].\n",
};

function folderDisk(): Map<string, string> {
  return new Map(Object.entries(FOLDER).map(([name, text]) => [`${DIR}/${name}`, text]));
}

const MERGE_PLAN = JSON.stringify({
  merged: [{ into: "feedback_package_manager.md", from: ["feedback_pnpm.md"], content: "---\nname: package-manager\ndescription: pnpm only, never npm\nmetadata:\n  type: feedback\n---\nPnpm only.\n", why: "duplicate" }],
  index: "# Feedback\n- [pm](feedback_package_manager.md) - pnpm only\n- [pnpm](feedback_pnpm.md) - use pnpm\n- [noaa](reference_noaa.md) - tides\n",
});

test("plan: the whole folder is backed up under .memory-backup/<stamp>/ before anything else is touched", () => {
  const plan = parsePlan(MERGE_PLAN, FOLDER);
  assert.notEqual(plan, null);
  if (plan === null) return;
  const { ops } = planTidy({ dir: DIR, files: FOLDER, plan, stamp: STAMP, why: "every 20 turns" });
  const firstChange = ops.findIndex((op) => op.kind === "remove" || (op.kind === "write" && !op.path.includes(BACKUP_DIR)));
  const backups = ops.slice(0, firstChange);
  assert.deepEqual(backups.map((op) => (op.kind === "write" ? op.path : "")).sort(), Object.keys(FOLDER).map((name) => `${DIR}/${BACKUP_DIR}/${STAMP}/${name}`).sort());
  for (const op of backups) {
    assert.ok(op.kind === "write");
    if (op.kind === "write") assert.equal(op.content, FOLDER[op.path.split("/").pop() as keyof typeof FOLDER]);
  }
});

test("plan: a merge removes the merged file, redirects [[links]] to it and drops the dead pointer the model kept", () => {
  const plan = parsePlan(MERGE_PLAN, FOLDER);
  assert.notEqual(plan, null);
  if (plan === null) return;
  const disk = folderDisk();
  const result = planTidy({ dir: DIR, files: FOLDER, plan, stamp: STAMP, why: "/memory tidy" });
  applyOps(disk, result.ops);
  assert.equal(disk.has(`${DIR}/feedback_pnpm.md`), false);
  assert.match(disk.get(`${DIR}/feedback_package_manager.md`) ?? "", /pnpm only, never npm/);
  assert.match(disk.get(`${DIR}/reference_noaa.md`) ?? "", /\[\[package-manager\|the pm rule\]\]/);
  assert.doesNotMatch(disk.get(`${DIR}/MEMORY.md`) ?? "", /feedback_pnpm\.md/);
  assert.deepEqual(result.changes.map((c) => c.kind).sort(), ["index", "links", "merged"]);
  assert.match(disk.get(`${DIR}/${BACKUP_DIR}/${STAMP}/TIDY.md`) ?? "", /merged feedback_pnpm\.md: merged into feedback_package_manager\.md/);
});

test("plan: a removal with no index in the reply still drops the removed file's pointer", () => {
  const plan = parsePlan('{"removed":[{"file":"reference_noaa.md","why":"dead"}]}', FOLDER);
  assert.notEqual(plan, null);
  if (plan === null) return;
  const disk = folderDisk();
  applyOps(disk, planTidy({ dir: DIR, files: FOLDER, plan, stamp: STAMP, why: "x" }).ops);
  assert.doesNotMatch(disk.get(`${DIR}/MEMORY.md`) ?? "", /reference_noaa/);
  assert.match(disk.get(`${DIR}/MEMORY.md`) ?? "", /feedback_pnpm\.md/);
});

test("plan: an empty plan changes nothing and writes no backup", () => {
  const plan = parsePlan("{}", FOLDER);
  assert.notEqual(plan, null);
  if (plan === null) return;
  const result = planTidy({ dir: DIR, files: FOLDER, plan, stamp: STAMP, why: "x" });
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.changes, []);
});

test("plan: Engram mirrors are protected: they can be neither merged away, rewritten nor removed", () => {
  const mirror = memo("rule", "  type: feedback\n  topic_key: language-es\n  engram_id: 412\n");
  const files = { "MEMORY.md": "- [m](m.md) - x\n- [a](a.md) - y\n", "m.md": mirror, "a.md": memo("a") };
  const plan = parsePlan('{"merged":[{"into":"a.md","from":["m.md"],"content":"c"}],"rewritten":[{"file":"m.md","content":"c"}],"removed":[{"file":"m.md"}],"added":[]}', files, { protect: new Set(["m.md"]) });
  assert.notEqual(plan, null);
  assert.deepEqual(plan?.merged.map((m) => m.from), [[]]);
  assert.deepEqual(plan?.rewritten, []);
  assert.deepEqual(plan?.removed, []);
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

test("undo: the backup is put back byte for byte, files the backup lacks go away, the used backup is retired", () => {
  const plan = parsePlan(MERGE_PLAN, FOLDER);
  assert.notEqual(plan, null);
  if (plan === null) return;
  const disk = folderDisk();
  applyOps(disk, planTidy({ dir: DIR, files: FOLDER, plan, stamp: STAMP, why: "x" }).ops);
  disk.set(`${DIR}/added_after.md`, "new file after the tidy");
  const current = Object.fromEntries([...disk].filter(([path]) => path.startsWith(`${DIR}/`) && !path.includes(BACKUP_DIR) && path.lastIndexOf("/") === DIR.length).map(([path, text]) => [path.slice(DIR.length + 1), text]));
  const backup = Object.fromEntries([...disk].filter(([path]) => path.startsWith(`${DIR}/${BACKUP_DIR}/${STAMP}/`)).map(([path, text]) => [path.split("/").pop() ?? "", text]));
  applyOps(disk, undoOps({ dir: DIR, stamp: STAMP, backup, current }));
  for (const [name, text] of Object.entries(FOLDER)) assert.equal(disk.get(`${DIR}/${name}`), text, name);
  assert.equal(disk.has(`${DIR}/added_after.md`), false);
  assert.equal(disk.has(`${DIR}/${BACKUP_DIR}/${STAMP}/MEMORY.md`), false);
  assert.ok(disk.has(`${DIR}/${BACKUP_DIR}/undone-${STAMP}/MEMORY.md`));
});

test("undo: the newest backup that is not already undone is the one used, and none gives null", () => {
  assert.equal(backupStamp("2026-10-12T10:00:00.000Z"), STAMP);
  assert.equal(latestBackup(["2026-10-11T09-00-00-000Z", STAMP, `undone-${STAMP}`, "notes", ".DS_Store"]), STAMP);
  assert.equal(latestBackup([`undone-${STAMP}`, "junk"]), null);
  assert.equal(latestBackup([]), null);
});

test("undo: the backup's own log is not restored as a memory", () => {
  const ops = undoOps({ dir: DIR, stamp: STAMP, backup: { "MEMORY.md": "idx", "TIDY.md": "log" }, current: { "MEMORY.md": "new" } });
  assert.ok(!ops.some((op) => op.kind === "write" && op.path.endsWith("TIDY.md")));
});

// ---------------------------------------------------------------------------
// The lock Claude Code's own consolidation holds
// ---------------------------------------------------------------------------

test("lock: a fresh lock with a pid is that pid; a stale, empty or garbled one is none", () => {
  const now = 10_000_000;
  assert.equal(lockPid({ content: "4242\n", mtimeMs: now - 1000, nowMs: now }), 4242);
  assert.equal(lockPid({ content: "4242", mtimeMs: now - 3_600_001, nowMs: now }), null);
  assert.equal(lockPid({ content: "", mtimeMs: now, nowMs: now }), null);
  assert.equal(lockPid({ content: "abc", mtimeMs: now, nowMs: now }), null);
  assert.equal(lockPid({ content: "0", mtimeMs: now, nowMs: now }), null);
  assert.equal(lockPid({ content: null, mtimeMs: null, nowMs: now }), null);
});

// ---------------------------------------------------------------------------
// Mirrors against Engram
// ---------------------------------------------------------------------------

test("frontmatter: name, description and the metadata the module reads", () => {
  const text = memo("always pnpm", "  type: feedback\n  topic_key: pm\n  engram_id: 412\n  pending_engram: true\n  originSessionId: session-0\n");
  assert.deepEqual(parseFrontmatter(text), { name: "x", description: "always pnpm", type: "feedback", topicKey: "pm", engramId: "412", pendingEngram: true, originSessionId: "session-0" });
  assert.deepEqual(parseFrontmatter("no frontmatter"), { name: null, description: null, type: null, topicKey: null, engramId: null, pendingEngram: false, originSessionId: null });
});

test("frontmatter: a quoted description is unquoted", () => {
  assert.equal(parseFrontmatter('---\nname: n\ndescription: "Say \\"hola\\""\n---\n').description, 'Say "hola"');
});

test("mirror check: a mirror whose Engram observation is gone, a copy Engram has since taken, two files on one topic, and a topic that changed", () => {
  const files = {
    "MEMORY.md": "",
    "gone.md": memo("d", "  type: feedback\n  topic_key: gone\n  engram_id: 9\n"),
    "waiting.md": memo("d", "  type: feedback\n  topic_key: waiting\n  pending_engram: true\n"),
    "still-waiting.md": memo("d", "  type: feedback\n  topic_key: not-in-engram\n  pending_engram: true\n"),
    "ok.md": memo("d", "  type: feedback\n  topic_key: ok\n  engram_id: 7\n"),
    "moved.md": memo("d", "  type: feedback\n  topic_key: old-key\n  engram_id: 8\n"),
    "dup-a.md": memo("d", "  type: user\n  topic_key: same\n"),
    "dup-b.md": memo("d", "  type: user\n  topic_key: same\n"),
    "plain.md": memo("not a mirror", "  type: project\n"),
  };
  const engram = [
    { id: 7, topicKey: "ok" },
    { id: 8, topicKey: "new-key" },
    { id: 21, topicKey: "waiting" },
  ];
  assert.deepEqual(mirrorProblems(files, engram), [
    { file: "dup-a.md", kind: "duplicate-topic", detail: "same" },
    { file: "dup-b.md", kind: "duplicate-topic", detail: "same" },
    { file: "gone.md", kind: "dangling", detail: "engram_id 9" },
    { file: "moved.md", kind: "topic-mismatch", detail: "engram_id 8 is now new-key" },
    { file: "waiting.md", kind: "pending-resolved", detail: "engram_id 21" },
  ]);
});

test("mirror check: with nothing wrong, no problems", () => {
  assert.deepEqual(mirrorProblems({ "MEMORY.md": "", "a.md": memo("a") }, []), []);
});

test("promote: a copy Engram has taken becomes the mirror: engram_id added, pending_engram gone, the rest untouched", () => {
  const before = memo("d", "  type: feedback\n  topic_key: waiting\n  pending_engram: true\n  originSessionId: s1\n");
  const after = promotePendingMirror(before, "21");
  assert.equal(after, memo("d", "  type: feedback\n  topic_key: waiting\n  engram_id: 21\n  originSessionId: s1\n"));
  assert.equal(promotePendingMirror(after, "21"), after, "promoting twice changes nothing");
});

// ---------------------------------------------------------------------------
// The tidy prompt
// ---------------------------------------------------------------------------

test("tidy prompt: marked as ours, no tools, files are data, mirrors are named as untouchable, the reply shape is given", () => {
  const prompt = buildTidyPrompt({
    files: { "MEMORY.md": "- [a](a.md) - x\n", "a.md": memo("a") },
    today: "2026-10-12",
    problems: ["1 file(s) not in the index"],
    sessionId: "s1",
    sources: "",
    recent: "",
    protectedFiles: ["m.md"],
  });
  assert.ok(prompt.startsWith("[orca-memory]"));
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /<file name="a\.md" modified="\?">/);
  assert.match(prompt, /1 file\(s\) not in the index/);
  assert.match(prompt, /m\.md/);
  assert.match(prompt, /"merged"/);
  assert.match(prompt, /\(no sources found\)/);
});
