// Reads the tool roster the model has in this session -- built-in and MCP
// alike -- through an injectable lister, the same seam skill_inventory.ts
// uses for `$.fs` (see that module). Unlike skills there is no filesystem
// to scan and no SKILL.md frontmatter to parse: Claude Code's own
// `$.tool.list()` already hands over each tool's name, description and
// whether it is an MCP tool (adapters/claude/mod-skills/claude-code.d.ts,
// `ToolInfo`, around line 9885: `{ name, description, mcp }`, "in the
// order the model sees them"). This module's job is only the seam and a
// boundary guard -- the runtime shape is worth verifying rather than
// assumed, even though claude-code.d.ts types it.

import { isBoolean, isRecord, isString } from "../guards.ts";

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly mcp: boolean;
}

/** The subset of `$.tool` the inventory needs; a mod passes `() => $.tool.list()`. */
export type ToolLister = () => Promise<readonly unknown[]>;

function isToolSummary(value: unknown): value is ToolSummary {
  return isRecord(value) && isString(value.name) && isString(value.description) && isBoolean(value.mcp);
}

/** Guards a `$.tool.list()` result at the boundary: malformed entries are dropped, never thrown on. */
export function asToolSummaries(value: readonly unknown[]): ToolSummary[] {
  return value.filter(isToolSummary);
}

/**
 * Lists the tools the model can call right now, guarded and deduplicated
 * by name (first occurrence wins, the same order `$.tool.list()` returns
 * them in).
 *
 * Never throws: a lister failure, or a malformed entry in its result,
 * simply yields nothing for that entry, so one bad tool never empties the
 * roster (the same guarantee `listSkillInventory` makes for skills).
 */
export async function listToolInventory(lister: ToolLister): Promise<ToolSummary[]> {
  let raw: readonly unknown[];
  try {
    raw = await lister();
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const tools: ToolSummary[] = [];
  for (const tool of asToolSummaries(raw)) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}
