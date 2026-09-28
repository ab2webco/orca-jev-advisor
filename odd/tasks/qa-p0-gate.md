# QA 0.6.5 P0: gate bypasses, unredacted prompts, board XSS, mod-tools above 255

## Objective
Close the P0 findings of the independent QA of 0.6.5 (2026-09-28, Plane
JEVADV-58) and the mod-tools failure found while triaging it.

## Scope (authorized by the owner 2026-09-28: "Dale empieza")
- T1 C1 (JEVADV-59): `awk` and `sed -n` leave tier 1a and the mention-only
  verbs. `src/core/gate_safe_command.ts` (+ test).
- T2 C2 (JEVADV-60): heredoc openers are quote-aware and `<<<` opens nothing.
  `src/core/command_text.ts` (+ test).
- T3 A1 (JEVADV-61): model, skill and tool decisions redact secrets before Jev
  and before the measurement records. `src/core/model_decisions.ts`,
  `skill_decisions.ts`, `tool_decisions.ts` (+ tests).
- T4 A9 (JEVADV-69): board `esc()` escapes quotes, with a hostile-input panel
  test. `adapters/orca/panels/board.html`, `scripts/panels.spec.mjs`.
- T5 JEVADV-76: mod-tools never sends more than 255 choices to Jev.
  `src/core/tool_decisions.ts`, `skill_decisions.ts` (+ tests).

Out of scope: the remaining high, medium and low findings (JEVADV-62..74).

## Checklist
- [x] T1 C1 awk / sed -n (RED: QA repro failed; GREEN: 38/38 unit, 2266/2266 suite)
- [ ] T2 C2 phantom heredoc
- [ ] T3 A1 redaction in model, skill and tool decisions
- [ ] T4 A9 esc() quotes
- [ ] T5 mod-tools 255-choice limit

## Acceptance criteria
- Every QA repro for C1 and C2 is a regression test that failed before the fix.
- No prompt reaches Jev or a measurement record from these three paths without
  `redactSecretsForJev`.
- A board value containing `"` cannot close an attribute.
- A tool roster over 255 never produces a 400 from Jev.

## Checks
- `npm test` (full suite), `npm run check` for T4, screenshots of the board at
  1440/768/390/320 in both themes, looked at.
