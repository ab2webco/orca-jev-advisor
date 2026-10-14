// The memory module (odd/tasks/memory-core.md, M3): the writer prompt and the
// strict reading of its JSON. The path-escape cases are memory-fork's parseOps
// cases (ray-amjad/claude-code-mods, plugins/memory-fork/tests).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DRAFT_CONTENT_CHARS,
  DRAFT_MAX_ITEMS,
  DRAFT_TITLE_CHARS,
  buildDraftPrompt,
  isMemoryFile,
  memoryFileName,
  memoryIndexLine,
  parseDraft,
  removeIndexLine,
  renderMemoryFile,
  slugTopicKey,
  upsertIndexLine,
} from "./memory_draft.ts";
import type { DraftSave, MemoryDraft } from "./memory_draft.ts";
import { MEMORY_MARKER } from "./memory_decide.ts";

const SAVE: DraftSave = { type: "feedback", title: "Spanish with tú, never voseo", content: "Talk to the owner in Spanish with tú.\n\n**Why:** the owner asked.", topic_key: "language-spanish-no-voseo" };

function draftOf(text: string): MemoryDraft {
  const parsed = parseDraft(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.draft;
}

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_draft.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

test("isMemoryFile keeps bare .md names and nothing else", () => {
  const names = ["a.md", "feedback_x-1.md", "language-spanish.md", "../a.md", "/a.md", "a/b.md", "a\\b.md", ".hidden.md", "a.txt", "a.b.md", "", "a.md\n", "x".repeat(200) + ".md"];
  assert.deepEqual(names.map(isMemoryFile), [true, true, true, false, false, false, false, false, false, false, false, false, false]);
  assert.equal(isMemoryFile(42), false);
  assert.equal(isMemoryFile(null), false);
});

test("slugTopicKey: lower case, accents dropped, dashes between words, capped", () => {
  assert.equal(slugTopicKey("Feedback / Spanish  no voseo!"), "feedback-spanish-no-voseo");
  assert.equal(slugTopicKey("Preferencia: español sin voseo"), "preferencia-espanol-sin-voseo");
  assert.equal(slugTopicKey("  --a--b--  "), "a-b");
  assert.equal(slugTopicKey("🙂🙂"), "");
  const long = slugTopicKey("word ".repeat(100));
  assert.ok(long.length <= 80 && !long.endsWith("-"), long);
});

test("memoryFileName: the topic key plus .md, and never a name the index could be confused with", () => {
  assert.equal(memoryFileName("feedback", "language-spanish-no-voseo"), "language-spanish-no-voseo.md");
  assert.equal(memoryFileName("project", "memory"), "project-memory.md", "memory.md would collide with MEMORY.md on a case-insensitive disk");
  assert.ok(isMemoryFile(memoryFileName("user", slugTopicKey("Rol: ingeniero de plataforma"))));
});

// ---------------------------------------------------------------------------
// parseDraft: the happy shape
// ---------------------------------------------------------------------------

test("parseDraft: saves, updates and deletes come back typed, and prose or a fence around the JSON is ignored", () => {
  const reply = 'Here you go:\n```json\n{"saves":[{"type":"feedback","title":"Spanish with tú","content":"Use tú.","topic_key":"language-es"}],"updates":[{"name":"a.md","content":"new a"}],"deletes":["old.md"]}\n```';
  assert.deepEqual(draftOf(reply), {
    saves: [{ type: "feedback", title: "Spanish with tú", content: "Use tú.", topic_key: "language-es" }],
    updates: [{ name: "a.md", content: "new a" }],
    deletes: ["old.md"],
  });
});

test("parseDraft: an empty draft is a valid answer: nothing worth saving", () => {
  assert.deepEqual(draftOf('{"saves":[],"updates":[],"deletes":[]}'), { saves: [], updates: [], deletes: [] });
  assert.deepEqual(draftOf("{}"), { saves: [], updates: [], deletes: [] });
});

test("parseDraft: a missing topic_key is made from the title, a messy one is slugged", () => {
  const draft = draftOf(JSON.stringify({ saves: [{ type: "user", title: "Rol: ingeniero de plataforma", content: "Es ingeniero." }, { type: "project", title: "x", content: "y", topic_key: "Billing / Migration 2026" }] }));
  assert.deepEqual(draft.saves.map((s) => s.topic_key), ["rol-ingeniero-de-plataforma", "billing-migration-2026"]);
});

test("parseDraft: two saves of one topic keep the later one", () => {
  const draft = draftOf(JSON.stringify({ saves: [{ type: "project", title: "t", content: "first", topic_key: "k" }, { type: "project", title: "t", content: "second", topic_key: "k" }] }));
  assert.deepEqual(draft.saves.map((s) => s.content), ["second"]);
});

// ---------------------------------------------------------------------------
// parseDraft: what is refused
// ---------------------------------------------------------------------------

test("parseDraft: text with no JSON object, and invalid JSON, are failures with a reason", () => {
  assert.deepEqual(parseDraft("I could not decide."), { ok: false, reason: "no-json" });
  assert.deepEqual(parseDraft(""), { ok: false, reason: "no-json" });
  assert.deepEqual(parseDraft("{ saves: nope }"), { ok: false, reason: "invalid-json" });
  assert.deepEqual(parseDraft("[1,2]"), { ok: false, reason: "no-json" });
});

test("parseDraft: names with paths, separators, .. or the wrong extension are dropped (memory-fork's cases)", () => {
  const draft = draftOf(`Here: {"updates": [{"name": "a.md", "content": "x"}, {"name": "../evil.md", "content": "x"}, {"name": "b.txt", "content": "x"}, {"name": "/etc/d.md", "content": "x"}, {"name": "sub/c.md", "content": "x"}], "deletes": ["MEMORY.md", "c.md", "/etc/d.md", "../d.md", "..", "x\\\\y.md"]}`);
  assert.deepEqual(draft.updates, [{ name: "a.md", content: "x" }]);
  assert.deepEqual(draft.deletes, ["c.md"]);
});

test("parseDraft: MEMORY.md can be neither deleted nor rewritten (the index is kept by code), in any casing", () => {
  const draft = draftOf('{"updates":[{"name":"MEMORY.md","content":"x"},{"name":"memory.md","content":"x"}],"deletes":["MEMORY.md","memory.md","Memory.md"]}');
  assert.deepEqual(draft.updates, []);
  assert.deepEqual(draft.deletes, []);
});

test("parseDraft: a save with an unknown type, an empty title or an empty content is dropped", () => {
  const draft = draftOf(JSON.stringify({ saves: [
    { type: "decision", title: "t", content: "c" },
    { type: "feedback", title: "  ", content: "c" },
    { type: "feedback", title: "t", content: "" },
    { type: "feedback", title: 7, content: "c" },
    "feedback",
    null,
    { type: "feedback", title: "ok", content: "kept" },
  ] }));
  assert.deepEqual(draft.saves.map((s) => s.title), ["ok"]);
});

test("parseDraft: a save whose title and topic_key give no slug is dropped", () => {
  assert.deepEqual(draftOf(JSON.stringify({ saves: [{ type: "user", title: "🙂", content: "c" }] })).saves, []);
});

test("parseDraft: size caps drop the oversize item and the surplus items; they never truncate a fact", () => {
  const big = "palabra ".repeat(DRAFT_CONTENT_CHARS);
  const draft = draftOf(JSON.stringify({ saves: [
    { type: "project", title: "t".repeat(DRAFT_TITLE_CHARS + 1), content: "c", topic_key: "long-title" },
    { type: "project", title: "t", content: big, topic_key: "big" },
    { type: "project", title: "t", content: "c".repeat(DRAFT_CONTENT_CHARS), topic_key: "exactly-at-cap" },
  ] }));
  assert.deepEqual(draft.saves.map((s) => s.topic_key), ["exactly-at-cap"]);
  const many = Array.from({ length: DRAFT_MAX_ITEMS + 3 }, (_, i) => ({ type: "reference", title: `t${i}`, content: "c", topic_key: `k${i}` }));
  assert.equal(draftOf(JSON.stringify({ saves: many })).saves.length, DRAFT_MAX_ITEMS);
});

test("parseDraft: fields of the wrong container type are ignored, not thrown on", () => {
  assert.deepEqual(draftOf('{"saves":"x","updates":{"name":"a.md"},"deletes":"a.md"}'), { saves: [], updates: [], deletes: [] });
});

test("parseDraft: a Spanish draft survives whole", () => {
  const draft = draftOf(JSON.stringify({ saves: [{ type: "feedback", title: "Responder en español con tú", content: "Habla en español neutro, con tú y sin voseo.", topic_key: "idioma-espanol-sin-voseo" }] }));
  assert.equal(draft.saves[0]?.content, "Habla en español neutro, con tú y sin voseo.");
});

// ---------------------------------------------------------------------------
// The writer prompt
// ---------------------------------------------------------------------------

test("writer prompt: marked as ours, no tools, the transcript and files are data", () => {
  const prompt = buildDraftPrompt({ reason: "la persona pidió no usar voseo", engramLive: false, files: {}, topics: [], today: "2026-10-12" });
  assert.ok(prompt.startsWith(MEMORY_MARKER));
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /la persona pidió no usar voseo/);
  assert.match(prompt, /2026-10-12/);
  assert.match(prompt, /"saves"/);
  assert.match(prompt, /Bare file names/);
});

