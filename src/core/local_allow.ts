// 0.6.28 T6 follow-up: a command that qualifies structurally for a local
// allow -- Option D's own-branch push and guarded git delete
// (push_own_branch.ts), own-tree work (contained_effect.ts's isOwnTreeWork),
// a line of trusted programs (T7, trusted_programs.ts) -- is allowed with no Jev call when no command-scoped policy survives.
// When one does, Jev is still asked, but only its policy coverage can stop
// the command (decisions.ts's `localAllowQualifies`): the risk axes never
// decide for it. Every real install has command-scoped policies (the seed
// ships eight that survive T1), so this second path is the one that matters.
//
// Pure: which stop reason and reason text each kind records. The verdict
// cache keys a qualifying command's verdicts by its kind (gate-bash.ts's
// cacheKey), so the same shape that does not qualify never shares them.
import type { GateStopReason } from "./gate_measurement.ts";
import type { GateKey } from "./i18n_gate.ts";

export type LocalAllowKind = "ownBranchPush" | "guardedGitDelete" | "ownTree" | "trusted";

/** The stop reason a local allow of this kind records. */
export function localAllowStopReason(kind: LocalAllowKind): GateStopReason {
  return kind === "ownTree" ? "own-tree" : kind === "trusted" ? "trusted" : "local-allow";
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
    case "trusted":
      return "reason.trusted";
  }
}
