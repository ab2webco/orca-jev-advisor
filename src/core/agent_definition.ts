// 0.6.8 T7: the model an agent definition fixes (`.claude/agents/<name>.md`,
// `model:` in its frontmatter). The `agent.spawn` input carries only the
// Agent call's own `model`; a model the definition fixes is resolved by the
// engine after the hook, so the hooks module reads the definitions itself
// and hands them here. With it, "Models fixed by an agent: keep them" keeps
// a definition's model too, and the status line calls it an explicit
// request instead of a model the router chose.
//
// Pure: the caller lists and reads the files.

export interface AgentDefinition {
  readonly name: string | null;
  readonly model: string | null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted !== null ? (quoted[2] as string) : trimmed;
}

/** `name` and `model` from a definition's leading `---` frontmatter; nothing when there is none, or it never closes. */
export function parseAgentDefinition(text: string): AgentDefinition {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name: null, model: null };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { name: null, model: null };
  let name: string | null = null;
  let model: string | null = null;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = unquote(match[2] as string);
    if (value.length === 0) continue;
    if (match[1] === "name") name = value;
    else if (match[1] === "model") model = value;
  }
  return { name, model };
}

export interface AgentDefinitionFile {
  /** The file's own name (`reviewer.md`), used when the frontmatter names nothing. */
  readonly file: string;
  readonly text: string;
}

/** The model the definition of `subagentType` fixes, or null (none found, no model, or `inherit`). The first match wins, so the caller lists the project's own definitions before the user's. */
export function agentDefinitionModel(files: readonly AgentDefinitionFile[], subagentType: string): string | null {
  for (const { file, text } of files) {
    const definition = parseAgentDefinition(text);
    const name = definition.name ?? file.replace(/\.md$/i, "");
    if (name !== subagentType) continue;
    return definition.model === null || definition.model === "inherit" ? null : definition.model;
  }
  return null;
}
