import assert from "node:assert/strict";
import test from "node:test";

import { HOLD_AFTER, holdEffort, isExec, stepPhase, toolFailed, withStep } from "./step_phase.ts";
import type { PhaseTurn } from "./step_phase.ts";

// ---------------------------------------------------------------------------
// 0.6.16 T4 (odd/research/phase-effort.md §1, §6 B): each main step's phase,
// and what a hold rule would send. Measure only.
// ---------------------------------------------------------------------------

const bash = (command: string) => ({ name: "Bash", input: { command } });

test("T4 stepPhase: the research's labels, first match by priority", () => {
  assert.equal(stepPhase([{ name: "Edit", input: {} }, { name: "Read", input: {} }], "tool_use"), "EDIT");
  assert.equal(stepPhase([{ name: "Agent", input: {} }], "tool_use"), "DELEGATE");
  assert.equal(stepPhase([bash("npm test")], "tool_use"), "VERIFY");
  assert.equal(stepPhase([bash("npx tsc --noEmit")], "tool_use"), "VERIFY");
  assert.equal(stepPhase([bash("git commit -m x")], "tool_use"), "RUN");
  assert.equal(stepPhase([bash("gh run watch 12")], "tool_use"), "WAIT");
  assert.equal(stepPhase([{ name: "TaskOutput", input: {} }], "tool_use"), "WAIT");
  assert.equal(stepPhase([bash("node build.mjs")], "tool_use"), "RUN");
  assert.equal(stepPhase([{ name: "mcp__srv__deploy", input: {} }], "tool_use"), "RUN");
  assert.equal(stepPhase([{ name: "Grep", input: {} }], "tool_use"), "READ");
  assert.equal(stepPhase([bash("git status")], "tool_use"), "READ");
  assert.equal(stepPhase([bash("sed -n 1,20p a.ts")], "tool_use"), "READ");
  assert.equal(stepPhase([{ name: "mcp__graft__graft_find_code", input: {} }], "tool_use"), "READ");
  assert.equal(stepPhase([{ name: "TodoWrite", input: {} }], "tool_use"), "OTHER");
  assert.equal(stepPhase([], "end_turn"), "ANSWER");
  assert.equal(stepPhase([], "max_tokens"), "TEXT");
});

test("T4 isExec: verify, run, wait and read", () => {
  assert.deepEqual(["EDIT", "DELEGATE", "VERIFY", "RUN", "WAIT", "READ", "ANSWER", "TEXT", "OTHER"].map((phase) => isExec(phase as never)), [false, false, true, true, true, true, false, false, false]);
});

function turnOf(phases: string[], failedAt: number[] = []): PhaseTurn {
  let turn: PhaseTurn = { turnId: "t", steps: [] };
  phases.forEach((phase, index) => {
    turn = withStep(turn, phase as never, failedAt.includes(index));
  });
  return turn;
}

test("T4 withStep: OTHER takes the previous step's side; the EXEC run length counts back from the last step", () => {
  const turn = turnOf(["EDIT", "READ", "OTHER", "RUN"]);
  assert.deepEqual(turn.steps.map((step) => step.exec), [false, true, true, true]);
});

test("T4 holdEffort: lowered to medium only after 5 EXEC steps with no failure, from high or xhigh, on Opus 5.5", () => {
  assert.equal(HOLD_AFTER, 5);
  const five = turnOf(["EDIT", "READ", "READ", "RUN", "VERIFY", "WAIT"]);
  assert.deepEqual(holdEffort(five, "high", "claude-opus-5-5"), { effort: "medium", execRun: 5 });
  assert.deepEqual(holdEffort(five, "xhigh", "claude-opus-5-5[1m]"), { effort: "medium", execRun: 5 });
  assert.deepEqual(holdEffort(turnOf(["EDIT", "READ", "READ", "RUN", "VERIFY"]), "high", "claude-opus-5-5"), { effort: "high", execRun: 4 });
});

test("T4 holdEffort: an error or failed test in the run, an edit, a delegation or a new turn raises it back", () => {
  assert.equal(holdEffort(turnOf(["READ", "READ", "RUN", "VERIFY", "WAIT"], [3]), "high", "claude-opus-5-5").effort, "high");
  assert.equal(holdEffort(turnOf(["READ", "READ", "RUN", "VERIFY", "WAIT", "READ", "EDIT"]), "high", "claude-opus-5-5").effort, "high");
  assert.equal(holdEffort(turnOf(["READ", "READ", "RUN", "VERIFY", "WAIT", "DELEGATE"]), "high", "claude-opus-5-5").effort, "high");
  assert.deepEqual(holdEffort({ turnId: "t", steps: [] }, "high", "claude-opus-5-5"), { effort: "high", execRun: 0 });
});

test("T4 holdEffort: never from medium or below, max or a number, never on Sonnet 5 or Sonnet 5.5", () => {
  const run = turnOf(["READ", "READ", "RUN", "VERIFY", "WAIT"]);
  for (const effort of ["medium", "low", "max", 8000, null] as const) assert.equal(holdEffort(run, effort, "claude-opus-5-5").effort, effort);
  assert.equal(holdEffort(run, "high", "claude-sonnet-5").effort, "high");
  assert.equal(holdEffort(run, "high", "claude-sonnet-5-5").effort, "high");
});

test("T4 toolFailed: an error, a refusal, or a test run that reports failures", () => {
  assert.equal(toolFailed("Read", {}, { isError: true }), true);
  assert.equal(toolFailed("Bash", { command: "rm -rf /" }, { deny: "no" }), true);
  assert.equal(toolFailed("Bash", { command: "npm test" }, { text: "ℹ fail 2\n✖ parser" }), true);
  assert.equal(toolFailed("Bash", { command: "npm test" }, { text: "ℹ pass 12\nℹ fail 0" }), false);
  assert.equal(toolFailed("Bash", { command: "echo FAIL" }, { text: "FAIL" }), false, "only a test command's output reads as a test");
});
