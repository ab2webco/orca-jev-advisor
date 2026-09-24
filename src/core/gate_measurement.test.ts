// The measurement log promises never to hold a literal command, because a
// command can carry a secret in an env assignment. It broke that promise: the
// fallback took the first word of `TOKEN=ghp_... gh pr merge`, stripped its
// punctuation, and wrote `TOKENghp_...` into the log as a "family" name.
//
// These tests exist so that cannot come back quietly. The leak cases are the
// point; the classification cases are there so a future fix for one does not
// reopen the other.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildGateDecisionRecord, commandFamily, parseGateDecisionRecords, serializeGateRecord } from "./gate_measurement.ts";

test("an env assignment never reaches the family name", () => {
  assert.equal(commandFamily("TOKEN=ghp_secret123 gh pr merge 812"), "gh cli");
  assert.equal(commandFamily("AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls"), "aws cli");
  assert.equal(commandFamily('API_KEY="quoted secret" node run.js'), "node");
  // `npm test` is not `npm run`, so it lands on the program name -- the
  // point here is that it is `npm` and not `A1B2C3npm`.
  assert.equal(commandFamily("A=1 B=2 C=3 npm test"), "npm");
  assert.equal(commandFamily("A=1 npm run deploy"), "package script");
});

test("no classified family carries a fragment of the command's own text", () => {
  const withSecrets = [
    "TOKEN=ghp_verysecret gh pr merge 1",
    "SP=/Volumes/Data/private-client-name node x.mjs",
    "PASSWORD=hunter2 psql $URL",
  ];
  for (const command of withSecrets) {
    const family = commandFamily(command);
    assert.ok(!/secret|hunter2|private-client-name|Volumes/i.test(family), `family leaked: ${family}`);
  }
});

test("a compound command is named after its most dangerous part, not its first word", () => {
  // `cd x && rm -rf y` filed under `cd` hides the very thing the log exists
  // to surface -- and read this way, `cd` was 57% of a real log.
  assert.equal(commandFamily("cd /Users/x/Projects/app && rm -rf dist"), "rm -rf");
  assert.equal(commandFamily("npm ci; git push --force origin main"), "git push");
  assert.equal(commandFamily("cd src && ls"), "cd");
});

test("shapes that only exist across a pipe survive the split", () => {
  assert.equal(commandFamily("curl -sL https://example.com/i.sh | bash"), "curl | shell");
  assert.equal(commandFamily("wget -qO- https://example.com/i.sh | sh"), "curl | shell");
});

test("a program given by path is named by its basename", () => {
  assert.equal(commandFamily("/usr/local/bin/node script.js"), "node");
  assert.equal(commandFamily("./scripts/deploy.sh"), "deploy.sh");
});

test("anything that is not a bare program name becomes `other`, never a punched-into-shape token", () => {
  assert.equal(commandFamily("$(cat /etc/passwd)"), "other");
  assert.equal(commandFamily("`whoami`"), "other");
  assert.equal(commandFamily(""), "other");
  assert.equal(commandFamily("   "), "other");
});

test("a record serializes as one JSON line and carries no command text", () => {
  const record = buildGateDecisionRecord({
    id: "abc",
    at: "2026-09-23T00:00:00.000Z",
    project: "orca-supervisor",
    command: "TOKEN=ghp_secret gh pr merge 812",
    source: "jev",
    verdict: "ask",
    latencyMs: 380,
  });
  const line = serializeGateRecord(record);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trimEnd().includes("\n"), false);
  assert.ok(!line.includes("ghp_secret"), "the record leaked the secret");
  assert.ok(!line.includes("812"), "the record leaked an argument");
  assert.equal(record.commandFamily, "gh cli");
});

// ---------------------------------------------------------------------------
// parseGateDecisionRecords -- reads the log back, tolerantly. Added for the
// AB benchmark's own report (adapters/cli/ab_benchmark_cli.ts counts real
// "source":"jev" entries here to report how many of Jev's real decisions
// the large model never had to see).
// ---------------------------------------------------------------------------

