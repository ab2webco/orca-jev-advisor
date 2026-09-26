// Unit tests for secret_redaction.ts -- pure input to pure output, no
// filesystem, no network. Run with:
//   node --test src/core/secret_redaction.test.ts
//
// JEVADV-29 (odd/tasks/release-0.5.1.md): the risk and policy stages send
// the proposed shell command to api.typesafe.ai. This module masks anything
// that looks like a credential VALUE before that happens -- see this
// module's own header for the structure-survives, values-don't rule and its
// documented false-negative/false-positive stance.

import assert from "node:assert/strict";
import test from "node:test";

import { redactSecretsForJev } from "./secret_redaction.ts";

const MARKER = "[REDACTED]";

function text(command: string): string {
  return redactSecretsForJev(command).text;
}

function count(command: string): number {
  return redactSecretsForJev(command).redactedCount;
}

// ===========================================================================
// Assignment rule: NAME=value / export NAME=value
// ===========================================================================

test("assignment: export NAME=value with a secret-shaped name is redacted", () => {
  assert.equal(text("export TOKEN=abc123"), `export TOKEN=${MARKER}`);
  assert.equal(count("export TOKEN=abc123"), 1);
});

test("assignment: a bare NAME=value (no export) is redacted the same way", () => {
  assert.equal(text("API_KEY=xyz987 curl https://example.com"), `API_KEY=${MARKER} curl https://example.com`);
});

test("assignment: matches every secret-shaped keyword the task specifies, as its own name segment", () => {
  for (const name of ["API_KEY", "AUTH_TOKEN", "APP_SECRET", "DB_PASSWORD", "DB_PASSWD", "PWD", "BASIC_AUTH", "MY_CREDENTIAL", "PRIVATE"]) {
    const command = `${name}=some-value-here`;
    assert.equal(text(command), `${name}=${MARKER}`, `expected ${name} to be treated as a secret-shaped name`);
  }
});

test("assignment: is case-insensitive on the name", () => {
  assert.equal(text("token=abc123"), `token=${MARKER}`);
});

test("assignment: a quoted value keeps its quote style", () => {
  assert.equal(text('export TOKEN="abc 123"'), `export TOKEN="${MARKER}"`);
  assert.equal(text("export TOKEN='abc 123'"), `export TOKEN='${MARKER}'`);
});

test("assignment: --flag=value form is redacted the same way as NAME=value", () => {
  assert.equal(text("curl --password=hunter2 https://example.com"), `curl --password=${MARKER} https://example.com`);
});

test("assignment: an empty value is left alone -- nothing to redact", () => {
  assert.equal(text("export TOKEN="), "export TOKEN=");
  assert.equal(count("export TOKEN="), 0);
});

// ---------------------------------------------------------------------------
// Assignment rule negatives
// ---------------------------------------------------------------------------

test("assignment negative: a name that merely CONTAINS a keyword as a substring, not as its own segment, is left alone", () => {
  assert.equal(text("MONKEY=1"), "MONKEY=1", "MONKEY contains KEY but is not a KEY-named variable");
  assert.equal(text("TOKENIZE_INPUT=abc"), "TOKENIZE_INPUT=abc", "TOKENIZE is not the TOKEN segment");
});

test("assignment negative: a *_FILE value is a path reference, not a secret -- keep it", () => {
  assert.equal(text("PASSWORD_FILE=/path/to/file"), "PASSWORD_FILE=/path/to/file");
  assert.equal(text("--password-file=/path/to/file some-command"), "--password-file=/path/to/file some-command");
});

test("assignment negative: a *_PATH or *_DIR value is also a path reference, not a secret", () => {
  assert.equal(text("TOKEN_PATH=/path/to/token"), "TOKEN_PATH=/path/to/token");
  assert.equal(text("SECRET_DIR=/var/secrets"), "SECRET_DIR=/var/secrets");
});

test("assignment negative: a space-separated --password-file path is untouched (no = at all, and the path is structural)", () => {
  assert.equal(text("mytool --password-file /path/to/file"), "mytool --password-file /path/to/file");
});

// ===========================================================================
// Header rule: Authorization: (Bearer|Basic|Token) <value>
// ===========================================================================

test("header: Authorization: Bearer <token> is redacted, the scheme survives", () => {
  const command = 'curl -H "Authorization: Bearer abcdef0123456789" https://api.example.com';
  assert.equal(text(command), `curl -H "Authorization: Bearer ${MARKER}" https://api.example.com`);
});

