// ---------------------------------------------------------------------------
// JEVADV-118 T2 (odd/tasks/jevadv-118.md): the code floor, step by step.
//
// An Orca member's run is one long turn: the start decision (point A) sets
// its model for the whole run, and Jev is not asked again (17 of 116 member
// sessions had any later stage row). Once a brief is judged (T1), a read-only
// one starts low -- so the floor cannot wait for the next prompt. On every
// main-loop step of a session the router has below the code floor, the work
// since the last real prompt is read here, locally (no Jev call):
//
//   code-edit       -- an edit to a file inside the worktree (not under
//                      `.orca/`), or a shell command that changes tracked
//                      files (commit, apply, in-place sed or perl);
//   high-risk-edit  -- an edited path in a sensitive area (security,
//                      credentials, migration, deploy, release, production),
//                      in the worktree or out of it, but not in a temp folder.
//
// Either raises the model to IMPLEMENT_FLOOR_TIER (Opus 5.5) on the next step.
//
// T4, on any model: a failing test run, then a fix to a non-test file in the
// worktree, then a failing run again (a test-fix loop) raises the model to
// at least Opus 5.5 and the effort one step past its own (high to xhigh),
// never past xhigh and never to Fable (lead, 2026-10-27). RED-safe: writing
// a failing test, editing only tests and running it again is TDD, not a
// loop.
// Writes to /tmp, a scratchpad, the brief folder or another folder do not:
// a read-only audit can stay low (lead, 2026-10-27). Only ever up, never
// down; an Orca model pin wins, an effort pin keeps the session's effort, and
// a person's `/model` lock never reaches here.
//
// Pure: no I/O.
// ---------------------------------------------------------------------------

import { collapseTier, modelRank, tierOfModel } from "./model_router_accounts.ts";
import type { ResolvedTiers } from "./model_router_accounts.ts";
import { EFFORT_LEVELS, IMPLEMENT_FLOOR_TIER, TIER_EFFORT, effortRank, exactModelId, guardedEffort, isPersonEffort, topicFlags } from "./model_router_decide.ts";
import type { SessionEffort, TierEffortMap } from "./model_router_decide.ts";
import { isFailingTestRun, isTestRun, messagesSinceLastPrompt } from "./model_router_stage.ts";
import type { ActivityMessage, StageDecision } from "./model_router_stage.ts";
import { pinnedEffort } from "./orca_pins.ts";
import type { OrcaPins } from "./orca_pins.ts";

export type EscalationSignal = "code-edit" | "high-risk-edit" | "test-loop";

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Shell commands that change tracked files. Anything else a command writes is not read as code work. */
const SHELL_CODE_WRITE = /\bgit\s+(?:commit|apply|am|cherry-pick|merge|rebase|revert)\b|\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b|\bsed\s+-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i/;

