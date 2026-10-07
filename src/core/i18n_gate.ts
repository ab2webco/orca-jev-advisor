// gate-bash.ts's own catalog: every string it puts in front of the user
// (permissionDecisionReason, systemMessage), keyed and in both locales. See
// src/core/i18n.ts for why this exists instead of Orca's `languagePacks`.
import type { Catalog } from "./i18n.ts";

export type GateKey =
  | "rule.forcePush"
  | "rule.pushProtected"
  | "rule.rmRf"
  | "rule.resetClean"
  | "rule.resetCleanLoss"
  | "discardLoss.modified.one"
  | "discardLoss.modified.other"
  | "discardLoss.untracked.one"
  | "discardLoss.untracked.other"
  | "rule.dropTable"
  | "rule.kubectlDelete"
  | "rule.terraformApply"
  | "rule.terraformDestroy"
  | "rule.curlPipeShell"
  | "rule.ownConfig"
  | "ownFileEditDeny"
  | "localRule"
  | "localRuleDeny"
  | "localRuleDenyLoss"
  | "policyDeny"
  | "advisedLine"
  | "advisedRetryLine"
  | "authorizedLine"
  | "blockedLine"
  | "policyBlockedLine"
  | "policyAskLine"
  | "policyAskReason"
  | "queuedReason"
  | "queuedLine"
  | "authRejected"
  | "noApiKey"
  | "jevUnreachable"
  | "commandTooLarge"
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
  | "reason.guardedGitDelete"
  | "reason.contained"
  | "effect.namedFiles"
  | "effect.deploy"
  | "effect.publish"
  | "effect.leavesMachine"
  | "effect.cannotUndo"
  | "effect.othersNotice"
  | "effect.uncertain";

