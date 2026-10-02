// 0.6.24 T1 (JEVADV-100): whether a git discard would lose anything NOW.
//
// git_discard.ts recognises the commands that overwrite the working tree
// (`reset --hard`, `clean -f`, `checkout -- <paths>`, `restore`, ...) from
// their spelling alone, and the gate used to refuse every one of them. On a
// clean tree nothing is lost, and the refusal only got in the way (the owner
// hit it with `git reset --hard origin/main` on a clean worktree). This
// module reads the match the way git would act on it, asks the repository
// the command acts on one bounded question per discard, and says whether
// something that exists now would be thrown away:
//
//   - reset --hard                 staged or unstaged changes to tracked files
//                                  (`git status --porcelain`; untracked files
//                                  survive a hard reset)
//   - clean -f[d][x]               untracked files: the same arguments with
//                                  `-n` instead of `-f`, a dry run; any
//                                  "Would remove" line is a loss
//   - checkout -- <paths>,         worktree changes under those paths; with a
//     restore <paths>              tree-ish (`checkout main -- <paths>`) the
//                                  index is overwritten too
//   - checkout ., checkout -f,     the same over the whole tree (`-f` also
//     restore .                    rewrites the index)
//   - restore --staged --worktree  index or worktree changes
//
// Anything it cannot read with certainty is `unknown` / fail-closed, and the
// caller keeps today's refusal: a discard inside ssh, eval, `bash -c`, `su
// -c`, watch, `script -c`, xargs or `$(...)`; `--git-dir`, `--work-tree`,
// `HOME=` or `GIT_*=` in the command; a directory that cannot be resolved; a
// path list read from a file; git failing or timing out (the injected reader
// returns null). A clean reading is also refused when an earlier command in
// the same line might have written to the tree (`git stash pop && git reset
// --hard`): the tree is clean now but not when the discard runs.
//
// What tooling writes back is not a loss either (regenerated_files.ts): the
// files a dev server or compiler rewrites, the build and temp folders a
// `clean` would remove. A
// secret never counts, and a directory the dry run reports as one line is
// searched for secret-shaped files before it is excused. A refusal names only
// the real work, and carries the paths so the caller can offer a `git stash
// push` of exactly them (stashCommandFor).
//
// A clean answer is never an allow: the caller falls through to the ordinary
// Jev path. Pure: the only I/O is the injected `GitReader`.

