// Unit tests for resolvePersonEffect -- pure input to pure output. Priority
// order: named unrecoverable files > deploy/publish > local rule effect >
// leaves this machine > cannot be undone > someone else will notice.
//
// 0.5.3: a field test of 0.5.2 found the person-facing line claiming "lo
// verán otras personas" (someone else will notice) for an advised `rm -rf
// tmp/` on an untracked local dir with no collaborators -- a factual claim
// nothing about the command actually supported. Two causes, both closed
// here: only the FIRST risk reason was ever passed in, and three reasons
// with no concrete fact of their own (breaksSomethingImportant,
// needsCleanupAfter, tooCloseToTheLine) were mapped to othersNotice, which
// asserts something specific and often untrue. Now EVERY risk reason is
// checked, in a fixed priority order (never the order they happen to be
// listed in), and othersNotice is reachable ONLY through
// reason.someoneElseWillNotice -- nothing else ever maps to it. Every other
// case, including no signal at all, resolves to the new, honest
// effect.uncertain floor.

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePersonEffect } from "./gate_person_effect.ts";
import type { RecoverabilitySegmentResult } from "./git_recoverability.ts";

function recoverabilityWith(paths: ReadonlyArray<{ readonly path: string; readonly why: "uncommitted-changes" | "untracked" | "secret" | "build-or-temp" | "committed-clean" }>): readonly RecoverabilitySegmentResult[] {
  return [{ shape: "rm", classified: paths, unresolvedTargets: [] }];
}

test("named unrecoverable files win over every other signal", () => {
  const effect = resolvePersonEffect({
    recoverability: recoverabilityWith([{ path: "src/a.ts", why: "uncommitted-changes" }]),
    deployPublishKind: "publish",
    ruleKey: "rule.forcePush",
    riskReasonKeys: ["reason.cannotUndo"],
  });
  assert.equal(effect.key, "effect.namedFiles");
  assert.deepEqual(effect.files, ["src/a.ts"]);
});

test("build-or-temp and committed-clean targets are never named -- only the protected whys", () => {
  const effect = resolvePersonEffect({
    recoverability: recoverabilityWith([
      { path: "dist/main.js", why: "build-or-temp" },
      { path: "README.md", why: "committed-clean" },
    ]),
  });
  assert.notEqual(effect.key, "effect.namedFiles");
});

test("named files are de-duplicated and capped at 3", () => {
  const effect = resolvePersonEffect({
    recoverability: [
      { shape: "rm", classified: [{ path: "a.ts", why: "uncommitted-changes" }], unresolvedTargets: [] },
      { shape: "rm", classified: [{ path: "a.ts", why: "uncommitted-changes" }, { path: "b.ts", why: "untracked" }, { path: "c.env", why: "secret" }, { path: "d.ts", why: "uncommitted-changes" }], unresolvedTargets: [] },
    ],
  });
  assert.equal(effect.key, "effect.namedFiles");
  assert.equal(effect.files?.length, 3);
  assert.deepEqual(effect.files, ["a.ts", "b.ts", "c.env"]);
});

test("a deploy is bucketed separately from a publish", () => {
  assert.equal(resolvePersonEffect({ deployPublishKind: "deploy" }).key, "effect.deploy");
  assert.equal(resolvePersonEffect({ deployPublishKind: "publish" }).key, "effect.publish");
});

test("deploy/publish outranks a rule or risk-reason effect", () => {
  const effect = resolvePersonEffect({ deployPublishKind: "deploy", ruleKey: "rule.rmRf", riskReasonKeys: ["reason.cannotUndo"] });
  assert.equal(effect.key, "effect.deploy");
});

test("a local rule's own effect: force push and push-protected leave this machine", () => {
  assert.equal(resolvePersonEffect({ ruleKey: "rule.forcePush" }).key, "effect.leavesMachine");
  assert.equal(resolvePersonEffect({ ruleKey: "rule.pushProtected" }).key, "effect.leavesMachine");
});

