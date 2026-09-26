// JEVADV-39 (odd/tasks/release-0.5.1.md T-lane-a): whether a `git push`
// command's own remote resolves to a LOCAL filesystem path or a `file://`
// URL, so gate-bash.ts's push-protected rule (main/master/production) can
// tell "a brand-new personal repo whose remote is its own local bare
// directory" apart from an actual shared branch on GitHub/GitLab/a real SSH
// host. A push naming main/master/production is only a shared-branch push
// once its remote actually points somewhere shared -- a fresh `git init`
// with `git remote add origin ../some.bare.git` (or a plain local path, no
// remote configured elsewhere) is not that, and this file's whole job is
// recognizing it without ever touching the network.
//
// Deliberately narrow: this reads exactly what the task in scope asks for
// (`[remote "<name>"] url = …` in a `.git/config` this process can already
// read from disk, no `git` subprocess), and fails CLOSED -- an unresolvable
// remote, an unreadable config, or anything this parser does not recognize
// answers `false` ("not a local remote"), which leaves the caller's own
// 'deny' standing exactly as it does today. This never widens what is
// refused, only narrows the one case the task names.

import { readFileSync } from "node:fs";

import { resolveGitDirForConfig } from "./linked_worktree.ts";

/**
 * The exact branch names gate-bash.ts's pushProtectedRule treats as
 * shared/protected -- the ONE list, so push_own_branch.ts (the own-branch
 * push allow, odd/tasks/release-0.5.1-push-own-branch.md) checks a resolved
 * or explicit branch name against the same notion of "shared" rather than a
 * second, independently maintained one. Lowercase and exact, matching
 * pushProtectedRule's own case-sensitive regex: "Main" or "MAIN" is not
 * caught by either.
 */
export const PROTECTED_BRANCH_NAMES: readonly string[] = ["main", "master", "production"];

/**
 * Extracts the push command's own remote argument: the first token after
 * `git push` that does not start with `-`, taken from the same segment only
 * (stopping at the next `;`, `&&`, `||`, `|` or newline, so a compound
 * command's later stage is never mistaken for this push's own argument).
 * `null` when there is no `git push` invocation at all in `command`; an
 * empty string when `git push` is followed by nothing but flags (or
 * nothing at all) -- git itself would resolve that to the current branch's
 * configured remote, which this module has no way to know, so the caller
 * treats it the same as any other unresolvable remote (fails closed).
 *
 * Deliberately simple, per the task's own bounded scope: "the remote name
 * is the first non-option arg after push, default origin". This does not
 * distinguish a flag that takes a following value (`git push -o <opt>`)
 * from one that does not -- an option's OWN value is comparatively rare as
 * the very first token right after `push`, and misreading one as the
 * remote only ever means falling back to "unresolvable" (fails closed to
 * `false`), never the reverse.
 */
export function extractPushRemoteArg(command: string): string | null {
  const pushMatch = /git\s+push\b/.exec(command);
  if (pushMatch === null) return null;
  const rest = command.slice(pushMatch.index + pushMatch[0].length);
  const separatorMatch = /[;&|\n]/.exec(rest);
  const segment = separatorMatch === null ? rest : rest.slice(0, separatorMatch.index);
  const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (!token.startsWith("-")) return token;
  }
  return "";
}

/** A bare git remote NAME: letters, digits, `.`, `_` and `-` only -- no `/` or `:`, so it can never be mistaken for a path or a URL (see isLocalRemoteReference below, which handles everything else). Exported for push_own_branch.ts: a remote positional that is not a bare name (a URL or a path given directly) does not qualify for the own-branch push allow -- conservative on purpose, never a reason to widen what qualifies. */
export function isBareRemoteName(ref: string): boolean {
  return ref.length > 0 && /^[A-Za-z0-9._-]+$/.test(ref);
}

/**
 * Whether `ref` -- already known NOT to be a bare remote name -- is itself a
 * local filesystem reference: an explicit `file://` URL, or anything else
 * with no recognizable remote-host shape at all (a `/absolute/path`, a
 * `./relative/path`, a bare `path/to/repo.git`, `~/path`). Any OTHER URL
 * scheme (`https://`, `ssh://`, `git://`, …) and git's own SCP-like
 * `[user@]host:path` shorthand (recognized, per git's own rule, only when a
 * `:` appears before the first `/`, e.g. `git@github.com:org/repo.git`) are
 * both "somewhere shared" and answer `false` here.
 */
