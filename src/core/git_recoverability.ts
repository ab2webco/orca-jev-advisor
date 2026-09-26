// Resolves the targets of the five command shapes that can throw away
// uncommitted work -- `rm`, `git checkout -- <path>`, `git restore <path>`,
// `git clean` and `git reset --hard` -- against the repository's real git
// status, so the advice mechanism (the advise-model release) can name
// CONCRETELY which files hold unrecoverable work versus which are build/temp
// output safe to delete.
//
// Ported from the validated advice-experiment prototype
// (jobs/74914c09/tmp/advice-exp/proto-hook.mjs, report.md: 30 real
// `claude -p` sessions, the model obeyed every advice and never routed
// around one) -- same classify()/resolveTargets() shape, same
// BUILD_TEMP_NAMES/SECRET_PATTERN, rewritten as a pure TypeScript module that
// takes ALREADY-FETCHED git status (never runs git itself: that I/O belongs
// to the caller, adapters/claude/gate-bash.ts, exactly the way
// push_own_branch.ts's own readFile injection keeps its classifiers pure and
// unit-testable with no filesystem).
//
// Deliberately conservative, same discipline as push_own_branch.ts: a target
// this module cannot positively resolve (it sits behind a shell variable
// like `$TMP`, or a glob like `*.log`) is reported as UNRESOLVED, never
// guessed at either "safe" or "protected" -- the advice text says so plainly
// rather than pretending to know.
//
// Pure: no I/O. tokenize/splitOnCommandSeparators are reused from
// git_discard.ts rather than a second, drifting shell-word reader.

import { isAbsolute, relative, resolve } from "node:path";

import { splitOnCommandSeparators, tokenize } from "./git_discard.ts";

export interface GitStatusSets {
  /** Tracked files with uncommitted changes (git status's ` M`/`M `/etc. codes). */
  readonly modified: ReadonlySet<string>;
  readonly untracked: ReadonlySet<string>;
  readonly ignored: ReadonlySet<string>;
  readonly tracked: ReadonlySet<string>;
}

export const EMPTY_GIT_STATUS: GitStatusSets = {
  modified: new Set(),
  untracked: new Set(),
  ignored: new Set(),
  tracked: new Set(),
};

/** Top-level directory names this module trusts as build/temp output, safe to recreate. */
const BUILD_TEMP_NAMES: ReadonlySet<string> = new Set(["dist", "node_modules", "tmp", "coverage", ".cache", "build", "out"]);

/** Secret-shaped filenames: `.env`, `.env.*`, a `.pem`/`.key`, an SSH private key, a credentials file. */
const SECRET_PATTERN = /(^|\/)(\.env(\..+)?|[^/]+\.(pem|key)|id_rsa|id_ed25519|credentials\.json)$/i;

export type RecoverabilityWhy = "uncommitted-changes" | "untracked" | "secret" | "build-or-temp" | "committed-clean" | "unknown-or-nonexistent";

const PROTECTED_WHYS: ReadonlySet<RecoverabilityWhy> = new Set(["uncommitted-changes", "untracked", "secret"]);

export interface ClassifiedPath {
  readonly path: string;
  readonly why: RecoverabilityWhy;
  /** The matched top-level build/temp directory name, present only when `why === "build-or-temp"`. */
  readonly matchedBuildTempName?: string;
}

function matchedBuildTempName(relPath: string): string | null {
  for (const part of relPath.split("/")) {
    if (BUILD_TEMP_NAMES.has(part)) return part;
  }
  return null;
}

/** Classifies one repo-root-relative path against already-fetched git status. Never touches disk or git. */
export function classifyRecoverabilityPath(relPath: string, status: GitStatusSets): ClassifiedPath {
  if (SECRET_PATTERN.test(relPath)) return { path: relPath, why: "secret" };
  const matched = matchedBuildTempName(relPath);
  if (matched !== null) return { path: relPath, why: "build-or-temp", matchedBuildTempName: matched };
  if (status.tracked.has(relPath) && !status.modified.has(relPath)) return { path: relPath, why: "committed-clean" };
  if (status.modified.has(relPath)) return { path: relPath, why: "uncommitted-changes" };
  if (status.untracked.has(relPath)) return { path: relPath, why: "untracked" };
  return { path: relPath, why: "unknown-or-nonexistent" };
}