test("header: Basic and Token schemes are also redacted, case-insensitively", () => {
  assert.equal(text("curl -H 'authorization: basic dXNlcjpwYXNz'"), `curl -H 'authorization: basic ${MARKER}'`);
  assert.equal(text("curl -H 'Authorization: Token abc.def'"), `curl -H 'Authorization: Token ${MARKER}'`);
});

// ===========================================================================
// URL userinfo rule: scheme://user:pass@host
// ===========================================================================

test("url userinfo: the password half of a connection string is redacted, the user and host survive", () => {
  const command = "psql postgres://dbuser:hunter2@db.internal:5432/app";
  assert.equal(text(command), `psql postgres://dbuser:${MARKER}@db.internal:5432/app`);
});

test("url userinfo: an https URL with basic-auth-in-URL is also redacted", () => {
  assert.equal(text("curl https://apiuser:s3cr3t@example.com/x"), `curl https://apiuser:${MARKER}@example.com/x`);
});

test("url userinfo: a URL with no userinfo at all is untouched", () => {
  const command = "curl https://example.com/path";
  assert.equal(text(command), command);
});

// ===========================================================================
// curl -u user:pass
// ===========================================================================

test("curl -u user:pass: the password half is redacted, the username survives", () => {
  assert.equal(text("curl -u apiuser:hunter2 https://example.com"), `curl -u apiuser:${MARKER} https://example.com`);
  assert.equal(text("curl --user apiuser:hunter2 https://example.com"), `curl --user apiuser:${MARKER} https://example.com`);
});

test("curl -u username (no colon, no password) is left alone", () => {
  assert.equal(text("curl -u apiuser https://example.com"), "curl -u apiuser https://example.com");
});

// ===========================================================================
// mysql -p<password> (glued, no space) -- scoped to the mysql family
// ===========================================================================

test("mysql -p<password> glued to the flag is redacted, scoped to a mysql-family command", () => {
  assert.equal(text("mysql -uroot -pSuperSecret123 mydb"), `mysql -uroot -p${MARKER} mydb`);
  assert.equal(text("mysqldump -uroot -pSuperSecret123 mydb > dump.sql"), `mysqldump -uroot -p${MARKER} mydb > dump.sql`);
});

test("mysql -p with a space prompts interactively and is left alone", () => {
  assert.equal(text("mysql -uroot -p mydb"), "mysql -uroot -p mydb");
});

test("a -p glued value OUTSIDE a mysql-family command is left alone -- this rule is scoped, not general", () => {
  assert.equal(text("mkdir -pv /tmp/x"), "mkdir -pv /tmp/x");
  assert.equal(text("ssh -p2222 host"), "ssh -p2222 host");
});

// ===========================================================================
// Known token prefixes, anywhere in the command
// ===========================================================================

test("known prefixes: each documented prefix is redacted as a whole token", () => {
  const cases = [
    ["export TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant-"],
    ["curl -H \"Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\"", "ghp_"],
    ["git remote set-url origin https://gho_abcdefghijklmnop@github.com/x/y", "gho_"],
    ["export TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_"],
    ["export SLACK_TOKEN=" + "xoxb" + "-111111111111-222222222222-abcdefghijklmnopqrstuvwx", "xoxb-"],
    ["export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIA"],
    ["export MAPS_KEY=AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe", "AIza"],
    ["export TOKEN=glpat-abcdefghijklmnopqrst", "glpat-"],
  ];
  for (const [command, prefix] of cases) {
    const result = text(command as string);
    assert.ok(!result.includes(prefix as string), `expected the ${prefix} token to be fully replaced, not just partially, in: ${result}`);
    assert.ok(result.includes(MARKER), `expected a marker in the output for prefix ${prefix}: ${result}`);
  }
});

// ===========================================================================
// JEVADV-37 precision fix (odd/tasks/release-0.5.1.md): looksLikePrefixedId's
// old, permissive suffix check exempted npm_/hf_ real credentials the same
// way it exempted a genuine reference id -- a real secret format must win
// that ambiguity. Each new prefix below needs a length-gated tail (not the
// legacy prefixes' "anything after it" tail): npm_/hf_/pypi- are also
// ordinary NAME prefixes in real commands, and a shorter, mundane name must
// never be swallowed along with a genuine token.
// ===========================================================================

