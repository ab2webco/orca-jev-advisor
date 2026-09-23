// mod-skills' own catalog: the status line and the injected
// <skill_relevance> block's prose (the model reads it; it is not shown to
// the user, but it is still text this plugin puts in front of the Claude
// Code session -- see src/core/i18n.ts for why it is not Orca's own
// `contributes.languagePacks`).
import type { Catalog } from "./i18n.ts";

export type ModSkillsKey = "status.skill" | "status.noSkill" | "relevance.intro" | "relevance.instructions";

export const MOD_SKILLS_CATALOG: Catalog<ModSkillsKey> = {
  es: {
    "status.skill": "jev · skill: {{name}}",
    "status.noSkill": "jev · sin skill",
    "relevance.intro": "Relevante para el pedido actual: {{name}}. Ignora esto si no coincide con lo que el usuario realmente pidió.",
    "relevance.instructions": "Sus instrucciones siguen a continuación: síguelas ahora, incluido cualquier paso de configuración. No la cargues con la herramienta Skill (ya está cargada aquí y la herramienta podría rechazarla).",
  },
  en: {
    "status.skill": "jev · skill: {{name}}",
    "status.noSkill": "jev · no skill",
    "relevance.intro": "Relevant to the current request: {{name}}. Ignore this if it does not match what the user actually asked for.",
    "relevance.instructions": "Its instructions follow: follow them now, including any setup steps. Do not load it with the Skill tool (it is already loaded here, and the tool may refuse it).",
  },
};
