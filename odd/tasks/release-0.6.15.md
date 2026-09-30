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
- [x] T1 command position only. RED: command_text.test.ts 25/30 (5 new: a quoted argument of any program, a program that runs its argument, interpreter source per language incl. N-10 f-strings and N-11 `require("fs")`, a heredoc by its reader, the f-string call reaching the rules), git_discard.test.ts 1 new fail (a `-c`/`-e` string that is only printed was `code`), gate_advice_text.test.ts 1 new fail (N-11: "It would run" named a heredoc body line); then, each observed failing before its fix: stdin runners (`echo "DROP …" | psql`, `psql <<< …`, found by the replay: H-drop-pipe and H-drop-herestring went from stop to allow on the first cut), the deploy/publish floor reading a heredoc body written to a file ("publishes a package" on `cat > notes.md <<EOF` naming a publish, found in the corpus), `$( )` bodies read again, `NAME=value`/paths with spaces, and runners reached through `docker exec`/`kubectl exec --`/`rails runner`. GREEN: npm test 2807/2807. Fix: the copy Jev reads keeps the words in command position and the paths and refs they act on; every other quoted text is `‹text›` unless the program runs it (eval, `-c`, `su -c`, ssh, watch, xargs, `--`, `find -exec`, `$( )`, SQL clients, awk/sed that run commands, interpreter source read by language in src/core/program_text.ts, moved out of command_text.ts); hand-off detection is one function shared with the local rules (git_discard.ts commandHandOff). Local rules: a `-c`/`-e` source is read by language in the "command" view (N-10), so a printed string is a mention (Jev), a call is still `code` (advice). Changed tests, not weakened, each for the plan's inversion: "text that runs, or that a script may run, keeps its text for Jev" lost its `node probe.mjs '<json>'` case, now asserted the other way in the new test; decisions.test.ts expects `node probe.mjs ‹text›` for the same command; two gate-bash tests of the `code` advice now use a real `execSync(...)` call (a `console.log` is now a string), and a new test asserts the print-only form is not a local advice. Replays against the working-tree hook, fresh cache dir each, baseline = v0.6.14 tree: 244-row replay 244/244 before and 244/244 after (N-06 happened to pass both times; no refusal lost, 1 advice became a refusal); 38 new rows 36/38 and 36/38 (N23/N24 are T2's; no refusal lost); N-09 rows 10/10 and 10/10. False-positive corpus: every Bash command in the Claude transcripts (7805 files, 233 with a stop, 2026-09-24..30) whose result was a gate stop, deduplicated: 512 commands (717 stops, 433 whose identical retry then ran). Replayed on both trees: stopped 400 (63 refused) before, 364 (62 refused) after. Labelled by hand into 77 that only edit, read or test locally and 435 where the command itself acts (push, merge, release, delete, overwrite from git, discard, API or service calls, unknown scripts, policy writes on main): the local ones went from 39 stopped to 14, none refused; all 62 refusals are the command's own action (discard, push to main, force push, policy on main, curl piped to bash). The 14 left are Jev's own risk read of a python program that rewrites a tracked file ("right at its limit", "needs cleanup"): their Jev copy holds no data text (read one by one), so they are the command's own write, not the text; follow-up candidate: tell Jev a written path is tracked and clean. The corpus holds private text and stays in the scratchpad. While writing T1 the installed 0.6.14 gate advised 4 of this task's own edits (two python heredocs editing source, a heredoc writing a scratch file, a `sed -i` on a test), each named a body line as what "would run"; each was re-run unchanged, no REFUSED.
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