import { commandWords, gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { discardsUncommittedWork, someSegmentMatches, tokenize, type SegmentMatchSeverity } from "./git_discard.ts";
import { isRegenerablePath } from "./regenerated_files.ts";

/** Runs git with `args` in `dir` and returns its stdout; null on any failure or timeout. */
export type GitReader = (args: readonly string[], dir: string) => string | null;

export type DiscardPlan =
  | { readonly kind: "status"; readonly paths: readonly string[]; readonly columns: "worktree" | "index-or-worktree" }
  | { readonly kind: "clean"; readonly args: readonly string[]; readonly forceCount: number }
  | { readonly kind: "nothing" };

export type DiscardLoss =
  | {
      readonly lost: true;
      readonly count: number;
      readonly example: string;
      readonly kind: "modified" | "untracked";
      /** Every path that would be lost, repository-root-relative. Regenerated files (regenerated_files.ts) are not among them. */
      readonly paths: readonly string[];
      /** A `clean` that removes ignored files too (`-x`/`-X`): a stash of these paths needs `-a`, not `-u`. */
      readonly ignoredToo: boolean;
    }
  | { readonly lost: false };

export interface DiscardLossDetail {
  readonly count: number;
  readonly example: string;
  readonly kind: "modified" | "untracked";
  readonly paths: readonly string[];
  readonly ignoredToo: boolean;
  /** The directory the command ran in, as a path inside the repository (`apps/web/`, empty at the root). */
  readonly prefix: string;
  /** The command segment that would discard it. */
  readonly segment: string;
}

export interface DiscardAssessment {
  readonly severity: SegmentMatchSeverity;
  /** Set when the refusal is because something would be lost; null for a fail-closed refusal or no refusal. */
  readonly loss: DiscardLossDetail | null;
}

const WHOLE_TREE_PATHSPECS = new Set([".", "./", ":/", "*"]);
const BRANCH_CREATING_OPTIONS = new Set(["-b", "-B", "--orphan"]);

/** Environment or options that move the repository or the configuration git reads: the check could look at the wrong tree. */
const REDIRECTS_GIT = /(?:^|[\s;&|(`])(?:HOME|XDG_CONFIG_HOME|GIT_[A-Z0-9_]+)=|--git-dir|--work-tree|core\.worktree/;

function isShortCluster(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token);
}

/** A long option written in full or as a unique prefix git accepts (`--for`, `--forc`). */
function isLongOption(token: string, name: string): boolean {
  return token.startsWith("--") && token.length >= 3 && name.startsWith(token);
}

interface CleanOptions {
  readonly kept: readonly string[];
  readonly forceCount: number;
  readonly dryRun: boolean;
  readonly interactive: boolean;
}

/**
 * `git clean`'s arguments without `-f`/`--force`, `-n`/`--dry-run` and
 * `-q`/`--quiet` (a quiet dry run prints nothing), counting the forces. The
 * value of `-e`/`--exclude` and everything after `--` is kept as written.
 */
function readCleanOptions(args: readonly string[]): CleanOptions {
  const kept: string[] = [];
  let forceCount = 0;
  let dryRun = false;
  let interactive = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    if (word === "--") {
      kept.push(...args.slice(at));
      break;
    }
    if (word === "--exclude" || word === "-e") {
      kept.push(word, args[at + 1] ?? "");
      at += 1;
    } else if (isLongOption(word, "--force")) forceCount += 1;
    else if (isLongOption(word, "--dry-run")) dryRun = true;
    else if (isLongOption(word, "--quiet")) continue;
    else if (isLongOption(word, "--interactive")) interactive = true;
    else if (isShortCluster(word)) {
      let letters = "";
      let valueFollows = false;
      for (let index = 1; index < word.length; index += 1) {
        const letter = word[index] ?? "";
        if (letter === "e") {
          letters += word.slice(index);
          valueFollows = index === word.length - 1;
          break;
        }
        if (letter === "f") forceCount += 1;
        else if (letter === "n") dryRun = true;
        else if (letter === "i") interactive = true;
        else if (letter !== "q") letters += letter;
      }
      if (letters.length > 0) kept.push(`-${letters}`);
      if (valueFollows) {
        kept.push(args[at + 1] ?? "");
        at += 1;
      }
    } else kept.push(word);
  }
  return { kept, forceCount, dryRun, interactive };
}

function cleanPlan(args: readonly string[]): DiscardPlan | "unknown" | null {
  const options = readCleanOptions(args);
  if (options.forceCount === 0) return null;
  if (options.interactive) return "unknown";
  // The user's own `-n` makes the real command a dry run too: it deletes nothing.
  if (options.dryRun) return { kind: "nothing" };
  const dry = ["clean", "-n", ...options.kept];
  // The dry run must be unable to delete: no force survives, and `-n` is there.
  const check = readCleanOptions(dry.slice(1));
  if (check.forceCount !== 0 || !check.dryRun) return "unknown";
  return { kind: "clean", args: dry, forceCount: options.forceCount };
}

function checkoutPlan(args: readonly string[]): DiscardPlan | "unknown" | null {
  if (args.some((arg) => arg.startsWith("--pathspec-from-file"))) return "unknown";
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  const after = separator === -1 ? [] : args.slice(separator + 1);
  const positionals = before.filter((arg) => !arg.startsWith("-"));
  const creates = before.some((arg) => BRANCH_CREATING_OPTIONS.has(arg));
  const forced = before.some((arg) => arg === "--force" || (isShortCluster(arg) && arg.includes("f")));
  if (after.length > 0) {
    if (creates) return "unknown";
    // `checkout <tree-ish> -- <paths>` overwrites the index as well as the worktree.
    return { kind: "status", paths: after, columns: positionals.length > 0 ? "index-or-worktree" : "worktree" };
  }
  if (forced) return { kind: "status", paths: [], columns: "index-or-worktree" };
  // A bare trailing `--` and a lone branch name are branch switches, which are not discards.
  if (separator !== -1) return null;
  if (creates) return positionals.some((arg) => WHOLE_TREE_PATHSPECS.has(arg)) ? "unknown" : null;
  if (positionals.length >= 2) return { kind: "status", paths: positionals.slice(1), columns: "index-or-worktree" };
  const only = positionals[0];
  if (positionals.length === 1 && only !== undefined && WHOLE_TREE_PATHSPECS.has(only)) return { kind: "status", paths: [only], columns: "worktree" };
  return null;
}

const RESTORE_OPTIONS_WITH_VALUE = new Set(["-s", "--source", "--conflict"]);

function restorePlan(args: readonly string[]): DiscardPlan | "unknown" | null {
  if (args.some((arg) => arg.startsWith("--pathspec-from-file"))) return "unknown";
  let staged = false;
  let worktree = false;
  const paths: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    if (word === "--") {
      paths.push(...args.slice(at + 1));
      break;
    }
    if (RESTORE_OPTIONS_WITH_VALUE.has(word)) at += 1;
    else if (word === "--staged") staged = true;
    else if (word === "--worktree") worktree = true;
    else if (isShortCluster(word)) {
      if (word.includes("S")) staged = true;
      if (word.includes("W")) worktree = true;
    } else if (!word.startsWith("-")) paths.push(word);
  }
  // `restore --staged` alone rewrites the index only: no uncommitted work in the tree.
  if (staged && !worktree) return null;
  return { kind: "status", paths, columns: staged && worktree ? "index-or-worktree" : "worktree" };
}

/**
 * What a git discard puts at risk: the git call that shows it, or null when
 * `subcommand args` is not a discard, or `"unknown"` when it is one this
 * module cannot read with certainty.
 */
export function discardPlan(subcommand: string, args: readonly string[]): DiscardPlan | "unknown" | null {
  if (subcommand === "reset") return args.includes("--hard") ? { kind: "status", paths: [], columns: "index-or-worktree" } : null;
  if (subcommand === "clean") return cleanPlan(args);
  if (subcommand === "checkout") return checkoutPlan(args);
  if (subcommand === "restore") return restorePlan(args);
  return null;
}

/** The git call that answers a plan. */
function gitArgsFor(plan: Exclude<DiscardPlan, { kind: "nothing" }>): readonly string[] {
  if (plan.kind === "clean") return plan.args;
  return ["--no-optional-locks", "status", "--porcelain", "-uno", ...(plan.paths.length > 0 ? ["--", ...plan.paths] : [])];
}

function unquote(path: string): string {
  return path.replace(/^"|"$/g, "");
}

/** A bound on the paths kept for the person and the model to read: far more than a stash command would list. */
const MAX_LOST_PATHS = 200;

/** Whether a `clean`'s arguments also remove ignored files: `-x` and `-X`, alone or inside a cluster. */
function cleanReachesIgnored(args: readonly string[]): boolean {
  return args.some((word) => isShortCluster(word) && /[xX]/.test(word));
}

/**
 * Reads the output of a plan's git call. `prefix` is the working directory's
 * path inside the repository (`rev-parse --show-prefix`), so a dry run's
 * paths are relative to the repository root like a status line's are.
 * What tooling is known to rewrite (regenerated_files.ts) is not a loss,
 * because the tool writes it back. What is left is real work.
 */
export function judgeDiscardOutput(plan: Exclude<DiscardPlan, { kind: "nothing" }>, output: string, prefix: string): DiscardLoss {
  const lines = output.split("\n").filter((line) => line.length > 0);
  const origin = plan.kind === "clean" ? "untracked" : "tracked";
  let candidates: string[];
  if (plan.kind === "clean") {
    candidates = lines
      .map((line) => (line.startsWith("Would remove ") ? line.slice("Would remove ".length) : plan.forceCount >= 2 && line.startsWith("Would skip repository ") ? line.slice("Would skip repository ".length) : null))
      .filter((path): path is string => path !== null)
      .map((path) => `${prefix}${unquote(path)}`);
  } else {
    candidates = lines
      .filter((line) => {
        const code = line.slice(0, 2);
        if (code === "??" || code === "!!") return false;
        return plan.columns === "worktree" ? code[1] !== " " : code !== "  ";
      })
      .map((line) => {
        const path = line.slice(3);
        return unquote(path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path);
      });
  }
  const real = candidates.filter((path) => !isRegenerablePath(path, origin));
  const first = real[0];
  if (first === undefined) return { lost: false };
  return { lost: true, count: real.length, example: first, kind: plan.kind === "clean" ? "untracked" : "modified", paths: real.slice(0, MAX_LOST_PATHS), ignoredToo: plan.kind === "clean" && cleanReachesIgnored(plan.args) };
}

/** The names a secret takes (git_recoverability.ts's SECRET_PATTERN), as pathspec globs matched case-insensitively at any depth. */
const SECRET_GLOBS: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519", "**/credentials.json"];

/**
 * A `git clean` dry run reports an untracked directory as one line
 * (`Would remove dist/`), so a secret inside a directory that is excused as
 * build output would be removed unseen. The directories the dry run excused,
 * root-relative with their trailing slash.
 */
function excusedDirectories(output: string, prefix: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("Would remove "))
    .map((line) => `${prefix}${unquote(line.slice("Would remove ".length))}`)
    .filter((path) => path.endsWith("/") && isRegenerablePath(path, "untracked"));
}

/** A character git would read as part of a glob inside a pathspec. */
const PATHSPEC_GLOB_CHARS = /[*?[\\]/;

/** More paths than this are not worth listing in a command: the suggestion is the whole tree instead. */
const STASH_PATH_CAP = 20;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * The reversible way past a refused discard: a `git stash push` of exactly
 * what would be lost, which the model runs as a command of its own and then
 * retries. `-u` brings untracked files and `-a` ignored ones; `tag` makes the
 * entry findable on a stash stack shared with other worktrees. From a
 * subdirectory the paths carry the `:/` top-of-repository magic, because git
 * reads a stash's pathspecs relative to the directory it runs in. With more
 * paths than fit in a command it stashes the whole tree, except when that
 * would pull every ignored file along (null: the caller says to commit or
 * stash by hand).
 */
export function stashCommandFor(loss: DiscardLossDetail, tag: string): string | null {
  const flag = loss.kind === "untracked" ? (loss.ignoredToo ? " -a" : " -u") : "";
  const head = `git stash push${flag} -m ${shellQuote(tag)}`;
  if (loss.paths.length > STASH_PATH_CAP) return loss.ignoredToo ? null : head;
  return `${head} -- ${loss.paths.map((path) => shellQuote(loss.prefix === "" ? path : `:/${path}`)).join(" ")}`;
}

/** Git reads that cannot write to the tree: what may run before a discard without making a clean reading stale. */
const READ_ONLY_GIT = new Set(["fetch", "status", "log", "diff", "show", "rev-parse", "rev-list", "remote", "branch", "ls-files", "ls-remote", "describe", "merge-base", "cat-file", "blame", "shortlog", "reflog", "switch", "checkout"]);
const READ_ONLY_PROGRAMS = new Set(["echo", "printf", "pwd", "ls", "cat", "true", "false", "date", "sleep", "test", "[", "which", "head", "tail", "wc", "grep", "rg"]);

function mayChangeTheTree(outer: string): boolean {
  if (outer.includes(">")) return true;
  const run = commandWords(tokenize(outer));
  const program = (run[0] ?? "").split("/").pop() ?? "";
  if (program === "git") {
    const invocation = gitInvocation(outer, null, "/");
    const subcommand = invocation?.subcommand ?? "";
    return !READ_ONLY_GIT.has(subcommand) || run.some((word) => word === "-f" || word === "--force" || word === "--discard-changes");
  }
  return !READ_ONLY_PROGRAMS.has(program);
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { ask: 1, code: 2, deny: 3 };

function stronger(a: SegmentMatchSeverity, b: SegmentMatchSeverity): SegmentMatchSeverity {
  return (SEVERITY_RANK[b ?? ""] ?? 0) > (SEVERITY_RANK[a ?? ""] ?? 0) ? b : a;
}

const FAIL_CLOSED: DiscardAssessment = { severity: "deny", loss: null };

/**
 * Judges the discard rule for `command` run from `cwd`: refuse because
 * something would be lost (`loss` set), refuse because the check cannot be
 * trusted (`loss` null, today's refusal), or no refusal (`severity` null, or
 * the mention/code severity of a match the check does not cover).
 * `rawPattern` is the rule's second, text-level pattern for commands spelled
 * through a non-shell interpreter.
 */
export function assessDiscard(command: string, cwd: string, home: string, git: GitReader, rawPattern: { test(segment: string): boolean }): DiscardAssessment {
  if (!discardsUncommittedWork(command)) return { severity: someSegmentMatches(command, rawPattern), loss: null };
  if (REDIRECTS_GIT.test(command)) return FAIL_CLOSED;
  let severity: SegmentMatchSeverity = null;
  let checked = 0;
  let treeMayHaveChanged = false;
  for (const located of locateCommandSegments(command, cwd, home)) {
    const direct = !located.substituted && !located.viaScript && !tokenize(located.outer).some((word) => (word.split("/").pop() ?? word) === "xargs");
    const invocation = direct ? gitInvocation(located.outer, located.dir, home) : null;
    const plan = invocation?.subcommand != null ? discardPlan(invocation.subcommand, invocation.args) : null;
    if (plan === null) {
      // Not a discard this module reads. If git_discard still calls it one (ssh, watch, xargs, `$(...)`), the old refusal stands.
      if (discardsUncommittedWork(located.outer)) return FAIL_CLOSED;
      severity = stronger(severity, someSegmentMatches(located.segment, rawPattern));
      if (mayChangeTheTree(located.outer)) treeMayHaveChanged = true;
      continue;
    }
    if (plan === "unknown" || invocation === null || invocation.dir === null) return FAIL_CLOSED;
    checked += 1;
    if (plan.kind === "nothing") continue;
    const output = git(gitArgsFor(plan), invocation.dir);
    if (output === null) return FAIL_CLOSED;
    // Only with something to read: a clean tree costs the one call above.
    let prefix = "";
    if (output.trim().length > 0) {
      const read = git(["rev-parse", "--show-prefix"], invocation.dir);
      // Without it the paths cannot be placed in the repository.
      if (read === null) return FAIL_CLOSED;
      prefix = read.trim();
    }
    let loss = judgeDiscardOutput(plan, output, prefix);
    if (plan.kind === "clean" && !loss.lost && /^Would remove .*\/$/m.test(output)) {
      const directories = excusedDirectories(output, prefix);
      if (directories.length > 0) {
        if (directories.some((directory) => PATHSPEC_GLOB_CHARS.test(directory))) return FAIL_CLOSED;
        const specs = directories.flatMap((directory) => SECRET_GLOBS.map((glob) => `:(top,glob,icase)${directory}${glob}`));
        const hidden = git(["ls-files", "-o", ...(cleanReachesIgnored(plan.args) ? ["-i"] : []), "--exclude-standard", "--", ...specs], invocation.dir);
        if (hidden === null) return FAIL_CLOSED;
        const secrets = hidden.split("\n").filter((line) => line.length > 0);
        const first = secrets[0];
        if (first !== undefined) loss = { lost: true, count: secrets.length, example: first, kind: "untracked", paths: secrets.slice(0, MAX_LOST_PATHS), ignoredToo: cleanReachesIgnored(plan.args) };
      }
    }
    if (loss.lost) return { severity: "deny", loss: { count: loss.count, example: loss.example, kind: loss.kind, paths: loss.paths, ignoredToo: loss.ignoredToo, prefix, segment: located.segment } };
    if (treeMayHaveChanged) return FAIL_CLOSED;
  }
  // The line was matched but no discard was read from it: the two readings disagree, so keep the refusal.
  if (checked === 0) return FAIL_CLOSED;
  return { severity, loss: null };
}
