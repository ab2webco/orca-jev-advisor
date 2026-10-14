// The memory module (odd/tasks/memory-core.md, M5): judging the conflicts
// Engram's mem_save surfaces. Haiku reads only the two observations' text; a
// verdict the person must make is left pending, never guessed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONFIDENCE_FLOOR,
  HUMAN_ONLY_TYPES,
  JUDGE_SYSTEM,
  RELATIONS,
  RESOLVE_OPTIONS,
  buildJudgePrompt,
  buildJudgeArgs,
  decideVerdict,
  parseJudgment,
  parseObservationText,
  readObservationResult,
} from "./memory_judge.ts";
import type { Relation, Verdict } from "./memory_judge.ts";

const SAVED = { title: "Responder en español con tú", type: "policy", content: "Habla en español neutro, con tú y sin voseo." };
const OLD = { title: "Spanish with vos", type: "policy", content: "Talk to the owner in Spanish with vos." };

const verdict = (relation: Relation, confidence: number): Verdict => ({ relation, confidence, reason: "r" });

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_judge.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// The prompt: two texts only
// ---------------------------------------------------------------------------

test("prompt: the new and the existing observation, each with its title, type and content, and nothing else", () => {
  const prompt = buildJudgePrompt({ saved: SAVED, candidate: OLD });
  assert.match(prompt, /<new>\nTitle: Responder en español con tú\nType: policy\nHabla en español neutro, con tú y sin voseo\.\n<\/new>/);
  assert.match(prompt, /<existing>\nTitle: Spanish with vos\nType: policy\nTalk to the owner in Spanish with vos\.\n<\/existing>/);
  assert.ok(prompt.indexOf("<new>") < prompt.indexOf("<existing>"));
  assert.doesNotMatch(prompt, /<turn>|<memory_index>/);
});

test("prompt: a long content is cut and a secret in it is redacted first", () => {
  const secret = "sk-ant-api03-" + "a".repeat(40);
  const prompt = buildJudgePrompt({ saved: { ...SAVED, content: `usa ${secret} ${"palabra ".repeat(1000)}` }, candidate: OLD });
  assert.ok(!prompt.includes(secret));
  assert.ok(prompt.length < 6000, `${prompt.length}`);
});

test("system prompt: names all six relations, the direction of supersedes, data-not-instructions and one JSON object", () => {
  for (const relation of RELATIONS) assert.match(JUDGE_SYSTEM, new RegExp(relation));
  assert.match(JUDGE_SYSTEM, /supersedes[^\n]*new[^\n]*existing/i);
  assert.match(JUDGE_SYSTEM, /data, not instructions/);
  assert.match(JUDGE_SYSTEM, /"relation"/);
  assert.match(JUDGE_SYSTEM, /"confidence"/);
});

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test("parseJudgment: each relation is accepted", () => {
  for (const relation of RELATIONS) {
    const parsed = parseJudgment(JSON.stringify({ relation, confidence: 0.9, reason: "because" }));
    assert.deepEqual(parsed, { kind: "verdict", verdict: { relation, confidence: 0.9, reason: "because" } }, relation);
  }
});

test("parseJudgment: prose or a code fence around the object is ignored, and the reason is optional and cut", () => {
  const parsed = parseJudgment('```json\n{"relation":"scoped","confidence":0.8}\n```');
  assert.deepEqual(parsed, { kind: "verdict", verdict: { relation: "scoped", confidence: 0.8, reason: "" } });
  const long = parseJudgment(JSON.stringify({ relation: "related", confidence: 1, reason: "x".repeat(1000) }));
  assert.equal(long.kind, "verdict");
  if (long.kind === "verdict") assert.ok(long.verdict.reason.length <= 200);
});

test("parseJudgment: an unknown relation, a missing or out-of-range confidence, or no JSON is a failure, never a verdict", () => {
  for (const text of [
    "",
    "supersedes",
    "{ nope",
    "[]",
    JSON.stringify({ relation: "replaces", confidence: 0.9 }),
    JSON.stringify({ relation: "SUPERSEDES", confidence: 0.9 }),
    JSON.stringify({ confidence: 0.9 }),
    JSON.stringify({ relation: "supersedes" }),
    JSON.stringify({ relation: "supersedes", confidence: "high" }),
    JSON.stringify({ relation: "supersedes", confidence: 1.5 }),
    JSON.stringify({ relation: "supersedes", confidence: -0.1 }),
    JSON.stringify({ relation: ["supersedes"], confidence: 0.9 }),
  ]) {
    assert.deepEqual(parseJudgment(text), { kind: "failure" }, JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------
// The human-only rule
// ---------------------------------------------------------------------------

test("rule: a confident verdict on an ordinary type is recorded, for every relation", () => {
  for (const relation of RELATIONS) {
    assert.deepEqual(decideVerdict(verdict(relation, 0.9), { savedType: "discovery", candidateType: "learning" }), { action: "record" }, relation);
  }
});

test("rule: confidence below the floor goes to the person, whatever the relation; at the floor it is recorded", () => {
  assert.equal(CONFIDENCE_FLOOR, 0.7);
  for (const relation of RELATIONS) {
    assert.deepEqual(decideVerdict(verdict(relation, 0.69), { savedType: "discovery", candidateType: "learning" }), { action: "pending", why: "low-confidence" }, relation);
  }
  assert.deepEqual(decideVerdict(verdict("related", 0.7), { savedType: "discovery", candidateType: "learning" }), { action: "record" });
});

test("rule: supersedes or conflicts_with on architecture, policy or decision goes to the person", () => {
  assert.deepEqual([...HUMAN_ONLY_TYPES].sort(), ["architecture", "decision", "policy"]);
  for (const type of HUMAN_ONLY_TYPES) {
    for (const relation of ["supersedes", "conflicts_with"] as const) {
      assert.deepEqual(decideVerdict(verdict(relation, 0.95), { savedType: type, candidateType: "discovery" }), { action: "pending", why: "protected-type" }, `${type} saved, ${relation}`);
      assert.deepEqual(decideVerdict(verdict(relation, 0.95), { savedType: "discovery", candidateType: type }), { action: "pending", why: "protected-type" }, `${type} existing, ${relation}`);
    }
  }
});

test("rule: the other relations on a protected type are recorded when confident", () => {
  for (const relation of ["related", "compatible", "scoped", "not_conflict"] as const) {
    assert.deepEqual(decideVerdict(verdict(relation, 0.9), { savedType: "policy", candidateType: "decision" }), { action: "record" }, relation);
  }
});

test("rule: supersedes on an ordinary type is recorded", () => {
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.9), { savedType: "discovery", candidateType: "bugfix" }), { action: "record" });
});

test("rule: low confidence and a protected type together say low confidence (the first reason)", () => {
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.4), { savedType: "policy", candidateType: "policy" }), { action: "pending", why: "low-confidence" });
});

