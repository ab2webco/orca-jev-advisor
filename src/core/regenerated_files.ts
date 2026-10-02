// 0.6.24 T1b: which files a git discard may overwrite because tooling writes
// them back.
//
// The discard rule (discard_loss.ts) refuses when a `git restore`, `git
// checkout -- <path>`, `git reset --hard` or `git clean -f` would throw away
// something that exists now. A dev server rewrites `next-env.d.ts` and, in
// some projects, a `CLAUDE.md` of its own on every start; restoring them
// loses nothing, and refusing it left an agent unable to clean its own
// worktree. This module says which paths count as regenerated:
//
//   - what tooling is known to rewrite (`next-env.d.ts`, `*.tsbuildinfo`,
//     `.next/`), whether the file is tracked or not;
//   - for UNTRACKED files only (the output of a `git clean`): the build and
//     temp folders git_recoverability.ts already trusts (`dist/`, `build/`,
//     `node_modules/`, ...). A tracked change under `src/build/` is source,
//     never output, so the folder names do not apply to it;
//
// A secret-shaped path is never regenerable, whoever listed it: that is the
// one thing the rule exists to keep.
//
// Pure: no fs, no git.

import { EMPTY_GIT_STATUS, classifyRecoverabilityPath } from "./git_recoverability.ts";

/** File names a dev server or compiler writes back on its own, in any project and at any depth. */
const TOOLING_FILE_NAME = /^(?:next-env\.d\.ts|.+\.tsbuildinfo)$/;

function isToolingRewrite(path: string): boolean {
  const segments = path.split("/");
  return segments.includes(".next") || TOOLING_FILE_NAME.test(segments[segments.length - 1] ?? "");
}

/**
 * Whether discarding the change to `path` loses nothing the tooling does not
 * write again. `origin` says what the discard would touch: a change to a
 * `tracked` file (`restore`, `checkout`, `reset --hard`) or an `untracked`
 * one (`clean`); the build and temp folders count only for the second.
 */
export function isRegenerablePath(path: string, origin: "tracked" | "untracked"): boolean {
  const why = classifyRecoverabilityPath(path, EMPTY_GIT_STATUS).why;
  if (why === "secret") return false;
  if (isToolingRewrite(path)) return true;
  return origin === "untracked" && why === "build-or-temp";
}
