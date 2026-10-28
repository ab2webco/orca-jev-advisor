// ---------------------------------------------------------------------------
// Model router status line (JEV-060 slice 2, §8): what the person sees of a
// decision, in their locale. Pure.
//
// A decision that KEEPS a model Jev's tier would not pick says why (held by a
// guard, low confidence, hysteresis, break-even, unknown prices) and names
// Jev's tier as Jev's, so "Opus 5.5 · extra high effort" is never read as
// what a "consult" needs. Switches and same-tier decisions read as before.
// ---------------------------------------------------------------------------

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import { baseModelId } from "./model_router_accounts.ts";
import type { RouterTier } from "./model_router_accounts.ts";
import { floorForWork, raiseForDoubt } from "./model_router_decide.ts";
import type { RouterEffort, RouterGuard, SessionEffort, StartReason } from "./model_router_decide.ts";
import type { EscalationSignal } from "./model_router_floor.ts";
import type { StageReason } from "./model_router_stage.ts";
import type { WorkKind } from "./work_kind.ts";

/** Why a model was kept: a held decision's own reason, or the guard that held it. */
export type RouterKeptWhy = "low-confidence" | "break-even" | "hysteresis" | "prices-unknown" | "unknown-savings" | "pointer-prompt" | "context-window" | "orca-pin";

/**
 * JEVADV-118 T6: who chose a model the router did not keep, and why: Jev,
 * by the work's kind; the code floor over Jev's tier; a raise on Jev's
 * doubt; or a signal mid-turn (an edit, a high-risk path, a test-fix loop).
 */
export type RouterChose =
  | { readonly why: "kind"; readonly kind: WorkKind }
  | { readonly why: "code-floor"; readonly kind: WorkKind }
  | { readonly why: "doubt" }
  | { readonly why: EscalationSignal };

export interface RouterStatusInput {
  /** The model's short label ("Sonnet 5"), or its id when it has none. */
  readonly label: string;
  /** null = the model takes no effort, or the session sends none. */
  readonly effort: RouterEffort | null;
  readonly tier: RouterTier;
  /** Why the model was kept although Jev's tier picks another (keptWhy); null or absent reads as a plain decision. */
  readonly kept?: RouterKeptWhy | null;
  /** T6: who chose it and why (choseWhy), shown when nothing kept it; null or absent adds nothing. */
  readonly chose?: RouterChose | null;
}

/** The part of a decision choseWhy reads: its reason and signal, Jev's (shifted) tier, confidence and kind. */
export interface ChoseInput {
  readonly reason: string;
  readonly signal?: EscalationSignal;
  readonly tier: RouterTier | null;
  readonly confidence: number | null;
  readonly kind?: WorkKind;
}

/** T6: the escalation's signal, else the code floor, else a raise on doubt, else Jev's kind; null when none applies. */
export function choseWhy(input: ChoseInput): RouterChose | null {
  if (input.reason === "escalate" && input.signal !== undefined) return { why: input.signal };
  if (input.tier === null) return null;
  if (input.kind !== undefined && floorForWork(input.tier, input.kind) !== input.tier) return { why: "code-floor", kind: input.kind };
  if (input.confidence !== null && raiseForDoubt(input.tier, input.confidence) !== input.tier) return { why: "doubt" };
  return input.kind === undefined ? null : { why: "kind", kind: input.kind };
}

function choseText(locale: Locale, chose: RouterChose, stage: string): string {
  if (chose.why === "kind" || chose.why === "code-floor") {
    return translate(MODEL_ROUTER_CATALOG, locale, `chose.${chose.why}`, { kind: translate(MODEL_ROUTER_CATALOG, locale, `kind.${chose.kind}`) });
  }
  return translate(MODEL_ROUTER_CATALOG, locale, `chose.${chose.why}`, { stage });
}

/** The part of a start or stage decision keptWhy reads. */
export interface KeptDecision {
  readonly reason: StartReason | StageReason;
  readonly guard: RouterGuard | null;
  readonly changed: boolean;
  /** What Jev's tier resolves to on this account; null when Jev failed. */
  readonly proposed: string | null;
  /** What the session runs on (in measure mode, would). */
  readonly model: string;
  /** 0.6.2 E2: the effort it runs at, and the one a same-model stage decision aimed for; a gap between them is a kept effort. */
  readonly effort?: SessionEffort | null;
  readonly effortTarget?: SessionEffort | null;
}

/**
 * Why a decision kept the model or its effort, or null when it did not: it
 * changed (a switch), Jev failed, or Jev's tier resolves to this very model
 * at the effort it runs at.
 */
export function keptWhy(decision: KeptDecision): RouterKeptWhy | null {
  if (decision.changed || decision.proposed === null) return null;
  const effortKept = decision.effortTarget !== undefined && decision.effortTarget !== null && decision.effortTarget !== decision.effort;
  if (baseModelId(decision.model) === decision.proposed && !effortKept) return null;
  switch (decision.reason) {
    case "effort-hysteresis":
      return "hysteresis";
    case "effort-break-even":
      return "break-even";
    case "effort-unknown-savings":
      return "unknown-savings";
    case "held-by-guard":
      return decision.guard;
    case "held-by-orca-pin":
      return "orca-pin";
    case "hysteresis":
    case "break-even":
    case "prices-unknown":
      return decision.reason;
    default:
      return null;
  }
}

export function routerStatusText(locale: Locale, mode: "measure" | "active", input: RouterStatusInput): string {
  const stage = translate(MODEL_ROUTER_CATALOG, locale, `stage.${input.tier}`);
  const kept = input.kept ?? null;
  const why = kept === null ? null : translate(MODEL_ROUTER_CATALOG, locale, `why.${kept}`);
  const chose = why === null && input.chose !== undefined && input.chose !== null ? choseText(locale, input.chose, stage) : null;
  if (input.effort === null) {
    if (why !== null) return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.kept.noEffort" : "status.measure.kept.noEffort", { model: input.label, why, stage });
    if (chose !== null) return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.chose.noEffort" : "status.measure.chose.noEffort", { model: input.label, why: chose });
    return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.noEffort" : "status.measure.noEffort", { model: input.label });
  }
  const effort = translate(MODEL_ROUTER_CATALOG, locale, `effort.${input.effort}`);
  if (why !== null) return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.kept.effort" : "status.measure.kept.effort", { model: input.label, effort, why, stage });
  if (chose !== null) return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.chose.effort" : "status.measure.chose.effort", { model: input.label, effort, why: chose });
  return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.effort" : "status.measure.effort", { model: input.label, effort });
}

/** 0.6.2 E8: a warm session keeps the model it runs (the context is warm; a switch would rewrite it), and says so. */
export function routerWarmStatusText(locale: Locale, mode: "measure" | "active", label: string): string {
  return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.warm" : "status.measure.warm", { model: label });
}

/** Review nit 10: the person switched the session's model (or effort) mid-session; the router adopts it and says so, instead of showing its own older decision. */
export function routerPersonStatusText(locale: Locale, mode: "measure" | "active", label: string): string {
  return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.person" : "status.measure.person", { model: label });
}
