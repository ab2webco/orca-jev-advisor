// ---------------------------------------------------------------------------
// JEVADV-118 T1 (odd/tasks/jevadv-118.md): an Orca member's brief, judged.
//
// Every Orca member starts with "Read your Orca Lab brief at
// .orca/briefs/ctx_….md (task …) and follow it." -- a pointer prompt (0.6.2
// E6), so the router held the launch model for 206 of 231 member sessions and
// Jev chose nothing. The brief's TASK block is the work; Jev judges that
// instead, and the pointer guard no longer holds.
//
// Narrow on purpose: only a file under the worktree's own `.orca/briefs/`, a
// regular file under BRIEF_MAX_BYTES, and only the text between `=== TASK ===`
// and `<<< PROJECT LESSONS` -- the CLI part carries a live dispatch
// capability and the lessons are untrusted data. A TASK that only names a
// ticket keeps the guard: Jev would be judging a title. Every other pointer
// keeps E6 as it was.
//
// Pure: the hooks module stats and reads the file.
// ---------------------------------------------------------------------------

import { isPointerPrompt } from "./model_router_decide.ts";

export const BRIEF_MAX_BYTES = 64 * 1024;

/** A path whose last two directories are `.orca/briefs`, ending in a plain `.md` name; never one with `..` in it. */
const BRIEF_PATH = /(?:^|[\s(`'"])((?:\/|\.\/)?(?:[^\s`'"()]*\/)?\.orca\/briefs\/[\w.-]+\.md)(?=$|[\s)`'".,;:])/;

/** The brief a pointer prompt names, as written; null for any other prompt. */
export function briefPointerPath(prompt: string): string | null {
  if (!isPointerPrompt(prompt)) return null;
  const path = BRIEF_PATH.exec(prompt)?.[1];
  if (path === undefined || path.split("/").includes("..")) return null;
  return path;
}

/** What `$.fs.stat(path, { resolve: true })` answers that this check reads. */
export interface BriefStat {
  readonly kind: "file" | "dir" | "other";
  readonly size: number;
  readonly realPath: string | undefined;
}

/** A regular file whose real path is inside `<cwdReal>/.orca/briefs/` (no escape through a link) and under the size cap. */
export function briefFileUsable(cwdReal: string, stat: BriefStat): boolean {
  const root = `${cwdReal.replace(/\/+$/, "")}/.orca/briefs/`;
  return stat.kind === "file" && stat.size <= BRIEF_MAX_BYTES && stat.realPath !== undefined && stat.realPath.startsWith(root);
}

const TASK_START = /^=== TASK ===[ \t]*$/m;
const LESSONS_START = /^<<< PROJECT LESSONS/m;

/** The text between `=== TASK ===` and `<<< PROJECT LESSONS` (or the end), trimmed; null when there is none. */
export function briefTaskText(content: string): string | null {
  const start = TASK_START.exec(content);
  if (start === null) return null;
  const rest = content.slice(start.index + start[0].length);
  const end = LESSONS_START.exec(rest);
  const task = (end === null ? rest : rest.slice(0, end.index)).trim();
  return task.length === 0 ? null : task;
}

const URL = /\bhttps?:\/\/\S+/g;
const TICKET = /\b[A-Z][A-Z0-9]*-\d+\b/g;
/** Orca's own launch template: "Work on <ticket>[: <title>]". */
const WORK_ON_TICKET = /^work on\s+[A-Z][A-Z0-9]*-\d+\b/i;
/** Fewer words than this, ticket ids and links aside, describe no work. */
const MIN_TASK_WORDS = 8;

/** The TASK text when it describes work Jev can judge; null when it only names a ticket (its id, a title, links). */
export function judgeableBriefTask(task: string): string | null {
  const lines = task
    .split("\n")
    .map((line) => line.replace(URL, "").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 1 && WORK_ON_TICKET.test(lines[0] as string)) return null;
  const words = lines.join(" ").replace(TICKET, " ").split(/\s+/).filter((word) => /\w/.test(word));
  return words.length < MIN_TASK_WORDS ? null : task;
}