export function isProtectedRecoverabilityWhy(why: RecoverabilityWhy): boolean {
  return PROTECTED_WHYS.has(why);
}

/** A raw shell-word target that CANNOT be resolved with confidence: it carries an unexpanded shell variable or a glob the shell may expand to anything at runtime. Never guessed at either safe or protected. */
function isResolvableTarget(raw: string): boolean {
  return raw.length > 0 && !/[$*?[]/.test(raw);
}

export type RecoverabilityShape = "rm" | "git checkout" | "git restore" | "git reset --hard" | "git clean";

export interface RecoverabilitySegmentResult {
  readonly shape: RecoverabilityShape;
  /** The segment's own resolved, repo-root-relative targets, classified. */
  readonly classified: readonly ClassifiedPath[];
  /** Raw target text this module could not resolve (a shell variable, a glob) -- named, never guessed. */
  readonly unresolvedTargets: readonly string[];
}

/** repo-root-relative path for a target given as written (already resolved against `resolveDir`), or null when it resolves outside the repository entirely (never happens for a relative target, kept only for symmetry with an absolute one naming another disk). */
function toRepoRelative(target: string, repoRoot: string, resolveDir: string): string {
  const absolute = isAbsolute(target) ? target : resolve(resolveDir, target);
  return relative(repoRoot, absolute);
}

function resolveRmSegment(tokens: readonly string[], status: GitStatusSets, repoRoot: string, resolveDir: string): RecoverabilitySegmentResult {
  const rawTargets = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const unresolvedTargets: string[] = [];
  const classified: ClassifiedPath[] = [];
  for (const raw of rawTargets) {
    if (!isResolvableTarget(raw)) {
      unresolvedTargets.push(raw);
      continue;
    }
    classified.push(classifyRecoverabilityPath(toRepoRelative(raw, repoRoot, resolveDir), status));
  }
  return { shape: "rm", classified, unresolvedTargets };
}

/** `git checkout`'s own path form -- see git_discard.ts's checkoutDiscards for the exact discard-shape rules this reuses conceptually; here we only need WHICH paths, not whether it discards (the caller already knows that). */
function checkoutPathArgs(tokens: readonly string[]): readonly string[] | null {
  const rest = tokens.slice(2);
  const dashIdx = rest.indexOf("--");
  const pathArgs = dashIdx >= 0 ? rest.slice(dashIdx + 1) : rest.filter((w) => !w.startsWith("-"));
  return pathArgs.length === 0 ? null : pathArgs;
}

function restorePathArgs(tokens: readonly string[]): readonly string[] | null {
  const rest = tokens.slice(2);
  const pathArgs = rest.filter((w) => !w.startsWith("-"));
  return pathArgs.length === 0 ? null : pathArgs;
}

function resolvePathShapeSegment(
  shape: "git checkout" | "git restore",
  pathArgs: readonly string[],
  status: GitStatusSets,
  repoRoot: string,
  resolveDir: string,
): RecoverabilitySegmentResult {
  // `git checkout .` / `git restore .` -- "everything modified", named
  // explicitly rather than resolved as a literal path.
  if (pathArgs.length === 1 && pathArgs[0] === ".") {
    const classified = [...status.modified].map((path) => classifyRecoverabilityPath(path, status));
    return { shape, classified, unresolvedTargets: [] };
  }
  const unresolvedTargets: string[] = [];
  const classified: ClassifiedPath[] = [];
  for (const raw of pathArgs) {
    if (!isResolvableTarget(raw)) {
      unresolvedTargets.push(raw);
      continue;
    }
    classified.push(classifyRecoverabilityPath(toRepoRelative(raw, repoRoot, resolveDir), status));
  }
  return { shape, classified, unresolvedTargets };
}

function resolveResetHardSegment(status: GitStatusSets): RecoverabilitySegmentResult {
  return {
    shape: "git reset --hard",
    classified: [...status.modified].map((path) => classifyRecoverabilityPath(path, status)),
    unresolvedTargets: [],
  };
}

/** `-x`/`-X` folded into a short cluster (or `--force` alone, which is required for clean to run at all but does not by itself include ignored files). */
function cleanIncludesIgnored(flags: readonly string[]): boolean {
  return flags.some((f) => /^-[a-zA-Z]*[xX][a-zA-Z]*$/.test(f) || f === "--force" && flags.some((g) => /x|X/.test(g)));
}

function resolveCleanSegment(tokens: readonly string[], status: GitStatusSets, repoRoot: string, resolveDir: string): RecoverabilitySegmentResult {
  const rest = tokens.slice(2);
  const flags = rest.filter((w) => w.startsWith("-"));
  const pathArgs = rest.filter((w) => !w.startsWith("-"));
  const includeIgnored = cleanIncludesIgnored(flags);
  let candidates = [...status.untracked];
  if (includeIgnored) candidates = candidates.concat([...status.ignored]);
  if (pathArgs.length > 0) {
    const unresolvedTargets: string[] = [];
    const prefixes: string[] = [];
    for (const raw of pathArgs) {
      if (!isResolvableTarget(raw)) {
        unresolvedTargets.push(raw);
        continue;
      }
      prefixes.push(toRepoRelative(raw, repoRoot, resolveDir));
    }
    candidates = candidates.filter((c) => prefixes.some((pre) => c === pre || c.startsWith(`${pre}/`)));
    return { shape: "git clean", classified: candidates.map((path) => classifyRecoverabilityPath(path, status)), unresolvedTargets };
  }
  return { shape: "git clean", classified: candidates.map((path) => classifyRecoverabilityPath(path, status)), unresolvedTargets: [] };
}

/** One segment's own recoverability resolution, or null when the segment is not one of the five recognised shapes at all. `resolveDir` is the directory a relative target resolves against -- `cwd` itself, or a leading `cd <dir> &&` prefix's own target (see resolveRecoverabilityTargets below). */
function resolveSegment(segmentText: string, status: GitStatusSets, repoRoot: string, resolveDir: string): RecoverabilitySegmentResult | null {
  const tokens = tokenize(segmentText);
  const head = tokens[0];
  if (head === "rm") return resolveRmSegment(tokens, status, repoRoot, resolveDir);
  if (head === "git" && tokens[1] === "checkout") {
    const pathArgs = checkoutPathArgs(tokens);
    return pathArgs === null ? null : resolvePathShapeSegment("git checkout", pathArgs, status, repoRoot, resolveDir);
  }
  if (head === "git" && tokens[1] === "restore") {
    const pathArgs = restorePathArgs(tokens);
    return pathArgs === null ? null : resolvePathShapeSegment("git restore", pathArgs, status, repoRoot, resolveDir);
  }
  if (head === "git" && tokens[1] === "reset" && tokens.includes("--hard")) return resolveResetHardSegment(status);
  if (head === "git" && tokens[1] === "clean") return resolveCleanSegment(tokens, status, repoRoot, resolveDir);
  return null;
}

function parseCdSegment(segmentText: string): string | null {
  const tokens = tokenize(segmentText);
  if (tokens.length !== 2 || tokens[0] !== "cd") return null;
  const dir = tokens[1] ?? "";
  return dir.length > 0 && !dir.startsWith("-") ? dir : null;
}

/**
 * Resolves every recognised (rm / git checkout / git restore / git clean /
 * git reset --hard) segment of `command` against already-fetched git
 * status. Tracks a leading `cd <dir> &&`/`;` prefix so a later segment's
 * relative targets resolve against the directory the shell would actually
 * be in when it runs them, same discipline as push_own_branch.ts's own
 * `resolveCdTargetDir`.
 */
export function resolveRecoverabilityTargets(command: string, cwd: string, repoRoot: string, status: GitStatusSets): readonly RecoverabilitySegmentResult[] {
  const results: RecoverabilitySegmentResult[] = [];
  let resolveDir = cwd;
  for (const segment of splitOnCommandSeparators(command)) {
    const cdDir = parseCdSegment(segment);
    if (cdDir !== null) {
      resolveDir = isAbsolute(cdDir) ? cdDir : resolve(resolveDir, cdDir);
      continue;
    }
    const resolved = resolveSegment(segment, status, repoRoot, resolveDir);
    if (resolved !== null) results.push(resolved);
  }
  return results;
}
