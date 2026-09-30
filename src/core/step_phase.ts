// ---------------------------------------------------------------------------
// 0.6.16 T4 (odd/research/phase-effort.md §1, §6 B): the phase of each main
// step, and the effort a hold rule WOULD send. Measure only: nothing here is
// ever sent. The research could not tell from the transcripts alone whether
// lowering effort on long execute runs pays; these rows let a later release
// decide on the plugin's own measurements.
//
// Labels, the research's own (first match by priority): EDIT, DELEGATE,
// VERIFY (tests, builds, linters), RUN (other shell, git writes, gh, MCP),
// WAIT (task output, monitors, sleeps and polls), READ (reads, searches,
// read-only shell, git status/log/diff), ANSWER (no tool, the turn ends),
// TEXT (no tool otherwise), OTHER (todo lists, skills): OTHER takes the
// previous step's side. EXEC = VERIFY + RUN + WAIT + READ.
//
// The would-be hold rule: lower to medium only after HOLD_AFTER consecutive
// EXEC steps in the turn with no tool error and no failed test among them
// (so no edit in the last two either), from high or xhigh only; any other
// step (an edit, a delegation, an answer), an error, and a new turn raise it
// back. Never on Sonnet 5 (a change restarts its cache) or Sonnet 5.5 (a
// per-message change is refused with `between_tools` thinking, which a hook
// cannot see).
//
// Pure: the hooks module feeds each step's tools and its tools' outcomes.
// ---------------------------------------------------------------------------

import { baseModelId } from "./model_router_accounts.ts";
import type { SessionEffort } from "./model_router_decide.ts";

export type StepPhase = "EDIT" | "DELEGATE" | "VERIFY" | "RUN" | "WAIT" | "READ" | "ANSWER" | "TEXT" | "OTHER";

const TEST = /\b(npm (run )?test|npx (jest|vitest|playwright)|jest|vitest|pytest|go test|cargo test|node --test|bun test|deno test|phpunit|rspec|playwright test)\b/;
const BUILD = /\b(tsc|eslint|prettier|biome|npm run (build|lint|check|typecheck|format|verify|ci)|pnpm (build|lint|check|typecheck)|yarn (build|lint)|cargo (build|check|clippy)|make\b|go build|go vet|ruff|mypy|bun run (build|check|lint))/;
const CI_WAIT = /\bgh (run|pr checks|pr view|pr status|api)|\bsleep \d|until .*; do|while .*sleep/;
const GIT_WRITE = /\bgit (commit|push|add|checkout|switch|merge|rebase|reset|stash|tag|cherry-pick|worktree|branch -)|\bgh (pr (create|merge|edit|comment)|release)/;
const GIT_READ = /^\s*(cd \S+ *(&&|;) *)?git (status|log|diff|show|rev-parse|ls-files|branch|remote|fetch)\b/;
const PROBE = /^\s*(cd \S+ *(&&|;) *)?(ls|cat|head|tail|sed -n|wc|grep|rg|find|file|stat|jq|tree|du|which|echo|pwd|awk)\b/;

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "ToolSearch"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DELEGATE_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const WAIT_TOOLS: ReadonlySet<string> = new Set(["TaskOutput", "SendMessage", "Monitor", "BashOutput", "KillShell", "TaskStop", "ScheduleWakeup"]);
const READ_MCP = /^mcp__(graft|context7)|^mcp__engram__mem_(search|get|context)/;

type Category = "edit" | "delegate" | "test" | "build" | "git_w" | "ci_wait" | "run" | "wait" | "mcp" | "read" | "probe" | "git_r" | "other";

