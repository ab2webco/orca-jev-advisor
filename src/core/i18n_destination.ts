// decideDestination's own catalog: the `rationale` a caller prints or shows
// for a destination decision (tools/decide.ts, tools/policy-gate.ts,
// adapters/orca/main.mjs), keyed and in both locales. See src/core/i18n.ts
// for why this catalog mechanism exists instead of Orca's own
// `languagePacks`, and src/core/decisions.ts for the pure functions that
// return `LocalizedReason<DestinationKey>` values instead of already-
// localized text.
import type { Catalog } from "./i18n.ts";

export type DestinationKey =
  | "policy.allowed"
  | "policy.needsHuman"
  | "policy.forbidden"
  | "risk.incompleteAnswers"
  | "risk.hardToUndo"
  | "risk.noticedOutsideTeam"
  | "risk.hurtsIfWrong"
  | "risk.clear"
  | "risk.noPolicyCoverage";

export const DESTINATION_CATALOG: Catalog<DestinationKey> = {
  es: {
    "policy.allowed": "Permitida por {{policyId}}: {{rule}}",
    "policy.needsHuman": "{{policyId}} exige que decida una persona: {{rule}}",
    "policy.forbidden": "Prohibida por {{policyId}}: {{rule}}",
    "risk.incompleteAnswers": "Jev no devolvió respuestas completas para 'reversible', 'externa' o 'consecuencia'.",
    "risk.hardToUndo": "revertirla no es trivial",
    "risk.noticedOutsideTeam": "se nota fuera del equipo",
    "risk.hurtsIfWrong": "si sale mal, duele",
    "risk.clear": "Sin politica que la cubra, pero es reversible, interna y barata.",
    "risk.noPolicyCoverage": "Sin politica que la cubra",
  },
  en: {
    "policy.allowed": "Allowed by {{policyId}}: {{rule}}",
    "policy.needsHuman": "{{policyId}} requires a person to decide: {{rule}}",
    "policy.forbidden": "Forbidden by {{policyId}}: {{rule}}",
    "risk.incompleteAnswers": "Jev didn't return complete answers for 'reversible', 'external' or 'consequence'.",
    "risk.hardToUndo": "undoing it isn't trivial",
    "risk.noticedOutsideTeam": "someone outside the team will notice",
    "risk.hurtsIfWrong": "if it goes wrong, it hurts",
    "risk.clear": "No policy covers it, but it's reversible, internal and cheap.",
    "risk.noPolicyCoverage": "No policy covers it",
  },
};
