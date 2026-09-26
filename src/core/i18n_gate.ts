// gate-bash.ts's own catalog: every string it puts in front of the user
// (permissionDecisionReason, systemMessage), keyed and in both locales. See
// src/core/i18n.ts for why this exists instead of Orca's `languagePacks`.
import type { Catalog } from "./i18n.ts";

export type GateKey =
  | "rule.forcePush"
  | "rule.pushProtected"
  | "rule.rmRf"
  | "rule.resetClean"
  | "rule.dropTable"
  | "rule.kubectlDelete"
  | "rule.terraformApply"
  | "rule.terraformDestroy"
  | "rule.curlPipeShell"
  | "verb.blocks"
  | "verb.asks"
  | "localRule"
  | "localRuleDeny"
  | "cached"
  | "statusLine"
  | "advisedLine"
  | "authRejected"
  | "noApiKey"
  | "jevUnreachable"
  | "notice"
  | "reason.allowClear"
  | "reason.incompleteAnswers"
  | "reason.cannotUndoAndLeavesMachine"
  | "reason.cannotUndo"
  | "reason.someoneElseWillNotice"
  | "reason.breaksSomethingImportant"
  | "reason.needsCleanupAfter"
  | "reason.tooCloseToTheLine"
  | "reason.noDestinationMatched"
  | "reason.ownBranchPush"
  | "reason.guardedGitDelete";

export const GATE_CATALOG: Catalog<GateKey> = {
  es: {
    "rule.forcePush": "force push: reescribe el remoto — quien ya hizo pull se rompe",
    "rule.pushProtected": "empuja directo a una rama compartida, sin pasar por revisión",
    "rule.rmRf": "borrado recursivo desde / o $HOME — sin deshacer",
    "rule.resetClean": "descarta trabajo sin confirmar — no hay de dónde recuperarlo",
    "rule.dropTable": "elimina una tabla o una base entera",
    "rule.kubectlDelete": "borra algo que está corriendo y sirviendo ahora mismo",
    "rule.terraformApply": "crea o cambia infraestructura real",
    "rule.terraformDestroy": "destruye infraestructura real",
    "rule.curlPipeShell": "ejecuta un script descargado en tu máquina, sin revisarlo",
    "verb.blocks": "bloquea",
    "verb.asks": "pregunta",
    localRule: "regla local — {{why}}",
    // Deliberately identical to the English entry: this string is read by the
    // model, not by a person. See the note on the English one.
    localRuleDeny: "REFUSED: {{why}}. You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work.",
    cached: "{{reason}} · cacheado",
    statusLine: "jev · {{verb}}: {{reason}} · {{ms}}ms",
    // The advise-model release: nobody is interrupted here -- the model was
    // handed a reason and decides. Deliberately its own line, distinct from
    // statusLine's "bloquea"/"pregunta": this is neither.
    advisedLine: "jev · avisó al modelo: {{effect}}",
    authRejected: "sin opinar: la llave fue rechazada ({{status}})",
    noApiKey: "sin llave configurada: la mitad del gate que juzga con Jev no está corriendo — solo las reglas locales siguen activas. Configúrala en el panel de ajustes del plugin en Orca.",
    jevUnreachable: "no se pudo contactar a Jev: la mitad del gate que juzga con Jev no está corriendo ahora mismo — solo las reglas locales siguen activas. Se va a intentar de nuevo con el próximo comando.",
    notice: "jev · {{message}}",
    "reason.allowClear": "reversible, local y barato",
    "reason.incompleteAnswers": "Jev no devolvió respuestas completas para 'reversible', 'externa' o 'consecuencia'.",
    "reason.cannotUndoAndLeavesMachine": "no se puede deshacer y afecta algo fuera de tu máquina",
    "reason.cannotUndo": "no hay forma automática de deshacerlo",
    "reason.someoneElseWillNotice": "otra persona va a notar el efecto",
    "reason.breaksSomethingImportant": "si sale mal, rompe algo que le importa a alguien",
    "reason.needsCleanupAfter": "si sale mal, habrá que limpiar después",
    "reason.tooCloseToTheLine": "quedó justo en el límite, así que prefiere confirmarlo contigo antes que dejarlo pasar solo",
    "reason.noDestinationMatched": "este directorio no corresponde a ningún destino del catálogo, así que se usaron los umbrales globales",
    "reason.ownBranchPush": "sube tu propia rama, sin force y sin tocar ramas compartidas",
    "reason.guardedGitDelete": "solo usa borrados que git mismo protege: se niega si hay trabajo sin guardar o sin integrar",
  },
  en: {
    "rule.forcePush": "force push: rewrites the remote — anyone who already pulled breaks",
    "rule.pushProtected": "pushes straight to a shared branch, skipping review",
    "rule.rmRf": "recursive delete from / or $HOME — no undo",
    "rule.resetClean": "discards uncommitted work — nothing to recover it from",
    "rule.dropTable": "drops a table or a whole database",
    "rule.kubectlDelete": "deletes something that is running and serving right now",
    "rule.terraformApply": "creates or changes real infrastructure",
    "rule.terraformDestroy": "destroys real infrastructure",
    "rule.curlPipeShell": "runs a downloaded script on your machine, unreviewed",
    "verb.blocks": "blocks",
    "verb.asks": "asks",
    localRule: "local rule — {{why}}",
    // English in BOTH catalogs, on purpose. A `deny` reason is delivered to
    // the model, not to a person -- Claude Code's contract: "Refuses the call;
    // the model receives the text as the reason". Translating it makes the one
    // reader it has understand it less well. Everything a PERSON reads stays
    // translated; this does not.
    //
    // It is written as an instruction rather than an explanation, because a
    // model that only learns "this was blocked" tends to try the same effect
    // by another route, which is the outcome the rule exists to prevent.
    localRuleDeny: "REFUSED: {{why}}. You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work.",
    cached: "{{reason}} · cached",
    statusLine: "jev · {{verb}}: {{reason}} · {{ms}}ms",
    advisedLine: "jev · advised the model: {{effect}}",
    authRejected: "not judging: the key was rejected ({{status}})",
    noApiKey: "no key configured: the Jev-backed half of the gate is not running — only the local rules are still active. Set one in the plugin's settings panel in Orca.",
    jevUnreachable: "couldn't reach Jev: the Jev-backed half of the gate is not running right now — only the local rules are still active. It'll try again on the next command.",
    notice: "jev · {{message}}",
    "reason.allowClear": "reversible, local and cheap",
    "reason.incompleteAnswers": "Jev didn't return complete answers for 'reversible', 'external' or 'consequence'.",
    "reason.cannotUndoAndLeavesMachine": "it can't be undone and the effect leaves your machine",
    "reason.cannotUndo": "there's no automatic way to undo it",
    "reason.someoneElseWillNotice": "someone else is going to notice the effect",
    "reason.breaksSomethingImportant": "if it's wrong, it breaks something that matters to someone",
    "reason.needsCleanupAfter": "if it's wrong, there's cleanup to do afterward",
    "reason.tooCloseToTheLine": "right at the limit, so it checks with you instead of letting it through on its own",
    "reason.noDestinationMatched": "this directory doesn't match any catalog destination, so the global thresholds were used",
    "reason.ownBranchPush": "pushes your own branch, with no force and no shared branch",
    "reason.guardedGitDelete": "only uses deletes git itself guards: it refuses when there is unsaved or unmerged work",
  },
};
