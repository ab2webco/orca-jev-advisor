import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ADVICE_OUTCOMES,
  OUTCOME_TTL_MS,
  RECENT_OUTCOMES,
  SILENT_AFTER,
  adviceKey,
  formatAdviceReplayMarkdown,
  isSilentKey,
  outcomeKey,
  parseAdviceOutcomes,
  recordAdviceIssued,
  recordIdenticalRetry,
  replayAdviceOutcomes,
  settleAdviceOutcomes,
  type AdviceOutcomeStore,
} from "./gate_advice_outcomes.ts";
import { ADVICE_RETRY_WINDOW_MS } from "./gate_advice_retry.ts";
import { buildGateDecisionRecord, commandFamily, parseGateDecisionRecords, serializeGateRecord, type GateDecisionRecord } from "./gate_measurement.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const MINUTE = 60 * 1000;

// --- what a family is, and why it is not what the gate learns on -------------

test("the family of a container or compound line is its first word or a pattern match, not what runs; none of them has an advice key", () => {
  // [command, the family gate_measurement.ts gives it today]
  const cases: readonly (readonly [string, string])[] = [
    ["bash -c 'make deploy'", "make"],
    ["sh -c \"gh pr merge 4\"", "gh cli"],
    ["python3 -c 'import shutil; shutil.rmtree(\"x\")'", "python3"],
    ["for b in a b; do gh pr merge $b; done", "for"],
    ["for f in *.md; do wc -l $f; done", "for"],
    ["echo x && gh pr merge 4", "gh cli"],
    ["echo x && orca game push", "echo"],
    ["ssh host 'systemctl restart api'", "ssh"],
    ["npx vercel deploy --prod", "npx"],
    ["make release", "make"],
    ["npm run deploy", "package script"],
    ["pnpm run build", "package script"],
  ];
  for (const [command, family] of cases) {
    assert.equal(commandFamily(command), family, `family of ${command}`);
    assert.equal(adviceKey(command), null, `${command} never goes silent`);
  }
});

test("outward or irreversible subcommands never have an advice key", () => {
  for (const command of [
    "gh pr merge 45 --squash",
    "gh pr create --fill",
    "gh pr close 4",
    "gh pr comment 4 --body hi",
    "gh release create v1.2.3",
    "gh release delete v1",
    "gh workflow run deploy.yml",
    "gh run rerun 123",
    "gh run cancel 123",
    "gh issue close 9",
    "gh issue delete 9",
    "gh repo delete acme/x",
    "gh api -X DELETE repos/acme/x",
    "gh api repos/acme/x",
    "git push origin feat/x",
    "git push --force origin main",
    "git -C /repo push origin main",
    "cd /repo && git push",
    "npm publish",
    "cargo publish",
    "orca game push",
    "orca worktree rm x",
    "brew uninstall x",
    "systemctl restart api",
    "kubectl get pods",
    "terraform plan",
    "docker ps",
    "curl -X POST https://example.com",
    "rsync -a a b",
  ]) {
    assert.equal(adviceKey(command), null, command);
  }
});

test("a single command with a plain program and subcommand has a key of plain words only", () => {
  assert.equal(adviceKey("gh pr view 45 --comments"), "gh pr view");
  assert.equal(adviceKey("gh run view 123 --log-failed"), "gh run view");
  assert.equal(adviceKey("gh pr checks 45"), "gh pr checks");
  assert.equal(adviceKey("git branch -D feat/old"), "git branch");
  assert.equal(adviceKey("cd /repo && git status"), "git status", "a leading cd is not the command that runs");
  assert.equal(adviceKey("orca game state --json"), "orca game state");
  assert.equal(adviceKey("rg TODO src"), "rg");
  assert.equal(adviceKey("TOKEN=ghp_secret gh pr view 4"), "gh pr view", "an assignment never reaches the key");
});

test("no key for substitutions, heredocs, paths, or a subcommand that is not a plain word", () => {
  for (const command of ["gh pr view $(cat n)", "gh pr view `cat n`", "cat <<'EOF' > x\nhi\nEOF", "./scripts/release.sh", "/usr/bin/git status", "git -C /repo status", "gh pr", "orca game"]) {
    assert.equal(adviceKey(command), null, command);
  }
});

test("the key survives the decision record, and a record never carries an argument in it", () => {
  const base = { id: "r", at: new Date(T0).toISOString(), project: "app", command: "gh pr view 4", source: "jev" as const, verdict: "advise" as const, latencyMs: 1, pluginVersion: "0", stopReason: "risk" as const };
  const keyed = buildGateDecisionRecord({ ...base, adviceKey: "gh pr view" });
  assert.equal(keyed.adviceKey, "gh pr view");
  assert.deepEqual(parseGateDecisionRecords(serializeGateRecord(keyed)), [keyed]);
  assert.equal(buildGateDecisionRecord({ ...base, adviceKey: "gh pr view ghp_SECRET" }).adviceKey, undefined, "a fourth word is not a key");
  assert.equal(buildGateDecisionRecord({ ...base, adviceKey: "cat /home/me/.env" }).adviceKey, undefined, "a path is not a key");
  assert.equal(buildGateDecisionRecord({ ...base, adviceKey: null }).adviceKey, undefined);
  assert.deepEqual(parseGateDecisionRecords(JSON.stringify({ ...keyed, adviceKey: "x Y" }) + "\n"), [], "a malformed key makes the row invalid");
});

