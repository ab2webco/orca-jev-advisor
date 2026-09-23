// Reads a skill's name and description straight from its SKILL.md
// frontmatter, and lists the skills a session has installed -- project,
// user and claude.ai-synced -- by how Claude Code lays them out on disk
// (`.claude/skills/<name>/SKILL.md`, `.claude/skills/synced/<account>/
// <name>/SKILL.md`). This is what jev-skill-suggestion's "candidates come
// from the listing" step needs replaced with: our mod reads the roster
// itself, before the listing even exists (see mod-skills' README).
//
// The frontmatter reader is not a YAML parser -- no dependency is pulled
// in for it on purpose (this is a zero-dependency project). It reads the
// file as a flat line sequence, finds the `---`-delimited block, and
// inside it reads only `name:` and `description:` at zero indentation.
// That is every shape this machine's real skills actually use, measured
// against ~/.claude/skills before writing this:
//
//   name: archify
//   description: One line, quoted or not.
//
//   description: >-
//     A folded block scalar (several of this user's skills use exactly
//     this): lines join with a single space, a blank line starts a new
//     paragraph.
//
//   description: |
//     A literal block scalar: every line is kept, newlines and all, with
//     the block's own indentation stripped.
//
// A value of another YAML shape (a flow sequence, an anchor, a multi-line
// plain scalar with no block indicator) is read as best-effort plain text
// rather than rejected -- nothing here is asked to reject a SKILL.md, only
// to get its name and description when it can.

import { isRecord, isString } from "../guards.ts";

// ---------------------------------------------------------------------------
// Frontmatter reading (pure)
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  readonly name: string | null;
  readonly description: string | null;
}

function stripMatchingQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match !== null ? (match[1] as string).length : 0;
}

/**
 * Reads a block scalar (`>` folded or `|` literal) starting right after its
 * `key:` line. Chomping indicators (`-`/`+`) are not distinguished -- the
 * result is trimmed either way, which is all a description sent to Jev
 * needs.
 */
function readBlockScalar(lines: readonly string[], startIndex: number, style: ">" | "|"): { value: string; nextIndex: number } {
  let i = startIndex;
  while (i < lines.length && (lines[i] as string).trim() === "") i++;
  if (i >= lines.length) return { value: "", nextIndex: startIndex };

  const blockIndent = indentOf(lines[i] as string);
  if (blockIndent === 0) return { value: "", nextIndex: startIndex };

  const collected: string[] = [];
  let next = startIndex;
  let j = startIndex;
  while (j < lines.length) {
    const line = lines[j] as string;
    if (line.trim() === "") {
      collected.push("");
      j++;
      continue;
    }
    if (indentOf(line) < blockIndent) break;
    collected.push(line.slice(blockIndent));
    j++;
    next = j;
  }

  if (style === "|") {
    return { value: collected.join("\n").trim(), nextIndex: next };
  }

  // Folded: consecutive non-blank lines join with a space; a blank line
  // (or a run of them) becomes a paragraph break.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of collected) {
    if (line === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return { value: paragraphs.join("\n").trim(), nextIndex: next };
}

/** A SKILL.md's body with its `---`-delimited frontmatter stripped, for stage 2's excerpt. */
export function stripSkillFrontmatter(markdown: string): string {
  const opening = /^---\r?\n/.exec(markdown);
  if (!opening) return markdown;
  const rest = markdown.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(rest);
  if (!closing) return markdown;
  return rest.slice(closing.index + closing[0].length);
}

/** Reads `name:` and `description:` from a SKILL.md's frontmatter, or nulls when absent. */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const opening = /^---\r?\n/.exec(markdown);
  if (!opening) return { name: null, description: null };
  const rest = markdown.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(rest);
  if (!closing) return { name: null, description: null };

  const lines = rest.slice(0, closing.index).split(/\r?\n/);
  let name: string | null = null;
  let description: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (indentOf(line) !== 0) continue;
    const match = /^(name|description):[ \t]?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as "name" | "description";
    const rawValue = (match[2] ?? "").trim();
    const blockIndicator = /^([>|])[+-]?\s*$/.exec(rawValue);

    let value: string;
    if (blockIndicator) {
      const style = blockIndicator[1] === ">" ? ">" : "|";
      const block = readBlockScalar(lines, i + 1, style);
      value = block.value;
      i = block.nextIndex - 1;
    } else {
      value = stripMatchingQuotes(rawValue);
    }

    if (key === "name") name = value.length > 0 ? value : null;
    else description = value.length > 0 ? value : null;
  }

  return { name, description };
}

