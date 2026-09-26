// Composes the advice mechanism's model-facing text (the advise-model
// release) -- always English, whatever the developer's locale, because the
// one reader of this text is the coding model, not a person. See
// i18n_gate.ts's own `localRuleDeny` for the same precedent (a `deny`
// reason is delivered to the model; translating it would make its one real
// reader understand it less well).
//
// Structure, per the product decision (10-escenarios-reales-y-decision.md):
//   1. A header that can never be confused with a hard stop -- it must NOT
//      contain the word REFUSED, which localRuleDeny uses, so the model can
//      tell "you are refused, do not retry" apart from "here is a concern,
//      decide" just from the words alone.
//   2. What the command would concretely affect: the segments that change
//      something (never a tier-1a-safe one, at most two, each truncated),
//      and the plain-English reasons behind the concern.
//   3. For the five recoverability-checked shapes (rm, git checkout --,
//      restore, clean, reset --hard): which files hold UNRECOVERABLE work,
//      versus build/temp output safe to delete, with an exact safe-subset
//      command when one exists.
//   4. The retry clause: an identical retry goes through when the session
//      can be identified; otherwise the text says so honestly rather than
//      promising a pass that cannot happen (a missing session_id never
//      grants one -- see gate_advice_retry.ts's own caller).
//
// Pure: no I/O, no clock, no randomness.

import { splitOnCommandSeparators } from "./git_discard.ts";
import { isSafeSegment } from "./gate_safe_command.ts";
import { isProtectedRecoverabilityWhy } from "./git_recoverability.ts";
import type { ClassifiedPath, RecoverabilitySegmentResult } from "./git_recoverability.ts";

const SEGMENT_MAX_CHARS = 80;
const MAX_SEGMENTS_NAMED = 2;

function truncateSegment(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SEGMENT_MAX_CHARS ? trimmed : `${trimmed.slice(0, SEGMENT_MAX_CHARS - 1)}…`;
}

/** The command's own segments that change something -- never a tier-1a-safe one (a bare `git status`, a bare `cd`, ...), at most two, each truncated. */
export function affectedSegments(command: string): readonly string[] {
  return splitOnCommandSeparators(command)
    .filter((segment) => !isSafeSegment(segment))
    .slice(0, MAX_SEGMENTS_NAMED)
    .map(truncateSegment);
}

function recoverabilityWhyLabel(why: ClassifiedPath["why"]): string {
  if (why === "uncommitted-changes") return "uncommitted changes";
  if (why === "untracked") return "untracked, never committed";
  if (why === "secret") return "looks like a secret";
  return why;
}

/** One recoverability-checked segment's own sentence, or null when nothing about it is worth saying (no protected target, no unresolved target). */
function recoverabilitySentence(result: RecoverabilitySegmentResult): string | null {
  const protectedTargets = result.classified.filter((c) => isProtectedRecoverabilityWhy(c.why));
  const safeBuildTemp = [...new Set(result.classified.filter((c) => c.why === "build-or-temp").map((c) => c.matchedBuildTempName ?? ""))].filter((n) => n.length > 0).sort();

  const parts: string[] = [];
  if (protectedTargets.length > 0) {
    const named = protectedTargets.map((t) => `${t.path} (${recoverabilityWhyLabel(t.why)})`).join(", ");
    parts.push(`\`${result.shape}\` would lose work git cannot recover: ${named}.`);
  }
  if (result.unresolvedTargets.length > 0) {
    parts.push(`Unresolved (a shell variable or a glob, never guessed): ${result.unresolvedTargets.join(", ")}.`);
  }
  // The exact safe-alternative command is only offered for `rm`: it is the
  // one shape whose safe subset is itself a valid, complete replacement
  // command (`rm -rf <safe subset>`). The other four shapes' safe subset is
  // not a drop-in replacement of the same form, so naming the protected
  // files above is the honest, complete thing to say for them.
  if (result.shape === "rm" && protectedTargets.length > 0 && safeBuildTemp.length > 0) {
    parts.push(`To remove only regenerable output, run: \`rm -rf ${safeBuildTemp.join(" ")}\`.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function retryClause(sessionEligible: boolean): string {
  if (sessionEligible) {
    return (
      "If the user asked for exactly this, run the same command again unchanged and it will go through. " +
      "Otherwise, change course."
    );
  }
  return (
    "This session could not be identified, so repeating the command will NOT be recognized as the same " +
    "request and will be judged fresh. If the user explicitly asked for exactly this, say so plainly and " +
    "proceed deliberately; otherwise, change course."
  );
}

export interface AdviceCompositionInput {
  readonly command: string;
  /** Plain-English reasons behind the concern -- either the risk stage's own axis reasons, or a local rule's own English description. Never empty. */
  readonly reasons: readonly string[];
  /** Recoverability resolution for this command, when it matches one of the five checked shapes -- see git_recoverability.ts. Omit (or pass an empty array) when the command matches none of them. */
  readonly recoverability?: readonly RecoverabilitySegmentResult[];
  /** Whether an identical retry can actually pass -- false when the hook's own session_id was missing (see gate_advice_retry.ts). */
  readonly sessionEligibleForRetry: boolean;
}

export interface ComposedAdvice {
  /** The full model-facing text -- always English, never contains the word REFUSED. */
  readonly modelText: string;
  /** A short phrase for the person-facing status line (adapters/claude/gate-bash.ts's own i18n_gate.ts "advisedLine" template) -- the first reason, or the first affected segment when there is no reason text. */
  readonly effectSummary: string;
}

/** Composes the full advice text. Never throws; `reasons` with no entries falls back to a generic "this looks risky" phrase rather than producing an empty sentence. */
export function composeAdviceText(input: AdviceCompositionInput): ComposedAdvice {
  const segments = affectedSegments(input.command);
  const reasons = input.reasons.length > 0 ? input.reasons : ["this could not be undone or verified safely"];

  const affectedLine =
    segments.length > 0
      ? `It would run: ${segments.map((s) => `\`${s}\``).join(", ")}.`
      : "It would run the command as given.";
  const reasonsLine = `Why: ${reasons.join("; ")}.`;

  const recoverabilitySentences = (input.recoverability ?? [])
    .map(recoverabilitySentence)
    .filter((s): s is string => s !== null);

  const lines = [
    "Jev advice (not a refusal): this command would affect something worth a second look before it runs.",
    affectedLine,
    reasonsLine,
    ...recoverabilitySentences,
    retryClause(input.sessionEligibleForRetry),
  ];

  return {
    modelText: lines.join("\n"),
    effectSummary: reasons[0] ?? segments[0] ?? "this command",
  };
}
