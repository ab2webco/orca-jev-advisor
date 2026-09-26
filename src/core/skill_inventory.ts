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

import { isBoolean, isRecord, isString } from "../guards.ts";

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

/**
 * One entry of `$.fs.list`: the entry itself, a link not followed -- a
 * symbolic link reports `kind: "other"` with `isLink: true` ($.fs.list
 * never follows a link; `$.fs.stat` says what it leads to). `isLink` is
 * optional here, not on the real `FsEntry`, purely so a hand-written test
 * double that omits it (as this project's did before symlinks mattered)
 * keeps typechecking; a missing value reads as `false`.
 */
export interface SkillFsEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
  readonly isLink?: boolean;
}

/** What `$.fs.stat` resolves with, narrowed to the one field this module needs: what the path leads to, a link followed. */
export interface SkillFsStat {
  readonly kind: "file" | "dir" | "other";
}

/** The subset of `$.fs` the inventory scan needs; a mod passes `$.fs` itself. */
export interface SkillFs {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<readonly SkillFsEntry[]>;
  read(path: string): Promise<string>;
  /** What `path` leads to, a link followed -- mirrors `$.fs.stat` (no `resolve` needed: `kind` alone already answers "is this a directory"). */
  stat(path: string): Promise<SkillFsStat>;
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
  /** Claude Code's own user skills folder for this session: `$CLAUDE_CONFIG_DIR/skills` when that variable is set, else `<home>/.claude/skills`; null when neither is known. See adapters/claude/mod-skills/hooks/runtime.ts's `resolveUserSkillsDir`, which computes this for the one real caller. */
  readonly userSkillsDir: string | null;
}

function isSkillFsEntry(value: unknown): value is SkillFsEntry {
  return isRecord(value) && isString(value.name) && (value.kind === "file" || value.kind === "dir" || value.kind === "other") && (value.isLink === undefined || isBoolean(value.isLink));
}

/** Guards a `$.fs.list` result at the boundary: malformed entries are dropped, never thrown on. */
export function asSkillFsEntries(value: readonly unknown[]): SkillFsEntry[] {
  return value.filter(isSkillFsEntry);
}

/**
 * Whether a listed entry is (or leads to) a directory. A plain directory
 * entry (`kind: "dir"`) needs no extra work; a symbolic link -- reported by
 * `$.fs.list` as `kind: "other"` with `isLink: true` -- is resolved with one
 * `fs.stat` call and counted only when it leads to a directory. A dangling
 * link, a link to a file, or a rejected stat all read as "not a directory"
 * rather than throwing, so one bad entry never empties the roster.
 */
async function entryLeadsToDir(fs: SkillFs, entryPath: string, entry: SkillFsEntry): Promise<boolean> {
  if (entry.kind === "dir") return true;
  if (entry.kind !== "other" && entry.isLink !== true) return false;
  try {
    const stat = await fs.stat(entryPath);
    return stat.kind === "dir";
  } catch {
    return false;
  }
}

/** Directory names directly under `parentDir`, a link resolved to what it leads to (see `entryLeadsToDir`). `filter` narrows which entries are even considered (name-based only; cheap, so it runs before any `stat` call). */
async function dirNamesUnder(fs: SkillFs, parentDir: string, filter: (entry: SkillFsEntry) => boolean): Promise<readonly string[]> {
  let exists: boolean;
  try {
    exists = await fs.exists(parentDir);
  } catch {
    return [];
  }
  if (!exists) return [];
  let entries: readonly SkillFsEntry[];
  try {
    entries = await fs.list(parentDir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!filter(entry)) continue;
    if (await entryLeadsToDir(fs, `${parentDir}/${entry.name}`, entry)) names.push(entry.name);
  }
  return names;
}

async function skillDirNames(fs: SkillFs, skillsDir: string): Promise<readonly string[]> {
  return dirNamesUnder(fs, skillsDir, (entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_") && entry.name !== "synced");
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
    // dirNamesUnder already yields [] when `synced/` is missing or
    // unlistable, so no separate `fs.exists` guard is needed here.
    const syncedRoot = `${roots.userSkillsDir}/synced`;
    for (const account of await dirNamesUnder(fs, syncedRoot, () => true)) {
      await addFrom(`${syncedRoot}/${account}`, "synced");
    }
  }

  return skills;
}
