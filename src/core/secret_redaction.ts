// Masks the VALUE half of anything that looks like a credential in a
// proposed shell command, before that command leaves this machine in a Jev
// request -- JEVADV-29 (odd/tasks/release-0.5.1.md). Pure: no I/O, no
// network, so every rule is unit-tested directly. Wired in at the single
// point where a command becomes a Jev `proposed_command`
// (buildActionGateState, decisions.ts) -- see that function's own comment
// for exactly why one call site covers both the risk and policy stages
// (adapters/claude/gate-bash.ts, one shared callJev call) and the AB
// benchmark's direct-batch path (adapters/cli/ab_benchmark_cli.ts) at once.
//
// STRUCTURE SURVIVES, VALUES DON'T: variable names, flags, hosts and paths
// stay exactly as written -- that is what a risk or policy judgment reasons
// about ("this touches a remote", "this writes outside the tree"). Only the
// bytes that would let someone act as the command's author -- the actual
// key, token or password -- are replaced with a fixed marker. Never the
// whole command.
//
// LOCAL RULES AND TIER-1A NEVER SEE THIS: gate-bash.ts's own NEVER_SILENTLY
// deny/ask rules, and its tier-1a "obviously safe" fast path, run on the
// UNREDACTED command, before Jev is ever called -- this module is wired in
// only where a command enters a Jev request, never upstream of that. The
// verdict cache key is computed from the unredacted shape for the same
// reason: it is not part of what leaves this machine.
//
// FALSE-NEGATIVE / FALSE-POSITIVE STANCE: every rule below is deliberately
// narrow, and ambiguity resolves in different directions depending on the
// cost of being wrong:
//   - A missed secret still only leaves this machine inside a request this
//     project already sends to Jev for every command; a MISSED credential
//     is a normal exposure the whole project already accepts for the rest
//     of the command's text, not a new one.
//   - An OVER-redacted value corrupts the command's actual meaning for the
//     judgment reading it (a fake, uniform marker where a real path or id
//     was), which is worse for the one thing this project's whole gate
//     exists to do: judge the command correctly. So the high-entropy
//     fallback in particular leans hard toward NOT touching anything that
//     could plausibly be structural (a git SHA, a UUID, a file path, a
//     base64 blob embedded IN a path) even at the cost of missing some real
//     secrets shaped the same way (an npm `sha512-...==` integrity string is
//     a known, accepted false positive -- see this module's own test file).

const MARKER = "[REDACTED]";

export interface RedactSecretsResult {
  readonly text: string;
  readonly redactedCount: number;
}

/** Already our own marker -- never re-redact it. Guarantees idempotence by construction rather than by accident. */
function isAlreadyRedacted(value: string): boolean {
  return value === MARKER || value === `"${MARKER}"` || value === `'${MARKER}'`;
}

// ---------------------------------------------------------------------------
// Assignment rule: NAME=value / export NAME=value / --flag=value
// ---------------------------------------------------------------------------

/**
 * The task's own keyword list, matched as a WHOLE name segment (split on `_`
 * and `-`), never as a bare substring. A substring test flags `MONKEY`
 * (contains `KEY`) and `TOKENIZE_INPUT` (contains `TOKEN`) -- neither is a
 * credential-shaped name. Splitting on the separators shell/CLI naming
 * conventions actually use (`API_KEY`, `--auth-token`) and requiring an
 * EXACT match against one whole segment keeps both of those out while still
 * catching every real form the task lists, including a bare `PWD` (kept
 * because the task explicitly names it, even though it usually holds a
 * directory, not a secret -- a deliberate, documented lean toward
 * over-matching here, unlike the entropy rule's opposite lean below).
 *
 * Known, accepted false negative: a GLUED name with no separator at all
 * (`APIKEY=x`) is one segment, `APIKEY`, which does not exactly equal `KEY`
 * -- real shell/env naming overwhelmingly uses the separated form, so this
 * is judged a rarer miss than the false positives exact-segment matching
 * avoids.
 */
const SECRET_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  "KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "AUTH", "CREDENTIAL", "PRIVATE",
]);