export function isLocalRemoteReference(ref: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref)) return ref.toLowerCase().startsWith("file://");
  const colonIndex = ref.indexOf(":");
  if (colonIndex !== -1) {
    const slashIndex = ref.indexOf("/");
    const scpLike = slashIndex === -1 || colonIndex < slashIndex;
    // A single-letter scheme immediately followed by a path separator is a
    // Windows drive letter (`C:\repo`, `C:/repo`), a local path, not git's
    // SCP-like SSH shorthand.
    const isWindowsDrive = colonIndex === 1 && /^[A-Za-z]$/.test(ref.slice(0, 1)) && /^[\\/]/.test(ref.slice(colonIndex + 1));
    if (scpLike && !isWindowsDrive) return false;
  }
  return true;
}

/**
 * `[remote "<remoteName>"]`'s own body text out of already-read
 * `.git/config`, from its header line to the next `[` header or the end of
 * the file. `null` when the section itself does not exist. Shared by
 * parseGitConfigRemoteUrl and parseGitConfigRemotePushUrl below, so both
 * read exactly the same section boundary.
 */
function remoteConfigSection(configText: string, remoteName: string): string | null {
  const escapedName = remoteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\[remote\\s+"${escapedName}"\\]\\s*$`, "m");
  const headerMatch = headerPattern.exec(configText);
  if (headerMatch === null) return null;
  const afterHeader = configText.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderMatch = /^\[/m.exec(afterHeader);
  return nextHeaderMatch === null ? afterHeader : afterHeader.slice(0, nextHeaderMatch.index);
}

function configField(body: string, key: string): string | null {
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.+?)[ \\t]*$`, "m");
  const match = pattern.exec(body);
  return match === null ? null : match[1];
}

/**
 * Parses `[remote "<remoteName>"] url = …` out of already-read `.git/config`
 * text. Deliberately minimal -- exactly the shape `git remote add` itself
 * writes (a `[remote "name"]` header line, then indented `key = value`
 * lines until the next `[` header or the end of the file) -- not a general
 * git-config parser. `null` when the section or its `url` is missing.
 *
 * This is the FETCH url, which `git push` itself does not necessarily use
 * -- see parseGitConfigRemotePushUrl below, which resolvePushRemoteIsLocal
 * actually calls.
 */
export function parseGitConfigRemoteUrl(configText: string, remoteName: string): string | null {
  const body = remoteConfigSection(configText, remoteName);
  return body === null ? null : configField(body, "url");
}

/**
 * The URL `git push` actually sends `remoteName` to: its `pushurl` when the
 * section has one (`git remote set-url --push`, a real "fetch from one
 * place, push to another" pattern -- e.g. a local mirror clone whose real
 * pushes go to GitHub), falling back to `url` otherwise, exactly the way
 * git itself resolves it. Reading `url` alone here would let a remote like
 * that resolve to the wrong (local) answer even though the push itself
 * goes to `pushurl` -- a deny-tier rule turning MORE permissive on a case
 * the release's own constraints forbid.
 */
export function parseGitConfigRemotePushUrl(configText: string, remoteName: string): string | null {
  const body = remoteConfigSection(configText, remoteName);
  if (body === null) return null;
  return configField(body, "pushurl") ?? configField(body, "url");
}

export interface ResolvePushRemoteInput {
  readonly command: string;
  readonly cwd: string;
  /** Injectable for tests -- defaults to a real, synchronous UTF-8 file read. */
  readonly readFile?: (path: string) => string;
}

/**
 * Whether `command`'s own `git push` targets a local filesystem remote (a
 * local path or a `file://` URL). Fails CLOSED to `false` on absolutely
 * anything this cannot positively resolve without the network -- no `git
 * push` at all, no readable remote argument, a bare remote name this
 * repository's own `.git/config` does not define, or a config this process
 * cannot read -- so the caller's own 'deny' is left standing exactly as
 * before whenever this function is not certain the remote is local.
 */
export function resolvePushRemoteIsLocal(input: ResolvePushRemoteInput): boolean {
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const remoteArg = extractPushRemoteArg(input.command);
    if (remoteArg === null) return false;
    const ref = remoteArg.length > 0 ? remoteArg : "origin";
    if (!isBareRemoteName(ref)) return isLocalRemoteReference(ref);

    const gitDir = resolveGitDirForConfig(input.cwd);
    if (gitDir === null) return false;
    const configText = readFile(`${gitDir}/config`);
    const url = parseGitConfigRemotePushUrl(configText, ref);
    if (url === null) return false;
    return isLocalRemoteReference(url);
  } catch {
    return false;
  }
}
