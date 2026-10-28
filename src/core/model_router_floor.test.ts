import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./model_catalog.ts";
import { resolveAccountTiers } from "./model_router_accounts.ts";
import { belowCodeFloor, decideStepEscalation, decideTestLoopEscalation, escalationSignal, testFixLoop } from "./model_router_floor.ts";
import type { StepEscalationInput } from "./model_router_floor.ts";
import type { ActivityMessage } from "./model_router_stage.ts";

function entry(id: string, rank: number): ModelEntry {
  return { id, provider: "anthropic", label: id, rank, agentModel: id, source: "", available: true };
}
const TIERS = resolveAccountTiers({ env: {}, catalog: [{ ...entry("claude-fable-5-1", 1), available: false }, entry("claude-opus-5-5", 2), entry("claude-sonnet-5-5", 3), entry("claude-haiku-5-5", 4)], quota: null });

const CWD = "/w/orca-823";

function edit(tool: string, input: Record<string, unknown>): ActivityMessage {
  return { role: "assistant", text: "", toolUses: [{ tool, input }] };
}
const PROMPT: ActivityMessage = { role: "user", text: "Read your Orca Lab brief at .orca/briefs/ctx_1.md and follow it.", toolUses: [] };

function input(turn: readonly ActivityMessage[], overrides: Partial<StepEscalationInput> = {}): StepEscalationInput {
  return { tiers: TIERS, currentModel: "claude-haiku-5-5", currentEffort: "medium", configuredModel: "claude-opus-5-5", configuredEffort: "high", cwd: CWD, messages: [PROMPT, ...turn], ...overrides };
}

test("an edit to a file in the worktree is code work", () => {
  assert.equal(escalationSignal([PROMPT, edit("Edit", { file_path: `${CWD}/src/fleet.ts` })], CWD), "code-edit");
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: "src/new.ts" })], CWD), "code-edit", "relative to the worktree");
  assert.equal(escalationSignal([PROMPT, edit("NotebookEdit", { notebook_path: `${CWD}/a.ipynb` })], CWD), "code-edit");
});

test("a shell command that changes tracked files is code work too", () => {
  for (const command of ["git commit -m 'fix: x'", "sed -i '' 's/a/b/' src/a.ts", "git apply fix.patch", "perl -pi -e 's/a/b/' src/a.ts"]) {
    assert.equal(escalationSignal([PROMPT, edit("Bash", { command })], CWD), "code-edit", command);
  }
});

test("reading, a scratch file, /tmp, the brief folder and a file outside the worktree are not code work (lead, 2026-10-27)", () => {
  assert.equal(escalationSignal([PROMPT, edit("Read", { file_path: `${CWD}/src/a.ts` }), edit("Bash", { command: "du -xsh ~/orca/workspaces/*" })], CWD), null);
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: "/tmp/disk-audit.md" })], CWD), null);
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: "/Volumes/Data/claude-tmp/x/scratchpad/table.md" })], CWD), null);
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: `${CWD}/.orca/briefs/notes.md` })], CWD), null);
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: "/w/orca-823-other/src/a.ts" })], CWD), null, "a sibling folder is not inside");
});

test("an edited path in a high-risk area escalates, inside the worktree or out of it, but not in a temp folder", () => {
  assert.equal(escalationSignal([PROMPT, edit("Edit", { file_path: `${CWD}/src/security/gate.ts` })], CWD), "high-risk-edit");
  assert.equal(escalationSignal([PROMPT, edit("Edit", { file_path: "/home/dev/.aws/credentials" })], CWD), "high-risk-edit");
  assert.equal(escalationSignal([PROMPT, edit("Write", { file_path: "/tmp/deploy-notes.md" })], CWD), null);
});

test("only the work since the last real prompt counts", () => {
  const earlier = [{ role: "user" as const, text: "fix the parser", toolUses: [] }, edit("Edit", { file_path: `${CWD}/src/a.ts` })];
  assert.equal(escalationSignal([...earlier, PROMPT, edit("Read", { file_path: `${CWD}/src/a.ts` })], CWD), null);
});

