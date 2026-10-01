# Release 0.6.21: gate log retention, the last redirections, and Jev call failures

## Objective
Two backlog cards, worked in parallel by two writers in separate worktrees and merged into this release branch:
- JEVADV-98: the gate's hourly decision files grow forever, and two redirection forms are still not read.
- JEVADV-96: a failed Jev call is recorded without its cause, transient failures are not retried, and nothing caps the state sent to Jev.

Authorized by the owner 2026-10-01 ("sigue con la 98 y si puedes las demas en paralelo"). JEVADV-97 (judgment health probes) follows in 0.6.22, so at most two writers run at once.

## Scope
- T1 (JEVADV-98, branch `0621-gate-logs`) Gate log retention.
  - Each gate decision file older than 8 days is folded into a small running-totals file holding exactly the counts the board's windows ("all time", "this version") and the A/B count need, then deleted.
  - Readers combine the totals with the live files.
  - The fold is idempotent and crash-safe: a file is deleted only after its totals are durably written, and a file is never counted twice.
  - Test: no window changes its numbers across a fold.
- T2 (JEVADV-98) Redirections: `&>file`, `&>>file` and a redirection glued to a word (`echo hi>x`, `echo hi>>../x`) resolve their target like the spaced form.
- T3 (JEVADV-96, branch `0621-jev-calls`) Failure class.
  - `callJev` returns why a call failed: timeout, network, 4xx (with status), 5xx (with status), 429/529 overload, or a malformed answer.
  - The gate's measurement rows record it.
  - Report the share of unjudged gate decisions in the existing logs, as the "before" figure.
- T4 (JEVADV-96) Transient retry. A 5xx or network failure is retried once, only inside the remaining time budget, honouring `Retry-After` when present. Same cap as the existing 429/529 retry: never two retries of one call.
- T5 (JEVADV-96) Oversized state.
  - Measure the largest real states the gate sent (from logs or by rebuilding from recorded commands).
  - Set a cap from that.
  - Over the cap, the gate does not call Jev: local rules only, with a visible note saying the command was too large to judge.
- T6 README (latest "What changed"), CHANGELOG, version, QA in `odd/qa/qa-0.6.21.md`, release, live check.

## Checklist
- [x] T1 gate log fold and prune
- [x] T2 `&>` and glued redirections
- [x] T3 Jev failure class recorded
- [x] T4 transient retry within budget
- [x] T5 oversized-state cap
- [ ] T6 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change (RED observed, then GREEN).
- `npm run typecheck` exits 0, `npm test` is green, and `npm run test:panels` is green if a panel or a reader the board uses changes.
- The gate replay sets pass unchanged: replay-0615 (244, only D17 allows), new-0613 (38), n09-0614 (10), t1-0617 (11), t2-live (16), t3-live (9).
- The privacy test exits 0.
- No user-visible window number changes because of the fold.

## Proof
- T1 036a1df, T2 8b7394d (writer A): gate_stats 23/23, gate_decision_totals 10/10, gate-log-fold 11/11 (RED 5/9 then 9/11), read-consumption 18/18, redirections 6/6, command_targets 16/16, gate_own_files 11/11; test:panels 190/190.
- T3 c4a1048, T4 aa22156, T5 de55120 and 080f0a1 (writer B): gate_measurement 39 (RED 3 failing), jev_call 7 then 14 (RED 7 of 14), cap and condensing tests (RED at import).
- Merged on the release branch: typecheck 0, npm test 3093/3093, privacy 0, all six replay sets unchanged (lead).
