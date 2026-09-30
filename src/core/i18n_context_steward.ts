// The context steward's own catalog (odd/tasks/jev-context-steward.md): its
// part of the status line and the one-line /clear suggestion.
import type { Catalog } from "./i18n.ts";

export type ContextStewardKey =
  | "status.applied"
  | "status.applied.unknownAfter"
  | "status.measure"
  | "why.boundary"
  | "why.new-topic"
  | "why.hard-limit"
  | "why.soft-limit"
  | "clearHint";

export const CONTEXT_STEWARD_CATALOG: Catalog<ContextStewardKey> = {
  es: {
    "status.applied": "contexto {{before}} → {{after}} ({{why}})",
    "status.applied.unknownAfter": "contexto {{before}} → compactado ({{why}})",
    "status.measure": "contexto {{before}} → compactaría ({{why}} · solo mide)",
    "why.boundary": "tarea cerrada",
    "why.new-topic": "tema nuevo",
    "why.hard-limit": "límite de contexto",
    "why.soft-limit": "límite suave de 400k",
    clearHint: "tarea cerrada: /clear libera todo el contexto",
  },
  en: {
    "status.applied": "context {{before}} → {{after}} ({{why}})",
    "status.applied.unknownAfter": "context {{before}} → compacted ({{why}})",
    "status.measure": "context {{before}} → would compact ({{why}} · measuring only)",
    "why.boundary": "task closed",
    "why.new-topic": "new topic",
    "why.hard-limit": "context limit",
    "why.soft-limit": "400k soft limit",
    clearHint: "task closed: /clear frees the whole context",
  },
};