test("known prefixes: npm_/hf_/pypi-/shpat_/sq0atp-/rk_live_/sk_live_/whsec_/dop_v1_/SG. are redacted as a whole token", () => {
  const cases: readonly [string, string][] = [
    ["mytool --token npm_aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGhIj", "npm_"],
    ["mytool --auth h" + "f_aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGh", "hf_"],
    ["pip install --index-url https://pypi.org/simple pypi-AgEIcHlwaS5vcmcCJDAxMjM0NTY3LWFiY2QtZWZnaC1pams", "pypi-"],
    ["mytool --token shp" + "at_0123456789abcdef0123456789abcdef", "shpat_"],
    ["mytool --token sq0" + "atp-0123456789AbCdEfGhIjKl", "sq0atp-"],
    ["curl -H 'Authorization: Bearer rk_live_0123456789AbCdEfGhIjKl'", "rk_live_"],
    ["curl -H 'Authorization: Bearer sk_live_0123456789AbCdEfGhIjKl'", "sk_live_"],
    ["mytool --webhook-secret whsec_0123456789AbCdEfGhIjKlMnOp", "whsec_"],
    ["mytool --token dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "dop_v1_"],
    ["mytool --token SG.aBcDeFGhIjKlMnOpQrStUv.aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQr", "SG."],
  ];
  for (const [command, prefix] of cases) {
    const result = text(command);
    assert.ok(result.includes(MARKER), `expected a marker in the output for prefix ${prefix}: ${result}`);
    assert.ok(!new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[A-Za-z0-9]").test(result), `expected the ${prefix} token to be fully replaced, not just partially, in: ${result}`);
  }
});

test("known prefixes negative: a structural NAME using the same prefix as a real credential survives untouched", () => {
  // npm_config_registry/npm_package_version/npm_lifecycle_event are ordinary
  // npm-set environment variable names, not credentials; hf_cache is an
  // ordinary Hugging Face cache directory name. Neither has anywhere near a
  // real token's own length right after the prefix -- exactly what
  // distinguishes them from npm_/hf_'s own KNOWN_PREFIX_PATTERN rule.
  assert.equal(text("npm_config_registry=https://registry.npmjs.org/"), "npm_config_registry=https://registry.npmjs.org/");
  assert.equal(text("echo $npm_package_version"), "echo $npm_package_version");
  assert.equal(text("ls hf_cache/models"), "ls hf_cache/models");
  assert.equal(count("npm_config_registry=https://registry.npmjs.org/"), 0);
  assert.equal(count("ls hf_cache/models"), 0);
});

// ===========================================================================
// JEVADV-37: an AWS secret access key and a base64 credential both commonly
// contain a `/`, without being a path at all -- looksLikePathOrUrl's old
// blanket "contains a slash anywhere" carve-out let both through unmasked.
// ===========================================================================

test("entropy: an AWS-secret-access-key-shaped positional argument (containing '/') is masked", () => {
  // AWS's own published EXAMPLE secret key (never a real, live credential),
  // used here only for its shape: 40 characters of [A-Za-z0-9/+].
  const command = "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.equal(text(command), "aws configure set aws_secret_access_key [REDACTED]");
  assert.equal(count(command), 1);
});

test("entropy: a base64 credential containing '/' (not sitting in a path) is masked", () => {
  const command = "mytool --token aB3xK9mQ7pL2vN8wZ4tY6rD1sF5g/H0jC3kM9nP2qR7sT5uV8wX1yZ3";
  assert.equal(text(command), "mytool --token [REDACTED]");
  assert.equal(count(command), 1);
});

test("entropy: an AWS-secret-shaped value behind a --flag=value assignment is still masked, the flag name survives", () => {
  const command = "mytool --secret-key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.equal(text(command), "mytool --secret-key=[REDACTED]");
});

test("entropy negative: the sha512- integrity value (leading hyphen) still fails the new base64/AWS shape check the same way it fails the old one", () => {
  const integrity = "sha512-oIPzksC78K18u7fj2CqQCu3RWH+iuZzuVaOFm4/n/Y3hoRJhqxwj5CTdMxqOWx6mp5PU2SBn/JLDLZ7SkRvzow==";
  const command = `npm install --save foo@1.0.0 --integrity=${integrity}`;
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("entropy negative: a Windows backslash path with a high-entropy segment is still never masked (no forward slash at all)", () => {
  const command = "type C:\\Users\\example\\AppData\\Local\\some-app\\aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7.log";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("entropy negative: a TitleCase relative path with no separators is never masked, even though every character is [A-Za-z] and it contains '/'", () => {
  // Real directory names (macOS/Windows) are commonly TitleCase with no
  // hyphen/underscore/dot at all -- looksLikeBase64OrAwsSecretWithSlash's own
  // "no all-lowercase segment" check must not require EVERY letter in a
  // segment to be lowercase, or a path this ordinary reads as base64/an AWS
  // secret (all of [A-Za-z0-9+/], 38 characters, mixed upper/lower across
  // segments) purely because none of its segments happens to be all-lowercase.
  const command = "some-tool Documents/Projects/ClientWork/Frontend";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

// odd/tasks/release-0.5.1.md T-lane-a task 4 (JEVADV-40): the previous test
// is only saved by "Documents"/"Frontend" -- single-capitalised segments the
// OLD per-segment check already recognised. A path whose EVERY segment is a
// compound camel/PascalCase developer word (no plain single-cap segment
// among them) had no segment left to save it, so it fell through to
// hasMixedCharacterClasses and was masked as if it were a real credential.
test("entropy negative: an all-compound-PascalCase path (no plain single-cap segment) is never masked", () => {
  const command = "some-tool ClientWork/BackEnd/DataLayer/UserRepo";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("entropy negative: the same all-compound-PascalCase shape with a 5th segment is never masked", () => {
  const command = "some-tool ClientWork/BackEnd/DataLayer/UserRepo/OrderService";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("entropy negative: an all-compound-camelCase path (lowercase-first hump) is never masked", () => {
  const command = "some-tool clientWork/backEnd/dataLayer/userRepo";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

// The broadened per-segment check must still lose to a REAL secret: digits
// anywhere in a segment, or two consecutive uppercase letters (no lowercase
// run in between), are outside the new camel/PascalCase shape and must stay
// exactly as maskable as before this fix.
test("entropy: an AWS-like segment (digits, random case) mixed into an otherwise word-shaped path is still masked", () => {
  const command = "some-tool ClientWork/BackEnd/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7/UserRepo";
  const result = text(command);
  assert.ok(result.includes(MARKER), `expected a marker in: ${result}`);
  assert.equal(count(command), 1);
});

test("entropy: real base64/AWS-secret shape (case and digits mixed WITHIN a run, no path-like segment) is still masked", () => {
  const command = "curl --data wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYUvNMhWXt/YExampleData https://example.com";
  const result = text(command);
  assert.ok(result.includes(MARKER), `expected a marker in: ${result}`);
});

// ===========================================================================
// JEVADV-37: webhook tokens embedded in a URL PATH (Slack, Discord/generic,
// Microsoft Teams) -- none of the rules above ever see these, since the
// secret is a path segment, not a query param or an Authorization header.
// The host and every structural id segment survive; only the token segment
// is replaced.
// ===========================================================================

test("webhook: a Slack incoming-webhook URL is masked, the team/bot id segments survive", () => {
  const command = "curl -X POST https://hooks.slack" + ".com/services/T00000000/B00000000/aBcDeFGhIjKlMnOpQrStUvWx";
  assert.equal(text(command), "curl -X POST https://hooks.slack" + ".com/services/T00000000/B00000000/[REDACTED]");
  assert.equal(count(command), 1);
});

test("webhook: a Discord webhook URL (/api/webhooks/<id>/<token>) is masked, the numeric id survives", () => {
  const command = "curl -X POST https://discord.com/api/webhooks/123456789012345678/aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp1234567890";
  assert.equal(text(command), "curl -X POST https://discord.com/api/webhooks/123456789012345678/[REDACTED]");
  assert.equal(count(command), 1);
});

test("webhook: a Microsoft Teams incoming-webhook URL is masked", () => {
  const command = "curl -X POST https://webhook.office.com/webhookb2/abc-123@def-456/IncomingWebhook/0123456789abcdef0123456789abcdef/00000000-0000-0000-0000-000000000000";
  const result = text(command);
  assert.ok(result.includes(MARKER), `expected a marker in: ${result}`);
  assert.ok(!result.includes("0123456789abcdef0123456789abcdef"), `expected the token segment to be replaced in: ${result}`);
});

// ===========================================================================
// JWT-shaped strings (three base64url segments, header starting eyJ)
// ===========================================================================

test("jwt: a bare JWT-shaped string (not caught by the assignment or header rule) is redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const command = `mytool --send-token ${jwt}`;
  assert.equal(text(command), `mytool --send-token ${MARKER}`);
});

test("jwt: three short dot-separated segments (a version-like string) are left alone", () => {
  assert.equal(text("npm install foo@1.2.3"), "npm install foo@1.2.3");
});

// ===========================================================================
// High-entropy fallback
// ===========================================================================

test("entropy: a long mixed-case-and-digit token with no other shape is redacted", () => {
  const command = "curl --data aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7 https://example.com";
  assert.equal(text(command), `curl --data ${MARKER} https://example.com`);
});

test("entropy: a --flag=<high-entropy value> keeps the FLAG NAME intact -- only the value after = is masked", () => {
  const command = "curl --data=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7 https://example.com";
  assert.equal(text(command), `curl --data=${MARKER} https://example.com`);
});

test("entropy: a NAME=<high-entropy value> (non-secret-named) keeps the VARIABLE NAME intact -- only the value after = is masked", () => {
  assert.equal(text("DATA=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7"), `DATA=${MARKER}`);
});

test("entropy negative: a hyphenated identifier of plain-English-ish segments (a branch name, a docker tag) is never redacted, even past the length threshold", () => {
  assert.equal(text("git checkout feature-jevadv-29-secret-redaction-module"), "git checkout feature-jevadv-29-secret-redaction-module");
});

test("entropy negative: a git SHA (40 hex chars) is never redacted", () => {
  const command = "git show 4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  assert.equal(text(command), command);
});

test("entropy negative: a 64-char hex SHA-256 is never redacted", () => {
  const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const command = `sha256sum --check ${sha256.slice(0, 64)}`;
  assert.equal(text(command), command);
});

test("entropy negative: a UUID is never redacted", () => {
  const command = "docker inspect 6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(text(command), command);
});

test("entropy negative: a long file path is never redacted, even with long segments", () => {
  const command = "cat /Users/dev/Projects/some-really-long-nested-directory-name/another-long-segment/file.txt";
  assert.equal(text(command), command);
});

test("entropy negative: base64-looking content used AS a path segment is never redacted", () => {
  const command = "cat /uploads/aGVsbG8gd29ybGQxMjM0NTY3ODkwQUJDREVGR0hJSktMTU5PUA/file.png";
  assert.equal(text(command), command);
});

test("entropy negative (JEVADV-29 precision fix, was a documented false positive): an npm integrity hash contains a path separator, so it is no longer masked", () => {
  // Before this fix, this was accepted-but-documented over-masking: the
  // value looks exactly like the high-entropy shape this rule exists to
  // catch. JEVADV-29's own precision pass narrows the fallback to a
  // STANDALONE token -- one with no `/` in it at all -- and this value
  // contains two, so it now falls under the same "part of a path" carve-out
  // as a real filesystem path (see the path/id/URL tests below). Fixing the
  // false-positive class this rule exists to close necessarily fixes this
  // one too; it is not a separate regression.
  const integrity = "sha512-oIPzksC78K18u7fj2CqQCu3RWH+iuZzuVaOFm4/n/Y3hoRJhqxwj5CTdMxqOWx6mp5PU2SBn/JLDLZ7SkRvzow==";
  const command = `npm install --save foo@1.0.0 --integrity=${integrity}`;
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

// ===========================================================================
// JEVADV-29 precision fix (odd/tasks/release-0.5.1.md): stop masking
// non-secrets. Three false-positive classes measured over the owner's own
// 70,300-command corpus (never reproduced here -- this uses a synthetic set
// of fabricated commands instead): long path segments (~5,300), prefixed ids
// like `term_<uuid>`/`toolu_...`/`rctx2_<hex>` (~4,700), and URL path/query
// parts (469).
// ===========================================================================

// ---------------------------------------------------------------------------
// (a) never mask a token or segment that is part of a filesystem path.
// ---------------------------------------------------------------------------

test("path negative: a long, mixed-case directory name mangled with dashes (Claude's own -Users-name-Projects-repo convention) is never masked", () => {
  // The exact shape this bug produces: a directory-mangling convention that
  // replaces `/` with `-` turns a harmless path into ONE long hyphenated run
  // that mixes upper/lower case (TitleCase segments like "Users"/"Projects"
  // fail looksLikeHyphenatedIdentifier's per-segment all-one-case check), so
  // it used to read exactly like a high-entropy secret.
  const command =
    "cat ~/Library/Application/Support/orca/claude-accounts/00000000-0000-0000-0000-000000000000/projects/-Users-example-Projects-some-repo-name/memory/MEMORY.md";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("path negative: a long opaque segment after a real path prefix is never masked, even though the segment alone would qualify as high-entropy", () => {
  const command = "cat /Volumes/Data/claude-tmp/claude-501/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7/output.log";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("path negative: a --flag=/long/path/value form is never masked (path check runs on the value, after the assignment prefix)", () => {
  const command = "mytool --cwd=/Volumes/Data/claude-tmp/claude-501/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("path negative: a Windows backslash path is never masked", () => {
  const command = "type C:\\Users\\example\\AppData\\Local\\some-app\\aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7.log";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("path positive (unchanged): a real secret NOT sitting in a path is still masked", () => {
  const command = "curl --data aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7 https://example.com/x";
  assert.equal(text(command), `curl --data ${MARKER} https://example.com/x`);
});

// ---------------------------------------------------------------------------
// (b) never mask <word>_<uuid> / <word>_<hex> ids, or a plain UUID.
// ---------------------------------------------------------------------------

test("id negative: a word-prefixed hex id (rctx2_<hex>) is never masked", () => {
  const command = "orca session resume rctx2_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("id negative: a word-prefixed uuid id (term_<uuid>) is never masked", () => {
  const command = "orca terminal attach term_6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("id regression (JEVADV-37, accepted): a mixed alnum prefixed id (toolu_...) is now masked", () => {
  // Before this task, ANY <word>_<alnum-run> shape was exempted -- exactly
  // what let a real npm_/hf_ credential (word prefix + a long mixed-case-
  // and-digit run) through unmasked (see the npm_/hf_ tests below, and this
  // module's own header). looksLikePrefixedId now exempts only a REAL id
  // shape -- a UUID, or a run of lowercase hex -- and a mixed-case alnum
  // suffix like this one is indistinguishable, in general, from a real
  // credential once the exemption is narrowed that far. This is a deliberate,
  // accepted trade-off, not an oversight: a real Anthropic tool-call id
  // (`toolu_01` + 22 chars = 30 total) never reaches HIGH_ENTROPY_RUN's own
  // 32-character floor in the first place, so real ids of that shape are
  // unaffected -- only a fabrication this long is.
  const command = "orca tool trace toolu_01AbCdEfGhIjKlMnOpQrStUvWx";
  assert.ok(count(command) > 0, "accepted regression: this shape is no longer distinguishable from a real credential");
});

test("id negative: a plain UUID (already covered before this fix) still is not masked", () => {
  const command = "docker inspect 6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

// ---------------------------------------------------------------------------
// (c) never mask URL path/query parts, except explicit secret-named query
// params -- token=/access_token=/api_key=/password=/secret=/sig=/signature=
// always, key= only when its value is long/high-entropy.
// ---------------------------------------------------------------------------

test("url negative: a claude.ai artifact URL's opaque path id is never masked", () => {
  const command = "curl https://claude.ai/code/artifact/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("url negative: an ordinary, non-secret-named query param is never masked, however long", () => {
  const command = "curl https://example.com/search?ref=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
});

test("url positive: token=/access_token=/api_key=/password=/secret= query params are masked, the rest of the URL survives", () => {
  const cases: readonly [string, string][] = [
    ["curl https://example.com/x?token=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7", "token"],
    ["curl https://example.com/x?access_token=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7", "access_token"],
    ["curl https://example.com/x?api_key=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7", "api_key"],
    ["curl https://example.com/x?password=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7", "password"],
    ["curl https://example.com/x?secret=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7", "secret"],
  ];
  for (const [command, name] of cases) {
    const result = text(command);
    assert.match(result, new RegExp(`\\?${name}=${MARKER.replace(/[[\]]/g, "\\$&")}`), `expected ${name}= to be masked in: ${result}`);
    assert.match(result, /example\.com\/x/, "the rest of the URL must survive");
  }
});

test("url positive: sig= and signature= query params are masked -- new secret-named query params, not covered before this fix", () => {
  assert.equal(
    text("curl https://example.com/x?sig=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7"),
    `curl https://example.com/x?sig=${MARKER}`,
  );
  assert.equal(
    text("curl https://example.com/x?signature=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7"),
    `curl https://example.com/x?signature=${MARKER}`,
  );
});

test("url: key= is masked only when its value is long/high-entropy -- a short or mundane key= survives", () => {
  assert.equal(text("curl https://maps.example.com/api?key=en"), "curl https://maps.example.com/api?key=en", "a short key value is not a secret");
  assert.equal(
    text("curl https://maps.example.com/api?key=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7"),
    `curl https://maps.example.com/api?key=${MARKER}`,
    "a long, mixed-entropy key= value is still masked",
  );
});

test("url: a compound *_KEY/KEY_* name is unaffected by the bare key= nuance -- still unconditional", () => {
  assert.equal(text("export MAPS_KEY=short"), `export MAPS_KEY=${MARKER}`);
});

// ---------------------------------------------------------------------------
// Synthetic corpus (never the owner's corpus). R2-001 (odd/tasks/release-
// 0.5.1.md): this used to also assert a "before/after masked-command rate"
// with `beforeRate` hardcoded to `total / total` -- a tautology that could
// never fail regardless of what the module actually did. Removed rather than
// repaired honestly: this file has no access to 4d5ebe2's actual behaviour to
// compare against (only to today's), so the only honest claim left to make
// is the one the two loops below already make directly -- every real secret
// is masked, every false-positive class is not.
// ---------------------------------------------------------------------------

test("synthetic corpus: every real secret is still masked, every false-positive class is not", () => {
  const secrets = [
    "export TOKEN=abc123456789",
    "curl -H 'Authorization: Bearer aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7'",
    "psql postgres://dbuser:hunter2@db.internal:5432/app",
    "curl -u apiuser:hunter2 https://example.com",
    "mysql -uroot -pSuperSecret123 mydb",
    "export TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "curl https://example.com/x?sig=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
    // JEVADV-37 additions: real secret formats a permissive id/path exemption used to let through.
    "mytool --token npm_aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGhIj",
    "mytool --auth h" + "f_aBcDeFGhIjKlMnOpQrStUvWxYzAbCdEfGh",
    "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "curl -X POST https://hooks.slack" + ".com/services/T00000000/B00000000/aBcDeFGhIjKlMnOpQrStUvWx",
  ];
  const falsePositives = [
    "cat /Volumes/Data/claude-tmp/claude-501/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7/output.log",
    "cat ~/Library/Application/Support/orca/projects/-Users-example-Projects-some-repo-name/memory/MEMORY.md",
    "orca session resume rctx2_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    "docker inspect 6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "curl https://claude.ai/code/artifact/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
    "curl https://example.com/search?ref=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
    // JEVADV-37: a structural NAME using the same prefix a real credential
    // uses must survive -- see the npm_/hf_ tests below for the mechanism.
    "npm_config_registry=https://registry.npmjs.org/",
    "ls hf_cache/models",
  ];
  for (const command of secrets) {
    assert.ok(count(command) > 0, `expected a real secret to still be masked: ${command}`);
  }
  for (const command of falsePositives) {
    assert.equal(count(command), 0, `expected no masking on a false-positive-class command: ${command}`);
  }
});

// ===========================================================================
// Cross-cutting: idempotence, redactedCount, structure preservation
// ===========================================================================

test("idempotence: running redaction twice produces the same text, and the second pass redacts nothing new", () => {
  const command = 'export TOKEN=abc123; curl -H "Authorization: Bearer verylongbearertoken0123456789" https://user:hunter2@example.com';
  const first = redactSecretsForJev(command);
  const second = redactSecretsForJev(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.redactedCount, 0);
});

test("redactedCount: counts each distinct redaction, across different rules", () => {
  const command = 'export TOKEN=abc123 && curl -u user:hunter2 https://example.com';
  const result = redactSecretsForJev(command);
  assert.equal(result.redactedCount, 2);
});

test("redactedCount is 0 for a command with nothing to redact", () => {
  const result = redactSecretsForJev("git status");
  assert.equal(result.redactedCount, 0);
  assert.equal(result.text, "git status");
});

test("structure survives: flags, hosts and paths around a redacted value are untouched", () => {
  const command = "curl --retry 3 -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://api.example.com/v1/resource?x=1";
  const result = text(command);
  assert.match(result, /--retry 3/);
  assert.match(result, /https:\/\/api\.example\.com\/v1\/resource\?x=1/);
});

test("never redacts the whole command -- only the value half of a match", () => {
  const command = "export TOKEN=abc123456789";
  const result = text(command);
  assert.match(result, /^export TOKEN=/);
  assert.notEqual(result, MARKER);
});
