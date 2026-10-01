// Resolves the absolute directories a command's own file targets sit in --
// enough to answer "which repository does this command actually act on",
// never "is this destructive" (git_recoverability.ts's own, narrower job:
// only the five shapes whose safe subset matters for advice text). Part 4
// (0.5.2): a policy coverage judgment that only ever looks at the SESSION's
// own cwd misjudges a command that actually reaches into a different
// repository entirely -- the real miss this closes: two `rm` of a temp file
// in an UNRELATED repository, on a feature branch, were hard-denied by
// `never_write_to_main` because the session's own cwd happened to be a
// main-branch checkout.
//
// Recognised per segment:
//   - `cd <dir>` (alone): updates the running resolve directory for every
//     LATER segment -- the same running-prefix tracking
//     git_recoverability.ts's resolveRecoverabilityTargets already uses.
//   - `git -C <dir> ...`: `<dir>` is THIS segment's own target directory
//     only -- a `-C` flag does not persist to later segments the way `cd`
//     does.
//   - `rm <targets...>`: every non-flag argument.
//   - `mv <src...> <dest>` / `cp <src...> <dest>`: the LAST non-flag
//     argument only (the destination) -- a source is read, never written.
//   - a redirection to a file, `>`/`>>`/`>|`, with or without a descriptor
//     number (`1>`, `2>>`), and `&>`/`&>>`: the word after it, spaced or
//     not, also when glued to the word before it (`echo hi>x`), read by
//     redirections.ts from the segment's text (0.6.21 T2). A descriptor
//     duplication (`2>&1`, `>&2`) never names a path, and quoted text is data.
//
// A shell variable or a glob (the same check git_recoverability.ts's own
// isResolvableTarget uses) is never guessed at -- it changes nothing, same
// as it does there. Pure: no I/O. Returns absolute paths, deduplicated, in
// the order first seen -- resolving each one's own repository and branch is
// the caller's job (adapters/claude/gate-bash.ts), which needs the
// filesystem.
import { isAbsolute, resolve } from "node:path";
import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";
import { outputRedirectionTargets } from "./redirections.ts";

function isResolvableTarget(raw: string): boolean {
  return raw.length > 0 && !/[$*?[]/.test(raw);
}

function resolveAgainst(dir: string, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(dir, raw);
}

/** `cd <dir>` alone -- never `cd -` (no directory named) or a flag. */
function parseCdSegment(tokens: readonly string[]): string | null {
  if (tokens.length !== 2 || tokens[0] !== "cd") return null;
  const dir = tokens[1] ?? "";
  return dir.length > 0 && !dir.startsWith("-") ? dir : null;
}

/** `git -C <dir>`'s own directory, when this segment's leading tokens are exactly that shape. */
function gitDashCDir(tokens: readonly string[]): string | null {
  if (tokens[0] !== "git" || tokens[1] !== "-C") return null;
  const dir = tokens[2] ?? "";
  return dir.length > 0 ? dir : null;
}

function pushResolvable(raw: string, dir: string, out: string[]): void {
  if (isResolvableTarget(raw)) out.push(resolveAgainst(dir, raw));
}

export function resolveCommandTargetDirs(command: string, cwd: string): readonly string[] {
  const targets: string[] = [];
  let resolveDir = cwd;

  for (const segment of splitOnCommandSeparators(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const cdDir = parseCdSegment(tokens);
    if (cdDir !== null) {
      resolveDir = resolveAgainst(resolveDir, cdDir);
      continue;
    }

    const dashCDir = gitDashCDir(tokens);
    const segmentDir = dashCDir !== null ? resolveAgainst(resolveDir, dashCDir) : resolveDir;

    const head = tokens[0];
    const plain = tokens.filter((token) => !token.startsWith("-"));
    if (head === "rm") {
      for (const raw of plain.slice(1)) pushResolvable(raw, segmentDir, targets);
    } else if (head === "mv" || head === "cp") {
      const dest = plain.at(-1);
      if (dest !== undefined && plain.length >= 3) pushResolvable(dest, segmentDir, targets);
    }

    for (const target of outputRedirectionTargets(segment)) pushResolvable(target, segmentDir, targets);
  }

  return [...new Set(targets)];
}
