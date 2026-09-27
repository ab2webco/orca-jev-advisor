// ---------------------------------------------------------------------------
// Model router status line (JEV-060 slice 2, §8): what the person sees of a
// decision, in their locale. Pure.
// ---------------------------------------------------------------------------

import { translate } from "./i18n.ts";
import type { Locale } from "./i18n.ts";
import { MODEL_ROUTER_CATALOG } from "./i18n_model_router.ts";
import type { RouterTier } from "./model_router_accounts.ts";
import type { RouterEffort } from "./model_router_decide.ts";

export interface RouterStatusInput {
  /** The model's short label ("Sonnet 5"), or its id when it has none. */
  readonly label: string;
  /** null = the model takes no effort, or the session sends none. */
  readonly effort: RouterEffort | null;
  readonly tier: RouterTier;
}

export function routerStatusText(locale: Locale, mode: "measure" | "active", input: RouterStatusInput): string {
  const stage = translate(MODEL_ROUTER_CATALOG, locale, `stage.${input.tier}`);
  if (input.effort === null) {
    return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.noEffort" : "status.measure.noEffort", { model: input.label, stage });
  }
  const effort = translate(MODEL_ROUTER_CATALOG, locale, `effort.${input.effort}`);
  return translate(MODEL_ROUTER_CATALOG, locale, mode === "active" ? "status.active.effort" : "status.measure.effort", { model: input.label, effort, stage });
}
