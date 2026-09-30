// A cache key that describes the SHAPE of a command instead of its text.
//
// Why: measured over 702 real decisions, caching on the literal command hit
// 3.1% of the time, because commands almost never repeat verbatim --
// `node --test a.test.ts` and `node --test b.test.ts` are different strings
// doing the same thing. Those 702 decisions covered only 49 distinct command
// families, so the repetition is entirely in the shape.
//
// Why not just the family: measured against the live API, one family holds
// opposite verdicts.
//
//   rm -rf dist                    consequence 1.37  -> allow
//   rm -rf node_modules            consequence 1.00  -> allow
//   rm -rf ../other-project        consequence 2.13  -> ask
//   rm -rf ~/Documents/contracts   consequence 2.13  -> ask
//
// What moved the verdict is not the filename, it is WHERE the target points:
// inside the working tree, or out of it. So the shape keeps the program, all
// of its flags, and the *class* of every argument -- and throws away the
// parts that do not change the answer.
//
// THIS MODULE FAILS CLOSED, unlike the gate it serves. The gate allows when
// it cannot decide, because turning our own defects into a prompt on every
// command is worse than no gate. A cache is the opposite: reusing a verdict
// that does not apply is how `rm -rf dist` quietly authorises
// `rm -rf ~/Documents`. So anything this module cannot classify with
// certainty returns null, and a null shape is never cached -- the command
// goes to Jev, every time, and costs a few hundred milliseconds instead of
// borrowing an answer that was about something else.

/** Argument classes. Two commands share a shape only when every argument falls in the same class. */
const IN_TREE = "<in-tree>";
const OUT_OF_TREE = "<out-of-tree>";
const SYSTEM = "<system>";
const REMOTE = "<remote>";
const LITERAL = "<arg>";

/** Paths whose contents belong to the operating system, where a mistake is not a project problem. */
const SYSTEM_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/boot", "/dev", "/proc"];

/**
 * The Windows equivalents, compared case-insensitively (NTFS is
 * case-preserving but not case-sensitive, unlike the POSIX prefixes above).
 * This is a best-effort heuristic like SYSTEM_PREFIXES itself, not
 * exhaustive: it only covers the `C:` drive, which is where a normal
 * Windows install and its Program Files live -- a target on another drive
 * letter (`D:\Windows`, a portable install) is not recognized as SYSTEM by
 * this list and instead falls through to the ordinary in-tree/out-of-tree
 * check, same as it did before this list existed.
 */
const WINDOWS_SYSTEM_PREFIXES = ["c:/windows", "c:/program files", "c:/program files (x86)", "c:/programdata"];

/** A Windows absolute path: a drive letter followed by `:` and a separator (`C:\` or `C:/`), or a UNC path (`\\server\share`). */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function isWindowsAbsolutePath(token: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(token) || token.startsWith("\\\\");
}

/**
 * Command substitution and process substitution: `$(...)`, backticks,
 * `${...}`, `<(...)` and `>(...)`. A command carrying any of these cannot be
 * judged by looking at it -- its real behavior depends on running an
 * embedded command first, which can expand to anything.
 *
 * Shared with adapters/claude/gate_safe_command.ts's tier-1a fast path (see
 * hasCommandSubstitution below, and that module's own comment on
 * isSafeSegment): a cache that must never authorise the wrong command, and a
 * fast path that must never skip judgment on the wrong one, both need
 * exactly this same "cannot be known without running it" test, so this is
 * the one place that decides it rather than two drifting copies.
 *
 * Presence-only, not parse-aware: it does not distinguish an escaped `\$(`
 * from a real substitution, or a single-quoted `'$(...)'` (which the shell
 * never expands) from an unquoted one. Both ambiguous cases are treated as
 * a substitution -- the cheap, conservative answer is "cannot be judged
 * from the text alone", never "assume it's inert".
 */
