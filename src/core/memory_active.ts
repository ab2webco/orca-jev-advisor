// ---------------------------------------------------------------------------
// Memory module in Active (odd/tasks/memory-active-files.md, files store;
// odd/tasks/memory-active-engram.md, Engram live).
//
// Active writes into the auto-memory folder when it is the store (no Engram,
// or Engram configured but down) and into Engram when Engram is usable. With
// Engram live but its check refused it keeps measuring as Shadow. This file
// holds the pure rules the mod's write path follows:
//   - which mode really runs, from the switch and the backend;
//   - where the spool lives, one root per memory folder, so a replay only
//     ever writes the items of its own folder;
//   - whether a drafted update may rewrite a file;
//   - where a file is copied before it is rewritten;
//   - whether Claude Code's own consolidation holds the folder.
//
// Pure: no I/O and no node: import, so the mod sandbox can load it too.
// ---------------------------------------------------------------------------

import { engramUsable } from "./memory_detect.ts";
import type { MemoryBackendDecision } from "./memory_detect.ts";
import type { DraftUpdate } from "./memory_draft.ts";
import { fnv1a } from "./memory_shadow.ts";
import type { MemoryMode } from "./memory_shadow.ts";
import { BACKUP_DIR, backupStamp, lockPid, parseFrontmatter } from "./memory_tidy.ts";

/** Claude Code's own consolidation lock, in the memory folder. */
export const CONSOLIDATE_LOCK = ".consolidate-lock";

/**
 * What runs. Active writes to the files store (no Engram, or Engram down) and,
 * since 0.10.0, to Engram when it is usable. Engram live with its check
 * refused for want of a permission rule cannot be written: Active keeps
 * measuring as Shadow there.
 */
export function effectiveMemoryMode(mode: MemoryMode, backend: MemoryBackendDecision): MemoryMode {
  if (mode !== "active") return "shadow";
  return backend.backend !== "live" || engramUsable(backend) ? "active" : "shadow";
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** `<cache>/memory-spool/<store id>`: the spool of one memory folder; items go in `<sessionId>/<id>.json` under it. */
export function memorySpoolRoot(cacheDir: string, autoMemoryDir: string): string {
  const id = fnv1a(withoutTrailingSlash(autoMemoryDir)).toString(16).padStart(8, "0");
  return `${withoutTrailingSlash(cacheDir)}/memory-spool/${id}`;
}

export type UpdateCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "missing" | "no-frontmatter" };

/** An update rewrites only a file that is there, and only with a whole file whose frontmatter names it. */
export function checkUpdate(update: DraftUpdate, current: string | null): UpdateCheck {
  if (current === null) return { ok: false, reason: "missing" };
  if (parseFrontmatter(update.content).name === null) return { ok: false, reason: "no-frontmatter" };
  return { ok: true };
}

/** `<memory dir>/.memory-backup/<stamp>`: hidden and not `.md`, so Claude Code never reads it as memory. */
export function backupDir(autoMemoryDir: string, atIso: string): string {
  return `${withoutTrailingSlash(autoMemoryDir)}/${BACKUP_DIR}/${backupStamp(atIso)}`;
}

export interface LockInput {
  /** The lock's text, null when there is no lock. */
  readonly content: string | null;
  readonly mtimeMs: number | null;
  readonly nowMs: number;
  /** Whether its pid answers `kill -0`; null when that could not be asked. */
  readonly alive: boolean | null;
}

/** Whether the folder is held: a lock under an hour old with a pid that is alive, or that could not be checked. */
export function lockHeld(input: LockInput): boolean {
  if (lockPid({ content: input.content, mtimeMs: input.mtimeMs, nowMs: input.nowMs }) === null) return false;
  return input.alive !== false;
}
