// Unit tests for tool_decisions.ts -- pure input to pure output, no
// fetch, no fs. Run with:
//   node --test src/core/tool_decisions.test.ts
//
// Covers the three things this module exists to get right, the same three
// measured against the live Jev API before skill_decisions.ts (its
// template) was written:
//
//   1. one question per axis: buildWideQuestions returns two SEPARATE
//      questions (`which`, `needsOneTool`), never one compound question.
//   2. the candidate's own card travels in the STATE, not only in the
//      choice's `criteria`: buildWideState/buildFitState carry the same
//      name/description every question already has.
//   3. the gate is answered by a separate atomic noul, never by `which`'s
//      own `confidence`: interpretWide reads the `needsOneTool` noul, and
//      decideTool never inspects a `confidence` field at all.
//
// Plus the full decideTool branch table, mirroring decisions.test.ts's
// shape for the older decisions.ts module.

import assert from "node:assert/strict";
import test from "node:test";

import type { Answer, ChoiceAnswer, NoulAnswer } from "./jev.ts";
import {
  DEFAULT_FITS_THRESHOLD,
  DEFAULT_GATE_THRESHOLD,
  buildFitQuestions,
  buildFitState,
  buildWideQuestions,
  buildWideState,
  decideTool,
  interpretFit,
  interpretWide,
  listingCharsFor,
  shortlistOf,
} from "./tool_decisions.ts";
import type { FitResult, OrcaContextState, ToolCandidate, ToolCandidateDetail, WideResult } from "./tool_decisions.ts";

const ORCA: OrcaContextState = { worktree: "/wt", project: "orca-supervisor", branch: "refactor/english-artifacts" };

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence = 0.5): ChoiceAnswer {
  return { type: "choice", choice, probabilities, confidence };
}

function noulAnswer(noul: number): NoulAnswer {
  return { type: "noul", noul };
}

const READ: ToolCandidate = { name: "Read", description: "Reads a file." };
const BASH: ToolCandidate = { name: "Bash", description: "Runs a shell command." };
const GREP: ToolCandidate = { name: "Grep", description: "Searches file contents." };

// --- rule 1: one question per axis, never compound -------------------------

test("buildWideQuestions returns two separate questions, `which` and `needsOneTool`, never a compound one", () => {
  const questions = buildWideQuestions([READ, BASH]);
  assert.equal(Object.keys(questions).length, 2);
  assert.equal(questions.which?.type, "choice");
  assert.equal(questions.needsOneTool?.type, "noul");
  // The gate's own criteria are sub-questions about the REQUEST, not about
  // any one tool -- never folded into the ranking choice's criteria.
  assert.ok(questions.needsOneTool && "criteria" in questions.needsOneTool && questions.needsOneTool.criteria);
});

test("buildFitQuestions returns `which` plus one atomic `fits::<name>` noul per candidate, never one question over all of them", () => {
  const shortlist: ToolCandidateDetail[] = [
    { ...READ, fullDescription: READ.description },
    { ...BASH, fullDescription: BASH.description },
  ];
  const questions = buildFitQuestions(shortlist);
  assert.equal(Object.keys(questions).length, 3);
  assert.equal(questions.which?.type, "choice");
  assert.equal(questions["fits::Read"]?.type, "noul");
  assert.equal(questions["fits::Bash"]?.type, "noul");
});

// --- rule 2: candidate card travels in the state, not only in criteria -----

test("buildWideState carries each candidate's name and description in the state", () => {
  const state = buildWideState("read src/core/jev.ts", [READ, BASH], ORCA);
  assert.ok(typeof state === "object" && state !== null && !Array.isArray(state));
  const record = state as Record<string, unknown>;
  assert.equal(record.request, "read src/core/jev.ts");
  assert.deepEqual(record.candidates, [
    { name: "Read", description: "Reads a file." },
    { name: "Bash", description: "Runs a shell command." },
  ]);
  assert.deepEqual(record.orcaContext, { worktree: "/wt", project: "orca-supervisor", branch: "refactor/english-artifacts" });
});

