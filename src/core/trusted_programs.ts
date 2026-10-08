// 0.6.28 T7: the trusted programs list ("Lista de confianza", the owner's
// decision, 2026-10-07).
//
// In three days of real transcripts, 150-200 advice blocks were the owner's
// own command-line tools: a program that sends a message, invoked as a bare
// name, an absolute path or `"$DIR/name"`. Jev cannot know they are the
// person's own. The person names them, one by one, in the config panel; a
// line whose every segment is one of them, obviously safe, contained (T2) or
// own-tree work (T6) qualifies for a local allow (src/core/local_allow.ts).
// Nothing is ever added automatically, and the default is the empty list.
//
// The config panel asks the worker to add or remove a name; the worker
// validates it here, keeps the list under the `trustedPrograms` storage key
// and mirrors it to `<configDir>/trusted-programs.json` through
// write-secret-mirror.mjs; gate-bash.ts reads that file. Every reader goes
// through parseTrustedPrograms, so they never disagree about a name. A
// missing or malformed mirror reads as the empty list: nothing trusted.
//
// Pure: the filesystem the line reading needs is injected.
import { trustedProgramsRun } from "./contained_effect.ts";

/** The mirror's file name inside the config dir, for the writer (write-secret-mirror.mjs) and the reader (gate-bash.ts). */
export const TRUSTED_PROGRAMS_MIRROR_FILE = "trusted-programs.json";

/** The storage key the worker keeps the list under. */
export const TRUSTED_PROGRAMS_STORAGE_KEY = "trustedPrograms";

/** Far above what a person trusts by hand; keeps a pasted blob from growing the mirror. */
export const MAX_TRUSTED_PROGRAMS = 50;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

/**
 * Programs that run whatever they are given, or reach far: trusting one by
 * name would trust every command. Compared lower case (macOS filesystems
 * ignore case, so `Rm` runs `rm`).
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "nu", "pwsh", "powershell",
  "python", "pythonw", "pip", "pipx", "uv", "uvx", "poetry", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "java", "osascript", "swift", "tclsh", "awk", "gawk", "sed", "jq",
  "env", "sudo", "doas", "su", "xargs", "exec", "eval", "command", "builtin", "nohup", "time", "nice", "timeout", "watch", "parallel", "script", "expect",
  "git", "gh", "glab", "hub", "rm", "mv", "cp", "dd", "ln", "chmod", "chown", "find", "tee", "cat", "open", "launchctl", "systemctl", "crontab", "at",
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat", "telnet", "ftp",
  "kubectl", "helm", "terraform", "tofu", "pulumi", "docker", "podman", "aws", "gcloud", "az", "vercel", "netlify", "fly", "heroku",
  "npm", "npx", "pnpm", "pnpx", "yarn", "make", "cmake", "ninja", "bazel", "gradle", "mvn", "cargo", "go", "brew", "apt", "apt-get", "yum", "dnf", "pacman",
]);

/** Versioned spellings of the same refusals: `python3.12`, `node22`, `bash5`, `pip3`. */
const REFUSED_VERSIONED = /^(?:sh|bash|zsh|python|pip|node|nodejs|perl|ruby|php|lua|java|deno|bun|go|tclsh)[\d.]+$/;

export type TrustedProgramRefusal = "empty" | "shape" | "refused";

export type TrustedProgramValidation = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: TrustedProgramRefusal };

/**
 * One typed name, lower case, or why it is not one: `empty`, `shape` (a
 * path, whitespace, a shell character, a leading dash, over 64 characters)
 * or `refused` (a shell, an interpreter or a generic tool).
 */
export function validateTrustedProgram(raw: string): TrustedProgramValidation {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  const name = text.toLowerCase();
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: "shape" };
  if (REFUSED_NAMES.has(name) || REFUSED_VERSIONED.test(name)) return { ok: false, reason: "refused" };
  return { ok: true, name };
}

/** The stored or mirrored list: valid names only, once each, at most MAX_TRUSTED_PROGRAMS; anything but an array reads as empty. */
export function parseTrustedPrograms(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const row of value) {
    if (typeof row !== "string") continue;
    const checked = validateTrustedProgram(row);
    if (!checked.ok || names.includes(checked.name)) continue;
    names.push(checked.name);
    if (names.length === MAX_TRUSTED_PROGRAMS) break;
  }
  return names;
}

export type TrustedProgramAdd =
  | { readonly ok: true; readonly programs: readonly string[] }
  | { readonly ok: false; readonly reason: TrustedProgramRefusal | "duplicate" | "full"; readonly programs: readonly string[] };

/** `programs` with `raw` added, or why not -- the panel shows the reason. */
export function addTrustedProgram(programs: readonly string[], raw: string): TrustedProgramAdd {
  const current = parseTrustedPrograms(programs);
  const checked = validateTrustedProgram(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason, programs: current };
  if (current.includes(checked.name)) return { ok: false, reason: "duplicate", programs: current };
  if (current.length >= MAX_TRUSTED_PROGRAMS) return { ok: false, reason: "full", programs: current };
  return { ok: true, programs: [...current, checked.name] };
}

/** `programs` without `name`. */
export function removeTrustedProgram(programs: readonly string[], name: string): readonly string[] {
  const target = name.trim().toLowerCase();
  return parseTrustedPrograms(programs).filter((program) => program !== target);
}

/** What isTrustedProgramLine reads from the machine; every function fails closed by default. */
export interface TrustedLineFs {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tempRoots?: readonly string[];
  /** The PATH directories, in order, for a bare name. */
  readonly pathDirs?: readonly string[];
  /** Whether a path is an executable file. */
  readonly isExecutable?: (path: string) => boolean;
  readonly realpath?: (path: string) => string | null;
  readonly readFirstLine?: (path: string) => string | null;
}

/**
 * The trusted programs `command` runs when every segment is one of `names`,
 * obviously safe or contained to a temp root; null otherwise. With no
 * filesystem nothing resolves, so nothing is trusted: a replay passes its
 * own `pathDirs`/`isExecutable`/`realpath`/`readFirstLine`/`tempRoots` (the hook passes the real ones,
 * plus the own-tree reading, through contained_effect.ts directly).
 */
export function isTrustedProgramLine(command: string, names: readonly string[], fs: TrustedLineFs = {}): readonly string[] | null {
  const env = fs.env ?? {};
  return trustedProgramsRun(
    command,
    {
      tempRoots: fs.tempRoots ?? [],
      cwd: fs.cwd ?? "/",
      env: env["HOME"] === undefined ? { ...env, HOME: "/nonexistent-home" } : env,
      realpath: fs.realpath ?? (() => null),
      sessionRepoRoot: null,
      isLinkedWorktree: () => false,
      readFirstLine: fs.readFirstLine,
    },
    null,
    { names: new Set(parseTrustedPrograms(names)), pathDirs: fs.pathDirs ?? [], isExecutable: fs.isExecutable ?? (() => false) },
  );
}
