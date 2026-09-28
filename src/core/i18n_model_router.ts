// The model router's own catalog (JEV-060 slice 2, §8): the status line the
// person reads. Measure mode says what it would use; active mode says what
// runs. A kept model says why it was kept, and Jev's tier as Jev's.
import type { Catalog } from "./i18n.ts";

export type ModelRouterKey =
  | "status.active.effort"
  | "status.active.noEffort"
  | "status.measure.effort"
  | "status.measure.noEffort"
  | "status.active.kept.effort"
  | "status.active.kept.noEffort"
  | "status.measure.kept.effort"
  | "status.measure.kept.noEffort"
  | "status.active.warm"
  | "status.measure.warm"
  | "status.active.person"
  | "status.measure.person"
  | "effort.low"
  | "effort.medium"
  | "effort.high"
  | "effort.xhigh"
  | "stage.simple"
  | "stage.standard"
  | "stage.complex"
  | "stage.frontier"
  | "why.low-confidence"
  | "why.break-even"
  | "why.hysteresis"
  | "why.prices-unknown"
  | "why.unknown-savings"
  | "why.pointer-prompt";

export const MODEL_ROUTER_CATALOG: Catalog<ModelRouterKey> = {
  es: {
    "status.active.effort": "modelo: {{model}} · esfuerzo {{effort}} (etapa: {{stage}})",
    "status.active.noEffort": "modelo: {{model}} (etapa: {{stage}})",
    "status.measure.effort": "mediría: {{model}} · esfuerzo {{effort}} (etapa: {{stage}})",
    "status.measure.noEffort": "mediría: {{model}} (etapa: {{stage}})",
    "status.active.kept.effort": "modelo: {{model}} · esfuerzo {{effort}} · se mantiene: {{why}} (Jev: {{stage}})",
    "status.active.kept.noEffort": "modelo: {{model}} · se mantiene: {{why}} (Jev: {{stage}})",
    "status.measure.kept.effort": "mediría: {{model}} · esfuerzo {{effort}} · se mantendría: {{why}} (Jev: {{stage}})",
    "status.measure.kept.noEffort": "mediría: {{model}} · se mantendría: {{why}} (Jev: {{stage}})",
    "status.active.warm": "modelo: {{model}} · se mantiene: sesión ya iniciada",
    "status.measure.warm": "mediría: {{model}} · se mantendría: sesión ya iniciada",
    "status.active.person": "modelo: {{model}} · se mantiene: lo elegiste tú",
    "status.measure.person": "mediría: {{model}} · se mantendría: lo elegiste tú",
    "effort.low": "bajo",
    "effort.medium": "medio",
    "effort.high": "alto",
    "effort.xhigh": "muy alto",
    "stage.simple": "consultar",
    "stage.standard": "implementar",
    "stage.complex": "analizar",
    "stage.frontier": "razonar a fondo",
    "why.low-confidence": "poca confianza",
    "why.break-even": "cambiar cuesta más de lo que ahorra",
    "why.hysteresis": "esperando otro turno igual",
    "why.prices-unknown": "precios desconocidos",
    "why.unknown-savings": "ahorro aún sin medir",
    "why.pointer-prompt": "el mensaje remite a un documento",
  },
  en: {
    "status.active.effort": "model: {{model}} · {{effort}} effort (stage: {{stage}})",
    "status.active.noEffort": "model: {{model}} (stage: {{stage}})",
    "status.measure.effort": "would use: {{model}} · {{effort}} effort (stage: {{stage}})",
    "status.measure.noEffort": "would use: {{model}} (stage: {{stage}})",
    "status.active.kept.effort": "model: {{model}} · {{effort}} effort · kept: {{why}} (Jev: {{stage}})",
    "status.active.kept.noEffort": "model: {{model}} · kept: {{why}} (Jev: {{stage}})",
    "status.measure.kept.effort": "would use: {{model}} · {{effort}} effort · would keep: {{why}} (Jev: {{stage}})",
    "status.measure.kept.noEffort": "would use: {{model}} · would keep: {{why}} (Jev: {{stage}})",
    "status.active.warm": "model: {{model}} · kept: session already started",
    "status.measure.warm": "would use: {{model}} · would keep: session already started",
    "status.active.person": "model: {{model}} · kept: your choice",
    "status.measure.person": "would use: {{model}} · would keep: your choice",
    "effort.low": "low",
    "effort.medium": "medium",
    "effort.high": "high",
    "effort.xhigh": "extra high",
    "stage.simple": "ask",
    "stage.standard": "implement",
    "stage.complex": "analyse",
    "stage.frontier": "deep reasoning",
    "why.low-confidence": "low confidence",
    "why.break-even": "switching costs more than it saves",
    "why.hysteresis": "waiting for another such turn",
    "why.prices-unknown": "prices unknown",
    "why.unknown-savings": "saving not measured yet",
    "why.pointer-prompt": "the prompt points to a document",
  },
};
