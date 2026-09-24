// Guarded stand-ins for the handful of `node:fs/promises` functions that
// mutate the real filesystem, for the two sidecar scripts that write to a
// developer's real `~/.claude`, `~/.config/orca-supervisor`, or Orca's own
// `claude-accounts/*/auth` (install-claude-integration.mjs,
// write-secret-mirror.mjs).
//
// A caller imports these under the ordinary names --
// `import { guardedMkdir as mkdir, ... } from '../../src/core/guarded_fs.ts'`
// -- instead of node:fs/promises's own. Every mutating call in that file is
// then guarded by construction: there is no per-call-site discipline left
// to forget, which is exactly the discipline that has already failed four
// times (see write_guard.ts's module doc for the incident history). A
// future write added to either sidecar is safe automatically, as long as it
// still spells `mkdir`/`writeFile`/`rename`/`rm`/`cp`/`chmod` the way every
// other function in the file already does.
//
// Read-only functions (readFile, readdir, lstat, readlink, stat) carry none
// of this risk and are imported directly from node:fs/promises, unchanged,
// by both sidecars.

import {
  chmod as fsChmod,
  cp as fsCp,
  mkdir as fsMkdir,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertSafeWriteTarget } from "./write_guard.ts";

export async function guardedWriteFile(
  path: string,
  data: string,
  options?: BufferEncoding | { readonly encoding?: BufferEncoding; readonly mode?: number }
): Promise<void> {
  assertSafeWriteTarget(path);
  await fsWriteFile(path, data, options);
}

export async function guardedMkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
  assertSafeWriteTarget(path);
  await fsMkdir(path, options);
}

/** Guards the destination -- the source of a rename is always a temp file this same guard already checked when it was written. */
export async function guardedRename(oldPath: string, newPath: string): Promise<void> {
  assertSafeWriteTarget(newPath);
  await fsRename(oldPath, newPath);
}

export async function guardedRm(
  path: string,
  options?: { readonly recursive?: boolean; readonly force?: boolean }
): Promise<void> {
  assertSafeWriteTarget(path);
  await fsRm(path, options);
}

/** Guards the destination only -- `source` for every caller in this repository is inside the plugin's own install tree, which is exactly what is meant to be read. */
export async function guardedCp(
  source: string,
  destination: string,
  options?: { readonly recursive?: boolean }
): Promise<void> {
  assertSafeWriteTarget(destination);
  await fsCp(source, destination, options);
}

export async function guardedChmod(path: string, mode: number): Promise<void> {
  assertSafeWriteTarget(path);
  await fsChmod(path, mode);
}