/** A name segment that means "this holds a REFERENCE to the secret, not the secret itself" -- a path or filename. `PASSWORD_FILE=/path` and `TOKEN_PATH=/x` are never redacted, matching this project's own SYSTEM_PREFIXES-style path exceptions elsewhere (src/core/command_shape.ts). */
const PATH_REFERENCE_SEGMENTS: ReadonlySet<string> = new Set(["FILE", "PATH", "DIR", "DIRECTORY"]);

function nameSegments(name: string): string[] {
  return name
    .split(/[_-]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toUpperCase());
}

function looksLikeSecretName(name: string): boolean {
  const segments = nameSegments(name);
  if (segments.some((segment) => PATH_REFERENCE_SEGMENTS.has(segment))) return false;
  return segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment));
}

/**
 * `NAME=value`, `export NAME=value`, and `--flag=value` -- one pattern for
 * all three, since a CLI long flag (`--password=hunter2`) and a shell
 * assignment differ only in an optional leading `--` and whether hyphens are
 * allowed in the name. The value is captured whole (double-quoted,
 * single-quoted, or a bare run up to the next shell metacharacter) so the
 * replacement can preserve whichever quoting style, if any, was actually
 * used.
 */
const ASSIGNMENT_PATTERN = /(--)?([A-Za-z][A-Za-z0-9_-]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]*)/g;

function unquote(value: string): { readonly inner: string; readonly wrap: (inner: string) => string } {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return { inner: value.slice(1, -1), wrap: (inner) => `"${inner}"` };
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return { inner: value.slice(1, -1), wrap: (inner) => `'${inner}'` };
  }
  return { inner: value, wrap: (inner) => inner };
}

