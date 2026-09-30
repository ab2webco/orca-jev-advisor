// The shapes the gate's local deny rules recognise, spelled every way the
// shell accepts them. The 0.6.11 live QA (odd/qa/qa-0.6.11.md, F-01..F-04)
// found each rule matched one spelling of its effect: `rm -rf /` was refused
// and `rm -fr /`, `rm -r -f /`, `rm -Rf ~` were only advised. The rules read
// the command through someSegmentMatches (git_discard.ts), which keeps the
// mention-vs-command design: a phrase in a grep pattern, a quoted argument,
// an echo or a heredoc body is data. Each predicate here runs on the text
// that scan lets it read, so it inherits that design unchanged.
import { resolve } from "node:path";
import { afterHome, gitInvocation, locateCommandSegments } from "./command_locations.ts";
import { someSegmentMatches } from "./git_discard.ts";
import { PROTECTED_BRANCH_NAMES } from "./push_remote.ts";
import type { SegmentMatchSeverity } from "./git_discard.ts";

const SEVERITY_RANK: Readonly<Record<string, number>> = { ask: 1, code: 2, deny: 3 };

/** The stronger of two outcomes on the ladder null -> ask -> code -> deny. */
export function strongerSeverity(a: SegmentMatchSeverity, b: SegmentMatchSeverity): SegmentMatchSeverity {
  if (a === null) return b;
  if (b === null) return a;
  return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;
}

/** Words of a scan view; grouping and quoting punctuation never hides a program name (`(rm`, `os.system('rm`). */
function viewWords(view: string): string[] {
  return view.split(/[\s()`;'"]+/).filter((word) => word.length > 0);
}

/** A path made only of `.`, `..` and a trailing `*` components: the directory it starts from, all of it. */
function isWholeDirectory(rest: string): boolean {
  const parts = rest.split("/").filter((part) => part.length > 0);
  return parts.every((part, at) => part === "." || part === ".." || (part === "*" && at === parts.length - 1));
}

function isRootOrHome(target: string, home: string): boolean {
  const rest = afterHome(target, home);
  if (rest !== null) return isWholeDirectory(rest);
  return target.startsWith("/") && isWholeDirectory(target);
}

export interface RecursiveRmOptions {
  readonly home: string;
  /** The segment runs in `/` or the home directory, so `.` or `*` names all of it. */
  readonly runsInRootOrHome: boolean;
}

/**
 * True when `view` runs a recursive `rm` on the filesystem root or the home
 * directory, in any flag spelling: `-rf`, `-fr`, `-Rf`, `-r -f`,
 * `--recursive --force`, extra letters (`-rfv`), options after the targets,
 * a `--` end of options, and root or home spelled `/`, `//`, `/.`, `/*`,
 * `~`, `~/`, `~/*`, `$HOME`, `${HOME}` or the home directory's own path.
 * Force is not required: the rule it replaces matched `-r` alone too.
 */
export function runsRecursiveRmOfRootOrHome(view: string, options: RecursiveRmOptions): boolean {
  const words = viewWords(view);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word !== "rm" && !word.endsWith("/rm")) continue;
    let recursive = false;
    let optionsEnded = false;
    const targets: string[] = [];
    for (const arg of words.slice(i + 1)) {
      if (!optionsEnded && arg === "--") optionsEnded = true;
      else if (!optionsEnded && arg.startsWith("--")) recursive ||= arg === "--recursive";
      else if (!optionsEnded && /^-[a-zA-Z]+$/.test(arg)) recursive ||= /[rR]/.test(arg);
      else targets.push(arg);
    }
    if (!recursive) continue;
    if (targets.some((target) => isRootOrHome(target, options.home) || (options.runsInRootOrHome && isWholeDirectory(target)))) return true;
  }
  return false;
}

/**
 * The rmRf rule's outcome for a whole command run from `cwd`: each simple
 * command is read through someSegmentMatches, and the directory it runs in
 * (command_locations.ts) decides whether `.` or `*` names the root or the
 * home directory (`cd / && rm -rf *`, `pushd ~ && rm -rf .`).
 */
export function recursiveRmOfRootOrHomeOutcome(command: string, cwd: string, home: string): SegmentMatchSeverity {
  const homeDir = resolve(home);
  let severity: SegmentMatchSeverity = null;
  for (const { segment, dir } of locateCommandSegments(command, cwd, homeDir)) {
    const runsInRootOrHome = dir === "/" || dir === homeDir;
    const outcome = someSegmentMatches(segment, { test: (view) => runsRecursiveRmOfRootOrHome(view, { home: homeDir, runsInRootOrHome }) });
    if (outcome === "deny") return "deny";
    severity = strongerSeverity(severity, outcome);
  }
  return severity;
}

// git's own global options that take their value as the next word.
const GIT_GLOBAL_OPTIONS_WITH_VALUE = "-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix";
const GIT_GLOBAL_OPTIONS_BEFORE_PUSH = new RegExp(`(^|[\\s(\`'"/])git((?:\\s+(?:(?:${GIT_GLOBAL_OPTIONS_WITH_VALUE})\\s+\\S+|-\\S*))+)(?=\\s+push\\b)`, "g");

/** `git -C dir --no-pager -c k=v push ...` read as `git push ...`: global options never change what a push does. */
export function withoutGitGlobalOptionsBeforePush(view: string): string {
  return view.replace(GIT_GLOBAL_OPTIONS_BEFORE_PUSH, "$1git");
}

// `--force` (never `--force-with-lease`/`--force-if-includes`), a short
// cluster holding `f` (`-f`, `-fu`, `-uf`, `-qf`), or a `+refspec`.
const FORCE_PUSH = /git\s+push\b.*(?:(?:^|\s)(?:--force(?!-with-lease|-if-includes)\b|-[a-zA-Z0-9]*f[a-zA-Z0-9]*\b)|(?:^|\s)\+\S)/;

/** True when `view` runs a force push, in any flag spelling and through any git global option. */
export const FORCE_PUSH_SHAPE = { test: (view: string): boolean => FORCE_PUSH.test(withoutGitGlobalOptionsBeforePush(view)) };

const PUSH_PROTECTED = new RegExp(`git\\s+push\\b.*\\b(${PROTECTED_BRANCH_NAMES.join("|")})\\b`);

/** True when `view` runs a push naming a shared branch, through any git global option. */
export const PUSH_PROTECTED_SHAPE = { test: (view: string): boolean => PUSH_PROTECTED.test(withoutGitGlobalOptionsBeforePush(view)) };

/**
 * The pushProtected rule's outcome. A command-position match is set aside
 * only when the push's remote resolves to a local directory (JEVADV-39), and
 * that remote is read in the repository the push acts on -- after `cd`,
 * `pushd`, a subshell, `bash -c` or `git -C` -- never the session's own.
 * A directory that cannot be known keeps the refusal.
 */
export function protectedPushOutcome(command: string, cwd: string, home: string, remoteIsLocal: (push: string, dir: string) => boolean): SegmentMatchSeverity {
  let severity: SegmentMatchSeverity = null;
  for (const { segment, dir } of locateCommandSegments(command, cwd, home)) {
    const outcome = someSegmentMatches(segment, PUSH_PROTECTED_SHAPE);
    if (outcome !== "deny") {
      severity = strongerSeverity(severity, outcome);
      continue;
    }
    const pushDir = gitInvocation(segment, dir, resolve(home))?.dir ?? null;
    if (pushDir !== null && remoteIsLocal(withoutGitGlobalOptionsBeforePush(segment), pushDir)) continue;
    return "deny";
  }
  return severity;
}