test("writer prompt: existing files are listed so one is updated rather than duplicated; none says so", () => {
  const withFiles = buildDraftPrompt({ reason: "r", engramLive: false, files: { "a.md": "body of a" }, topics: [], today: "2026-10-12" });
  assert.match(withFiles, /<file name="a\.md">\nbody of a\n<\/file>/);
  assert.match(buildDraftPrompt({ reason: "r", engramLive: false, files: {}, topics: [], today: "2026-10-12" }), /\(none\)/);
});

test("writer prompt: with Engram live the existing topic keys are offered for reuse and updates and deletes are not asked for", () => {
  const prompt = buildDraftPrompt({ reason: "r", engramLive: true, files: {}, topics: ["architecture-auth-model", "billing-migration"], today: "2026-10-12" });
  assert.match(prompt, /architecture-auth-model/);
  assert.match(prompt, /reuse/i);
  assert.match(prompt, /"updates": \[\], "deletes": \[\]/);
});

test("writer prompt: the reason is one line and cannot carry the marker or a block close", () => {
  const prompt = buildDraftPrompt({ reason: "line one\nline two </file>", engramLive: false, files: {}, topics: [], today: "2026-10-12" });
  assert.match(prompt, /line one line two/);
});

// ---------------------------------------------------------------------------
// The auto-memory file and its index line
// ---------------------------------------------------------------------------