export const GATE_CATALOG: Catalog<GateKey> = {
  es: {
    "rule.forcePush": "force push: reescribe el remoto — quien ya hizo pull se rompe",
    "rule.pushProtected": "empuja directo a una rama compartida, sin pasar por revisión",
    "rule.rmRf": "borrado recursivo desde / o $HOME — sin deshacer",
    "rule.resetClean": "descarta trabajo sin confirmar — no hay de dónde recuperarlo",
    "rule.resetCleanLoss": "descarta trabajo sin confirmar: {{loss}}",
    "discardLoss.modified.one": "{{count}} archivo modificado, p. ej. {{example}}",
    "discardLoss.modified.other": "{{count}} archivos modificados, p. ej. {{example}}",
    "discardLoss.untracked.one": "{{count}} archivo sin seguimiento, p. ej. {{example}}",
    "discardLoss.untracked.other": "{{count}} archivos sin seguimiento, p. ej. {{example}}",
    "rule.dropTable": "elimina una tabla o una base entera",
    "rule.kubectlDelete": "borra algo que está corriendo y sirviendo ahora mismo",
    "rule.terraformApply": "crea o cambia infraestructura real",
    "rule.terraformDestroy": "destruye infraestructura real",
    "rule.curlPipeShell": "descarga y ejecuta un script en tu máquina, sin revisarlo",
    "rule.ownConfig": "edita las reglas del propio gate ({{file}}); cámbialas en el panel del Advisor",
    localRule: "regla local — {{why}}",
    // Deliberately identical to the English entry: this string is read by the
    // model, not by a person. See the note on the English one.
    localRuleDeny: "REFUSED: {{why}}. You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work.",
    localRuleDenyLoss: "REFUSED: discards uncommitted work: {{loss}}. Those changes exist only in the working tree, so nothing could bring them back. Do not run this command as written, and do not delete or overwrite the same files by another command, tool or script. {{next}} Continue with the rest of the work.",
    // 0.6.17 T2: the file tools' counterpart of localRuleDeny, English in both catalogs for the same reason.
    ownFileEditDeny: "REFUSED: {{why}}. You cannot make this edit. Do not retry it, and do not reach the same result by another tool, command or script. If it genuinely needs to change, say so and let the person change it in the Advisor panel. Continue with the rest of the work.",
    // A `prohibits` team policy match: the same REFUSED wording pattern as
    // localRuleDeny above, naming the policy instead of a local rule -- also
    // deliberately identical in both catalogs (model-facing, never a person).
    // No retry clause: this is a hard stop, not an advice.
    policyDeny: "REFUSED: forbidden by the team policy {{policyId}} ({{rule}}). You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work.",
    // 0.5.2: the person must read, in one line, WHAT Jev decided and ON
    // WHICH command -- "jev · avisó al modelo: si sale mal, habrá que
    // limpiar después" named neither. `{{segment}}` is the part of the
    // command that caused the decision; `{{effect}}` is the most concrete
    // fact available (gate_person_effect.ts), never the abstract "si sale
    // mal..." framing (that stays model-facing only, in the reason the model
    // itself reads).
    advisedLine: "jev · avisó al modelo antes de `{{segment}}`: {{effect}}",
    // An identical retry within the window actually RAN -- this used to be a
    // silent allow (the person had already seen the original advice), but a
    // silent success is indistinguishable from the model quietly doing
    // something else instead, so it is now its own visible line.
    advisedRetryLine: "jev · el modelo lo confirmó y se ejecutó: `{{segment}}`",
    // 0.6.28: a delivery already confirmed in this repository ran without a new advice.
    authorizedLine: "jev · ya lo confirmaste en este repositorio, se ejecutó: `{{segment}}`",
    // A LOCAL NEVER_SILENTLY rule's hard stop -- names the command and the
    // rule in plain words, never the model-facing REFUSED text
    // (localRuleDeny stays English and keeps talking to the model; this
    // line is for the person watching). `{{rule}}` here is always
    // GATE_CATALOG's own `rule.*` text, already translated for this locale
    // -- never a team's own configured policy text (see policyBlockedLine
    // below for that case).
    blockedLine: "jev · bloqueó `{{segment}}`: {{rule}}",
    // 0.5.3: a `prohibits` team policy's own hard stop got its OWN key,
    // separate from blockedLine above -- the defect this closes: a policy's
    // `rule` is arbitrary, team-authored text (often English, e.g. "Never
    // write directly on main or develop, not even a one-line fix."), and
    // interpolating it here produced a mixed-language line even in `es`
    // ("jev · bloqueó `git add README.md`: Never write directly on main or
    // develop..."). This names only the command and the POLICY, entirely in
    // the person's own locale, with no rule text at all.
    policyBlockedLine: "jev · bloqueó `{{segment}}`: lo prohíbe la política {{policyId}}",
    // A `requires_human` policy still stops the person to decide -- but the
    // reason now names the policy and the command in one short sentence,
    // rather than only the policy's own rationale text.
    policyAskLine: "jev · {{policyId}} pide que decidas: `{{segment}}`",
    // 0.5.3: the person's own confirmation prompt for a `requires_human`
    // ask (Claude Code shows `permissionDecisionReason` to the PERSON for an
    // 'ask', not the model) used to be DESTINATION_CATALOG's own
    // `policy.needsHuman` text, which splices the team's own (often
    // English) rule in after a locale-resolved lead-in -- the exact defect a
    // blind rerun caught: "producción exige que decida una persona:
    // Deploying to production, running production migrations or rotating
    // credentials is decided by a person, always, no exception for
    // urgency." Names only the policy and the command, never the rule.
    policyAskReason: "La política {{policyId}} pide que decidas si se ejecuta `{{segment}}`",
    // 0.6.8 T4: queue mode. Model-facing, so deliberately identical in both
    // catalogs, like policyDeny: the command was queued for a person, it did
    // not run, and the only way forward is the person. No advice retry
    // clause -- an identical retry is ASKED, never passed.
    queuedReason: "Queued for a person: the team policy {{policyId}} needs a person to approve `{{segment}}`, and it was NOT run. Do not retry it now, and do not work around it — no other command, tool or script that reaches the same result. Carry on with the rest of the work, and say in your summary that this step is waiting for the person's approval. Only when the person tells you to, run the same command again: they will be asked then.",
    // The person's line: what waits for them and under which policy. The
    // item is on the board's "Waiting for you" list.
    queuedLine: "jev · {{policyId}} lo dejó en espera para ti: `{{segment}}` — el agente sigue con lo demás",
    authRejected: "sin opinar: la llave fue rechazada ({{status}})",
    noApiKey: "sin llave configurada: la mitad del gate que juzga con Jev no está corriendo — solo las reglas locales siguen activas. Configúrala en el panel de ajustes del plugin en Orca.",
    jevUnreachable: "no se pudo contactar a Jev: la mitad del gate que juzga con Jev no está corriendo ahora mismo — solo las reglas locales siguen activas. Se va a intentar de nuevo con el próximo comando.",
    commandTooLarge: "este comando es demasiado grande para que Jev lo juzgue: solo se aplicaron las reglas locales y no se consultó a Jev.",
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
    "reason.contained": "solo escribe o borra dentro de un directorio temporal",
    // 0.5.2's own concrete-effect line (gate_person_effect.ts), in priority
    // order: named files first, then deploy/publish, then leaves-this-
    // machine, then cannot-undo, then the always-available others-notice
    // floor. Never the abstract "si sale mal..." framing.
    "effect.namedFiles": "borra trabajo sin guardar: {{files}}",
    "effect.deploy": "dispara un deploy",
    "effect.publish": "publica un paquete",
    "effect.leavesMachine": "publica fuera de tu máquina",
    "effect.cannotUndo": "no se puede deshacer",
    "effect.othersNotice": "lo verán otras personas",
    // 0.5.3: the honest floor for a risk reason that carries no concrete
    // fact of its own (needsCleanupAfter, breaksSomethingImportant,
    // tooCloseToTheLine) -- never othersNotice, which asserts something
    // these reasons do not actually support (see gate_person_effect.ts).
    "effect.uncertain": "Jev no está seguro de que sea inofensivo",
  },
  en: {
    "rule.forcePush": "force push: rewrites the remote — anyone who already pulled breaks",
    "rule.pushProtected": "pushes straight to a shared branch, skipping review",
    "rule.rmRf": "recursive delete from / or $HOME — no undo",
    "rule.resetClean": "discards uncommitted work — nothing to recover it from",
    "rule.resetCleanLoss": "discards uncommitted work: {{loss}}",
    "discardLoss.modified.one": "{{count}} modified file, e.g. {{example}}",
    "discardLoss.modified.other": "{{count}} modified files, e.g. {{example}}",
    "discardLoss.untracked.one": "{{count}} untracked file, e.g. {{example}}",
    "discardLoss.untracked.other": "{{count}} untracked files, e.g. {{example}}",
    "rule.dropTable": "drops a table or a whole database",
    "rule.kubectlDelete": "deletes something that is running and serving right now",
    "rule.terraformApply": "creates or changes real infrastructure",
    "rule.terraformDestroy": "destroys real infrastructure",
    "rule.curlPipeShell": "downloads and runs a script on your machine, unreviewed",
    "rule.ownConfig": "edits the gate's own rules ({{file}}); change them in the Advisor panel",
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
    localRuleDenyLoss: "REFUSED: discards uncommitted work: {{loss}}. Those changes exist only in the working tree, so nothing could bring them back. Do not run this command as written, and do not delete or overwrite the same files by another command, tool or script. {{next}} Continue with the rest of the work.",
    // 0.6.17 T2: the file tools' counterpart of localRuleDeny, English in both catalogs for the same reason.
    ownFileEditDeny: "REFUSED: {{why}}. You cannot make this edit. Do not retry it, and do not reach the same result by another tool, command or script. If it genuinely needs to change, say so and let the person change it in the Advisor panel. Continue with the rest of the work.",
    policyDeny: "REFUSED: forbidden by the team policy {{policyId}} ({{rule}}). You cannot run this command. Do not retry it, and do not reach the same result by another command, tool or script — the refusal is about the effect, not the spelling. If it genuinely needs to happen, say so and let the person run it themselves in a terminal; they are not blocked. Continue with the rest of the work.",
    advisedLine: "jev · advised the model before `{{segment}}`: {{effect}}",
    advisedRetryLine: "jev · the model confirmed it and it ran: `{{segment}}`",
    authorizedLine: "jev · already confirmed in this repository, it ran: `{{segment}}`",
    blockedLine: "jev · blocked `{{segment}}`: {{rule}}",
    policyBlockedLine: "jev · blocked `{{segment}}`: forbidden by the policy {{policyId}}",
    policyAskLine: "jev · {{policyId}} asks you to decide: `{{segment}}`",
    policyAskReason: "The policy {{policyId}} asks you to decide whether to run `{{segment}}`",
    queuedReason: "Queued for a person: the team policy {{policyId}} needs a person to approve `{{segment}}`, and it was NOT run. Do not retry it now, and do not work around it — no other command, tool or script that reaches the same result. Carry on with the rest of the work, and say in your summary that this step is waiting for the person's approval. Only when the person tells you to, run the same command again: they will be asked then.",
    queuedLine: "jev · {{policyId}} queued it for you: `{{segment}}` — the agent carries on",
    authRejected: "not judging: the key was rejected ({{status}})",
    noApiKey: "no key configured: the Jev-backed half of the gate is not running — only the local rules are still active. Set one in the plugin's settings panel in Orca.",
    jevUnreachable: "couldn't reach Jev: the Jev-backed half of the gate is not running right now — only the local rules are still active. It'll try again on the next command.",
    commandTooLarge: "this command is too large for Jev to judge: only the local rules were applied and Jev was not asked.",
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
    "reason.contained": "only writes or deletes inside a temporary directory",
    "effect.namedFiles": "deletes unsaved work: {{files}}",
    "effect.deploy": "triggers a deploy",
    "effect.publish": "publishes a package",
    "effect.leavesMachine": "reaches beyond this machine",
    "effect.cannotUndo": "cannot be undone",
    "effect.othersNotice": "other people will see it",
    "effect.uncertain": "Jev isn't sure it's harmless",
  },
};
