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

import { buildGateDecisionRecord, canonicalCommandFamily, commandFamily, parseGateDecisionRecords, serializeGateRecord, splitSegments } from "./gate_measurement.ts";

test("an env assignment never reaches the family name", () => {
  assert.equal(commandFamily("TOKEN=ghp_secret123 gh pr merge 812"), "gh cli");
  assert.equal(commandFamily("AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls"), "aws cli");
  assert.equal(commandFamily('API_KEY="quoted secret" node run.js'), "node");
  // `npm test` is not `npm run`, so it lands on the program name -- the
  // point here is that it is `npm` and not `A1B2C3npm`.
  assert.equal(commandFamily("A=1 B=2 C=3 npm test"), "npm");
  assert.equal(commandFamily("A=1 npm run deploy"), "package script");
});

// odd/tasks/release-0.5.1.md T9 (JEVADV-25): `stripAssignments` required a
// `\s+` AFTER the assignment, so once `splitSegments` had already isolated
// a leading `NAME=value` into its own segment (nothing trailing it
// anymore), the regex stopped matching it at all. The fallback then took
// THAT unstripped segment as the family's raw material: `programName`
// found a `/` in the assignment's VALUE and returned its basename as the
// family -- `DEV=/Users/x/Projects/orca-jev-advisor-dev` was logged as
// commandFamily `orca-jev-advisor-dev`, a project path standing in for a
// program name. `export NAME=value;` never matched at all, for the same
// reason plus the unhandled `export` keyword.
test("a leading env assignment isolated by its own separator still never reaches the family name", () => {
  assert.equal(commandFamily("A=/x/y; node z"), "node");
  assert.equal(commandFamily("DEV=/Users/x/Projects/orca-jev-advisor-dev; node run.mjs"), "node");
});

