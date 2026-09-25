// What the person actually decided when the gate stopped them.
//
// The gate has judged hundreds of commands and every threshold in it was
// calibrated against a corpus somebody wrote by hand. Nobody's real judgement
// has ever been recorded, so when the threshold was wrong -- and it was wrong
// twice, first at 1.5 for compound scripts, then again on which axis decides
// -- the only way to find out was noticing the annoyance and re-measuring
// against another invented corpus.
//
// This closes that loop. Claude Code reports the outcome of a permission
// prompt through two hooks, and both carry the same `tool_use_id` the gate's
// own PreToolUse call carried, so the join is exact rather than heuristic:
//
//   PreToolUse       the gate answers "ask"        tool_use_id X
//   PostToolUse      the command ran               X  -> approved
//   PermissionDenied the command did not run       X  -> rejected
//
// A week of that is a corpus labelled by the person who has to live with the
// answers. It is worth more than any set of commands I can invent, because
// the population it describes is theirs.
//
// PRIVACY: the same rule as gate_measurement.ts, for the same reason. Never
// the command -- it can carry a secret in an env assignment, a token in an
// argument, a client's name in a path. What is stored is the shape hash the
// cache already computes, a coarse family, and the numbers. None of it can be
// read back into a command.

export type ApprovalOutcome = "approved" | "rejected";

/** Written when the gate stops a command, and resolved later by the outcome hook. */
export interface PendingApprovalRecord {
  readonly type: "gate-pending";
  readonly toolUseId: string;
  readonly at: string;
  readonly project: string | null;
  readonly destinationId: string | null;
  readonly commandFamily: string;
  /** The cache's shape hash, never the command. Null when the command was not cacheable. */
  readonly shape: string | null;
  readonly reversible: number | null;
  readonly external: number | null;
  readonly consequence: number | null;
  /** The ceiling in force for this decision, so a later re-reading knows what it was judged against. */
  readonly ceiling: number;
}

export interface ApprovalOutcomeRecord {
  readonly type: "gate-outcome";
  readonly toolUseId: string;
  readonly at: string;
  readonly outcome: ApprovalOutcome;
}

export function buildPendingApprovalRecord(input: Omit<PendingApprovalRecord, "type">): PendingApprovalRecord {
  return { type: "gate-pending", ...input };
}

export function buildApprovalOutcomeRecord(input: Omit<ApprovalOutcomeRecord, "type">): ApprovalOutcomeRecord {
  return { type: "gate-outcome", ...input };
}

export function serializeApprovalRecord(record: PendingApprovalRecord | ApprovalOutcomeRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * The set of tool_use_ids the gate actually stopped for, parsed straight
 * from the approvals log's raw text -- used by gate-outcome.ts to decide
 * whether an outcome is joinable BEFORE appending it.
 *
 * Why this exists: gate-outcome.ts used to append an outcome for every
 * completed Bash command, but a gate-pending record only exists for the
 * commands the gate actually stopped. Measured on the real log: 2697
 * outcomes, 15 pendings, 11 joinable -- the only real calibration data this
 * plugin has was buried at a ratio of 245 to 1. An outcome with no matching
 * pending answers no question and should never have been written.
 *
 * Malformed lines are skipped, never thrown on: this reader must be at
 * least as forgiving as the file it reads, which grows from the exact same
 * best-effort, swallow-everything appends this module's own writers use.
 */
export function parsePendingToolUseIds(raw: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type === "gate-pending" && typeof record.toolUseId === "string") {
      ids.add(record.toolUseId);
    }
  }
  return ids;
}

/** A prompt the person walked away from: neither hook ever fires, so it must not be counted as either answer. */
export const UNRESOLVED_AFTER_MS = 6 * 60 * 60 * 1000;

export interface LabelledDecision {
  readonly at: string;
  readonly project: string | null;
  readonly destinationId: string | null;
  readonly commandFamily: string;
  readonly consequence: number;
  readonly ceiling: number;
  readonly outcome: ApprovalOutcome;
}

export interface ApprovalSummary {
  readonly asked: number;
  readonly approved: number;
  readonly rejected: number;
  /**
   * Asked, and still without an outcome {@link UNRESOLVED_AFTER_MS} after
   * the gate stopped it.
   *
   * This is a CLASSIFICATION, not a fact -- write that down here because it
   * is easy to forget once the number is on a dashboard next to "approved"
   * and "rejected", which are both facts. Two very different histories
   * produce the exact same trace:
   *
   *   1. The gate denied the command outright (a NEVER_SILENTLY rule, or a
   *      deny-tier toggle set to deny). The command never ran, no
   *      PostToolUse/PostToolUseFailure/PermissionDenied hook can ever
   *      fire for it, and no outcome will EVER arrive, no matter how long
   *      this waits. "The stop worked" -- this is what most of these are,
   *      now that nine rules deny outright (see this module's own header).
   *   2. The session crashed, was killed, or the machine slept between the
   *      command actually running and gate-outcome.ts's append -- which
   *      swallows its own errors by design (best-effort, same as the
   *      measurement log). This leaves the identical trace as case 1.
   *
   * Nothing recorded here can tell these apart. That is exactly why
   * `notRun` is never folded into `labelled` (ceilingEvidence's callers get
   * no evidence from it either way) -- the same discipline
   * {@link ceilingEvidence} already applies by returning null rather than a
   * number when approvals and rejections overlap: an honest "we don't know
   * which" beats a confident-looking guess.
   */
  readonly notRun: number;
  /**
   * Asked, with no outcome yet, but still inside {@link UNRESOLVED_AFTER_MS}
   * -- a prompt genuinely still on someone's screen. Without this bucket,
   * `approved + rejected + notRun` undercounts `asked` for exactly as long
   * as any prompt is unanswered, which is why the calibration card's legend
   * (board.html's renderApprovals) never summed to 100%: this is the fourth
   * bucket every one of those percentages is missing.
   */
  readonly awaiting: number;
  readonly labelled: readonly LabelledDecision[];
}

