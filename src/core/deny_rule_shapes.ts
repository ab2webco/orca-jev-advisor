// The shapes the gate's local deny rules recognise, spelled every way the
// shell accepts them. The 0.6.11 live QA (odd/qa/qa-0.6.11.md, F-01..F-04)
// found each rule matched one spelling of its effect: `rm -rf /` was refused
// and `rm -fr /`, `rm -r -f /`, `rm -Rf ~` were only advised. The rules read
// the command through someSegmentMatches (git_discard.ts), which keeps the
// mention-vs-command design: a phrase in a grep pattern, a quoted argument,
// an echo or a heredoc body is data. Each predicate here runs on the text
// that scan lets it read, so it inherits that design unchanged.
import { resolve } from "node:path";
import { afterHome, gitInvocation, locateCommandSegments, substitutionSpans } from "./command_locations.ts";
import { someSegmentMatches, splitOnCommandSeparatorsDetailed } from "./git_discard.ts";
import { PROTECTED_BRANCH_NAMES } from "./push_remote.ts";
import type { ImplicitPushDestination } from "./push_remote.ts";
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

/** `find` options before the start paths. */
const FIND_LEADING_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P", "-E", "-X", "-s", "-x"]);
/** `find` expression words that do not narrow what it matches; the value-taking ones skip their value. */
const FIND_UNFILTERED: ReadonlySet<string> = new Set(["-depth", "-d", "-xdev", "-mount", "-follow", "-noleaf", "-ignore_readdir_race", "-print", "-print0", "-delete"]);
const FIND_UNFILTERED_WITH_VALUE: ReadonlySet<string> = new Set(["-type", "-mindepth", "-maxdepth"]);
const FIND_EXEC: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * 0.6.13 T3 (N-04): true when `view` runs a `find` from the root or the home
 * directory that deletes what it finds -- `-delete`, or `-exec rm` -- with
 * nothing to narrow it: only depth, traversal, `-type` and print options.
 * A test such as `-name '*.pyc'` or `-path` makes it a cleanup, judged by Jev.
 */
function runsUnfilteredFindDelete(view: string, options: RecursiveRmOptions): boolean {
  const words = viewWords(view);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word !== "find" && !word.endsWith("/find")) continue;
    let at = i + 1;
    while (FIND_LEADING_OPTIONS.has(words[at] ?? "")) at += 1;
    const paths: string[] = [];
    while (at < words.length && !(words[at] ?? "").startsWith("-") && words[at] !== "!") paths.push(words[at++] ?? "");
    if (!paths.some((path) => isRootOrHome(path, options.home) || (options.runsInRootOrHome && isWholeDirectory(path)))) continue;
    let deletes = false;
    let filtered = false;
    for (; at < words.length; at += 1) {
      const token = words[at] ?? "";
      if (FIND_EXEC.has(token)) {
        const program = words[at + 1] ?? "";
        deletes ||= program === "rm" || program.endsWith("/rm");
        break;
      }
      if (FIND_UNFILTERED_WITH_VALUE.has(token)) at += 1;
      else if (token === "-delete") deletes = true;
      else if (!FIND_UNFILTERED.has(token)) filtered = true;
    }
    if (deletes && !filtered) return true;
  }
  return false;
}

/** A pipe stage that prints the root or the home directory: `echo ~`, `printf '%s' $HOME`. */
function printsRootOrHome(view: string, home: string): boolean {
  const words = viewWords(view);
  const program = words[0] ?? "";
  if (program !== "echo" && program !== "printf") return false;
  const args = words.slice(1).filter((arg, at) => !(program === "printf" && at === 0 && arg.includes("%")) && !/^-[a-zA-Z]+$/.test(arg));
  return args.length > 0 && args.every((arg) => isRootOrHome(arg, home));
}

/** A pipe stage whose `xargs` runs a recursive `rm` on what it reads. */
function xargsRunsRecursiveRm(view: string): boolean {
  const words = viewWords(view);
  const xargs = words.findIndex((word) => word === "xargs" || word.endsWith("/xargs"));
  if (xargs === -1) return false;
  const rm = words.findIndex((word, at) => at > xargs && (word === "rm" || word.endsWith("/rm")));
  return rm !== -1 && words.slice(rm + 1).some((arg) => arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg));
}

