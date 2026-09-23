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
  | "rule.terraform"
  | "rule.curlPipeShell"
  | "verb.blocks"
  | "verb.asks"
  | "localRule"
  | "cached"
  | "statusLine"
  | "authRejected"
  | "notice";

export const GATE_CATALOG: Catalog<GateKey> = {
  es: {
    "rule.forcePush": "force push: reescribe el remoto — quien ya hizo pull se rompe",
    "rule.pushProtected": "empuja directo a una rama compartida, sin pasar por revisión",
    "rule.rmRf": "borrado recursivo desde / o $HOME — sin deshacer",
    "rule.resetClean": "descarta trabajo sin confirmar — no hay de dónde recuperarlo",
    "rule.dropTable": "elimina una tabla o una base entera",
    "rule.kubectlDelete": "borra algo que está corriendo y sirviendo ahora mismo",
    "rule.terraform": "crea, cambia o destruye infraestructura real",
    "rule.curlPipeShell": "ejecuta un script descargado en tu máquina, sin revisarlo",
    "verb.blocks": "bloquea",
    "verb.asks": "pregunta",
    localRule: "regla local — {{why}}",
    cached: "{{reason}} · cacheado",
    statusLine: "jev · {{verb}}: {{reason}} · {{ms}}ms",
    authRejected: "sin opinar: la llave fue rechazada ({{status}})",
    notice: "jev · {{message}}",
  },
  en: {
    "rule.forcePush": "force push: rewrites the remote — anyone who already pulled breaks",
    "rule.pushProtected": "pushes straight to a shared branch, skipping review",
    "rule.rmRf": "recursive delete from / or $HOME — no undo",
    "rule.resetClean": "discards uncommitted work — nothing to recover it from",
    "rule.dropTable": "drops a table or a whole database",
    "rule.kubectlDelete": "deletes something that is running and serving right now",
    "rule.terraform": "creates, changes or destroys real infrastructure",
    "rule.curlPipeShell": "runs a downloaded script on your machine, unreviewed",
    "verb.blocks": "blocks",
    "verb.asks": "asks",
    localRule: "local rule — {{why}}",
    cached: "{{reason}} · cached",
    statusLine: "jev · {{verb}}: {{reason}} · {{ms}}ms",
    authRejected: "not judging: the key was rejected ({{status}})",
    notice: "jev · {{message}}",
  },
};
