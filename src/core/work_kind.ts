// ---------------------------------------------------------------------------
// 0.6.16 T2 (odd/research/phase-effort.md §6 A): the kind of work a subagent
// is spawned for, and the effort that fits it.
//
// A subagent's effort is set once, at spawn: its context is cold, so there is
// no cache to lose. Runs that only execute or read (run tests, watch CI,
// explore, research) are 83% execute steps, where high and medium write about
// the same and only xhigh adds thinking; reviews think the most per step and
// keep theirs. The kind is one more question in the spawn's own tier
// judgment (never a second Jev call), with its own confidence; the
// research's keyword categories on the description are the fallback when Jev
// does not answer, and are logged next to Jev's kind as a cross-check.
//
//   execute, read -- Sonnet 5 capped at high (never xhigh); Opus 5.5 and
//                    Sonnet 5.5 at medium (their Claude Code default);
//   review, implement, design -- unchanged.
//
// Guards, all of them: a confident kind (CONFIDENCE_FLOOR), no pointer
// prompt, no sensitive topic, not in a client's site, never a person's `max`
// or numeric budget, never below an agent definition's declared effort (T3).
// Its own switch, off | measure | active, measure by default.
//
// Pure: no I/O.
// ---------------------------------------------------------------------------

import { answerMargin, getChoiceAnswer } from "./jev.ts";
import type { Answer, Question } from "./jev.ts";
import { baseModelId } from "./model_router_accounts.ts";
import type { RouterTier } from "./model_router_accounts.ts";
import { CONFIDENCE_FLOOR, effortRank, mentionsSensitiveTopic } from "./model_router_decide.ts";
import type { DestinationKind, RouterGuard, SessionEffort, TierEffort } from "./model_router_decide.ts";

export type WorkKind = "execute" | "read" | "review" | "implement" | "design";

export const WORK_KINDS: readonly WorkKind[] = ["execute", "read", "review", "implement", "design"];

export type WorkKindMode = "off" | "measure" | "active";

export const WORK_KIND_MODES: readonly WorkKindMode[] = ["off", "measure", "active"];

export const DEFAULT_WORK_KIND_MODE: WorkKindMode = "measure";

export function parseWorkKindMode(value: unknown): WorkKindMode {
  return typeof value === "string" && (WORK_KIND_MODES as readonly string[]).includes(value) ? (value as WorkKindMode) : DEFAULT_WORK_KIND_MODE;
}

/** Jev's kind (with its confidence), or the keyword fallback's (no confidence: it never acts on its own). */
export interface WorkKindJudgment {
  readonly kind: WorkKind;
  readonly confidence: number | null;
  readonly source: "jev" | "keywords";
  /** 0.6.22 T1 (JEVADV-97): top probability minus runner-up; absent for the keyword fallback and when Jev's probabilities give none. Log only. */
  readonly margin?: number;
}

const KIND_CRITERIA: Readonly<Record<WorkKind, string>> = {
  execute:
    'Execute: runs things and reports what happened -- tests, a build, a script or command, CI checks, a deploy check, screenshots, waiting for or watching something. It changes no files. Examples: "run the full test suite and report failures", "watch the CI run until it finishes", "take screenshots of the panel at four widths".',
  read:
    'Read: reads and reports -- explores or searches code, finds where something lives, traces calls, researches docs or data, measures, summarises. It changes no files. Examples: "find every caller of parseDate", "explore how the router picks a model", "research what the docs say about effort".',
  review:
    'Review: judges work already done -- reviews a diff or PR, audits code or security, verifies claims against the code, critiques a plan. It changes no files but needs careful thought. Examples: "review this PR for bugs", "audit the gate for bypasses", "verify each claim in the report".',
  implement:
    'Implement: changes files -- writes or edits code, tests, docs or config, fixes a bug, refactors, applies a plan, commits. Examples: "implement T3 with tests", "fix the failing test in the parser", "update the README section".',
  design:
    'Design: plans before anything is built -- architecture, a plan or spec, weighing approaches. Examples: "design the cache between the API and the workers", "plan the migration in steps".',
};

/** `questions` with the kind question added: asked in the same call as the tier. */
export function withWorkKindQuestion(questions: Record<string, Question>): Record<string, Question> {
  const criteria: Record<string, string> = {};
  for (const kind of WORK_KINDS) criteria[kind] = KIND_CRITERIA[kind];
  return {
    ...questions,
    kind: {
      type: "choice",
      instructions:
        "`prompt` is the task a coding assistant hands to a helper agent (a short description, then the instructions). Choose what the helper will mostly do. A task that asks to change, write, fix, create or commit anything is implement, even when it reads or runs things first. When in doubt between a kind that changes no files and implement, choose implement.",
      criteria,
    },
  };
}

function isWorkKind(value: string): value is WorkKind {
  return (WORK_KINDS as readonly string[]).includes(value);
}

/** Jev's kind and confidence, or null for anything malformed. */
export function interpretWorkKind(answers: Record<string, Answer>): WorkKindJudgment | null {
  const answer = getChoiceAnswer(answers, "kind");
  if (answer === null || !isWorkKind(answer.choice)) return null;
  const margin = answerMargin(answer.probabilities);
  return { kind: answer.choice, confidence: answer.confidence, source: "jev", ...(margin === undefined ? {} : { margin }) };
}

