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

test("entropy false positive (documented, accepted): an npm integrity hash's VALUE is masked -- it has the same shape this rule exists to catch, but the --integrity= flag name itself survives", () => {
  const integrity = "sha512-oIPzksC78K18u7fj2CqQCu3RWH+iuZzuVaOFm4/n/Y3hoRJhqxwj5CTdMxqOWx6mp5PU2SBn/JLDLZ7SkRvzow==";
  const command = `npm install --save foo@1.0.0 --integrity=${integrity}`;
  const result = text(command);
  assert.notEqual(result, command, "documented false positive: integrity hashes look exactly like a high-entropy secret");
  assert.match(result, /--integrity=/, "the flag NAME must survive even when its value is masked");
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
