// mod-skills' tool-selection catalog: the status line and the injected
// <tool_relevance> block's prose (the model reads it; it is not shown to
// the user, but it is still text this plugin puts in front of the Claude
// Code session -- see src/core/i18n.ts for why it is not Orca's own
// `contributes.languagePacks`, and i18n_mod_skills.ts for the same shape
// applied to skill selection).
import type { Catalog } from "./i18n.ts";

export type ToolsKey = "status.tool" | "status.noTool" | "advice.intro" | "advice.instructions";

export const TOOLS_CATALOG: Catalog<ToolsKey> = {
  es: {
    "status.tool": "jev · herramienta: {{name}}",
    "status.noTool": "jev · sin herramienta",
    "advice.intro": "Sugerencia para este pedido: la herramienta {{name}} podría ser la indicada.",
    "advice.instructions": "Esto es solo una sugerencia, no una orden: evalúala y úsala solo si de verdad ayuda; ignórala si no coincide con lo que el usuario pidió, y sigue teniendo el resto de las herramientas disponibles igual que antes.",
  },
  en: {
    "status.tool": "jev · tool: {{name}}",
    "status.noTool": "jev · no tool",
    "advice.intro": "Suggestion for this request: the {{name}} tool might be the right one.",
    "advice.instructions": "This is only a suggestion, not an instruction: weigh it and use it only if it genuinely helps; ignore it if it doesn't match what the user actually asked for, and every other tool is still just as available as before.",
  },
};
