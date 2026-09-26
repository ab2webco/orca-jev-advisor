// Unit tests for resolvePersonEffect -- pure input to pure output. Priority
// order: named unrecoverable files > deploy/publish > leaves this machine >
// cannot be undone > others will notice (the always-available floor).

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
    riskReasonKey: "reason.cannotUndo",
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
  const effect = resolvePersonEffect({ deployPublishKind: "deploy", ruleKey: "rule.rmRf", riskReasonKey: "reason.cannotUndo" });
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

test("the risk stage's own combined reason leaves this machine, outranking a plain cannotUndo", () => {
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.cannotUndoAndLeavesMachine" }).key, "effect.leavesMachine");
});

test("the risk stage's own plain reasons map to cannotUndo / othersNotice", () => {
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.cannotUndo" }).key, "effect.cannotUndo");
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.someoneElseWillNotice" }).key, "effect.othersNotice");
});

test("reasons with no concrete fact of their own (a borderline score, an unspecified consequence) fall back to othersNotice, never an abstract phrase", () => {
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.tooCloseToTheLine" }).key, "effect.othersNotice");
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.breaksSomethingImportant" }).key, "effect.othersNotice");
  assert.equal(resolvePersonEffect({ riskReasonKey: "reason.needsCleanupAfter" }).key, "effect.othersNotice");
});

test("no signal at all -- a defensive floor -- still resolves to the generic, non-vacuous othersNotice", () => {
  assert.equal(resolvePersonEffect({}).key, "effect.othersNotice");
});