/**
 * The rmRf rule's outcome for a whole command run from `cwd`: each simple
 * command is read through someSegmentMatches, and the directory it runs in
 * (command_locations.ts) decides whether `.` or `*` names the root or the
 * home directory (`cd / && rm -rf *`, `pushd ~ && rm -rf .`).
 *
 * 0.6.13 T3 (N-04): an unfiltered `find -delete` from root or home, and root
 * or home printed into `xargs rm -r` through a real pipe (`echo ~ | xargs rm
 * -rf`), are the same effect and the same rule.
 */
export function recursiveRmOfRootOrHomeOutcome(command: string, cwd: string, home: string): SegmentMatchSeverity {
  const homeDir = resolve(home);
  let severity: SegmentMatchSeverity = null;
  for (const { segment, dir } of locateCommandSegments(command, cwd, homeDir)) {
    const options = { home: homeDir, runsInRootOrHome: dir === "/" || dir === homeDir };
    const outcome = someSegmentMatches(segment, { test: (view) => runsRecursiveRmOfRootOrHome(view, options) || runsUnfilteredFindDelete(view, options) });
    if (outcome === "deny") return "deny";
    severity = strongerSeverity(severity, outcome);
  }
  const { segments, joiners } = splitOnCommandSeparatorsDetailed(command);
  for (let i = 1; i < segments.length; i += 1) {
    if (joiners[i] !== "|") continue;
    const printed = someSegmentMatches(segments[i - 1] ?? "", { test: (view) => printsRootOrHome(view, homeDir) }) === "deny";
    if (printed && someSegmentMatches(segments[i] ?? "", { test: xargsRunsRecursiveRm }) === "deny") return "deny";
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

// `--force` (never `--force-with-lease`/`--force-if-includes`), `--mirror`,
// a short cluster holding `f` (`-f`, `-fu`, `-uf`, `-qf`), or a `+refspec`.
const FORCE_PUSH = /git\s+push\b.*(?:(?:^|\s)(?:--force(?!-with-lease|-if-includes)\b|--mirror\b|-[a-zA-Z0-9]*f[a-zA-Z0-9]*\b)|(?:^|\s)\+\S)/;

/** True when `view` runs a force push, in any flag spelling and through any git global option. */
export const FORCE_PUSH_SHAPE = { test: (view: string): boolean => FORCE_PUSH.test(withoutGitGlobalOptionsBeforePush(view)) };

/** One `git push` read from a view: its remote and refspecs, and the flags that change what they mean. */
interface PushInvocation {
  readonly refspecs: readonly string[];
  /** `--delete`/`-d`: every refspec names a remote branch to delete. */
  readonly deletes: boolean;
  /** `--all`/`--branches`: every local branch, a shared one included. */
  readonly allBranches: boolean;
  /** `--mirror`/`--tags`: no current-branch push is implied. */
  readonly noImplicit: boolean;
}

// `git push` options that take the next word as their value.
const PUSH_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const GIT_PUSH_AT = /\bgit\s+push\b/g;

/** Every `git push` in `view` (git global options already dropped), read word by word. */
function pushInvocations(view: string): readonly PushInvocation[] {
  const text = withoutGitGlobalOptionsBeforePush(view);
  const out: PushInvocation[] = [];
  for (const match of text.matchAll(GIT_PUSH_AT)) {
    const words = text.slice((match.index ?? 0) + match[0].length).trim().split(/\s+/).filter((word) => word.length > 0);
    const positionals: string[] = [];
    let repo: string | null = null;
    let deletes = false;
    let allBranches = false;
    let noImplicit = false;
    for (let at = 0; at < words.length; at += 1) {
      const word = words[at] ?? "";
      if (word === "--") {
        positionals.push(...words.slice(at + 1));
        break;
      }
      if (word.startsWith("--")) {
        const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
        if (name === "--repo") repo = word.includes("=") ? word.slice(word.indexOf("=") + 1) : (words[at + 1] ?? "");
        if (PUSH_OPTIONS_WITH_VALUE.has(name) && !word.includes("=")) at += 1;
        deletes ||= name === "--delete";
        allBranches ||= name === "--all" || name === "--branches";
        noImplicit ||= name === "--mirror" || name === "--tags";
        continue;
      }
      if (word.startsWith("-") && word.length > 1) {
        deletes ||= word.includes("d");
        if (word.endsWith("o")) at += 1;
        continue;
      }
      positionals.push(word);
    }
    out.push({ refspecs: repo !== null ? positionals : positionals.slice(1), deletes, allBranches, noImplicit });
  }
  return out;
}

/** The remote branch a refspec updates (`+` and `refs/heads/` dropped), or `HEAD` for a bare HEAD. */
function refspecDestination(refspec: string, deletes: boolean): string {
  const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const colon = deletes ? -1 : spec.indexOf(":");
  const destination = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon);
  return destination.replace(/^refs\/heads\//, "");
}

/**
 * 0.6.13 T0b: a push is to a shared branch when a refspec's DESTINATION is
 * one, exactly -- the part after `:` (or the whole ref), `+` and
 * `refs/heads/` dropped -- or when it deletes one, or pushes every branch.
 * It used to be any protected word anywhere after `git push`, so
 * `fix/main-menu` and `fix/cin-1184-production-azure-storage` (`-` and `/`
 * are word boundaries), a remote named `production`, or `main` as a source
 * (`main:feature/x`) were all refused as pushes to a shared branch.
 */
function pushesToProtected(view: string): boolean {
  return pushInvocations(view).some((push) => push.allBranches || push.refspecs.some((refspec) => PROTECTED_BRANCH_NAMES.includes(refspecDestination(refspec, push.deletes))));
}

/** True when `view` runs a push naming a shared branch as its destination, through any git global option. */
export const PUSH_PROTECTED_SHAPE = { test: pushesToProtected };

/** A push whose destination is the current branch's business: no refspec, or only `HEAD`. */
function implicitPush(push: PushInvocation): boolean {
  return !push.deletes && !push.allBranches && !push.noImplicit && push.refspecs.every((refspec) => refspecDestination(refspec, false) === "HEAD");
}

const IMPLICIT_PUSH_SHAPE = { test: (view: string): boolean => pushInvocations(view).some(implicitPush) };

/**
 * The pushProtected rule's outcome. A command-position match is set aside
 * only when the push's remote resolves to a local directory (JEVADV-39), and
 * that remote is read in the repository the push acts on -- after `cd`,
 * `pushd`, a subshell, `bash -c` or `git -C` -- never the session's own.
 * A directory that cannot be known keeps the refusal.
 *
 * 0.6.13 T0b: a push that names no destination (`git push`, `git push
 * origin`, `git push origin HEAD`) goes where git would send it,
 * `implicitDestination` answers that for the directory the push runs in
 * (push_remote.ts resolveImplicitPushDestination); a shared branch there, or
 * `push.default=matching`, is the same refusal. An unknown answer keeps the
 * command to the ordinary path, as before.
 */
export function protectedPushOutcome(
  command: string,
  cwd: string,
  home: string,
  remoteIsLocal: (push: string, dir: string) => boolean,
  implicitDestination: (dir: string, head: boolean) => ImplicitPushDestination,
): SegmentMatchSeverity {
  let severity: SegmentMatchSeverity = null;
  for (const { segment, dir } of locateCommandSegments(command, cwd, home)) {
    const pushDir = gitInvocation(segment, dir, resolve(home))?.dir ?? null;
    const outcome = someSegmentMatches(segment, PUSH_PROTECTED_SHAPE);
    if (outcome === "deny") {
      if (pushDir !== null && remoteIsLocal(withoutGitGlobalOptionsBeforePush(segment), pushDir)) continue;
      return "deny";
    }
    severity = strongerSeverity(severity, outcome);
    if (pushDir === null || someSegmentMatches(segment, IMPLICIT_PUSH_SHAPE) !== "deny") continue;
    const head = pushInvocations(segment).some((push) => implicitPush(push) && push.refspecs.length > 0);
    const destination = implicitDestination(pushDir, head);
    const shared = destination.kind === "matching" || (destination.kind === "branch" && PROTECTED_BRANCH_NAMES.includes(destination.name));
    if (shared && !remoteIsLocal(withoutGitGlobalOptionsBeforePush(segment), pushDir)) return "deny";
  }
  return severity;
}

// Words that run the command after them, with their own options and
// `NAME=value` assignments: `sudo -E`, `env A=1`, `/usr/bin/env`.
const RUNNER_PREFIX = String.raw`(?:(?:(?:\S*/)?(?:sudo|doas|env|command|exec|nohup|time)|timeout(?:\s+-\S+)*\s+\d\S*)\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*)*`;
const CURL_WGET_STAGE = new RegExp(String.raw`^${RUNNER_PREFIX}(?:\S*/)?(?:curl|wget)(?:\s|$)`);
const SHELL_STAGE = new RegExp(String.raw`^${RUNNER_PREFIX}(?:\S*/)?(?:bash|sh|zsh|dash|ksh)(?:\s|$)`);
const INTERPRETER_STAGE = new RegExp(String.raw`^${RUNNER_PREFIX}(?:\S*/)?(?:python[\d.]*|perl|ruby|node)((?:\s+\S+)*)\s*$`);
// An interpreter given one of these reads its program from the argument, not from stdin.
const PROGRAM_FROM_ARGUMENT = new Set(["-c", "-m", "-e", "-E", "-p", "-n", "-r", "--eval", "--print", "--require"]);

/** True when `view` is a pipe stage that runs what arrives on stdin: a shell, or an interpreter with no program of its own. */
function runsStdin(view: string): boolean {
  if (SHELL_STAGE.test(view)) return true;
  const match = INTERPRETER_STAGE.exec(view);
  if (match === null) return false;
  const args = (match[1] ?? "").trim().split(/\s+/).filter((arg) => arg.length > 0);
  return args.every((arg) => arg === "-" || (arg.startsWith("-") && !PROGRAM_FROM_ARGUMENT.has(arg)));
}

const REMOTE_CODE = "__remote_code__";
const DOWNLOAD_AT = /^\s*(?:\S*\/)?(?:curl|wget)\b/;

/**
 * `command` with every `$(curl ...)`, `` `wget ...` `` and `<(curl ...)` --
 * a download whose OUTPUT becomes text or a file the command reads --
 * replaced by one marker word, so a rule can see what receives it
 * (`bash -c "$(curl ...)"`, `eval ...`, `bash <(curl ...)`). Text inside
 * single quotes is never a substitution and stays as written.
 */
export function withDownloadsMarked(command: string): string {
  let out = "";
  let from = 0;
  for (const span of substitutionSpans(command)) {
    const bodyStart = span.end - span.body.length;
    out += command.slice(from, span.start);
    out += DOWNLOAD_AT.test(span.body) ? REMOTE_CODE : `${command.slice(span.start, bodyStart)}${withDownloadsMarked(span.body)}${command[span.end] ?? ""}`;
    from = span.end + 1;
  }
  return out + command.slice(from);
}

const RUNS_DOWNLOAD = new RegExp(String.raw`(?:^|[\s(])(?:\S*/)?(?:bash|sh|zsh|dash|ksh|eval|source|\.|python[\d.]*|perl|ruby|node)(?:\s+-\S+)*\s+${REMOTE_CODE}(?:\s|$)`);
const CURL_PIPE_SHELL_SPANNING = /\b(curl|wget)\b[^|]*\|\s*(?:\S*\/)?(?:(?:sudo|env)\s+(?:-\S+\s+)*)?(?:\S*\/)?(bash|sh|zsh|dash|ksh)\b/;

/**
 * The curlPipeShell rule's outcome: remote code handed to a shell or an
 * interpreter. A real pipe (split by splitOnCommandSeparatorsDetailed, so a
 * quoted `|` is never one) from a curl/wget stage to any LATER stage of the
 * same pipeline that runs its stdin (`curl | tee f | bash`); a download's
 * output run through `bash -c`, `eval`, `source` or process substitution;
 * and the whole shape inside one segment's own text, which someSegmentMatches
 * grades as interpreter code (advice) or a mention (data).
 */
export function curlToShellOutcome(command: string): SegmentMatchSeverity {
  const { segments, joiners } = splitOnCommandSeparatorsDetailed(command);
  let downloadUpstream = false;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    if (joiners[i] !== "|") downloadUpstream = false;
    else if (downloadUpstream && someSegmentMatches(segment, { test: runsStdin }) === "deny") return "deny";
    downloadUpstream ||= someSegmentMatches(segment, CURL_WGET_STAGE) === "deny";
  }
  const marked = someSegmentMatches(withDownloadsMarked(command), RUNS_DOWNLOAD);
  if (marked === "deny") return "deny";
  return strongerSeverity(marked, someSegmentMatches(command, CURL_PIPE_SHELL_SPANNING));
}