test("export NAME=value; is skipped like a bare assignment, leaving the family of the first real command", () => {
  // `cd` is not stripped or specially treated -- same "existing rules"
  // commandFamily already documents for `cd src && ls` above: the
  // fallback is the first segment's own program name, whatever it is.
  assert.equal(commandFamily("export PATH=/usr/bin; cd d && git status"), "cd");
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

// ---------------------------------------------------------------------------
// stopReason / policyId -- odd/tasks/release-0.5.1.md T1. `source` alone
// mixed policy stops, local-rule asks and uncacheable commands into one
// indistinguishable "jev" bucket; stopReason splits it finer, and a policy
// stop also carries which policy resolved it.
// ---------------------------------------------------------------------------

test("a record carries the stopReason it was built with", () => {
  const record = buildGateDecisionRecord({
    id: "sr-1",
    at: "2026-09-25T00:00:00.000Z",
    project: "orca-supervisor",
    command: "rm -rf dist",
    source: "jev",
    verdict: "ask",
    latencyMs: 300,
    pluginVersion: "0.5.1",
    stopReason: "risk",
  });
  assert.equal(record.stopReason, "risk");
});

test("stopReason round-trips through serialize/parse", () => {
  const record = buildGateDecisionRecord({
    id: "sr-2",
    at: "2026-09-25T00:00:01.000Z",
    project: null,
    command: "git push --force",
    source: "local-rule",
    verdict: "deny",
    latencyMs: null,
    pluginVersion: "0.5.1",
    stopReason: "local-rule",
  });
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("a record written before stopReason existed parses back with the field simply absent -- never dropped, never treated as corrupt", () => {
  const legacyLine = `${JSON.stringify({
    type: "gate-decision",
    id: "legacy-sr",
    at: "2026-01-01T00:00:00.000Z",
    project: "orca-supervisor",
    commandFamily: "rm -rf",
    source: "jev",
    verdict: "ask",
    latencyMs: 300,
  })}\n`;
  const parsed = parseGateDecisionRecords(legacyLine);
  assert.equal(parsed.length, 1, "the pre-existing record must survive, not be skipped as malformed");
  assert.equal(parsed[0]?.stopReason, undefined);
});

test("policyId is present only for a policy stop -- a risk stop carries no policyId key at all, not policyId:null", () => {
  const record = buildGateDecisionRecord({
    id: "sr-3",
    at: "2026-09-25T00:00:02.000Z",
    project: null,
    command: "npm run deploy",
    source: "jev",
    verdict: "ask",
    latencyMs: 320,
    pluginVersion: "0.5.1",
    stopReason: "risk",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(record, "policyId"), false);
});

test("a policy stop carries the policy's id, ids only -- never the command", () => {
  const record = buildGateDecisionRecord({
    id: "sr-4",
    at: "2026-09-25T00:00:03.000Z",
    project: null,
    command: "echo 'client site work'",
    source: "jev",
    verdict: "ask",
    latencyMs: 280,
    pluginVersion: "0.5.1",
    stopReason: "policy",
    policyId: "client_always_asks",
  });
  assert.equal(record.policyId, "client_always_asks");
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("a source:'none' record carries stopReason 'unreachable' -- Jev was asked but never answered", () => {
  const record = buildGateDecisionRecord({
    id: "sr-5",
    at: "2026-09-25T00:00:04.000Z",
    project: null,
    command: "npm test",
    source: "none",
    verdict: "allow",
    latencyMs: null,
    pluginVersion: "0.5.1",
    stopReason: "unreachable",
  });
  assert.equal(record.stopReason, "unreachable");
});

test("an advise verdict with stopReason 'advice-retry' round-trips -- an identical retry let a past advise through as a truthful allow", () => {
  const record = buildGateDecisionRecord({
    id: "sr-advice-retry",
    at: "2026-09-26T00:00:00.000Z",
    project: null,
    command: "rm -rf dist src/a.ts",
    source: "jev",
    verdict: "allow",
    latencyMs: null,
    pluginVersion: "0.5.1",
    stopReason: "advice-retry",
  });
  assert.equal(record.verdict, "allow");
  assert.equal(record.stopReason, "advice-retry");
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("an 'advise' verdict round-trips and is never dropped as an unrecognised verdict", () => {
  const record = buildGateDecisionRecord({
    id: "sr-advise",
    at: "2026-09-26T00:00:01.000Z",
    project: null,
    command: "rm -rf dist src/a.ts",
    source: "jev",
    verdict: "advise",
    latencyMs: 250,
    pluginVersion: "0.5.1",
    stopReason: "risk",
  });
  assert.equal(record.verdict, "advise");
  const raw = serializeGateRecord(record);
  assert.deepEqual(parseGateDecisionRecords(raw), [record]);
});

test("parseGateDecisionRecords: a line with an invalid stopReason value is skipped, siblings survive", () => {
  const good = buildGateDecisionRecord({
    id: "sr-6",
    at: "2026-01-01T00:00:00.000Z",
    project: null,
    command: "npm test",
    source: "cache",
    verdict: "allow",
    latencyMs: null,
    pluginVersion: "0.5.1",
    stopReason: "cache",
  });
  const badLine = `${JSON.stringify({
    type: "gate-decision",
    id: "sr-bad",
    at: "2026-01-01T00:00:00.000Z",
    project: null,
    commandFamily: "npm",
    source: "cache",
    verdict: "allow",
    latencyMs: null,
    stopReason: "not-a-real-reason",
  })}\n`;
  const raw = serializeGateRecord(good) + badLine;
  assert.deepEqual(parseGateDecisionRecords(raw), [good]);
});

test("discarding uncommitted work groups with reset/clean, a branch switch does not", () => {
  assert.equal(commandFamily("git reset --hard"), "git discard");
  assert.equal(commandFamily("git clean -fd"), "git discard");
  assert.equal(commandFamily("git checkout -- src/app.ts"), "git discard");
  assert.equal(commandFamily("git checkout ."), "git discard");
  assert.equal(commandFamily("git restore src/app.ts"), "git discard");
  assert.equal(commandFamily("cd repo && git restore ."), "git discard");
  assert.equal(commandFamily("git checkout main"), "git");
  assert.equal(commandFamily("git checkout -b feature/x"), "git");
  assert.equal(commandFamily("git restore --staged src/app.ts"), "git");
});

test("a record written under the old reset/clean label reads as the same family", () => {
  assert.equal(canonicalCommandFamily("git reset/clean"), "git discard");
  assert.equal(canonicalCommandFamily("git discard"), "git discard");
  assert.equal(canonicalCommandFamily("terraform"), "terraform");
});

// ---------------------------------------------------------------------------
// SECURITY HOTFIX (release-0.5.1-newline-bypass): splitSegments used to be a
// naive `command.split(/\|\||&&|[;|]/)` -- it never split on a newline or on
// a single background `&`, so `ls\nrm -rf $HOME` read as ONE segment whose
// own leading verb let gate_safe_command.ts's per-segment checks
// (isObviouslySafeCommand, mentionsRatherThanRuns) wave the rest through
// silently. It now delegates to git_discard.ts's own
// splitOnCommandSeparators -- the SAME primitive the deny-tier side
// (someSegmentMatches, discardsUncommittedWork) already used, so both sides
// of the gate finally agree on what separates two commands.
// ---------------------------------------------------------------------------

test("splitSegments splits on a bare newline, exactly like `;`", () => {
  assert.deepEqual(splitSegments("ls\npwd"), ["ls", "pwd"]);
  assert.deepEqual(splitSegments("ls\r\npwd"), ["ls", "pwd"]);
  assert.deepEqual(splitSegments("ls\nrm -rf $HOME"), ["ls", "rm -rf $HOME"]);
});

test("splitSegments splits on a lone `&`, exactly like `;`, but keeps `&&` as one joiner (still splits into two segments, never three)", () => {
  assert.deepEqual(splitSegments("ls & pwd"), ["ls", "pwd"]);
  assert.deepEqual(splitSegments("ls && pwd"), ["ls", "pwd"]);
  assert.deepEqual(splitSegments("ls & git push --force origin main"), ["ls", "git push --force origin main"]);
});

test("splitSegments leaves a redirection's own `&`/`|` alone -- never mistaken for a separator", () => {
  assert.deepEqual(splitSegments("git status 2>&1"), ["git status 2>&1"]);
  assert.deepEqual(splitSegments("cmd >&2"), ["cmd >&2"]);
  assert.deepEqual(splitSegments("cmd &>file"), ["cmd &>file"]);
  assert.deepEqual(splitSegments("cmd &>>file"), ["cmd &>>file"]);
  assert.deepEqual(splitSegments("cmd <&0"), ["cmd <&0"]);
  assert.deepEqual(splitSegments("git status 2>&1 | tail -5"), ["git status 2>&1", "tail -5"]);
});

test("commandFamily still resolves the most dangerous part across a newline or a lone `&`, not just `;`/`&&`", () => {
  assert.equal(commandFamily("ls\nrm -rf $HOME"), "rm -rf");
  assert.equal(commandFamily("pwd & git push --force origin main"), "git push");
});