test("a member started low that edits code is raised to Opus 5.5 at the floor tier's effort", () => {
  const decision = decideStepEscalation(input([edit("Edit", { file_path: `${CWD}/src/a.ts` })]));
  assert.equal(decision?.model, "claude-opus-5-5");
  assert.equal(decision?.effort, "high");
  assert.equal(decision?.changed, true);
  assert.equal(decision?.reason, "escalate");
  assert.equal(decision?.signal, "code-edit");
  assert.equal(decision?.current, "claude-haiku-5-5");
});

test("back on the session's own model, its own higher effort is kept", () => {
  const decision = decideStepEscalation(input([edit("Edit", { file_path: `${CWD}/src/a.ts` })], { configuredEffort: "xhigh" }));
  assert.equal(decision?.effort, "xhigh");
});

test("no signal, or a model already at the floor, changes nothing", () => {
  assert.equal(decideStepEscalation(input([edit("Read", { file_path: `${CWD}/src/a.ts` })])), null);
  assert.equal(decideStepEscalation(input([edit("Edit", { file_path: `${CWD}/src/a.ts` })], { currentModel: "claude-opus-5-5" })), null);
});

test("an Orca model pin always wins: the model is never moved", () => {
  assert.equal(decideStepEscalation(input([edit("Edit", { file_path: `${CWD}/src/a.ts` })], { pins: { model: true, effort: false } })), null);
});

test("an Orca effort pin keeps the session's own effort while the model rises", () => {
  const decision = decideStepEscalation(input([edit("Edit", { file_path: `${CWD}/src/a.ts` })], { pins: { model: false, effort: true }, configuredEffort: "medium" }));
  assert.equal(decision?.model, "claude-opus-5-5");
  assert.equal(decision?.effort, "medium");
});

test("belowCodeFloor: Haiku and Sonnet are below the code floor, Opus and Fable are not", () => {
  assert.equal(belowCodeFloor(TIERS, "claude-haiku-5-5"), true);
  assert.equal(belowCodeFloor(TIERS, "claude-sonnet-5-5"), true);
  assert.equal(belowCodeFloor(TIERS, "claude-opus-5-5"), false);
  assert.equal(belowCodeFloor(TIERS, "claude-opus-5-5[1m]"), false);
  assert.equal(belowCodeFloor(TIERS, "some-unknown-model"), false);
});

// ---------------------------------------------------------------------------
// JEVADV-118 T4: failing tests twice, RED-safe
// ---------------------------------------------------------------------------

function testRun(failed: boolean, command = "npm test"): ActivityMessage {
  return { role: "assistant", text: "", toolUses: [{ tool: "Bash", input: { command }, text: failed ? "ℹ pass 12\nℹ fail 2" : "ℹ pass 14\nℹ fail 0", ...(failed ? { isError: true as const } : {}) }] };
}
const FIX = edit("Edit", { file_path: `${CWD}/src/parser.ts` });
const TEST_EDIT = edit("Edit", { file_path: `${CWD}/src/parser.test.ts` });

test("T4: a failing run, a fix to a non-test file and a failing run again is a test-fix loop", () => {
  assert.equal(testFixLoop([PROMPT, testRun(true), FIX, testRun(true)], CWD), true);
  assert.equal(testFixLoop([PROMPT, testRun(true, "node --test src/a.test.ts"), FIX, edit("Read", { file_path: `${CWD}/src/a.ts` }), testRun(true, "node --test src/a.test.ts")], CWD), true);
});

test("T4: RED first is not a loop: a failing run, a test-only edit and a failing run again", () => {
  assert.equal(testFixLoop([PROMPT, testRun(true), TEST_EDIT, testRun(true)], CWD), false);
  assert.equal(testFixLoop([PROMPT, TEST_EDIT, testRun(true), edit("Write", { file_path: `${CWD}/test/parser_spec.rb` }), testRun(true)], CWD), false);
});

