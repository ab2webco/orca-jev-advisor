# QA 0.6.17: the gate guards itself, no false refusal on a PR merge

Run 2026-10-01 against the 0.6.17 release branch (on main at 90348b3, working-tree hook, the owner's real team policies, live Jev), scratch repositories under `/Volumes/Data/jev-live-check/` (`SCR`). The writer's per-task proof, with the RED and GREEN counts, the list of protected files with the file:line of each read, and the decisions, is in odd/tasks/release-0.6.17.md. The lead re-ran every check below independently and read the core of T2 (src/core/gate_own_files.ts).

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm test` (lead) | 1 | 1 (2932/2932) | 0 | privacy test exit code 0 |
| `npm run test:panels` (lead) | 1 | 1 (173/173) | 0 | |
| Replay of the 0.6.12 rows (lead) | 244 | 244 | 0 | 8 rows FAIL→PASS against the script's stored baseline, none PASS→FAIL; the writer's run found 0 rows changed against 0.6.15 |
| New rows of 0.6.13 (lead) | 38 | 38 | 0 | |
| N-09 rows of 0.6.14 (lead) | 10 | 10 | 0 | |
| T1 `gh` merge rows (lead, live Jev) | 11 | 11 | 0 | see below |
| T2 own-file probes, real HOME (lead) | 16 | 16 | 0 | 9 Bash writes refused, 2 reads and a test HOME allowed, 2 file-tool writes refused, 2 other edits silent |
| T2 against the 0.6.15 false-positive corpus (writer) | 512 commands | 0 matches | | the first version matched 3; each is now a negative test |
| T2 file-tool hook latency (writer) | 40 runs | +1.3 ms median | | +31 ms on a path containing `orca-supervisor`; no Jev call |
| Screenshots (writer, 3 opened by the lead) | 32 images | looked at | | integration section and board status chip, 1440/768/390/320, both themes, en and es |

The one refusal that turns into an allow in the 244-row replay is D17 (`cd demo-app && git tag`), the N-02 false refusal of 0.6.12. The same row changed in 0.6.15.

## T1: what a merge does

| Row | Command (shape) | Checkout | Expected | 0.6.17 |
|---|---|---|---|---|
| G01 | `gh pr merge 430 -R acme-labs/widget --squash --delete-branch` | main | allow | advice |
| G02 | `gh pr merge 430 -R acme-labs/widget --squash --delete-branch` | feature | allow | advice |
| G03 | `gh pr merge 12 --merge` | main | allow | allow |
| G04 | `gh pr merge --auto --squash 12` | main | allow | allow |
| G05 | `git merge feature/qa-work && git push origin main` | main | refuse | REFUSED never_write_to_main |
| G06 | `gh api -X POST repos/acme-labs/widget/merges -f base=main -f head=feature/qa-work` | main | refuse | REFUSED |
| G07 | the same `gh api … /merges` into main | feature | refuse | REFUSED (allowed on 0.6.16) |
| G08 | `git push origin main` | main | refuse | REFUSED |
| G09 | `gh pr merge 430 -R acme-labs/widget --admin --squash` | main | decide | REFUSED (skips review) |
| G10 | `gh pr merge 430 --admin --squash` | feature | decide | advice (the PR's base is unknown without a network call) |
| G11 | `gh pr merge 430 --squash && git pull --ff-only` | main | allow | allow |

The row that motivated T1, a reviewed `gh pr merge` from a checkout on main refused on 0.6.16 (JEVADV-93), is G01/G03.

## Observations

- **N-17 medium (JEVADV-94, next release).** The plugin's Orca `storage.json` is not covered by T2. The gate does not read it, but the panel and the worker rewrite the mirrors from it, so editing it changes the rules one step removed. Claude Code's own `settings.json` hook entries are also outside T2.
- **N-18 low.** `gh pr merge --admin` from a feature checkout is only advice, because the gate does not know the PR's base branch without a network call.
- The hand-edit digest (the panel stamps what it wrote and the board flags a mirror changed elsewhere) was deferred. A person editing by hand is legitimate, so it could only inform.
- T6 (the Advisor panel's close button) was not built: Orca Lab's v1.4.160-lab.90.rc, which carries the panel close action (ORCA-538), is not published yet.
- The replay rows and the T2 live probes ran against the owner's real policies and wrote decision rows to the real cache, as in earlier releases.

## Live check after the release

Pending: filled in after the release.
