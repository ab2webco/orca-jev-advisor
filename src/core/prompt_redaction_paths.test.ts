// QA 0.6.5 A1 (JEVADV-61): the gate, router and steward redact secrets before
// Jev sees a prompt, but the model, skill and tool decisions sent the prompt
// verbatim, and the skill and tool measurement records wrote it to disk. A
// person who pastes a key into a prompt must not have it leave the machine
// or land in a JSONL that nobody rotates. Each builder below is the last
// step before Jev or the disk. Run with:
//   node --test src/core/prompt_redaction_paths.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { buildModelState } from "./model_decisions.ts";
import { buildFitState as buildSkillFitState, buildWideState as buildSkillWideState } from "./skill_decisions.ts";
import { buildDecisionRecord as buildSkillRecord } from "./skill_measurement.ts";
import { buildFitState as buildToolFitState, buildWideState as buildToolWideState } from "./tool_decisions.ts";
import { buildDecisionRecord as buildToolRecord } from "./tool_measurement.ts";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const PROMPT = `deploy with export ANTHROPIC_API_KEY=${SECRET} and then run the tests`;

function assertRedacted(value: unknown, where: string): void {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(SECRET), `${where} carries the secret verbatim`);
  assert.ok(text.includes("run the tests"), `${where} lost the rest of the prompt`);
}

test("the model decision's state never carries a secret from the task prompt or description", () => {
  const state = buildModelState({ raw: {}, prompt: PROMPT, description: `uses ${SECRET}`, subagentType: null, model: null }, []);
  assertRedacted(state, "buildModelState");
  assert.ok(!JSON.stringify(state).includes(SECRET));
});

test("the skill decision's stage 1 and stage 2 states never carry a secret", () => {
  const orca = { worktree: "/wt", proyecto: "p", rama: "b" };
  assertRedacted(buildSkillWideState(PROMPT, [{ name: "s", description: "d" }], orca), "skill buildWideState");
  assertRedacted(buildSkillFitState(PROMPT, [{ name: "s", description: "d", excerpt: "e" }], orca), "skill buildFitState");
});

test("the tool decision's stage 1 and stage 2 states never carry a secret", () => {
  const orca = { worktree: "/wt", project: "p", branch: "b" };
  assertRedacted(buildToolWideState(PROMPT, [{ name: "t", description: "d" }], orca), "tool buildWideState");
  assertRedacted(buildToolFitState(PROMPT, [{ name: "t", description: "d", fullDescription: "f" }], orca), "tool buildFitState");
});

test("the skill and tool measurement records never write a secret to disk", () => {
  const common = { id: "i", at: "2026-09-28T00:00:00.000Z", mode: "active" as const, prompt: PROMPT, candidateCount: 1, listingChars: 1, wide: null, fit: null, decision: { name: null, reason: "r" }, latencyMs: { wide: null, fit: null } };
  assertRedacted(buildToolRecord({ ...common, orcaContext: { worktree: "/wt", project: "p", branch: "b" } }), "tool buildDecisionRecord");
  assertRedacted(buildSkillRecord({ ...common, orcaContext: { worktree: "/wt", proyecto: "p", rama: "b" }, listingWithheld: false, readiness: null }), "skill buildDecisionRecord");
});