test("buildFitState carries each shortlisted candidate's full description as its card", () => {
  const shortlist: ToolCandidateDetail[] = [{ ...READ, fullDescription: "Reads a file from the local filesystem, up to 2000 lines by default." }];
  const state = buildFitState("read the file", shortlist, ORCA);
  const record = state as Record<string, unknown>;
  assert.deepEqual(record.candidates, [{ name: "Read", card: "Reads a file from the local filesystem, up to 2000 lines by default." }]);
});

test("a tool with an empty description still gets a non-empty fallback card everywhere", () => {
  const blank: ToolCandidate = { name: "Mystery", description: "" };
  assert.equal(listingCharsFor([blank]), "- Mystery: A tool named Mystery, with no description.\n".length);
  const questions = buildWideQuestions([blank]);
  assert.equal((questions.which as { criteria: Record<string, string> }).criteria.Mystery, "A tool named Mystery, with no description.");
});

// --- rule 3: the gate is its own atomic noul, never `which`'s confidence ---

test("interpretWide reads the gate from the `needsOneTool` noul, not from `which`'s confidence", () => {
  // `which` has high confidence, but the gate noul says no single tool is
  // needed: the gate must win, not confidence.
  const answers: Record<string, Answer> = {
    which: choiceAnswer("Read", { Read: 0.9, Bash: 0.1 }, 0.98),
    needsOneTool: noulAnswer(0.1),
  };
  const wide = interpretWide(answers);
  assert.ok(wide !== null);
  assert.equal(wide.needsOneTool, false);
  assert.equal(wide.gate, 0.1);
});

test("interpretWide ranks candidates surest first from `which`'s probabilities", () => {
  const answers: Record<string, Answer> = {
    which: choiceAnswer("Bash", { Read: 0.2, Bash: 0.7, Grep: 0.1 }),
    needsOneTool: noulAnswer(0.9),
  };
  const wide = interpretWide(answers);
  assert.ok(wide !== null);
  assert.deepEqual(
    wide.ranked.map((r) => r.name),
    ["Bash", "Read", "Grep"],
  );
});

test("interpretWide is null when `which` didn't answer, even if the gate did", () => {
  const wide = interpretWide({ needsOneTool: noulAnswer(0.9) });
  assert.equal(wide, null);
});

test("interpretWide fails open toward 'needs a tool' when the gate noul is missing entirely", () => {
  const wide = interpretWide({ which: choiceAnswer("Read", { Read: 1 }) });
  assert.ok(wide !== null);
  assert.equal(wide.gate, null);
  assert.equal(wide.needsOneTool, true);
});

test("the gate threshold is a boundary: exactly at it counts as needing a tool, just under does not", () => {
  const at = interpretWide({ which: choiceAnswer("Read", { Read: 1 }), needsOneTool: noulAnswer(DEFAULT_GATE_THRESHOLD) });
  const under = interpretWide({ which: choiceAnswer("Read", { Read: 1 }), needsOneTool: noulAnswer(DEFAULT_GATE_THRESHOLD - 0.001) });
  assert.equal(at?.needsOneTool, true);
  assert.equal(under?.needsOneTool, false);
});

// --- shortlisting ------------------------------------------------------

test("shortlistOf takes the top N ranked names still present in the candidate list", () => {
  const wide: WideResult = {
    ranked: [
      { name: "Bash", probability: 0.7 },
      { name: "Vanished", probability: 0.6 },
      { name: "Read", probability: 0.2 },
      { name: "Grep", probability: 0.1 },
    ],
    gate: 0.9,
    needsOneTool: true,
  };
  const shortlist = shortlistOf(wide, [READ, BASH, GREP], 2);
  assert.deepEqual(
    shortlist.map((c) => c.name),
    ["Bash", "Read"],
  );
});

// --- stage 2 interpretation ----------------------------------------------

