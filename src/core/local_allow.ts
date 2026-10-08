// 0.6.28 T6 follow-up: a command that qualifies structurally for a local
// allow -- Option D's own-branch push and guarded git delete
// (push_own_branch.ts), own-tree work (contained_effect.ts's isOwnTreeWork)
// -- is allowed with no Jev call when no command-scoped policy survives.
// When one does, Jev is still asked, but only its policy coverage can stop
// the command (decisions.ts's `localAllowQualifies`): the risk axes never
// decide for it. Every real install has command-scoped policies (the seed
// ships eight that survive T1), so this second path is the one that matters.
//
// Pure: which stop reason and reason text each kind records, and how the
// verdict cache treats a qualifying command.
import type { GateStopReason } from "./gate_measurement.ts";
import type { GateKey } from "./i18n_gate.ts";

export type LocalAllowKind = "ownBranchPush" | "guardedGitDelete" | "ownTree";

/** The stop reason a local allow of this kind records. */
export function localAllowStopReason(kind: LocalAllowKind): GateStopReason {
  return kind === "ownTree" ? "own-tree" : "local-allow";
}

/** The reason text key a local allow of this kind shows. */
export function localAllowReasonKey(kind: LocalAllowKind): GateKey {
  switch (kind) {
    case "ownBranchPush":
      return "reason.ownBranchPush";
    case "guardedGitDelete":
      return "reason.guardedGitDelete";
    case "ownTree":
      return "reason.ownTree";
  }
}

/**
 * Whether a cached verdict is replayed. A cached `advise` only ever comes
 * from the risk stage, which never decides for a qualifying command; a
 * cached `deny` or `ask` is a policy verdict and still stands.
 */
export function replaysCachedDecision(decision: "allow" | "ask" | "deny" | "advise", localAllowQualifies: boolean): boolean {
  return !(localAllowQualifies && decision === "advise");
}

/**
 * Whether a fresh verdict is cached for the command's shape. An allow that
 * the structural qualification produced says nothing about the shape: a
 * command of the same shape that does not qualify must not replay it.
 */
export function storesVerdict(viaLocalAllow: boolean): boolean {
  return !viaLocalAllow;
}
