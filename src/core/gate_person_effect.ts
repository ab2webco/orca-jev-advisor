// Resolves the ONE concrete, non-abstract effect a person-facing gate line
// names -- never the model-facing "if it is wrong..." framing GATE_CATALOG's
// English text carries for a few risk axes (see MODEL_RISK_REASON's own doc
// in gate_advice_text.ts). The owner's own words for the defect this closes:
// a status line reading "jev · avisó al modelo: si sale mal, habrá que
// limpiar después" names no command and no concrete effect -- a person
// reading it in one line, in their locale, must be able to tell WHAT Jev
// decided and ON WHAT.
//
// 0.5.3: a blind field test of 0.5.2 found a SECOND defect in the same
// area -- an advised `rm -rf tmp/` (an untracked local dir, no
// collaborators) showed "lo verán otras personas" ("other people will see
// it"), a concrete claim nothing about the command actually supported. Two
// causes: only the caller's FIRST risk reason ever reached this module, and
// three reasons with no concrete fact of their own (breaksSomethingImportant,
// needsCleanupAfter, tooCloseToTheLine) were mapped to othersNotice anyway.
// Both are fixed here: every risk reason the caller has is now considered
// (`riskReasonKeys`, a list), scanned in the FIXED priority order below --
// never the order the caller happened to list them in -- and othersNotice is
// reachable ONLY through reason.someoneElseWillNotice. Nothing else ever
// maps to it; every other case floors to the new, honest effect.uncertain.
//
// Priority order (the most specific fact available wins), per the product
// decision:
//   1. named unrecoverable files -- git_recoverability.ts already resolved
//      these for the five checked shapes (rm, git checkout --, restore,
//      clean, reset --hard); if any target is protected (uncommitted,
//      untracked or secret), name it.
//   2. a deploy or a publish -- src/core/deploy_publish.ts's own detection,
//      bucketed by its `kind`.
//   3. a local NEVER_SILENTLY rule's own effect (RULE_EFFECT below), when
//      this effect is for a local-rule-sourced advice or hard stop.
//   4. the risk stage's own reason.cannotUndoAndLeavesMachine -- the effect
//      leaves this machine (a remote push, a live cluster, real cloud
//      infrastructure) AND cannot be undone.
//   5. the risk stage's own reason.cannotUndo -- no automatic way back,
//      whatever else is true.
//   6. the risk stage's own reason.someoneElseWillNotice -- a concrete
//      claim, "someone besides you will see this": the ONLY path that ever
//      reaches effect.othersNotice.
//   7. none of the above applied (this covers reason.needsCleanupAfter,
//      reason.breaksSomethingImportant and reason.tooCloseToTheLine, which
//      carry no concrete fact of their own, and the defensive case of no
//      signal at all) -- effect.uncertain, the honest "not sure" floor.
//      Never othersNotice: that would assert something none of these
//      reasons actually support.
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
  | "effect.othersNotice"
  | "effect.uncertain";

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

/**
 * The risk stage's own three CONCRETE axis reasons (decisions.ts's
 * decideAction), mapped to the one effect each actually supports.
 * `reason.tooCloseToTheLine`, `reason.breaksSomethingImportant` and
 * `reason.needsCleanupAfter` carry no concrete fact of their own (a
 * borderline score, an unspecified consequence) -- deliberately absent here,
 * they fall through resolveRiskReasonEffect to the honest effect.uncertain
 * floor rather than being mapped to anything, least of all othersNotice.
 */
const RISK_REASON_EFFECT: Readonly<Partial<Record<GateKey, PersonEffectKey>>> = {
  "reason.cannotUndoAndLeavesMachine": "effect.leavesMachine",
  "reason.cannotUndo": "effect.cannotUndo",
  "reason.someoneElseWillNotice": "effect.othersNotice",
};

/**
 * The FIXED priority order the risk stage's own reasons are checked in --
 * never the order the caller's own `riskReasonKeys` list happens to carry
 * them. The first of these three present anywhere in the list wins; see
 * resolveRiskReasonEffect.
 */
const RISK_REASON_PRIORITY: readonly GateKey[] = ["reason.cannotUndoAndLeavesMachine", "reason.cannotUndo", "reason.someoneElseWillNotice"];

/**
 * Scans `riskReasonKeys` for the first (in RISK_REASON_PRIORITY's own fixed
 * order, not the list's own order) of the three concrete risk-reason keys
 * RISK_REASON_EFFECT actually maps. Returns undefined when none of them are
 * present -- whether because the list is empty/absent, or because every key
 * it does carry (needsCleanupAfter, breaksSomethingImportant,
 * tooCloseToTheLine, noDestinationMatched, ...) carries no concrete fact of
 * its own -- so the caller's own floor (effect.uncertain) applies.
 */
function resolveRiskReasonEffect(riskReasonKeys: readonly GateKey[] | null | undefined): PersonEffectKey | undefined {
  if (riskReasonKeys === null || riskReasonKeys === undefined || riskReasonKeys.length === 0) return undefined;
  const present = new Set(riskReasonKeys);
  for (const candidate of RISK_REASON_PRIORITY) {
    if (present.has(candidate)) return RISK_REASON_EFFECT[candidate];
  }
  return undefined;
}

export interface ResolvePersonEffectInput {
  /** git_recoverability.ts's own resolution for this command, when it matches one of the five checked shapes -- omit (or pass an empty array) otherwise. */
  readonly recoverability?: readonly RecoverabilitySegmentResult[];
  /** Non-null when src/core/deploy_publish.ts's detectDeployPublish recognised this command. */
  readonly deployPublishKind?: "deploy" | "publish" | null;
  /** A local NEVER_SILENTLY rule's own key, when this effect is for a local-rule-sourced advice or hard stop. */
  readonly ruleKey?: GateKey | null;
  /**
   * EVERY risk-stage reason key for this Jev-risk-sourced advice (fresh, or
   * replayed from the shape cache) -- never only the first. See
   * resolveRiskReasonEffect's own doc for the fixed priority order these are
   * scanned in.
   */
  readonly riskReasonKeys?: readonly GateKey[] | null;
}

/** The single choke point every person-facing line's own effect resolves through -- see the module note above for the priority order. Never throws, never returns an empty/vacuous result: `effect.uncertain` is the floor every input eventually reaches. */
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

  const riskEffect = resolveRiskReasonEffect(input.riskReasonKeys);
  if (riskEffect !== undefined) return { key: riskEffect };

  return { key: "effect.uncertain" };
}
