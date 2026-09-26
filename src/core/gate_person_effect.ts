// Resolves the ONE concrete, non-abstract effect a person-facing gate line
// names -- never the model-facing "if it is wrong..." framing GATE_CATALOG's
// English text carries for a few risk axes (see MODEL_RISK_REASON's own doc
// in gate_advice_text.ts). The owner's own words for the defect this closes:
// a status line reading "jev · avisó al modelo: si sale mal, habrá que
// limpiar después" names no command and no concrete effect -- a person
// reading it in one line, in their locale, must be able to tell WHAT Jev
// decided and ON WHAT.
//
// Priority order (the most specific fact available wins), per the product
// decision:
//   1. named unrecoverable files -- git_recoverability.ts already resolved
//      these for the five checked shapes (rm, git checkout --, restore,
//      clean, reset --hard); if any target is protected (uncommitted,
//      untracked or secret), name it.
//   2. a deploy or a publish -- src/core/deploy_publish.ts's own detection,
//      bucketed by its `kind`.
//   3. the effect leaves this machine -- a remote push, a live cluster, real
//      cloud infrastructure.
//   4. cannot be undone -- no automatic way back, whatever else is true.
//   5. others will notice -- the generic, always-available fallback: never
//      vacuous (it is still a concrete claim, "someone besides you will see
//      this"), unlike "if it goes wrong...", which asserts nothing at all
//      about what actually happens.
//
// Pure: no I/O, no clock, no locale -- callers resolve `key` through
// GATE_CATALOG at the edge (adapters/claude/gate-bash.ts).
import { isProtectedRecoverabilityWhy } from "./git_recoverability.ts";
import type { RecoverabilitySegmentResult } from "./git_recoverability.ts";
import type { GateKey } from "./i18n_gate.ts";

export type PersonEffectKey =
  | "effect.namedFiles"
  | "effect.deploy"
  | "effect.publish"
  | "effect.leavesMachine"
  | "effect.cannotUndo"
  | "effect.othersNotice";

export interface PersonEffect {
  readonly key: PersonEffectKey;
  /** Only present for `effect.namedFiles`: the protected targets' own repo-relative paths, already de-duplicated, at most 3. */
  readonly files?: readonly string[];
}

/** A local NEVER_SILENTLY rule's own concrete effect, when the rule's `why` is all the caller has (a toggled-off deny, or an interpreter-code-only match). */
const RULE_EFFECT: Readonly<Partial<Record<GateKey, PersonEffectKey>>> = {
  "rule.forcePush": "effect.leavesMachine",
  "rule.pushProtected": "effect.leavesMachine",
  "rule.rmRf": "effect.cannotUndo",
  "rule.resetClean": "effect.cannotUndo",
  "rule.dropTable": "effect.cannotUndo",
  "rule.kubectlDelete": "effect.leavesMachine",
  "rule.terraformApply": "effect.leavesMachine",
  "rule.terraformDestroy": "effect.leavesMachine",
  "rule.curlPipeShell": "effect.cannotUndo",
};

/** The risk stage's own six axis reasons (decisions.ts's decideAction), mapped to a concrete effect. `reason.tooCloseToTheLine`, `reason.breaksSomethingImportant` and `reason.needsCleanupAfter` carry no concrete fact of their own (a borderline score, an unspecified consequence) -- they resolve to the generic, always-honest fallback rather than repeating the banned "if it goes wrong..." framing. */
const RISK_REASON_EFFECT: Readonly<Partial<Record<GateKey, PersonEffectKey>>> = {
  "reason.cannotUndoAndLeavesMachine": "effect.leavesMachine",
  "reason.cannotUndo": "effect.cannotUndo",
  "reason.someoneElseWillNotice": "effect.othersNotice",
  "reason.breaksSomethingImportant": "effect.othersNotice",
  "reason.needsCleanupAfter": "effect.othersNotice",
  "reason.tooCloseToTheLine": "effect.othersNotice",
};

export interface ResolvePersonEffectInput {
  /** git_recoverability.ts's own resolution for this command, when it matches one of the five checked shapes -- omit (or pass an empty array) otherwise. */
  readonly recoverability?: readonly RecoverabilitySegmentResult[];
  /** Non-null when src/core/deploy_publish.ts's detectDeployPublish recognised this command. */
  readonly deployPublishKind?: "deploy" | "publish" | null;
  /** A local NEVER_SILENTLY rule's own key, when this effect is for a local-rule-sourced advice or hard stop. */
  readonly ruleKey?: GateKey | null;
  /** The risk stage's own first reason key, when this effect is for a Jev-risk-sourced advice (fresh or replayed from the shape cache). */
  readonly riskReasonKey?: GateKey | null;
}

/** The single choke point every person-facing line's own effect resolves through -- see the module note above for the priority order. Never throws, never returns an empty/vacuous result: `effect.othersNotice` is the floor every input eventually reaches. */
export function resolvePersonEffect(input: ResolvePersonEffectInput): PersonEffect {
  const files = [
    ...new Set(
      (input.recoverability ?? [])
        .flatMap((segment) => segment.classified)
        .filter((classified) => isProtectedRecoverabilityWhy(classified.why))
        .map((classified) => classified.path),
    ),
  ];
  if (files.length > 0) return { key: "effect.namedFiles", files: files.slice(0, 3) };

  if (input.deployPublishKind === "deploy") return { key: "effect.deploy" };
  if (input.deployPublishKind === "publish") return { key: "effect.publish" };

  const ruleEffect = input.ruleKey !== null && input.ruleKey !== undefined ? RULE_EFFECT[input.ruleKey] : undefined;
  if (ruleEffect !== undefined) return { key: ruleEffect };

  const riskEffect = input.riskReasonKey !== null && input.riskReasonKey !== undefined ? RISK_REASON_EFFECT[input.riskReasonKey] : undefined;
  if (riskEffect !== undefined) return { key: riskEffect };

  return { key: "effect.othersNotice" };
}