test("T4: a fix that makes the run pass, a fix with no run before it, or one failing run is no loop", () => {
  assert.equal(testFixLoop([PROMPT, testRun(true), FIX, testRun(false)], CWD), false);
  assert.equal(testFixLoop([PROMPT, FIX, testRun(true)], CWD), false);
  assert.equal(testFixLoop([PROMPT, testRun(true), testRun(true)], CWD), false, "no fix between the runs");
  assert.equal(testFixLoop([PROMPT, testRun(true), edit("Write", { file_path: "/tmp/notes.md" }), testRun(true)], CWD), false, "a scratch note is no fix");
});

test("T4: a passing run ends the cycle: a second TDD cycle in the same turn is no loop", () => {
  assert.equal(testFixLoop([PROMPT, testRun(true), FIX, testRun(false), TEST_EDIT, testRun(true)], CWD), false);
  assert.equal(testFixLoop([PROMPT, testRun(true), FIX, testRun(false), FIX, testRun(true)], CWD), false, "the first failure of a new cycle is not a loop");
  assert.equal(testFixLoop([PROMPT, testRun(true), FIX, testRun(false), testRun(true), FIX, testRun(true)], CWD), true, "a new cycle can still loop");
});

test("T4: only the work since the last real prompt counts", () => {
  const earlier = [{ role: "user" as const, text: "fix the parser", toolUses: [] }, testRun(true), FIX];
  assert.equal(testFixLoop([...earlier, PROMPT, testRun(true)], CWD), false);
});

test("T4: below the floor the loop raises to Opus 5.5 and the effort one step past the floor's (high to xhigh)", () => {
  const decision = decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)]));
  assert.equal(decision?.model, "claude-opus-5-5");
  assert.equal(decision?.effort, "xhigh");
  assert.equal(decision?.reason, "escalate");
  assert.equal(decision?.signal, "test-loop");
});

test("T4: on Opus 5.5 the model stays and the effort rises one step; never Fable, never past xhigh", () => {
  const onOpus = decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "high" }));
  assert.equal(onOpus?.model, "claude-opus-5-5");
  assert.equal(onOpus?.effort, "xhigh");
  assert.equal(onOpus?.tier, "complex", "the tier of the model it stays on, so the status line can name it");
  const fromMedium = decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "medium" }));
  assert.equal(fromMedium?.effort, "high");
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "xhigh" })), null, "already at the cap: nothing to raise");
  // Fable is on no tier of the router's ladder, so a session the person put on it is left alone: never lowered.
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-fable-5-1", currentEffort: "high" })), null);
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "some-unknown-model", currentEffort: "high" })), null, "a model the account does not know is left alone");
});

test("T4: on Opus 5.5 with no effort sent, the floor tier's effort stands in and rises one step", () => {
  const decision = decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: null }));
  assert.equal(decision?.effort, "xhigh");
});

test("T4: a person's max or numeric effort is never touched", () => {
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "max" })), null);
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: 32000 })), null);
});

test("T4: no loop changes nothing", () => {
  assert.equal(decideTestLoopEscalation(input([testRun(true), TEST_EDIT, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "high" })), null);
});

test("T4: an Orca model pin holds; an effort pin keeps the session's effort", () => {
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { pins: { model: true, effort: false } })), null);
  const pinned = decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { pins: { model: false, effort: true }, configuredEffort: "medium" }));
  assert.equal(pinned?.model, "claude-opus-5-5");
  assert.equal(pinned?.effort, "medium");
  assert.equal(decideTestLoopEscalation(input([testRun(true), FIX, testRun(true)], { currentModel: "claude-opus-5-5", currentEffort: "high", pins: { model: false, effort: true } })), null, "on Opus an effort pin leaves nothing to raise");
});
