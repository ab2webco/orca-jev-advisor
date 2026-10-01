# Release 0.6.22: Jev judgment health probes

## Objective
JEVADV-97. Measure how well Jev's answers hold up, so a Jev model update or an edit to a question can be checked with one command, and so floors are changed only on evidence. The methods come from the jev-use evaluation (MIT, methods only). Every part is read-only or log-only. No floor or threshold changes in this release.

Authorized by the owner on 2026-10-01 ("sigue con la 98 y si puedes las demas en paralelo"). Two writers in separate worktrees, integrated here by cherry-pick (no merge commits).

## Scope
- **T1 Distribution margin (writer A, branch `0622-margin`).**
  - Add `margin = top probability − runner-up probability` to the router decision rows (`RouterDecisionRecord`) and the steward rows (`StewardRecord`), next to the reported confidence.
  - The margin is computed from `Answer.probabilities`.
  - It is absent (never `NaN`, never 0 as a stand-in) when the map has fewer than two numeric values or holds a non-number.
  - No floor changes: `CONFIDENCE_FLOOR`, `STEWARD_CONFIDENCE_FLOOR` and `SOFT_MID_TASK_FLOOR` stay as they are.
- **T2 Option usage (writer B, branch `0622-jev-health`).**
  - `npm run jev-health -- usage [--days N]` reads the real router and steward logs.
  - Per question (router `tier` per point, router work kind, steward `verdict`), it prints each option's count, share and mean confidence, plus the mean margin over the rows that carry one.
  - Rows written before T1 show the margin as n/a, never 0.
  - An option chosen 0 times is printed as a finding.
  - CLI only. The board does not change in this release.
- **T3 Flip rate (writer B).**
  - `npm run jev-health -- flips [--commands-file F] [--runs N]` puts the gate questions (`buildActionGateState`, `buildActionGateQuestions`) to the real Jev N times per command.
  - Per question it reports how many commands changed answer across runs (the noul value, the consequence level and the choice), and the spread of the consequence score against `CONSEQUENCE_NOISE_MARGIN`.
  - The default corpus is a committed file built only from command strings already in committed tests and fixtures (they have passed the privacy check), so the check is one command for anyone.
  - Defaults: N = 5. Corpus about 40 commands, about 200 calls.
- **T4 Redaction impact (writer B).**
  - `npm run jev-health -- redaction --commands-file F` puts each command to Jev twice, once with the normal redacted state and once with the raw state.
  - It lists the commands whose gate outcome flips, and those whose consequence or violation confidence crosses a threshold.
  - The raw state comes from an injected redactor parameter (default `redactSecretsForJev`; the CLI passes identity). It is never a boolean, never reachable from hook input, and a test asserts that `gate-bash.ts` never passes it.
  - The corpus with fake secrets stays outside the repository (scratchpad). It is never committed.
  - About 30 commands, 60 calls.
  - Local rules are added only for commands that actually flip. If none flip, the finding closes the card.
- **T5** Run T2–T4 on real data and record the findings in the QA file.
- **T6** README ("What changed"), CHANGELOG, version, QA in `odd/qa/qa-0.6.22.md`, release, live check. The live check covers the new margin field on router and steward rows from a real Claude Code session in an Orca terminal (second account). It also confirms that the five mod copies carry the updated hooks.

## Checklist
- [ ] T1 margin on router and steward rows
- [ ] T2 `jev-health usage`
- [ ] T3 `jev-health flips`
- [ ] T4 `jev-health redaction`
- [ ] T5 run the probes, record findings
- [ ] T6 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change (RED observed, then GREEN).
- `npm run typecheck` exits 0 and `npm test` is green.
- The gate replay sets pass unchanged: replay-0615 244, new-0613 38, n09-0614 10, t1-0617 11, t2-live 16, t3-live 9.
- The privacy test exits 0, and no fake secret is in the repository.
- No floor, ceiling or margin constant changes.
