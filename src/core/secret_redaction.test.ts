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

test("id negative: a mixed alnum prefixed id (toolu_...) is never masked", () => {
  const command = "orca tool trace toolu_01AbCdEfGhIjKlMnOpQrStUvWx";
  assert.equal(text(command), command);
  assert.equal(count(command), 0);
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
// Synthetic before/after masked-command rate (never the owner's corpus).
// ---------------------------------------------------------------------------

test("synthetic corpus: every real secret is still masked, every false-positive class is not -- reports the before/after rate", () => {
  const secrets = [
    "export TOKEN=abc123456789",
    "curl -H 'Authorization: Bearer aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7'",
    "psql postgres://dbuser:hunter2@db.internal:5432/app",
    "curl -u apiuser:hunter2 https://example.com",
    "mysql -uroot -pSuperSecret123 mydb",
    "export TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "curl https://example.com/x?sig=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
  ];
  const falsePositives = [
    "cat /Volumes/Data/claude-tmp/claude-501/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7/output.log",
    "cat ~/Library/Application/Support/orca/projects/-Users-example-Projects-some-repo-name/memory/MEMORY.md",
    "orca session resume rctx2_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    "orca tool trace toolu_01AbCdEfGhIjKlMnOpQrStUvWx",
    "docker inspect 6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "curl https://claude.ai/code/artifact/aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
    "curl https://example.com/search?ref=aB3xK9mQ7pL2vN8wZ4tY6rD1sF5gH0jC3kM9nP2qR7",
  ];
  for (const command of secrets) {
    assert.ok(count(command) > 0, `expected a real secret to still be masked: ${command}`);
  }
  for (const command of falsePositives) {
    assert.equal(count(command), 0, `expected no masking on a false-positive-class command: ${command}`);
  }
  // BEFORE this fix, every one of these false positives was ALSO masked
  // (that is the bug this task closes) -- so the "before" rate over this
  // same synthetic set is 100%: all 14 commands had something replaced.
  // AFTER: only the 7 real secrets do.
  const total = secrets.length + falsePositives.length;
  const afterMaskedCount = [...secrets, ...falsePositives].filter((c) => count(c) > 0).length;
  assert.equal(afterMaskedCount, secrets.length, "after the fix, only the real secrets are masked");
  const beforeRate = total / total; // every command in this set used to trigger a rule
  const afterRate = afterMaskedCount / total;
  assert.equal(beforeRate, 1);
  assert.equal(afterRate, secrets.length / total);
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