test("interpretFit reads `which` as the winner and each `fits::<name>` noul independently", () => {
  const shortlist: ToolCandidateDetail[] = [
    { ...READ, fullDescription: READ.description },
    { ...BASH, fullDescription: BASH.description },
  ];
  const answers: Record<string, Answer> = {
    which: choiceAnswer("Bash", { Read: 0.3, Bash: 0.7 }),
    "fits::Read": noulAnswer(0.1),
    "fits::Bash": noulAnswer(0.9),
  };
  const fit = interpretFit(answers, shortlist);
  assert.equal(fit.winner, "Bash");
  assert.deepEqual(fit.fits, { Read: 0.1, Bash: 0.9 });
});

test("interpretFit omits a candidate whose `fits` noul Jev never answered", () => {
  const shortlist: ToolCandidateDetail[] = [{ ...READ, fullDescription: READ.description }];
  const fit = interpretFit({ which: choiceAnswer("Read", { Read: 1 }) }, shortlist);
  assert.equal(fit.winner, "Read");
  assert.deepEqual(fit.fits, {});
});

// --- decideTool: the full branch table -------------------------------------

test("decideTool: wide is null -> no suggestion", () => {
  const decision = decideTool(null, null, false);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /stage 1/);
});

test("decideTool: gate says no single tool needed -> no suggestion, regardless of the ranking", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.99 }], gate: 0.1, needsOneTool: false };
  const decision = decideTool(wide, null, false);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /no single tool needed/);
});

test("decideTool: gate needs a tool but stage 1 ranked nothing -> no suggestion", () => {
  const wide: WideResult = { ranked: [], gate: 0.9, needsOneTool: true };
  const decision = decideTool(wide, null, false);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /ranked no tool/);
});

test("decideTool: stage 2 was attempted but Jev answered nothing -> no suggestion (the winner's false-positive check never ran)", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.9 }], gate: 0.9, needsOneTool: true };
  const decision = decideTool(wide, null, true);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /stage 2 didn't answer/);
});

test("decideTool: stage 2 was never attempted -> top of the ranking wins", () => {
  const wide: WideResult = {
    ranked: [
      { name: "Bash", probability: 0.9 },
      { name: "Read", probability: 0.1 },
    ],
    gate: 0.9,
    needsOneTool: true,
  };
  const decision = decideTool(wide, null, false);
  assert.equal(decision.name, "Bash");
  assert.match(decision.reason, /no stage 2/);
});

test("decideTool: every fit is below threshold -> nothing is suggested, even though `which` chose one", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.9 }], gate: 0.9, needsOneTool: true };
  const fit: FitResult = { winner: "Bash", fits: { Bash: 0.05 } };
  const decision = decideTool(wide, fit, true);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /nothing fits/);
});

test("decideTool: fit threshold is a boundary, exactly at it passes", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.9 }], gate: 0.9, needsOneTool: true };
  const fit: FitResult = { winner: "Bash", fits: { Bash: DEFAULT_FITS_THRESHOLD } };
  const decision = decideTool(wide, fit, true);
  assert.equal(decision.name, "Bash");
});

test("decideTool: stage 2 chose no winner even though a fit cleared the threshold -> no suggestion", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.9 }], gate: 0.9, needsOneTool: true };
  const fit: FitResult = { winner: null, fits: { Bash: 0.8 } };
  const decision = decideTool(wide, fit, true);
  assert.equal(decision.name, null);
  assert.match(decision.reason, /chose none/);
});

test("decideTool: the normal path -- stage 2's winner, with its fit value in the reason", () => {
  const wide: WideResult = { ranked: [{ name: "Bash", probability: 0.6 }], gate: 0.9, needsOneTool: true };
  const fit: FitResult = { winner: "Bash", fits: { Bash: 0.85 } };
  const decision = decideTool(wide, fit, true);
  assert.equal(decision.name, "Bash");
  assert.match(decision.reason, /stage 2, fits 0\.85/);
});