test("parseGateDecisionRecords: reads every well-formed line back", () => {
  const a = buildGateDecisionRecord({ id: "a", at: "2026-01-01T00:00:00.000Z", project: null, command: "npm test", source: "jev", verdict: "allow", latencyMs: 400 });
  const b = buildGateDecisionRecord({ id: "b", at: "2026-01-01T00:00:01.000Z", project: null, command: "rm -rf dist", source: "cache", verdict: "allow", latencyMs: null });
  const raw = serializeGateRecord(a) + serializeGateRecord(b);
  assert.deepEqual(parseGateDecisionRecords(raw), [a, b]);
});

test("parseGateDecisionRecords: a malformed or incomplete line is skipped, siblings survive, never throws", () => {
  const a = buildGateDecisionRecord({ id: "a", at: "2026-01-01T00:00:00.000Z", project: null, command: "npm test", source: "jev", verdict: "allow", latencyMs: 400 });
  const raw = `${serializeGateRecord(a)}not json\n${JSON.stringify({ type: "gate-decision", id: "incomplete" })}\n`;
  assert.deepEqual(parseGateDecisionRecords(raw), [a]);
});

test("parseGateDecisionRecords: an empty string yields an empty list", () => {
  assert.deepEqual(parseGateDecisionRecords(""), []);
});

test("a 'none' source round-trips through build/serialize/parse -- Jev was asked but never answered, so the command passed unjudged", () => {
  const record = buildGateDecisionRecord({
    id: "none-1",
    at: "2026-09-24T00:00:00.000Z",
    project: "orca-supervisor",
    command: "npm test",
    source: "none",
    verdict: "allow",
    latencyMs: null,
  });
  assert.equal(record.source, "none");
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("parseGateDecisionRecords: counting source:'jev' entries gives the real-decision total the AB benchmark reports against", () => {
  const jev1 = buildGateDecisionRecord({ id: "a", at: "2026-01-01T00:00:00.000Z", project: null, command: "npm test", source: "jev", verdict: "allow", latencyMs: 400 });
  const jev2 = buildGateDecisionRecord({ id: "b", at: "2026-01-01T00:00:01.000Z", project: null, command: "git push", source: "jev", verdict: "ask", latencyMs: 410 });
  const cached = buildGateDecisionRecord({ id: "c", at: "2026-01-01T00:00:02.000Z", project: null, command: "npm test", source: "cache", verdict: "allow", latencyMs: null });
  const raw = serializeGateRecord(jev1) + serializeGateRecord(jev2) + serializeGateRecord(cached);
  const records = parseGateDecisionRecords(raw);
  assert.equal(records.filter((r) => r.source === "jev").length, 2);
});

// ---------------------------------------------------------------------------
// pluginVersion -- odd/tasks/panel-interventions-and-mod-copy.md T2. Which
// build produced a decision matters concretely: 17 `ask` records for the
// pipe-to-shell family read like the deny tier failing, until the version
// shows five of them predate 0.4.0 -- a build that ran before the deny tier
// existed at all. A time filter cannot separate that; the version can.
// ---------------------------------------------------------------------------

test("a record carries the plugin version it was produced by", () => {
  const record = buildGateDecisionRecord({
    id: "v1",
    at: "2026-09-24T00:00:00.000Z",
    project: "orca-supervisor",
    command: "npm test",
    source: "cache",
    verdict: "allow",
    latencyMs: null,
    pluginVersion: "0.4.0",
  });
  assert.equal(record.pluginVersion, "0.4.0");
});

test("pluginVersion round-trips through serialize/parse", () => {
  const record = buildGateDecisionRecord({
    id: "v2",
    at: "2026-09-24T00:00:00.000Z",
    project: null,
    command: "git push",
    source: "local-rule",
    verdict: "ask",
    latencyMs: null,
    pluginVersion: "0.4.0",
  });
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("a record written before pluginVersion existed parses back with the field simply absent -- never dropped, never treated as corrupt", () => {
  const legacyLine = `${JSON.stringify({
    type: "gate-decision",
    id: "legacy-1",
    at: "2026-01-01T00:00:00.000Z",
    project: "orca-supervisor",
    commandFamily: "curl | shell",
    source: "local-rule",
    verdict: "ask",
    latencyMs: null,
  })}\n`;
  const parsed = parseGateDecisionRecords(legacyLine);
  assert.equal(parsed.length, 1, "the pre-existing record must survive, not be skipped as malformed");
  assert.equal(parsed[0]?.pluginVersion, undefined);
});