test("a local rule's own effect: rmRf, resetClean, dropTable and curlPipeShell cannot be undone", () => {
  for (const ruleKey of ["rule.rmRf", "rule.resetClean", "rule.dropTable", "rule.curlPipeShell"] as const) {
    assert.equal(resolvePersonEffect({ ruleKey }).key, "effect.cannotUndo");
  }
});

test("a local rule's own effect: kubectlDelete and terraform apply/destroy leave this machine", () => {
  for (const ruleKey of ["rule.kubectlDelete", "rule.terraformApply", "rule.terraformDestroy"] as const) {
    assert.equal(resolvePersonEffect({ ruleKey }).key, "effect.leavesMachine");
  }
});

test("a local rule's own effect outranks the risk stage's own reasons", () => {
  const effect = resolvePersonEffect({ ruleKey: "rule.forcePush", riskReasonKeys: ["reason.someoneElseWillNotice"] });
  assert.equal(effect.key, "effect.leavesMachine");
});

test("the risk stage's own combined reason leaves this machine, outranking a plain cannotUndo in the same list", () => {
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.cannotUndo", "reason.cannotUndoAndLeavesMachine"] }).key, "effect.leavesMachine");
});

test("the risk stage's own plain reasons map to cannotUndo / othersNotice", () => {
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.cannotUndo"] }).key, "effect.cannotUndo");
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.someoneElseWillNotice"] }).key, "effect.othersNotice");
});

// The B6 field-test case: Jev cited three reasons for one advised command --
// needsCleanupAfter (no concrete fact of its own), cannotUndo (concrete),
// and noDestinationMatched (not even a risk axis). The person-facing line
// must name "cannot be undone", never "someone else will notice" -- proving
// the priority scan checks every key in the list, not just the first.
test("B6: [needsCleanupAfter, cannotUndo, noDestinationMatched] resolves to cannotUndo -- the priority order, not the list order, decides", () => {
  const effect = resolvePersonEffect({ riskReasonKeys: ["reason.needsCleanupAfter", "reason.cannotUndo", "reason.noDestinationMatched"] });
  assert.equal(effect.key, "effect.cannotUndo");
});

// Priority-not-order, pinned a second way: someoneElseWillNotice sorts
// BEFORE cannotUndo in this list, yet cannotUndo must still win -- proving
// the scan follows the fixed priority order, never "first match in the
// array".
test("priority order wins over list order: [needsCleanupAfter, someoneElseWillNotice, cannotUndo] still resolves to cannotUndo", () => {
  const effect = resolvePersonEffect({ riskReasonKeys: ["reason.needsCleanupAfter", "reason.someoneElseWillNotice", "reason.cannotUndo"] });
  assert.equal(effect.key, "effect.cannotUndo");
});

test("[someoneElseWillNotice] alone resolves to othersNotice", () => {
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.someoneElseWillNotice"] }).key, "effect.othersNotice");
});

test("[needsCleanupAfter] alone -- no concrete fact of its own -- resolves to the new, honest uncertain floor, never othersNotice", () => {
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.needsCleanupAfter"] }).key, "effect.uncertain");
});

test("reasons with no concrete fact of their own (a borderline score, an unspecified consequence) fall back to uncertain, never othersNotice and never an abstract phrase", () => {
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.tooCloseToTheLine"] }).key, "effect.uncertain");
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.breaksSomethingImportant"] }).key, "effect.uncertain");
  assert.equal(resolvePersonEffect({ riskReasonKeys: ["reason.needsCleanupAfter"] }).key, "effect.uncertain");
});

test("a reason key this build does not recognise (stale or hand-edited) is ignored, never crashes, and still floors to uncertain", () => {
  const effect = resolvePersonEffect({ riskReasonKeys: ["reason.someInventedKeyThisBuildDoesNotKnow" as never] });
  assert.equal(effect.key, "effect.uncertain");
});

test("no signal at all -- a defensive floor -- resolves to the honest, non-vacuous uncertain, never a vacant claim about other people", () => {
  assert.equal(resolvePersonEffect({}).key, "effect.uncertain");
  assert.equal(resolvePersonEffect({ riskReasonKeys: [] }).key, "effect.uncertain");
  assert.equal(resolvePersonEffect({ riskReasonKeys: null }).key, "effect.uncertain");
});