/**
 * Joins the two halves by `tool_use_id`.
 *
 * An approval says "this stop was not worth making", which is the label the
 * thresholds need. A rejection says the opposite and is the more valuable of
 * the two, because it is rarer and it confirms the gate earned its
 * interruption. Anything still without an outcome after
 * {@link UNRESOLVED_AFTER_MS} is classified `notRun` and never guessed into
 * an approval or a rejection -- silence is not consent here, and treating it
 * as approval would teach the gate to relax every time someone walked away
 * from their desk (see {@link ApprovalSummary.notRun} for why "classified",
 * not "known").
 */
export function summarizeApprovals(
  pending: readonly PendingApprovalRecord[],
  outcomes: readonly ApprovalOutcomeRecord[],
  now: number = Date.now(),
): ApprovalSummary {
  const byId = new Map<string, ApprovalOutcomeRecord>();
  for (const o of outcomes) {
    // First answer wins: a tool retried under the same id must not overwrite
    // what the person already decided about it.
    if (!byId.has(o.toolUseId)) byId.set(o.toolUseId, o);
  }

  const labelled: LabelledDecision[] = [];
  let approved = 0;
  let rejected = 0;
  let notRun = 0;
  let awaiting = 0;

  for (const p of pending) {
    const outcome = byId.get(p.toolUseId);
    if (outcome === undefined) {
      if (now - Date.parse(p.at) > UNRESOLVED_AFTER_MS) notRun += 1;
      else awaiting += 1;
      continue;
    }
    if (outcome.outcome === "approved") approved += 1;
    else rejected += 1;
    if (p.consequence !== null) {
      labelled.push({
        at: p.at,
        project: p.project,
        destinationId: p.destinationId,
        commandFamily: p.commandFamily,
        consequence: p.consequence,
        ceiling: p.ceiling,
        outcome: outcome.outcome,
      });
    }
  }

  return { asked: pending.length, approved, rejected, notRun, awaiting, labelled };
}

export interface CeilingEvidence {
  /** The highest consequence score the person waved through: below this, stopping was noise. */
  readonly highestApproved: number | null;
  /** The lowest score they refused: above this, stopping was right. */
  readonly lowestRejected: number | null;
  /** Positive when the two do not overlap -- the width of the band a threshold can sit in. */
  readonly band: number | null;
  /** The midpoint of that band, or null when approvals and rejections overlap and no single threshold separates them. */
  readonly suggestedCeiling: number | null;
  readonly approvedCount: number;
  readonly rejectedCount: number;
}

/**
 * What the recorded decisions say the ceiling should be.
 *
 * Deliberately returns null rather than a number when approvals and
 * rejections overlap. An overlap means no threshold separates them, and
 * answering with a midpoint anyway would dress a coin flip as a measurement
 * -- which is exactly the mistake that shipped a policy stage whose gating
 * question had a band of -0.03.
 */
export function ceilingEvidence(labelled: readonly LabelledDecision[]): CeilingEvidence {
  const approved = labelled.filter((d) => d.outcome === "approved").map((d) => d.consequence);
  const rejected = labelled.filter((d) => d.outcome === "rejected").map((d) => d.consequence);
  if (approved.length === 0 || rejected.length === 0) {
    return {
      highestApproved: approved.length > 0 ? Math.max(...approved) : null,
      lowestRejected: rejected.length > 0 ? Math.min(...rejected) : null,
      band: null,
      suggestedCeiling: null,
      approvedCount: approved.length,
      rejectedCount: rejected.length,
    };
  }
  const highestApproved = Math.max(...approved);
  const lowestRejected = Math.min(...rejected);
  // Rounded because these are scores with two meaningful digits, and a raw
  // subtraction hands the caller 0.6000000000000001 to render.
  const band = Number((lowestRejected - highestApproved).toFixed(2));
  return {
    highestApproved,
    lowestRejected,
    band,
    suggestedCeiling: band > 0 ? Number(((highestApproved + lowestRejected) / 2).toFixed(2)) : null,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
  };
}