function categoryOf(name: string, input: unknown): Category {
  if (name === "Bash") {
    const command = typeof input === "object" && input !== null && typeof (input as { command?: unknown }).command === "string" ? (input as { command: string }).command : "";
    if (TEST.test(command)) return "test";
    if (BUILD.test(command)) return "build";
    if (GIT_WRITE.test(command)) return "git_w";
    if (CI_WAIT.test(command)) return "ci_wait";
    if (GIT_READ.test(command)) return "git_r";
    if (PROBE.test(command)) return "probe";
    return "run";
  }
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (DELEGATE_TOOLS.has(name)) return "delegate";
  if (WAIT_TOOLS.has(name)) return "wait";
  if (READ_MCP.test(name)) return "read";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

const PRIORITY: readonly (readonly [Category, StepPhase])[] = [
  ["edit", "EDIT"], ["delegate", "DELEGATE"], ["test", "VERIFY"], ["build", "VERIFY"], ["git_w", "RUN"], ["ci_wait", "WAIT"], ["run", "RUN"],
  ["wait", "WAIT"], ["mcp", "RUN"], ["read", "READ"], ["probe", "READ"], ["git_r", "READ"], ["other", "OTHER"],
];

/** A step's phase from the tools its response called and why it stopped. */
export function stepPhase(toolUses: readonly { readonly name: string; readonly input: unknown }[], stopReason: string | null): StepPhase {
  if (toolUses.length === 0) return stopReason === "end_turn" ? "ANSWER" : "TEXT";
  const categories = new Set(toolUses.map((use) => categoryOf(use.name, use.input)));
  for (const [category, phase] of PRIORITY) if (categories.has(category)) return phase;
  return "OTHER";
}

export function isExec(phase: StepPhase): boolean {
  return phase === "VERIFY" || phase === "RUN" || phase === "WAIT" || phase === "READ";
}

/** One step of the turn so far: its phase, which side it counts on (OTHER inherits), and whether one of its tools errored or a test failed. */
export interface PhaseStep {
  readonly phase: StepPhase;
  readonly exec: boolean;
  readonly failed: boolean;
}

export interface PhaseTurn {
  readonly turnId: string;
  readonly steps: readonly PhaseStep[];
}

/** `turn` with one more step. */
export function withStep(turn: PhaseTurn, phase: StepPhase, failed = false): PhaseTurn {
  const previous = turn.steps.at(-1);
  const exec = phase === "OTHER" ? (previous?.exec ?? false) : isExec(phase);
  return { ...turn, steps: [...turn.steps, { phase, exec, failed }] };
}

/** `turn` with its last step marked failed (a tool of it errored, or a test it ran failed). */
export function withLastFailed(turn: PhaseTurn): PhaseTurn {
  const last = turn.steps.at(-1);
  if (last === undefined || last.failed) return turn;
  return { ...turn, steps: [...turn.steps.slice(0, -1), { ...last, failed: true }] };
}

export const HOLD_AFTER = 5;

/** The consecutive EXEC steps that end the turn so far. */
function execRunOf(turn: PhaseTurn): number {
  let run = 0;
  for (let index = turn.steps.length - 1; index >= 0 && (turn.steps[index] as PhaseStep).exec; index -= 1) run += 1;
  return run;
}

/** What the would-be hold rule sends on the next step of `turn`, given what it is sent with (`sent`), and the EXEC run it read. */
export function holdEffort(turn: PhaseTurn, sent: SessionEffort | null, model: string): { readonly effort: SessionEffort | null; readonly execRun: number } {
  const execRun = execRunOf(turn);
  const id = baseModelId(model);
  const eligible = (sent === "high" || sent === "xhigh") && !/^claude-sonnet-5(?:-5)?(?:-\d{8})?$/.test(id);
  const clean = turn.steps.slice(-HOLD_AFTER).every((step) => !step.failed);
  return { effort: eligible && execRun >= HOLD_AFTER && clean ? "medium" : sent, execRun };
}

const TEST_FAILED = /✖|\bFAIL\b|\b[1-9]\d* (failing|failed|failures?)\b|\bfail [1-9]/;

/** Whether a main-loop tool call failed for the hold rule: it errored, it was refused, or it ran tests that report a failure. */
export function toolFailed(tool: string, input: unknown, outcome: { readonly isError?: boolean; readonly deny?: string; readonly text?: string }): boolean {
  if (outcome.isError === true || typeof outcome.deny === "string") return true;
  return tool === "Bash" && categoryOf(tool, input) === "test" && TEST_FAILED.test(outcome.text ?? "");
}