// --- learning -----------------------------------------------------------------

/** `count` advices for (project, key), each retried unchanged one minute later. */
function retriedAdvices(store: AdviceOutcomeStore, project: string | null, key: string, count: number, start = T0): AdviceOutcomeStore {
  let next = store;
  for (let i = 0; i < count; i++) {
    const at = start + i * 2 * MINUTE;
    next = recordAdviceIssued(next, `k-${key}-${start}-${i}`, project, key, at);
    next = recordIdenticalRetry(next, `k-${key}-${start}-${i}`, at + MINUTE);
  }
  return next;
}

test("a key is not silent until its last SILENT_AFTER advices were all retried unchanged", () => {
  const almost = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "gh pr view", SILENT_AFTER - 1);
  assert.equal(isSilentKey(almost, "app", "gh pr view", T0 + 60 * MINUTE), false);
  const enough = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "gh pr view", SILENT_AFTER);
  assert.equal(isSilentKey(enough, "app", "gh pr view", T0 + 60 * MINUTE), true);
});

test("silence is per project and per key: another project, or another subcommand, still gets the advice", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "gh pr view", SILENT_AFTER);
  assert.equal(isSilentKey(store, "other-app", "gh pr view", T0 + 60 * MINUTE), false);
  assert.equal(isSilentKey(store, "app", "gh pr checks", T0 + 60 * MINUTE), false);
});

test("an advice whose window closes with no identical retry is 'changed' and ends the silence", () => {
  let store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "git branch", SILENT_AFTER);
  const at = T0 + 30 * MINUTE;
  store = recordAdviceIssued(store, "changed-1", "app", "git branch", at);
  assert.equal(isSilentKey(store, "app", "git branch", at + MINUTE), true, "still pending: not yet known");
  assert.equal(isSilentKey(store, "app", "git branch", at + ADVICE_RETRY_WINDOW_MS), false, "the window closed: the advice changed what ran");
  const settled = settleAdviceOutcomes(store, at + ADVICE_RETRY_WINDOW_MS);
  assert.deepEqual(settled.pending, {});
  assert.equal(settled.keys[outcomeKey("app", "git branch")]?.recent.at(-1), "changed");
});

test("a retry after the window is not counted as 'same'", () => {
  let store = recordAdviceIssued(EMPTY_ADVICE_OUTCOMES, "late", "app", "gh pr view", T0);
  store = recordIdenticalRetry(store, "late", T0 + ADVICE_RETRY_WINDOW_MS);
  assert.deepEqual(store.keys[outcomeKey("app", "gh pr view")]?.recent, ["changed"]);
});

test("a retry of something never advised (a local rule's advice) teaches nothing", () => {
  assert.deepEqual(recordIdenticalRetry(EMPTY_ADVICE_OUTCOMES, "unknown", T0).keys, {});
});

test("a key with no outcome for the TTL forgets what it learned", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "orca game state", SILENT_AFTER);
  const last = T0 + (SILENT_AFTER - 1) * 2 * MINUTE + MINUTE;
  assert.equal(isSilentKey(store, "app", "orca game state", last + OUTCOME_TTL_MS - 1), true);
  assert.equal(isSilentKey(store, "app", "orca game state", last + OUTCOME_TTL_MS), false);
});

test("recent outcomes are capped", () => {
  const store = retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "rg", RECENT_OUTCOMES + 5);
  assert.equal(store.keys[outcomeKey("app", "rg")]?.recent.length, RECENT_OUTCOMES);
});

test("parse is tolerant: garbage or another version is an empty store, a good store round-trips", () => {
  assert.deepEqual(parseAdviceOutcomes(null), EMPTY_ADVICE_OUTCOMES);
  assert.deepEqual(parseAdviceOutcomes({ version: 1, families: {}, pending: {} }), EMPTY_ADVICE_OUTCOMES, "the family-keyed store of an earlier build is dropped");
  assert.deepEqual(parseAdviceOutcomes({ version: 2, keys: { a: { recent: "x" } }, pending: { b: { key: 1 } } }), EMPTY_ADVICE_OUTCOMES);
  const store = recordAdviceIssued(retriedAdvices(EMPTY_ADVICE_OUTCOMES, "app", "rg", 3), "p", "app", "rg", T0 + 10 * MINUTE);
  assert.deepEqual(parseAdviceOutcomes(JSON.parse(JSON.stringify(store))), store);
  const mixed = parseAdviceOutcomes({ version: 2, keys: { k: { recent: ["same", "bogus", "changed"], lastAt: new Date(T0).toISOString() } }, pending: {} });
  assert.deepEqual(mixed.keys.k?.recent, ["same", "changed"]);
});