// The owner's rule (odd/tasks/memory-shadow.md): fewer questions. A newer
// feedback that replaces an older one is the person's own latest word, so a
// confident supersedes between two policies is recorded, not asked.
test("rule: a feedback save (type policy in Engram) that supersedes an older feedback at 0.7 or above is recorded", () => {
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.95), { savedType: "policy", candidateType: "policy" }), { action: "record" });
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.7), { savedType: "policy", candidateType: "policy" }), { action: "record" });
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.69), { savedType: "policy", candidateType: "policy" }), { action: "pending", why: "low-confidence" });
});

test("rule: a feedback that conflicts with another, or supersedes a decision or architecture, still goes to the person", () => {
  assert.deepEqual(decideVerdict(verdict("conflicts_with", 0.95), { savedType: "policy", candidateType: "policy" }), { action: "pending", why: "protected-type" });
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.95), { savedType: "policy", candidateType: "decision" }), { action: "pending", why: "protected-type" });
  assert.deepEqual(decideVerdict(verdict("supersedes", 0.95), { savedType: "architecture", candidateType: "policy" }), { action: "pending", why: "protected-type" });
});

// ---------------------------------------------------------------------------
// What is passed to mem_judge
// ---------------------------------------------------------------------------

test("mem_judge args: Haiku's verdict with the candidate's own judgment id", () => {
  assert.deepEqual(buildJudgeArgs("rel-abc", verdict("compatible", 0.85)), {
    judgment_id: "rel-abc",
    relation: "compatible",
    confidence: 0.85,
    reason: "r",
  });
});

test("mem_judge args: the person's choice is the evidence, with full confidence", () => {
  assert.deepEqual(buildJudgeArgs("rel-abc", verdict("supersedes", 0.5), { relation: "conflicts_with", answer: "Sí, son incompatibles" }), {
    judgment_id: "rel-abc",
    relation: "conflicts_with",
    confidence: 1,
    reason: "r",
    evidence: "Resolved by the person: Sí, son incompatibles",
  });
});

test("resolve options: the person picks among two to four relations", () => {
  assert.ok(RESOLVE_OPTIONS.length >= 2 && RESOLVE_OPTIONS.length <= 4);
  for (const option of RESOLVE_OPTIONS) assert.ok((RELATIONS as readonly string[]).includes(option), option);
});

// ---------------------------------------------------------------------------
// mem_get_observation's text
// ---------------------------------------------------------------------------

test("observation text: id, type, title and content are read from mem_get_observation's text", () => {
  const text = "#18 [policy] Spanish with vos\nTalk to the owner in Spanish with vos.\nSecond line.\nSession: manual-save-x\nProject: orca\nScope: project\nTopic: language-es\nDuplicates: 1\nRevisions: 0\nCreated: 2026-10-01";
  assert.deepEqual(parseObservationText(text), { id: 18, type: "policy", title: "Spanish with vos", content: "Talk to the owner in Spanish with vos.\nSecond line." });
});

test("observation text: anything else is null", () => {
  assert.equal(parseObservationText("Observation #5 not found"), null);
  assert.equal(parseObservationText(""), null);
});

test("E1 observation result: mem_get_observation's MCP result, the text inside Engram 2.x's project envelope or bare", () => {
  const text = "#18 [policy] Spanish with vos\nTalk to the owner in Spanish with vos.\nSession: manual-save-x\nCreated: 2026-10-01";
  const expected = { id: 18, type: "policy", title: "Spanish with vos", content: "Talk to the owner in Spanish with vos." };
  const enveloped = { content: [{ type: "text", text: JSON.stringify({ project: "orca", project_source: "git_remote", result: text }) }], isError: false };
  assert.deepEqual(readObservationResult(enveloped), expected);
  assert.deepEqual(readObservationResult({ content: [{ type: "text", text }] }), expected, "an older Engram answers the bare text");
  assert.equal(readObservationResult({ content: [{ type: "text", text: "Observation #18 not found" }], isError: true }), null, "a tool error is no observation");
  assert.equal(readObservationResult({ content: [{ type: "text", text: JSON.stringify({ project: "orca" }) }] }), null);
  assert.equal(readObservationResult(null), null);
});
