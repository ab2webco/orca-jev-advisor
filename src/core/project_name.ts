// Shared project-naming helper, extracted from
// adapters/orca/read-measurements.mjs:429-438 so both that sidecar and the
// mod-skills hook (adapters/claude/mod-skills/hooks/index.ts) resolve a
// project name from an OrcaContext-shaped value the exact same way and can
// never drift (mirrors the existing header comment there asking to check
// main.mjs:2193/2219 agree).
//
// odd/tasks/board-leftovers.md L1 -- the name a skills-mod decision's
// project goes by in "By project", or null when nothing in the row can name
// it. The board adds these counts to the gate's by name, and the gate's rows
// are named when adapters/claude/gate-bash.ts writes them (its
// projectName(): the `origin` remote's last path segment without `.git`,
// else the working directory's own name). The skills mod records Orca's raw
// projectId instead, so this applies that same rule to what the row carries:
//
//   - `github:owner/name` (a remote-derived projectId) -> its last segment,
//     the same cut gate-bash.ts makes on the origin URL. main.mjs's
//     remoteShortName() is the other copy; `grep -nF "replace(/^.*[:/]/"`
//     across the three files is how to check they still agree.
//   - `repo:<id>` is Orca's id for a checkout with no remote, where the gate
//     falls back to the working directory's name -> the worktree's folder
//     name. With no worktree recorded, null: never the id itself.
//   - no projectId at all -> the worktree's folder name, the same fallback.

import { isRecord } from "../guards.ts";
import type { OrcaContext } from "./orca_context.ts";

// No `node:path` import: this module is shared with
// adapters/claude/mod-skills/hooks/index.ts, whose own tsconfig has no Node
// types at all (the hook sandbox's own "no DOM, no Node" -- see that
// tsconfig's own comment). `basenameOf` mirrors `path.basename`'s behavior
// for the plain POSIX-style worktree paths Orca actually hands this
// (trailing slashes stripped, the last non-empty segment kept).
function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : trimmed;
}

/** The subset of `OrcaContext` this helper actually reads. */
export type ProjectNameContext = Pick<OrcaContext, "worktree" | "proyecto">;

/** Reads an OrcaContext-shaped, possibly-untrusted value's project name.
 *  Returns null when nothing in the value can name a project. */
export function modSkillsProjectName(orcaContext: unknown): string | null {
  if (!isRecord(orcaContext)) return null;
  const present = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  const lastSegment = (value: string): string | null =>
    present(value.trim().replace(/^.*[:/]/, "").replace(/\.git$/, ""));
  const proyecto = present(orcaContext.proyecto);
  if (proyecto !== null && !proyecto.startsWith("repo:")) return lastSegment(proyecto);
  // gate-bash.ts's fallback is basename(cwd): the folder name as is.
  const worktree = present(orcaContext.worktree);
  return worktree !== null ? present(basenameOf(worktree)) : null;
}