// --- replay over the decision log -------------------------------------------

let nextId = 0;
function record(at: number, fields: Partial<GateDecisionRecord>): GateDecisionRecord {
  return {
    type: "gate-decision",
    id: `r${nextId++}`,
    at: new Date(at).toISOString(),
    project: "app",
    commandFamily: "gh cli",
    source: "jev",
    verdict: "advise",
    latencyMs: 300,
    stopReason: "risk",
    adviceKey: "gh pr view",
    ...fields,
  };
}

test("replay links each keyed risk advice to its identical retry and reports what would have been silent", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER + 3; i++) {
    const at = T0 + i * 5 * MINUTE;
    records.push(record(at, {}));
    records.push(record(at + MINUTE, { verdict: "allow", stopReason: "advice-retry" }));
  }
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.advised, SILENT_AFTER + 3);
  assert.equal(replay.retried, SILENT_AFTER + 3);
  assert.equal(replay.wouldBeSilent, 3, "the first SILENT_AFTER advices teach, the rest would have been silent");
  assert.equal(replay.wouldBeSilentChanged, 0);
  assert.equal(replay.untouched, SILENT_AFTER + 3, "the retries themselves are untouched");
  assert.deepEqual(replay.keys.map((item) => item.key), ["gh pr view"]);
});

test("replay counts a would-be-silent advice whose next command changed", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER; i++) {
    const at = T0 + i * 15 * MINUTE;
    records.push(record(at, {}));
    records.push(record(at + MINUTE, { verdict: "allow", stopReason: "advice-retry" }));
  }
  records.push(record(T0 + SILENT_AFTER * 15 * MINUTE, {}));
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.wouldBeSilent, 1);
  assert.equal(replay.wouldBeSilentChanged, 1, "the ninth advice was not re-run: silencing it would have hidden an advice that mattered");
});

test("replay never silences an unkeyed advice (a container, an outward subcommand, or a record from before the key)", () => {
  const records: GateDecisionRecord[] = [];
  for (let i = 0; i < SILENT_AFTER * 2; i++) {
    const at = T0 + i * 5 * MINUTE;
    const legacy = { commandFamily: "gh cli", adviceKey: undefined };
    records.push(record(at, legacy));
    records.push(record(at + MINUTE, { ...legacy, verdict: "allow", stopReason: "advice-retry" }));
    records.push(record(at + 2 * MINUTE, { source: "local-rule", verdict: "advise", stopReason: "local-rule", adviceKey: undefined }));
    records.push(record(at + 3 * MINUTE, { verdict: "deny", stopReason: "local-rule", source: "local-rule", adviceKey: undefined }));
    records.push(record(at + 3 * MINUTE + 1000, { verdict: "ask", stopReason: "policy", policyId: "p", adviceKey: undefined }));
  }
  const replay = replayAdviceOutcomes(records);
  assert.equal(replay.wouldBeSilent, 0);
  assert.equal(replay.unkeyed, SILENT_AFTER * 2);
  assert.equal(replay.unkeyedRetried, SILENT_AFTER * 2);
  assert.deepEqual(replay.keys, []);
});

test("the Markdown says when no decision falls in the range, and --totals leaves the per-key table out", () => {
  const empty = replayAdviceOutcomes([]);
  assert.match(formatAdviceReplayMarkdown(empty, { from: "2026-10-15", to: "2026-10-23", filesRead: 0, recordsInRange: 0, oldest: null, newest: null }), /No gate decision files were found/);
  assert.match(
    formatAdviceReplayMarkdown(empty, { from: "2026-10-15", to: "2026-10-23", filesRead: 3, recordsInRange: 0, oldest: "2026-11-05T00:01:00.000Z", newest: "2026-11-13T23:00:00.000Z" }),
    /No gate decisions fall in 2026-10-15 to 2026-10-23\. The files read \(3\) hold decisions from 2026-11-05T00:01:00\.000Z to 2026-11-13T23:00:00\.000Z/,
  );
  const records = [record(T0, {}), record(T0 + MINUTE, { verdict: "allow", stopReason: "advice-retry" })];
  const coverage = { from: null, to: null, filesRead: 1, recordsInRange: 2, oldest: records[0]!.at, newest: records[1]!.at };
  const full = formatAdviceReplayMarkdown(replayAdviceOutcomes(records), coverage);
  assert.match(full, /\| gh pr view \| 1 \|/);
  const totals = formatAdviceReplayMarkdown(replayAdviceOutcomes(records), coverage, { totalsOnly: true });
  assert.doesNotMatch(totals, /gh pr view/);
  assert.match(totals, /Keyed risk advices: 1, re-run unchanged 1 \(100%\)/);
});
