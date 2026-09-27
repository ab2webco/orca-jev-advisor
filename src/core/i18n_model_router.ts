// The model router's own catalog (JEV-060 slice 2, §8): the status line the
// person reads. Measure mode says what it would use; active mode says what
// runs.
import type { Catalog } from "./i18n.ts";

export type ModelRouterKey =
  | "status.active.effort"
  | "status.active.noEffort"
  | "status.measure.effort"
  | "status.measure.noEffort"
  | "effort.low"
  | "effort.medium"
  | "effort.high"
  | "effort.xhigh"
  | "stage.simple"
  | "stage.standard"
  | "stage.complex"
  | "stage.frontier";

export const MODEL_ROUTER_CATALOG: Catalog<ModelRouterKey> = {
  es: {
    "status.active.effort": "jev · modelo: {{model}} · esfuerzo {{effort}} (etapa: {{stage}})",
    "status.active.noEffort": "jev · modelo: {{model}} (etapa: {{stage}})",
    "status.measure.effort": "jev · mediría: {{model}} · esfuerzo {{effort}} (etapa: {{stage}})",
    "status.measure.noEffort": "jev · mediría: {{model}} (etapa: {{stage}})",
    "effort.low": "bajo",
    "effort.medium": "medio",
    "effort.high": "alto",
    "effort.xhigh": "muy alto",
    "stage.simple": "consultar",
    "stage.standard": "implementar",
    "stage.complex": "analizar",
    "stage.frontier": "razonar a fondo",
  },
  en: {
    "status.active.effort": "jev · model: {{model}} · {{effort}} effort (stage: {{stage}})",
    "status.active.noEffort": "jev · model: {{model}} (stage: {{stage}})",
    "status.measure.effort": "jev · would use: {{model}} · {{effort}} effort (stage: {{stage}})",
    "status.measure.noEffort": "jev · would use: {{model}} (stage: {{stage}})",
    "effort.low": "low",
    "effort.medium": "medium",
    "effort.high": "high",
    "effort.xhigh": "extra high",
    "stage.simple": "ask",
    "stage.standard": "implement",
    "stage.complex": "analyse",
    "stage.frontier": "deep reasoning",
  },
};