/** Temp folders: a write there is a scratch note, never code. */
const TEMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)|\/scratchpad\//;

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** `path` made absolute against `cwd`, with `.` and `..` segments folded. */
function absolutePath(path: string, cwd: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${trimSlash(cwd)}/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function editedPath(use: ActivityMessage["toolUses"][number]): string | null {
  if (!EDIT_TOOLS.has(use.tool)) return null;
  const path = use.input.file_path ?? use.input.notebook_path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** A test file by its name or folder: `a.test.ts`, `a_spec.rb`, `test_a.py`, `tests/`, `__tests__/`, `spec/`. */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]+$/;

/** Whether the work since the last real prompt holds a failing test run, a fix to a non-test file in the worktree, and a failing run again, in that order, with no passing run between them. */
export function testFixLoop(messages: readonly ActivityMessage[], cwd: string): boolean {
  const root = trimSlash(cwd);
  let stage: "start" | "failed" | "fixed" = "start";
  for (const message of messagesSinceLastPrompt(messages) ?? []) {
    for (const use of message.toolUses) {
      if (isFailingTestRun(use)) {
        if (stage === "fixed") return true;
        stage = "failed";
        continue;
      }
      // A passing run ends the cycle: the next RED test starts a new one.
      if (isTestRun(use)) {
        stage = "start";
        continue;
      }
      const raw = editedPath(use);
      if (raw === null || stage !== "failed") continue;
      const path = absolutePath(raw, root);
      if (path.startsWith(`${root}/`) && !path.startsWith(`${root}/.orca/`) && !TEMP_PATH.test(path) && !TEST_PATH.test(path)) stage = "fixed";
    }
  }
  return false;
}

/** The strongest signal in the work since the last real prompt, or null when it changed no code. */
export function escalationSignal(messages: readonly ActivityMessage[], cwd: string): EscalationSignal | null {
  const turn = messagesSinceLastPrompt(messages) ?? [];
  const root = trimSlash(cwd);
  let signal: EscalationSignal | null = null;
  for (const message of turn) {
    for (const use of message.toolUses) {
      const command = use.tool === "Bash" && typeof use.input.command === "string" ? use.input.command : null;
      if (command !== null && SHELL_CODE_WRITE.test(command)) signal = "code-edit";
      const raw = editedPath(use);
      if (raw === null) continue;
      const path = absolutePath(raw, root);
      if (TEMP_PATH.test(path) || path.startsWith(`${root}/.orca/`)) continue;
      if (topicFlags(path).length > 0) return "high-risk-edit";
      if (path.startsWith(`${root}/`)) signal = "code-edit";
    }
  }
  return signal;
}

/** Whether `model` is weaker than the code floor's model on this account; false for a model the account does not know. */
export function belowCodeFloor(tiers: ResolvedTiers, model: string): boolean {
  const rank = modelRank(tiers, model);
  const floor = modelRank(tiers, tiers[collapseTier(tiers, IMPLEMENT_FLOOR_TIER)].modelId);
  return rank !== null && floor !== null && rank < floor;
}

export interface StepEscalationInput {
  readonly tiers: ResolvedTiers;
  /** What the session runs on now (the router's sticky model). */
  readonly currentModel: string;
  readonly currentEffort: SessionEffort | null;
  /** The session's own model and effort. */
  readonly configuredModel: string;
  readonly configuredEffort: SessionEffort | null;
  readonly cwd: string;
  readonly messages: readonly ActivityMessage[];
  readonly tierEffort?: TierEffortMap;
  readonly pins?: OrcaPins;
}

export interface StepEscalation extends StageDecision {
  readonly signal: EscalationSignal;
}

/** The code floor applied to this step: the floor tier's model and effort when a signal fired below it; null otherwise. */
export function decideStepEscalation(input: StepEscalationInput): StepEscalation | null {
  if (input.pins?.model === true || !belowCodeFloor(input.tiers, input.currentModel)) return null;
  const signal = escalationSignal(input.messages, input.cwd);
  if (signal === null) return null;
  const target = input.tiers[collapseTier(input.tiers, IMPLEMENT_FLOOR_TIER)];
  const model = exactModelId(target.modelId, input.configuredModel);
  const tierEffort = target.supportsEffort ? (input.tierEffort ?? TIER_EFFORT)[IMPLEMENT_FLOOR_TIER] : null;
  const routed = model === input.configuredModel ? guardedEffort(input.configuredEffort, tierEffort) : tierEffort;
  const effort = input.pins?.effort === true ? pinnedEffort(input.tiers, model, input.configuredModel, input.configuredEffort) : routed;
  return {
    tier: IMPLEMENT_FLOOR_TIER,
    confidence: null,
    current: input.currentModel,
    proposed: target.modelId,
    model,
    effort,
    changed: true,
    reason: "escalate",
    guard: null,
    pending: null,
    breakEven: null,
    effortTarget: routed,
    signal,
  };
}

/** The loop's effort cap: one step up never goes past it (a person's `max` is theirs). */
const LOOP_EFFORT_CAP = effortRank("xhigh") as number;

/** `effort` one step up EFFORT_LEVELS, capped at xhigh; null for none or a numeric budget. */
function stepUp(effort: SessionEffort | null): SessionEffort | null {
  const rank = effortRank(effort);
  return rank === null ? null : (EFFORT_LEVELS[Math.min(rank + 1, LOOP_EFFORT_CAP)] ?? null);
}

/**
 * T4: a test-fix loop's step: at least the floor's model (a stronger one is
 * kept) and the effort one step past the one it would run at; null with no
 * loop, under an Orca model pin, on a model the account does not know, or
 * when nothing would change.
 */
export function decideTestLoopEscalation(input: StepEscalationInput): StepEscalation | null {
  if (input.pins?.model === true || isPersonEffort(input.currentEffort) || !testFixLoop(input.messages, input.cwd)) return null;
  const below = belowCodeFloor(input.tiers, input.currentModel);
  const floor = input.tiers[collapseTier(input.tiers, IMPLEMENT_FLOOR_TIER)];
  const model = below ? exactModelId(floor.modelId, input.configuredModel) : input.currentModel;
  const tier = tierOfModel(input.tiers, model);
  // A model the account does not know: nothing here can say what it takes.
  if (tier === null) return null;
  const supportsEffort = input.tiers[tier].supportsEffort;
  const tierEffort = supportsEffort ? (input.tierEffort ?? TIER_EFFORT)[IMPLEMENT_FLOOR_TIER] : null;
  // No effort sent is the API's default, not a choice: the floor tier's stands in for it.
  const base = below ? (model === input.configuredModel ? guardedEffort(input.configuredEffort, tierEffort) : tierEffort) : input.currentEffort ?? tierEffort;
  const routed = supportsEffort ? stepUp(base) ?? base : null;
  const effort = input.pins?.effort === true ? pinnedEffort(input.tiers, model, input.configuredModel, input.configuredEffort) : routed;
  if (model === input.currentModel && effort === input.currentEffort) return null;
  return {
    // The tier of the model it runs on, so the status line names the raise.
    tier,
    confidence: null,
    current: input.currentModel,
    proposed: below ? floor.modelId : input.currentModel,
    model,
    effort,
    changed: true,
    reason: "escalate",
    guard: null,
    pending: null,
    breakEven: null,
    effortTarget: routed,
    signal: "test-loop",
  };
}
