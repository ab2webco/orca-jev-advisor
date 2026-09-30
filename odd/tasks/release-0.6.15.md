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
- [x] T2 requires_human on effect. RED: decisions.test.ts 74/80 (the new needs_person question, its ask with the real id, the topic-only case N-05, the gate, GATE_DECISION_RULES_VERSION 6, and the two question-shape tests now expecting coverage over the permits only). GREEN: 80/80, npm test 2812/2812. Fix: `requires_human` rules are asked in a `needs_person` choice ("does the action itself do what the rule reserves for a person; sharing a topic, or what the rule says runs without asking, is not doing it"), checked after the violation and before coverage; coverage keeps only the permits; GATE_DECISION_RULES_VERSION 6. Changed tests, not weakened: the requires_human tests (kind table, decideGateAction ask, localAllowQualifies ask, neutral-key ask, violation-wins) now carry a `needs_person` answer, as 0.6.13 T2 added `violation` answers for prohibitions; the neutral-key test reads the requires_human rule from needs_person. Calibration against live Jev with the owner's policies as the gate scopes them (4 requires_human rules), 41 labelled commands x 3 runs = 123 answers: every command that does what a rule reserves (terraform/tofu apply and destroy, kubectl delete and drain with global options, production deploys and migrations, `vercel --prod`) scored 0.94-1.00 on its rule; every command that does not (plan, init, validate, show, get, describe, logs, top, events, staging deploy, preview deploy, reads, tests, feature push, PR view/create) scored at most 0.41 on any rule; gate 0.7, asked 39/42 and 0/81. The 3 not asked: `aws iam create-access-key` scored 0.38-0.41 on `production` ("rotating credentials"); creating a key is not rotating one, so it is left to the risk stage, stated here as a judgement call. Through the hook, fresh cache each run: the 38 new rows 38/38 three times (N23 `kubectl --context prod get pods`, N24 `terraform -chdir=infra plan` now allowed; N21/N22 apply/destroy still refused by the local rule); plain `terraform plan`, `kubectl get pods|describe|logs` allowed 3/3 runs each; 244-row replay 244/244, no refusal lost. Correction (second T2 commit): replaying T1's false-positive corpus during T3 showed the first cut asking a person on 43 of the owner's own `gh pr merge` commands through `others_pr` (0 asks before), a case the first corpus did not hold. RED: the new instruction and band tests failed on the first cut (79/81). GREEN 81/81. Fix: a condition a rule names (whose work, which environment, a QA window) counts only when the action or the context states it, else the ordinary case is read; recalibrated with 4 PR merges added, 45 commands x 3 = 135 answers: reserved actions 0.96-1.00, the rest at most 0.78 (the merges, 0.61-0.78), gate 0.87 in the middle; `aws iam create-access-key` 0.30-0.35. Corpus replay after it: 0 asks, 309 advice, 62 refused (512 commands); the 38 rows 38/38; plan/get/describe/logs allowed 3/3 again.
- [x] T3 N-06, N-07, N-08. RED: deny_rule_shapes.test.ts and cross_repo_context.test.ts failed to load (pushTargets, buildPushDestinationSentence missing); gate-deny-spellings.test.mjs 92/93 (`echo "DROP …" | psql` not refused); command_shape.test.ts 26/27 (`docker volume rm prod_pgdata` and `dev_pgdata` one key; also a `docker login -p <secret>` value kept as a verb in the key). GREEN: 35/35, 93/93, 27/27, npm test 2817/2817. N-06: pushTargets (deny_rule_shapes.ts) reads each push's remote, destination branch and whether the remote is on this machine, as the local rule reads it; buildPushDestinationSentence (cross_repo_context.ts) puts it in the context Jev reads ("pushes commits to branch main of remote origin, a repository on this machine; main is a shared branch there, whatever branch the checkout is on"), other branch and remote names pseudonymized; only Jev's copy carries it, the cache key already holds the destination. Live, fresh cache each run, from a feature checkout with a local bare remote: `git push origin main` and `GIT_SSH_COMMAND=ssh git push origin main` stopped 7/10 before (3 allowed), refused 10/10 after (never_write_to_main). N-07: droppedTableOutcome refuses SQL fed to psql/mysql/mariadb/sqlite3 through a pipe from echo/printf or a here-string, a SQL-client heredoc keeps its body in view like a shell's, `DROP/**/TABLE` and `--` comments between the words count, and sqlite3's statement argument is an exec position; printed to a file or to grep it is not refused. Replay: H-drop-pipe, H-drop-herestring, H-drop-heredoc and H-drop-comment now local refusals. N-08: docker, podman, kubectl, helm, systemctl, brew, fly, heroku, supabase, vercel, aws, gcloud, az, dropdb, createdb and redis-cli keep bare resource names and environment flag values literal in the key; a path, a value after a credential flag or one holding `=`, `:` or `@` still folds. Cache reach on 56,389 real Bash commands from the transcripts (24,870 cacheable, in time order, per cwd): 35.99% hits before and after; 58 commands change key. Replays with T1-T3: 244/244, 38/38, 10/10; no refusal lost; corpus 309 advice, 62 refused, 141 allowed, 0 asks.
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