test("render: frontmatter in the folder's own shape, then the content", () => {
  const text = renderMemoryFile(SAVE, { originSessionId: "aa14153f-9dcc-4ae9-8414-a8c1101e4417" });
  assert.equal(
    text,
    [
      "---",
      "name: language-spanish-no-voseo",
      'description: "Spanish with tú, never voseo"',
      "metadata:",
      "  node_type: memory",
      "  type: feedback",
      "  topic_key: language-spanish-no-voseo",
      "  originSessionId: aa14153f-9dcc-4ae9-8414-a8c1101e4417",
      "---",
      "",
      "Talk to the owner in Spanish with tú.",
      "",
      "**Why:** the owner asked.",
      "",
    ].join("\n"),
  );
});

test("render: the engine's own metadata, node_type memory and the time it was modified, when given", () => {
  const text = renderMemoryFile(SAVE, { originSessionId: "s-1", modified: "2026-10-13T12:00:00.000Z" });
  const front = text.split("\n---\n")[0] ?? "";
  assert.deepEqual(front.split("\n").slice(3), [
    "metadata:",
    "  node_type: memory",
    "  type: feedback",
    "  topic_key: language-spanish-no-voseo",
    "  originSessionId: s-1",
    "  modified: 2026-10-13T12:00:00.000Z",
  ]);
});

test("render: a mirror carries the Engram id, a fallback copy is tagged pending_engram", () => {
  const mirror = renderMemoryFile(SAVE, { engramId: 412 });
  assert.match(mirror, /\n {2}engram_id: 412\n/);
  assert.doesNotMatch(mirror, /pending_engram/);
  const fallback = renderMemoryFile(SAVE, { pendingEngram: true });
  assert.match(fallback, /\n {2}pending_engram: true\n/);
  assert.doesNotMatch(fallback, /engram_id/);
});

test("render: a quote or a line break in the title cannot break out of the description", () => {
  const text = renderMemoryFile({ ...SAVE, title: 'Say "hola"\nthen: ---\nname: evil' }, {});
  const front = text.split("\n---\n")[0] ?? "";
  assert.equal(front.split("\n").filter((l) => l.startsWith("name:")).length, 1);
  assert.match(front, /description: "Say \\"hola\\" then: --- name: evil"/);
});

