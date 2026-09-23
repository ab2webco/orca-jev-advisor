// adapters/orca/main.mjs's own catalog: the worker's user-facing text
// (`notifications.show` titles/bodies, and the one thrown error a command
// caller might surface). Everything else the worker does (`orca.log`) is
// an operator diagnostic in the debug log, never shown to the user in the
// UI, and stays out of this catalog on purpose -- same line the rest of
// this codebase already draws around `orca.log`.
import type { Catalog } from "./i18n.ts";

export type AdvisorKey =
  | "title"
  | "titleDoctor"
  | "notify.noKey.body"
  | "notify.decide.body"
  | "notify.doctor.ok"
  | "notify.doctor.problem"
  | "error.noApiKey";

export const ADVISOR_CATALOG: Catalog<AdvisorKey> = {
  es: {
    title: "Jev Advisor",
    titleDoctor: "Jev Advisor: diagnóstico",
    "notify.noKey.body": "No hay una clave de TypeSafe configurada. Abre la configuración del plugin.",
    "notify.decide.body": "{{act}} para actuar · {{blocked}} bloqueadas · {{ask}} para revisar.",
    "notify.doctor.ok": "Todo en orden.",
    "notify.doctor.problem": "Hay problemas de configuración -- revisa el panel.",
    "error.noApiKey": "No hay TYPESAFE_API_KEY configurada en el almacén de secrets del plugin.",
  },
  en: {
    title: "Jev Advisor",
    titleDoctor: "Jev Advisor: diagnostics",
    "notify.noKey.body": "No TypeSafe key is configured. Open the plugin's settings.",
    "notify.decide.body": "{{act}} to act on · {{blocked}} blocked · {{ask}} to review.",
    "notify.doctor.ok": "Everything checks out.",
    "notify.doctor.problem": "There are configuration problems -- check the panel.",
    "error.noApiKey": "No TYPESAFE_API_KEY is configured in the plugin's secrets store.",
  },
};