const SUBSTITUTION_PATTERN = /\$\(|`|\$\{|<\(|>\(/;

/** True when `text` contains a command or process substitution -- see SUBSTITUTION_PATTERN above for exactly which forms and why detection stops there. */
export function hasCommandSubstitution(text: string): boolean {
  return SUBSTITUTION_PATTERN.test(text);
}

/**
 * Everything this module additionally refuses to cache beyond a
 * substitution: `*` and `?[`, glob-like tokens whose expansion depends on
 * the filesystem at run time rather than on the text itself. Built from
 * SUBSTITUTION_PATTERN's own source so the substitution half can never
 * drift between the two checks.
 */
const UNKNOWABLE = new RegExp(`${SUBSTITUTION_PATTERN.source}|\\*|\\?\\[`);

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Resolves `a/../b` style segments without touching the filesystem, so this stays pure and testable for any platform. */
function resolveAgainst(base: string, relative: string): string {
  const parts = normalizeSeparators(base).split("/");
  for (const segment of normalizeSeparators(relative).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/") || "/";
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function looksLikePath(token: string): boolean {
  // `token.includes("\\")` (a bare backslash-separated Windows path or a
  // UNC share) was missing until this fix: without it, an absolute Windows
  // path passed to a SUBCOMMAND_PROGRAMS entry (e.g. `git add C:\Users\dev\
  // project\src\file.ts`) was not recognized as a path and was instead
  // treated as a second verb -- see the `MAX_VERBS` loop below -- kept
  // LITERAL in the shape instead of classified in-tree/out-of-tree.
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

/**
 * Programs whose first non-flag argument is a verb, not a target.
 *
 * Without this, `git push` and `git pull` both shape to "git <in-tree>" and
 * share a cache entry -- one of them would answer for the other. The verb is
 * therefore kept verbatim for these, and only what follows is classified.
 */
const SUBCOMMAND_PROGRAMS = new Set([
  "git", "gh", "glab", "jira", "npm", "pnpm", "yarn", "bun", "npx", "docker", "kubectl", "helm",
  "aws", "gcloud", "az", "terraform", "tofu", "cargo", "go", "systemctl", "brew",
  "pip", "pip3", "poetry", "flyctl", "vercel", "supabase", "orca",
]);

/**
 * Programs whose PR, issue, MR, ticket and repository arguments are an
 * IDENTITY, kept literal in the shape instead of folding into a class.
 *
 * Folded, `gh pr merge 12` and `gh pr merge 13` were one cache entry, and
 * the second merge replayed the first one's verdict for up to 30 days
 * without Jev ever seeing it. Which pull request is not a detail of the
 * question, it is the question -- the same reason in-tree and out-of-tree
 * are kept apart above.
 */
const IDENTITY_PROGRAMS = new Set(["gh", "glab", "jira"]);

/**
 * Value-taking flags of the identity programs whose NEXT token is content --
 * a body, a title, a request field, a header -- never an identity and never
 * a verb, however it looks. Without this, `gh secret set X --body 123456`
 * would put the secret into the shape because it looks like a PR number, and
 * `gh api -H "Authorization: token ..."` would keep the header as a verb.
 */
const CONTENT_VALUE_FLAGS = new Set([
  "--body", "-b", "--body-file", "-F", "--field", "-f", "--raw-field", "--title", "-t",
  "--notes", "--description", "--message", "--header", "-H", "--input",
]);

/**
 * 0.6.15 T3 (N-08, qa-0.6.13): tools whose arguments name a resource --
 * a volume, a container, a pod, a release, a service, a database -- not a
 * file. Which one is the question: a deny cached for `docker volume rm
 * prod_pgdata` answered `docker volume rm dev_pgdata`. Their bare-word
 * arguments stay literal; an explicit path still folds by tree, and so does
 * a value that may be a secret: one after a credential flag, or one holding
 * `=`, `:` or `@` (`-e KEY=value`, `user:pass`).
 */
const RESOURCE_PROGRAMS = new Set([
  "docker", "podman", "kubectl", "helm", "systemctl", "brew", "flyctl", "fly", "heroku", "supabase", "vercel",
  "aws", "gcloud", "az", "dropdb", "createdb", "redis-cli",
]);

/** Flags of the resource tools that only pick where they act -- kept with their value, which is never a secret. */
const ENVIRONMENT_FLAGS = new Set([
  "--context", "--kube-context", "--namespace", "-n", "--cluster", "--profile", "--project", "--region",
  "--app", "-a", "--env", "--environment", "--resource-group", "-g", "--subscription", "--host", "-h", "--db", "-d",
]);

/** Flags whose value can be a credential: it folds, whatever it looks like. */
const SECRET_VALUE_FLAGS = new Set([
  "-p", "--password", "--token", "--secret", "--build-arg", "-e", "-u", "--user", "--username", "-H", "--header",
  "--auth", "--api-key", "--key", "--access-token", "--client-secret", "--password-stdin",
]);

/** `git push -o <option>`: a push option is free text for the server and can carry a token. */
const PUSH_OPTION_FLAGS = new Set(["-o", "--push-option"]);

const NUMERIC_IDENTITY = /^#?\d+$/;
const TICKET_IDENTITY = /^[A-Z][A-Z0-9]+-\d+$/;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_REMOTE = /^[^@\s]+@[^:\s]+:/;

/** A path written as a path: absolute, relative to here, home-relative, or Windows-separated. */
function isExplicitPath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~") || token.includes("\\");
}

/**
 * `scheme://host/path`, with userinfo, query and fragment dropped -- a
 * credential in a URL's userinfo, or a token in its query string, must never
 * enter the shape. Null when `token` is not an absolute URL.
 */
function sanitizeUrl(token: string): string | null {
  if (!URL_SCHEME.test(token)) return null;
  try {
    const url = new URL(token);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Where an argument sits relative to the verbs before it; what identityLiteral needs to tell a target from content. */
interface ArgumentPosition {
  readonly program: string;
  /** The subcommand verbs already consumed for this segment, e.g. `["pr", "merge"]` or `["push"]`. */
  readonly verbs: readonly string[];
  /** The token just before this one, flags included, or undefined for the first argument. */
  readonly previous: string | undefined;
  /** How many non-flag arguments already followed the verbs; 0 means this is the command's first target. */
  readonly targetsSoFar: number;
}

/**
 * The literal form of `token` when it names WHICH thing a command acts on,
 * or null to let it fold as before.
 *
 * - `git push`: every positional after the verb -- remote and refspecs.
 *   `git push origin feature/x` and `git push origin main` are different
 *   questions. A URL remote keeps its sanitized URL and an scp-style remote
 *   drops its user, so pushing to another repository is another question
 *   too, never with the credential inside it; an explicit path still folds
 *   by tree.
 * - `gh`, `glab`, `jira`: PR/issue/MR numbers (`#12` and `12` are one),
 *   ticket ids, sanitized URLs, the `-R`/`--repo` slug, the first target
 *   after a two-level verb (`gh pr merge feature/x`, `gh repo delete
 *   acme/app`) and a `gh api` endpoint without its query string.
 *
 * A token right after any other flag is only literal when it is a number,
 * ticket or URL: the flag may take a value, and an arbitrary value can be a
 * secret (`glab auth login --token ...`).
 */
function identityLiteral(token: string, position: ArgumentPosition): string | null {
  const { program, verbs, previous, targetsSoFar } = position;
  const afterFlag = previous !== undefined && previous.startsWith("-");

  if (program === "git") {
    if (verbs[0] !== "push") return null;
    if (URL_SCHEME.test(token)) return sanitizeUrl(token);
    if (SCP_REMOTE.test(token)) return token.replace(/^[^@]+@/, "");
    if (isExplicitPath(token)) return null;
    return token;
  }

  if (!IDENTITY_PROGRAMS.has(program)) return null;
  if (NUMERIC_IDENTITY.test(token)) return token.replace(/^#/, "");
  if (TICKET_IDENTITY.test(token)) return token;
  const url = sanitizeUrl(token);
  if (url !== null) return url;
  if (previous === "-R" || previous === "--repo") return REPO_SLUG.test(token) ? token : null;
  if (afterFlag || targetsSoFar > 0) return null;
  if (verbs.length === 1 && verbs[0] === "api" && looksLikePath(token)) return token.replace(/[?#].*$/, "");
  if (verbs.length === 2 && !isExplicitPath(token)) return SCP_REMOTE.test(token) ? token.replace(/^[^@]+@/, "") : token;
  return null;
}

/**
 * Which class an argument belongs to, given where the command runs.
 *
 * There is deliberately no separate class for `$HOME`. It was tried and it
 * distinguished nothing: projects normally live under the home directory, so
 * a sibling project and a documents folder both land there, and measured
 * against the live API they score identically -- `rm -rf ../other-project`
 * and `rm -rf ~/Documents/contracts` both came back at 2.13. Splitting them
 * would only halve the cache's reach for a difference the judgement does not
 * make. What matters is in the tree or out of it.
 */
function classifyArgument(token: string, cwd: string, home: string, treeRoot: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^[^@\s]+@[^:\s]+:/.test(token)) return REMOTE;

  const normalizedCwd = normalizeSeparators(cwd);
  const normalizedHome = normalizeSeparators(home);
  // A Windows absolute path (`C:\...`, `C:/...`, or a `\\server\share` UNC
  // path) used to fall through to the `resolveAgainst(normalizedCwd, ...)`
  // branch below, because it does not start with `/`. resolveAgainst just
  // APPENDS the token's segments onto cwd's -- it never recognizes "this is
  // already absolute" -- so `C:\Users\dev\other-project\file` from cwd
  // `C:\Users\dev\project` produced the nonsense path
  // `C:/Users/dev/project/C:/Users/dev/other-project/file`, which starts
  // with the tree root and was therefore misclassified IN_TREE. That is not
  // a cosmetic bug: it lets a command targeting something genuinely outside
  // the working tree borrow a cached verdict that was only ever measured
  // for something inside it.
  const expanded = token.startsWith("~")
    ? resolveAgainst(normalizedHome, token.slice(1))
    : token.startsWith("/") || isWindowsAbsolutePath(token)
      ? normalizeSeparators(token)
      : resolveAgainst(normalizedCwd, token);

  if (SYSTEM_PREFIXES.some((p) => isInside(expanded, p))) return SYSTEM;
  if (WINDOWS_SYSTEM_PREFIXES.some((p) => isInside(expanded.toLowerCase(), p))) return SYSTEM;
  // Measured against the working tree's ROOT, not the current directory: from
  // `app/packages/web`, `../sibling` is still inside the project being worked
  // on, and calling it "outside" would refuse to reuse an answer that applies.
  return isInside(expanded, normalizeSeparators(treeRoot)) ? IN_TREE : OUT_OF_TREE;
}

/** Splits on quotes-aware whitespace. Returns null when a quote is left open, because the rest cannot be read reliably. */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export interface ShapeContext {
  /** Where the command runs; the boundary that separates `<in-tree>` from everything else. */
  readonly cwd: string;
  readonly home: string;
  /** The matched destination, whose thresholds change the verdict, or null when none matched. */
  readonly destinationId: string | null;
  /** The destination's root. `<in-tree>` is measured against this; falls back to `cwd` when nothing matched. */
  readonly treeRoot?: string;
  /** The repository description already sent to Jev; two different contexts must not share an answer. */
  readonly repoContext: string;
}

/**
 * The cache key for a command, or null when it must not be cached.
 *
 * Flags are kept in full and sorted: `git push` and `git push --force` are
 * different questions, and keeping every flag means a new one never silently
 * inherits an older, safer answer. Argument *values* collapse to their class,
 * which is what makes `rm -rf dist` and `rm -rf build` one entry while
 * `rm -rf ../other` opens its own. The exception is an identity -- which
 * PR, issue, ticket, repository or push destination -- kept literal by
 * identityLiteral, so `gh pr merge 12` never answers for `gh pr merge 13`.
 */
export function commandShape(command: string, context: ShapeContext): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  if (UNKNOWABLE.test(trimmed)) return null;

  const segments = trimmed.split(/\|\||&&|[;|]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const shaped: string[] = [];
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens === null || tokens.length === 0) return null;

    // A leading VAR=value sets the environment; its value can be a secret and
    // is never part of the shape, but its presence can matter, so the name stays.
    const assignments: string[] = [];
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) {
      assignments.push(`${(tokens[index] as string).split("=")[0]}=`);
      index += 1;
    }
    const program = tokens[index];
    if (program === undefined) return null;
    if (looksLikePath(program)) {
      const base = program.split("/").pop();
      if (base === undefined || base.length === 0) return null;
      shaped.push([...assignments, base].join(" "));
    } else {
      shaped.push([...assignments, program].join(" "));
    }

    const treeRoot = context.treeRoot ?? context.cwd;
    const rest = tokens.slice(index + 1);
    const programName = (shaped[shaped.length - 1] as string).split(" ").pop() ?? "";
    const flags: string[] = [];
    const classes: string[] = [];
    // Two levels, not one: `npm run build` and `npm run deploy` are different
    // questions -- measured at 0.90 and 1.95 -- and keeping only `run` would
    // let the build's answer authorise the deploy. `gh pr merge`,
    // `docker compose up` and `git remote add` have the same shape.
    const MAX_VERBS = 2;
    const verbs: string[] = [];
    let previous: string | undefined;
    let targetsSoFar = 0;
    for (const token of rest) {
      if (token.startsWith("-")) {
        const equalsAt = token.indexOf("=");
        const flagName = equalsAt === -1 ? token : token.slice(0, equalsAt);
        flags.push(flagName);
        // `--repo=acme/app` carries its slug inside the flag token itself,
        // so it never reaches identityLiteral's `-R acme/app` check below.
        const inlineValue = equalsAt === -1 ? "" : token.slice(equalsAt + 1);
        if (IDENTITY_PROGRAMS.has(programName) && (flagName === "-R" || flagName === "--repo") && REPO_SLUG.test(inlineValue)) {
          classes.push(inlineValue);
        }
        if (RESOURCE_PROGRAMS.has(programName) && ENVIRONMENT_FLAGS.has(flagName) && inlineValue.length > 0) classes.push(`${flagName}=${inlineValue}`);
        previous = flagName;
        continue;
      }
      // A content value is neither an identity nor a verb: it folds by
      // class like any other argument, whatever it looks like.
      const isContent =
        previous !== undefined &&
        ((IDENTITY_PROGRAMS.has(programName) && CONTENT_VALUE_FLAGS.has(previous)) || (programName === "git" && PUSH_OPTION_FLAGS.has(previous)));
      if (RESOURCE_PROGRAMS.has(programName)) {
        // A verb, a resource name and an environment flag's value stay
        // literal; a path, and anything that may be a secret, fold.
        const flagValue = previous !== undefined && previous.startsWith("-");
        const keeps = !isExplicitPath(token) && !/[=:@]/.test(token) && !(flagValue && SECRET_VALUE_FLAGS.has(previous ?? ""));
        if (!flagValue && verbs.length < MAX_VERBS && SUBCOMMAND_PROGRAMS.has(programName) && !looksLikePath(token)) verbs.push(token);
        previous = token;
        classes.push(keeps ? token : classifyArgument(token, context.cwd, context.home, treeRoot));
        continue;
      }
      const literal = isContent ? null : identityLiteral(token, { program: programName, verbs, previous, targetsSoFar });
      previous = token;
      if (literal !== null) {
        classes.push(literal);
        if (verbs.length > 0) targetsSoFar += 1;
        continue;
      }
      if (!isContent && verbs.length < MAX_VERBS && SUBCOMMAND_PROGRAMS.has(programName) && !looksLikePath(token)) {
        verbs.push(token);
        classes.push(token);
        continue;
      }
      if (verbs.length > 0 && !isContent) targetsSoFar += 1;
      classes.push(classifyArgument(token, context.cwd, context.home, treeRoot));
    }
    shaped.push(flags.sort().join(" "));
    shaped.push(classes.join(" "));
  }

  return [context.destinationId ?? "<no-destination>", context.repoContext, ...shaped].join("\u0000");
}