function redactAssignments(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(ASSIGNMENT_PATTERN, (match, dashes: string | undefined, name: string, rawValue: string) => {
    if (rawValue.length === 0 || !looksLikeSecretName(name) || isAlreadyRedacted(rawValue)) return match;
    redactedCount += 1;
    const { wrap } = unquote(rawValue);
    return `${dashes ?? ""}${name}=${wrap(MARKER)}`;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// Header rule: Authorization: (Bearer|Basic|Token) <value>
// ---------------------------------------------------------------------------

// The value is [^\s"']+ rather than \S+, so a trailing quote from the
// enclosing `-H "Authorization: ..."` shell argument is never swallowed
// into the captured value and lost from the replacement.
const AUTH_HEADER_PATTERN = /(Authorization:\s*(?:Bearer|Basic|Token)\s+)([^\s"']+)/gi;

function redactAuthorizationHeader(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(AUTH_HEADER_PATTERN, (match, prefix: string, value: string) => {
    if (isAlreadyRedacted(value)) return match;
    redactedCount += 1;
    return `${prefix}${MARKER}`;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// URL userinfo rule: scheme://user:pass@host
// ---------------------------------------------------------------------------

const URL_USERINFO_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

function redactUrlUserinfo(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(URL_USERINFO_PATTERN, (match, prefix: string, password: string, at: string) => {
    if (isAlreadyRedacted(password)) return match;
    redactedCount += 1;
    return `${prefix}${MARKER}${at}`;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// curl -u user:pass / --user user:pass
// ---------------------------------------------------------------------------

const BASIC_AUTH_FLAG_PATTERN = /(-u|--user)(\s+)(["']?)([^\s:"']+):([^\s"']+)(["']?)/g;

function redactBasicAuthFlag(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(
    BASIC_AUTH_FLAG_PATTERN,
    (match, flag: string, space: string, openQuote: string, user: string, password: string, closeQuote: string) => {
      if (isAlreadyRedacted(password)) return match;
      redactedCount += 1;
      return `${flag}${space}${openQuote}${user}:${MARKER}${closeQuote}`;
    },
  );
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// mysql -p<password> (glued, no space) -- scoped to the mysql family, since
// `-p` glued to a value is a common, ambiguous short flag elsewhere (`mkdir
// -pv`, `ssh -p2222`). mysql's own CLI takes a password ONLY when it is
// glued directly to `-p` with no space -- a space after `-p` means "prompt
// interactively", so this never touches that form either.
// ---------------------------------------------------------------------------

const MYSQL_FAMILY_PATTERN = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/i;
const MYSQL_INLINE_PASSWORD_PATTERN = /(^|\s)(-p)([^\s'"=-][^\s'"]*)/g;

function redactMysqlInlinePassword(text: string): RedactSecretsResult {
  if (!MYSQL_FAMILY_PATTERN.test(text)) return { text, redactedCount: 0 };
  let redactedCount = 0;
  const result = text.replace(MYSQL_INLINE_PASSWORD_PATTERN, (match, lead: string, flag: string, value: string) => {
    if (isAlreadyRedacted(value)) return match;
    redactedCount += 1;
    return `${lead}${flag}${MARKER}`;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// Known token prefixes, anywhere in the command -- the WHOLE glued token is
// replaced, not just the prefix, so `sk-ant-api03-<rest>` disappears
// completely rather than leaving its own tail exposed.
// ---------------------------------------------------------------------------

const KNOWN_PREFIXES = ["sk-ant-", "sk-", "ghp_", "gho_", "github_pat_", "xox[bp]-", "AKIA", "AIza", "glpat-"];
const KNOWN_PREFIX_PATTERN = new RegExp(`\\b(?:${KNOWN_PREFIXES.join("|")})[A-Za-z0-9_-]*`, "g");

function redactKnownPrefixTokens(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(KNOWN_PREFIX_PATTERN, (match) => {
    redactedCount += 1;
    return MARKER;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// JWT-shaped strings: three base64url segments, the first decoding to a JSON
// object header (`eyJ` is base64 for `{"`) -- the strongest, cheapest signal
// that this is really a JWT rather than any other dot-separated triple.
// ---------------------------------------------------------------------------

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function redactJwtShapedStrings(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(JWT_PATTERN, () => {
    redactedCount += 1;
    return MARKER;
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// High-entropy fallback: everything the named rules above don't already
// catch. Operates per WHITESPACE-DELIMITED TOKEN, never across a token
// boundary, so a long command line's overall length is never mistaken for
// one long secret.
// ---------------------------------------------------------------------------

const HIGH_ENTROPY_RUN = /[A-Za-z0-9+_=-]{32,}/g;
const PURE_HEX = /^[0-9a-fA-F]+$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Same idea as command_shape.ts's own looksLikePath: a token that is
 * clearly a filesystem path is never entropy-scanned, which is also what
 * keeps a base64-looking PATH SEGMENT (`/uploads/<base64>/file.png`)
 * untouched -- the whole token is skipped, not just the slash-adjacent
 * characters.
 *
 * Deliberately prefix-based, not "contains a `/` anywhere": base64 itself
 * uses `/` as one of its own alphabet characters (an npm `sha512-...==`
 * integrity string routinely contains one), so a token that merely
 * CONTAINS a slash without actually starting like a path is not excluded
 * here -- excluding it would hide exactly the high-entropy value this rule
 * exists to catch. A real path -- one this project's judgment reasons
 * about as "the target of this command" -- overwhelmingly starts with one
 * of these prefixes or uses a backslash throughout (Windows); this is the
 * same tradeoff command_shape.ts's own looksLikePath makes with the same
 * boundary.
 */
function looksLikePathToken(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~") || token.includes("\\");
}

function hasMixedCharacterClasses(candidate: string): boolean {
  const hasUpper = /[A-Z]/.test(candidate);
  const hasLower = /[a-z]/.test(candidate);
  const hasDigit = /[0-9]/.test(candidate);
  const hasBase64Punctuation = /[+=]/.test(candidate);
  return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower)) || hasBase64Punctuation;
}

/**
 * A hyphen/underscore-joined identifier of three or more segments (a branch
 * name, a docker tag, a package name -- `feature-jevadv-29-secret-
 * redaction-module`) reads as structural, not as a secret, even though it
 * can be long enough and, across the whole run, mixed enough in case and
 * digits to otherwise qualify. What actually separates it from real base64
 * is WHERE the mixing happens: each segment here is single-class on its own
 * (all lowercase, all uppercase, or all digits), while real base64/base64url
 * mixes case and digits WITHIN a segment, not just across segments joined by
 * `-`/`_`.
 */
function looksLikeHyphenatedIdentifier(candidate: string): boolean {
  const segments = candidate.split(/[-_]/).filter((segment) => segment.length > 0);
  if (segments.length < 3) return false;
  return segments.every((segment) => /^[a-z]+$/.test(segment) || /^[A-Z]+$/.test(segment) || /^[0-9]+$/.test(segment));
}

/**
 * A leading `NAME=` or `--flag=` is kept verbatim; only what follows the `=`
 * is entropy-scanned. Without this, the name itself sits inside the SAME
 * character class as the value (letters, digits, `_`, `-`, joined by the
 * `=`), so a single high-entropy value on a non-secret-named flag or
 * variable (`--data=<blob>`, `DATA=<blob>`) had its NAME swallowed into the
 * same "run" the regex found and replaced along with the real value --
 * exactly the "keep structure" rule this module exists to honour.
 */
const LEADING_ASSIGNMENT_PREFIX = /^(-{0,2}[A-Za-z][A-Za-z0-9_-]*=)([\s\S]*)$/;

function splitLeadingAssignment(token: string): { readonly prefix: string; readonly rest: string } {
  const match = LEADING_ASSIGNMENT_PREFIX.exec(token);
  if (match === null) return { prefix: "", rest: token };
  return { prefix: match[1] as string, rest: match[2] as string };
}

function redactHighEntropyInToken(token: string): { readonly token: string; readonly redactedCount: number } {
  if (looksLikePathToken(token) || isAlreadyRedacted(token)) return { token, redactedCount: 0 };
  const { prefix, rest } = splitLeadingAssignment(token);
  let redactedCount = 0;
  const rewrittenRest = rest.replace(HIGH_ENTROPY_RUN, (candidate) => {
    if (PURE_HEX.test(candidate) || UUID_SHAPE.test(candidate) || looksLikeHyphenatedIdentifier(candidate) || !hasMixedCharacterClasses(candidate)) {
      return candidate;
    }
    redactedCount += 1;
    return MARKER;
  });
  return { token: `${prefix}${rewrittenRest}`, redactedCount };
}

function redactHighEntropyTokens(text: string): RedactSecretsResult {
  let redactedCount = 0;
  const result = text.replace(/\S+/g, (rawToken) => {
    // Strip one layer of surrounding quotes, scan the inside, then restore
    // them -- so `"aB3xK9..."` is treated the same as the bare token.
    const { inner, wrap } = unquote(rawToken);
    const { token: rewrittenInner, redactedCount: tokenCount } = redactHighEntropyInToken(inner);
    redactedCount += tokenCount;
    return wrap(rewrittenInner);
  });
  return { text: result, redactedCount };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const RULES: readonly ((text: string) => RedactSecretsResult)[] = [
  redactAssignments,
  redactAuthorizationHeader,
  redactUrlUserinfo,
  redactBasicAuthFlag,
  redactMysqlInlinePassword,
  redactKnownPrefixTokens,
  redactJwtShapedStrings,
  redactHighEntropyTokens,
];

/**
 * Masks every credential-shaped VALUE in `command`, returning the rewritten
 * text and how many distinct redactions were made. Idempotent: running it
 * again on its own output redacts nothing further, because each rule either
 * requires bytes the marker does not contain (a `[` is not in the
 * high-entropy character class) or explicitly recognizes the marker and
 * leaves it alone (isAlreadyRedacted).
 *
 * Order matters only for `redactedCount` bookkeeping, not for correctness:
 * once a rule replaces a span with MARKER, no later rule in this list can
 * re-match that same span (MARKER's own text does not satisfy any of their
 * patterns), so a value is never counted twice.
 */
export function redactSecretsForJev(command: string): RedactSecretsResult {
  let text = command;
  let redactedCount = 0;
  for (const rule of RULES) {
    const result = rule(text);
    text = result.text;
    redactedCount += result.redactedCount;
  }
  return { text, redactedCount };
}
