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

// 0.6.11 T3: the Orca context -- worktree path, project and branch -- goes
// through the same redaction: placeholders, never the names themselves.
const ORCA_NAMES = { worktree: "/home/dev/Projects/acme-shop", project: "acme-shop", branch: "feat/acme-login" };
const REDACTED_ORCA = { worktree: "<path-1>", project: "<repo-1>", branch: "<branch-1>" };

function assertNoOrcaNames(value: unknown, where: string): void {
  const text = JSON.stringify(value);
  assert.ok(!text.includes("acme"), `${where} carries a worktree, project or branch name in clear`);
}

test("the skill decision's stage 1 and stage 2 states carry the Orca context as placeholders", () => {
  const orca = { worktree: ORCA_NAMES.worktree, proyecto: ORCA_NAMES.project, rama: ORCA_NAMES.branch };
  const wide = buildSkillWideState(PROMPT, [{ name: "s", description: "d" }], orca) as { orca_context: unknown };
  const fit = buildSkillFitState(PROMPT, [{ name: "s", description: "d", excerpt: "e" }], orca) as { orca_context: unknown };
  assert.deepEqual(wide.orca_context, REDACTED_ORCA);
  assert.deepEqual(fit.orca_context, REDACTED_ORCA);
  assertNoOrcaNames(wide, "skill buildWideState");
  assertNoOrcaNames(fit, "skill buildFitState");
});

test("the tool decision's stage 1 and stage 2 states carry the Orca context as placeholders", () => {
  const wide = buildToolWideState(PROMPT, [{ name: "t", description: "d" }], ORCA_NAMES) as { orcaContext: unknown };
  const fit = buildToolFitState(PROMPT, [{ name: "t", description: "d", fullDescription: "f" }], ORCA_NAMES) as { orcaContext: unknown };
  assert.deepEqual(wide.orcaContext, REDACTED_ORCA);
  assert.deepEqual(fit.orcaContext, REDACTED_ORCA);
  assertNoOrcaNames(wide, "tool buildWideState");
  assertNoOrcaNames(fit, "tool buildFitState");
});

test("an unknown Orca context stays null, and a protected branch stays in clear", () => {
  const wide = buildToolWideState(PROMPT, [{ name: "t", description: "d" }], { worktree: null, project: null, branch: "main" }) as { orcaContext: unknown };
  assert.deepEqual(wide.orcaContext, { worktree: null, project: null, branch: "main" });
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

// 0.6.11 T3: the prompt text reads with the same placeholders as the Orca context.
test("the skill and tool decisions' prompt shows the Orca context's names as the same placeholders", () => {
  const prompt = "push feat/acme-login from /home/dev/Projects/acme-shop and then run the tests in acme-shop";
  const expected = "push <branch-1> from <path-1> and then run the tests in <repo-1>";
  const skillOrca = { worktree: ORCA_NAMES.worktree, proyecto: ORCA_NAMES.project, rama: ORCA_NAMES.branch };
  const skillWide = buildSkillWideState(prompt, [{ name: "s", description: "d" }], skillOrca) as { solicitud: string; orca_context: unknown };
  const skillFit = buildSkillFitState(prompt, [{ name: "s", description: "d", excerpt: "e" }], skillOrca) as { solicitud: string };
  const toolWide = buildToolWideState(prompt, [{ name: "t", description: "d" }], ORCA_NAMES) as { request: string; orcaContext: unknown };
  const toolFit = buildToolFitState(prompt, [{ name: "t", description: "d", fullDescription: "f" }], ORCA_NAMES) as { request: string };
  assert.equal(skillWide.solicitud, expected);
  assert.equal(skillFit.solicitud, expected);
  assert.equal(toolWide.request, expected);
  assert.equal(toolFit.request, expected);
  assert.deepEqual(skillWide.orca_context, REDACTED_ORCA);
  assert.deepEqual(toolWide.orcaContext, REDACTED_ORCA);
});