// The research's categories on the description (§3, §5), in its order: the
// first match wins. Its stand-in precision (0.57 at 80% recall of read-only
// runs, 30% of flagged runs edited) is the bar Jev's kind must beat.
const KEYWORD_KINDS: readonly (readonly [WorkKind, RegExp])[] = [
  ["execute", /\b(watch|wait|monitor|poll|ci\b|checks?\b.*(pr|ci)|babysit|release)/],
  ["execute", /\b(run|verify|validate|test|check|qa|screenshot|smoke|probe|live)/],
  ["review", /\b(review|audit|lens|critique|verif(ier|y) .*claim|inspect)/],
  ["read", /\b(read|explore|find|search|investigat|research|map|trace|locate|look|survey|analy[sz]|measure|study|summar)/],
  ["implement", /\b(implement|fix|write|add|build|refactor|update|create|port|migrat|wire|apply|edit|land|t\d)/],
  ["design", /\b(design|plan|architect|propos|spec)/],
];

export function keywordWorkKind(description: string): WorkKind | null {
  const text = description.toLowerCase();
  for (const [kind, pattern] of KEYWORD_KINDS) if (pattern.test(text)) return kind;
  return null;
}

function readWork(kind: WorkKindJudgment | null): boolean {
  return kind !== null && (kind.kind === "execute" || kind.kind === "read") && kind.confidence !== null && kind.confidence >= CONFIDENCE_FLOOR;
}

/**
 * T1: the router's own `low` is sent only on work that cannot edit. The
 * simple tier's default is medium (TIER_EFFORT); on a confident read or
 * execute kind the router's own low comes back, unless the person set the
 * simple tier's effort themselves (`personSet`), which always wins.
 */
export function readWorkTierEffort(tier: RouterTier, effort: TierEffort, personSet: boolean, kind: WorkKindJudgment | null): TierEffort {
  return tier === "simple" && !personSet && readWork(kind) ? "low" : effort;
}

export interface KindEffortInput {
  readonly kind: WorkKindJudgment | null;
  /** The model the step names. */
  readonly model: string;
  /** What the step would be sent with without T2 (the tier's rewrite already applied). */
  readonly effort: SessionEffort | undefined;
  /** T3: the effort the agent's definition declares. */
  readonly declared: SessionEffort | null;
  /** The router guard at spawn, if one held. */
  readonly guard: RouterGuard | null;
  /** The spawn's description and prompt, for the sensitive-topic guard. */
  readonly text: string;
  readonly destinationKind: DestinationKind | null;
}

/** Why the kind leaves the effort as it is; null when its rule applies. */
export type KindHold = "no-kind" | "not-read-work" | "unsure" | "pointer-prompt" | "sensitive" | "client-site" | "person-effort" | "none-sent" | "other-model";

export interface KindEffortOutcome {
  readonly effort: SessionEffort | undefined;
  readonly hold: KindHold | null;
}

/** The most a read or execute run is sent with on this model, or null for a model the rule does not cover. */
function readWorkCap(modelId: string): TierEffort | null {
  const id = baseModelId(modelId);
  if (id === "claude-opus-5-5" || id === "claude-sonnet-5-5") return "medium";
  return /^claude-sonnet-5(?:-\d{8})?$/.test(id) ? "high" : null;
}

/** The effort a subagent's step is sent with once its work kind is weighed (see the notes above). */
export function kindStepEffort(input: KindEffortInput): KindEffortOutcome {
  const keep = (hold: KindHold): KindEffortOutcome => ({ effort: input.effort, hold });
  const { kind } = input;
  if (kind === null) return keep("no-kind");
  if (kind.kind !== "execute" && kind.kind !== "read") return keep("not-read-work");
  if (kind.confidence === null || kind.confidence < CONFIDENCE_FLOOR) return keep("unsure");
  if (input.guard === "pointer-prompt") return keep("pointer-prompt");
  if (mentionsSensitiveTopic(input.text)) return keep("sensitive");
  if (input.destinationKind === "client-site") return keep("client-site");
  const effortRankNow = effortRank(input.effort);
  if (input.effort === "max" || typeof input.effort === "number" || input.declared === "max" || typeof input.declared === "number") return keep("person-effort");
  if (input.effort === undefined || effortRankNow === null) return keep("none-sent");
  const cap = readWorkCap(input.model);
  if (cap === null) return keep("other-model");
  const capped = effortRankNow > (effortRank(cap) as number) ? cap : input.effort;
  const declaredRank = effortRank(input.declared);
  const floored = input.declared !== null && declaredRank !== null && declaredRank > (effortRank(capped) as number) ? input.declared : capped;
  return { effort: floored, hold: null };
}

/** What a subagent's decision row says about its work kind (measure or active): the kind and where it came from, the keywords' own kind as a cross-check, and the effort the rule sends (active) or would send (measure); `effort` is null when a guard holds (`hold`). */
export interface WorkKindRecord {
  readonly mode: "measure" | "active";
  readonly kind: WorkKind | null;
  readonly confidence: number | null;
  readonly source: "jev" | "keywords" | null;
  readonly keywords: WorkKind | null;
  readonly effort: SessionEffort | null;
  readonly hold: KindHold | null;
  /** Whether the effort sent differs from what it would have been without the rule. */
  readonly applied: boolean;
}