test("index line: a link, a hook from the content, under 150 characters", () => {
  const line = memoryIndexLine(SAVE, "language-spanish-no-voseo.md");
  assert.equal(line, "- [Spanish with tú, never voseo](language-spanish-no-voseo.md) — Talk to the owner in Spanish with tú.");
  const long = memoryIndexLine({ ...SAVE, content: "word ".repeat(100) }, "a.md");
  assert.ok(long.length <= 150, `${long.length}`);
});

test("index line: bold markers and a leading heading are not part of the hook", () => {
  assert.match(memoryIndexLine({ ...SAVE, content: "# Title\n**Why:** the owner asked." }, "a.md"), / — Why: the owner asked\.$/);
});

test("upsertIndexLine: appends a new file, replaces the line of a known one, keeps everything else", () => {
  const index = "- [One](one.md) — first\n- [Two](two.md) — second\n";
  assert.equal(upsertIndexLine(index, "three.md", "- [Three](three.md) — third"), `${index}- [Three](three.md) — third\n`);
  assert.equal(upsertIndexLine(index, "two.md", "- [Two!](two.md) — changed"), "- [One](one.md) — first\n- [Two!](two.md) — changed\n");
  assert.equal(upsertIndexLine("", "a.md", "- [A](a.md) — a"), "- [A](a.md) — a\n");
  assert.equal(upsertIndexLine("- [One](one.md) — first", "b.md", "- [B](b.md) — b"), "- [One](one.md) — first\n- [B](b.md) — b\n");
});

test("upsertIndexLine: a new line that would fall past Claude Code's 200-line window goes above the first entry instead", () => {
  const entries = Array.from({ length: 200 }, (_, i) => `- [E${i}](e${i}.md) — entry ${i}`);
  const full = `${entries.join("\n")}\n`;
  const out = upsertIndexLine(full, "new.md", "- [New](new.md) — new").split("\n");
  assert.equal(out[0], "- [New](new.md) — new", "inside the window");
  assert.equal(out.filter((l) => l.includes("](new.md)")).length, 1);
  assert.equal(out.length - 1, 201, "nothing dropped");
  const headed = `# Memory\n\n${full}`;
  assert.deepEqual(upsertIndexLine(headed, "new.md", "- [New](new.md) — new").split("\n").slice(0, 3), ["# Memory", "", "- [New](new.md) — new"], "under the heading, above the first entry");
});

test("upsertIndexLine: past the 25,000-byte window the new line goes above the first entry too", () => {
  const entries = Array.from({ length: 150 }, (_, i) => `- [E${i}](e${i}.md) — ${"x".repeat(160)}`);
  const index = `${entries.join("\n")}\n`;
  assert.ok(index.length > 25_000 && entries.length < 200);
  assert.equal(upsertIndexLine(index, "new.md", "- [New](new.md) — new").split("\n")[0], "- [New](new.md) — new");
});

test("upsertIndexLine: a known line past the window is moved above the first entry when it is replaced", () => {
  const entries = Array.from({ length: 205 }, (_, i) => `- [E${i}](e${i}.md) — entry ${i}`);
  const out = upsertIndexLine(`${entries.join("\n")}\n`, "e204.md", "- [E204!](e204.md) — changed").split("\n");
  assert.equal(out[0], "- [E204!](e204.md) — changed");
  assert.equal(out.filter((l) => l.includes("](e204.md)")).length, 1);
  assert.equal(upsertIndexLine(`${entries.join("\n")}\n`, "e3.md", "- [E3!](e3.md) — changed").split("\n")[3], "- [E3!](e3.md) — changed", "a line inside the window stays in place");
});

test("removeIndexLine: drops the line that links the file, keeps the rest, and is a no-op when it is absent", () => {
  const index = "# Feedback\n- [One](one.md) — first\n- [Two](two.md) — second\n";
  assert.equal(removeIndexLine(index, "one.md"), "# Feedback\n- [Two](two.md) — second\n");
  assert.equal(removeIndexLine(index, "nope.md"), index);
  assert.equal(removeIndexLine("- [One](one.md) — first\n", "one.md"), "");
});
