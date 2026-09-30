# Release 0.6.15: the gate reads what runs, policies judged on effect

## Objective
Remove the root cause of the gate's false positives instead of listing
exceptions one by one, so the plugin can be declared stable by a measured
criterion (odd/qa/qa-0.6.13.md, "Root cause of the false positives"): the
share of real commands stopped stays under 1% with zero false `REFUSED` on
legitimate work over a week of real use.
Authorized by the owner 2026-09-30 ("continuemos con el trabajo" after
0.6.14; the 0.6.15 scope was stated to them: JEVADV-83, 84, 86, 87).
Plane: JEVADV-83, 84, 86, 87.

## Scope
- T1 JEVADV-83, N-10, N-11: only words in command position are read as
  commands, by the local rules and by Jev. Everything else (a `for` list's
  words, `python3 -c`/`node -e` source, a script's arguments, a quoted
  argument of any program) is a placeholder unless the program is known to
  run it: `eval`, `bash|sh|zsh -c`, `ssh host cmd`, `watch`, `xargs`,
  `find -exec`, `$( )`/backticks, and an interpreter's program read as its
  language reads it (0.6.14 N-09 machinery, extended to `-c`/`-e` and to
  Python f-string `{…}` expressions, N-10). `const fs = require("fs")` is not
  a command the heredoc runs (N-11). Accept on: the 244-row replay, the 38
  new rows and 10 N-09 rows of qa-0.6.13/0.6.14 (no refusal lost), plus a
  false-positive corpus drawn from real sessions (gate-decisions.jsonl stops
  whose identical retry ran, and the lead's own advised commands in the
  0.6.12..0.6.14 sessions), published with its size.
- T2 JEVADV-84 (N-05): a `requires_human` policy is judged on effect, like
  `prohibits` in 0.6.13 T2: Jev is asked whether the action does what the
  rule says needs a person, not what it is about. `terraform plan`, `kubectl
  get|describe|logs` pass under `infrastructure_changes`; `terraform apply`
  and `kubectl delete` still ask (or are refused by the local rule).
  Calibrated on a labelled corpus against live Jev, band and size published.
- T3 JEVADV-86: N-06 (a push to main from a feature checkout with a local
  bare remote is decided near the gate: give Jev the exact destination the
  code already parsed), N-07 (SQL fed to psql/mysql through stdin, a pipe, a
  herestring or a heredoc, read as `psql -c` is), N-08 (the verdict cache
  keys on the command's shape: include the literal arguments that change
  the effect, so `prod_pgdata` and `dev_pgdata` never share a verdict).
- T4 JEVADV-87: context steward thresholds for 1M windows. Research first
  (Claude Code compaction docs, Anthropic prompt-caching and long-context
  pricing, the engine's `session.compact` contract, quality in long
  contexts; sources cited, unverified parts said), then measure on the
  steward log and real transcripts what a token hard limit (300k/400k/500k)
  would save and how often it would compact mid-task, then decide. Measure
  mode first. The research report goes in `odd/research/steward-1m.md`.
- T5 README, CHANGELOG, QA in `odd/qa/qa-0.6.15.md`, release, live check.

## Checklist
- [ ] T1 command position only
- [ ] T2 requires_human on effect
- [ ] T3 N-06, N-07, N-08
- [ ] T4 steward research, measurement, decision
- [ ] T5 README, QA, release, live check

## Acceptance criteria
- Every new behaviour is a regression test observed failing before its fix.
- No refusal of the 0.6.14 QA sets is lost (replay 243/244 or better, the
  38 new rows, the 10 N-09 rows).
- The false-positive corpus: every row allowed, or stopped only where the
  command itself does the risky thing; size and result published.
- `terraform plan` and `kubectl get` are not asked about under
  `infrastructure_changes`, three runs each; `terraform apply` still is.
- `prod_pgdata`/`dev_pgdata` get their own verdicts.
- The steward decision is backed by the published research and numbers.
- `npm test` green; no existing test weakened or removed.

## Checks
`npm test`; the replay sets (scratchpad replay scripts, reasons read); live
Jev for T2's corpus; the steward log for T4; a live agent session.
