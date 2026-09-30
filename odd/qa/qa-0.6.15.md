# QA 0.6.15: the gate reads what runs, policies on effect, steward on 1M windows

Run 2026-09-30 against the 0.6.15 release branch at 0516d8e plus the docs
and version commit (working-tree hook, real team policies, live Jev),
scratch repositories under `/Volumes/Data/jev-live-check/` (`SCR`) as in
odd/qa/qa-0.6.13.md. The writer's per-task proof is in
odd/tasks/release-0.6.15.md; the lead re-ran the three replay sets below
independently.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm test` | 1 | 1 (2838/2838) | 0 | privacy test exit code 0 |
| Replay of the 0.6.12 rows (lead) | 244 | 244 | 0 | 0.6.14: 243/244; H-protected-envvar (N-06) now refused |
| New rows of 0.6.13 (lead) | 38 | 38 | 0 | N23/N24 (`kubectl get`, `terraform plan`) pass: N-05 fixed |
| N-09 rows of 0.6.14 (lead) | 10 | 10 | 0 | |
| False-positive corpus (writer) | 512 commands | see below | | real stops from 233 transcripts, 2026-09-24..30 |
| `requires_human` calibration (writer) | 45 commands × 3 runs | band positive | | reserved 0.96–1.00, the rest ≤ 0.78, gate 0.87 |
| Verdict cache hit rate (writer) | 24,870 real commands | 35.99% → 35.99% | | only 58 keys change (N-08) |
| Screenshots, Models tab steward row | 9 images | looked at | | 1440/768/390/320, both themes, one Spanish |
| Screenshots, agents band with effort | 16 images | looked at | | 200/120/80/40, es/en, both themes |

Refusals lost against 0.6.14: none. The only verdict that moved from a stop
to an allow in the replay is D17 (`cd demo-app && git tag`), the N-02 false
refusal of 0.6.12.

## False-positive corpus

Every Bash command in the Claude transcripts of 2026-09-24..30 whose result
was a gate stop, de-duplicated: 512 commands (717 stops, 433 whose identical
retry then ran). Labelled by hand: 77 only edit, read or test locally; 435
act on something themselves (push, merge, release, delete, overwrite from
git, discard, API or service calls, unknown scripts, policy writes on main).

| | 0.6.14 | 0.6.15 (T1) | 0.6.15 (T1–T3) |
|---|---|---|---|
| stopped | 400 (63 refused) | 364 (62 refused) | 371 (309 advice, 62 refused, 0 asks) |
| local-only commands stopped | 39 | 14, none refused | 14, none refused |

All 62 refusals are the command's own action (a discard, a push to main, a
force push, a policy on main, curl piped to bash). The 14 local stops left
are Jev's risk read of Python programs that rewrite a tracked file; their
Jev copy holds no quoted text (read one by one). The corpus holds private
text and stays out of the repository.

## Observations

- **N-12 low.** At 390 px the Models tab's stage column breaks "Implementar"
  as "Implement / ar" without a hyphen (seen in the steward crop; predates
  0.6.15).
- **N-13 low.** `aws iam create-access-key` scores ~0.4 under the
  `production` policy and is not asked about; the writer judged creating a
  key as not the same as rotating credentials. Not verified with the owner.
- **N-14 low.** The `requires_human` band's margin is small after
  recalibration (non-reserved up to 0.78, gate 0.87): 43 of the owner's own
  `gh pr merge` commands were asked about under `others_pr` by the first
  version before four merges were added to the corpus.
- The 400k steward tier has run only in unit tests (measure mode); its log
  rows are the data for turning it on.

## Live check after the release

Pending: filled in after the release.