// ---------------------------------------------------------------------------
// Inventory scanning (adapter-facing: takes an injected fs facade)
// ---------------------------------------------------------------------------

/** The subset of `$.fs` the inventory scan needs; a mod passes `$.fs` itself. */
export interface SkillFsEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
}

export interface SkillFs {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly SkillFsEntry[]>;
  read(path: string): Promise<string>;
}

export type SkillSource = "project" | "user" | "synced";

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  /** Absolute (or session-relative) path to the skill's SKILL.md. */
  readonly path: string;
  readonly source: SkillSource;
}

export interface SkillInventoryRoots {
  /** `<project>/.claude/skills`, or null when there is no project directory. */
  readonly projectSkillsDir: string | null;
  /** `<home>/.claude/skills`, or null when HOME is unknown. */
  readonly userSkillsDir: string | null;
}

function isSkillFsEntry(value: unknown): value is SkillFsEntry {
  return isRecord(value) && isString(value.name) && (value.kind === "file" || value.kind === "dir" || value.kind === "other");
}

/** Guards a `$.fs.list` result at the boundary: malformed entries are dropped, never thrown on. */
export function asSkillFsEntries(value: readonly unknown[]): SkillFsEntry[] {
  return value.filter(isSkillFsEntry);
}

async function skillDirNames(fs: SkillFs, skillsDir: string): Promise<readonly string[]> {
  let exists: boolean;
  try {
    exists = await fs.exists(skillsDir);
  } catch {
    return [];
  }
  if (!exists) return [];
  let entries: readonly SkillFsEntry[];
  try {
    entries = await fs.list(skillsDir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.kind === "dir" && !entry.name.startsWith(".") && !entry.name.startsWith("_") && entry.name !== "synced").map((entry) => entry.name);
}

async function readSkillAt(fs: SkillFs, skillDir: string, dirName: string, source: SkillSource): Promise<SkillSummary | null> {
  const skillMdPath = `${skillDir}/SKILL.md`;
  let exists: boolean;
  try {
    exists = await fs.exists(skillMdPath);
  } catch {
    return null;
  }
  if (!exists) return null;

  let markdown: string;
  try {
    markdown = await fs.read(skillMdPath);
  } catch {
    return null;
  }

  const { name, description } = parseSkillFrontmatter(markdown);
  return {
    name: name ?? dirName,
    description: description ?? "",
    path: skillMdPath,
    source,
  };
}

/**
 * Lists every installed skill's name and description: project skills first,
 * then user skills, then claude.ai-synced ones (any account; first found
 * wins). A name already seen at a higher-precedence tier is not repeated.
 *
 * Never throws: a missing directory, an unreadable file or a malformed
 * frontmatter simply yields nothing for that entry, so one bad skill never
 * empties the roster.
 */
export async function listSkillInventory(fs: SkillFs, roots: SkillInventoryRoots): Promise<SkillSummary[]> {
  const seen = new Set<string>();
  const skills: SkillSummary[] = [];

  const addFrom = async (skillsDir: string, source: SkillSource): Promise<void> => {
    for (const dirName of await skillDirNames(fs, skillsDir)) {
      const skill = await readSkillAt(fs, `${skillsDir}/${dirName}`, dirName, source);
      if (skill !== null && !seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  };

  if (roots.projectSkillsDir) await addFrom(roots.projectSkillsDir, "project");
  if (roots.userSkillsDir) await addFrom(roots.userSkillsDir, "user");

  if (roots.userSkillsDir) {
    const syncedRoot = `${roots.userSkillsDir}/synced`;
    let hasSynced: boolean;
    try {
      hasSynced = await fs.exists(syncedRoot);
    } catch {
      hasSynced = false;
    }
    if (hasSynced) {
      let accounts: readonly string[];
      try {
        accounts = (await fs.list(syncedRoot)).filter((entry) => entry.kind === "dir").map((entry) => entry.name);
      } catch {
        accounts = [];
      }
      for (const account of accounts) {
        await addFrom(`${syncedRoot}/${account}`, "synced");
      }
    }
  }

  return skills;
}
