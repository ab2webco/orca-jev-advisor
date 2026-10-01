# QA 0.6.21: gate log retention, the last redirections, and Jev call failures

Run 2026-10-01 against the 0.6.21 release branch (both writer branches merged, the worktree's own `npm install`, live Jev). Writers' per-task RED and GREEN counts are in odd/tasks/release-0.6.21.md. The lead re-ran every check below on the merged branch.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm run typecheck` (lead) | 3 configs | exit 0 | | |
| `npm test` (lead) | 1 | 1 (3093/3093) | 0 | main had 3028; privacy test exit 0 |
| `npm run test:panels` (writer, T1) | 1 | 1 (190/190) | 0 | the board's readers changed, its output did not; CI runs it again |
| Replay of the 0.6.12 rows (lead) | 244 | 244 | 0 | only D17 allows, as since 0.6.15 |
| New rows of 0.6.13 (lead) | 38 | 38 | 0 | |
| N-09 rows of 0.6.14 (lead) | 10 | 10 | 0 | |
| 0.6.17 T1 merge rows (lead) | 11 | 11 | 0 | |
| 0.6.17 T2 own-file probes (lead) | 16 | 16 | 0 | |
| 0.6.18 T3 storage probes (lead) | 9 | 9 | 0 | |
| Fold on a copy of the real log (writer) | 25,086 decisions, 14 files | identical | | dates shifted 8 days back; 13 files folded in 125 ms; totals file 153 KB; all three readers' output identical byte for byte; copy deleted |

No screen changed in this release: the board shows the same numbers from a different source, which the panel tests cover.

## Measurements behind the choices (JEVADV-96)

- **Before figure:** 156 of 21,843 gate decisions in the 7 days to 2026-10-01 were unjudged because Jev failed (0.71%; 0.91% of the calls that reached Jev). They came in bursts across projects (2026-09-24 20:00 UTC, 2026-09-28 13:00 to 16:00 UTC) and none have occurred since 2026-09-29. The old rows hold no cause; from 0.6.21 they do.
- **Gate call latency:** p50 395 ms, p95 633, p99 1,137, max 1,809 (17,687 calls). The 1.5 s retry window covers the p99.
- **State size:** rebuilt with the gate's own builder from 10,715 real Bash commands: p50 320 characters, p99 1,485, max 3,659. Jev answered at about 31.7k input tokens and refused about 35k with HTTP 400 `max_tokens_exceeded` (probed live; undocumented). The cap is 16,000 characters.

## Scenarios

| # | Scenario | Expected | Covered by |
|---|---|---|---|
| S1 | Files older than 8 days | Folded into totals, then deleted; every window equal before and after | gate-log-fold tests, real-copy run |
| S2 | Crash between the totals write and the delete | Re-run finishes; no file counted twice | gate-log-fold tests |
| S3 | A file name recreated after its fold | Read as a new file, not skipped | gate-log-fold tests |
| S4 | Unreadable totals file | Fold does nothing, readers fail open | gate-log-fold tests |
| S5 | `&>f`, `&>>f`, `echo hi>x`, `echo hi>>../x` | Target resolved like the spaced form | redirections, command_targets tests |
| S6 | `2>&1`, `>&2`, `"a>b"` | No file target | redirections tests |
| S7 | `echo x>~/.config/orca-supervisor/policies.json` | Own-file protection fires | gate_own_files tests |
| S8 | Jev 5xx / network failure, budget left | One retry, honouring `Retry-After` | jev_call tests |
| S9 | Jev failure, under 1.5 s left | No retry; row records the class | jev_call, gate_measurement tests |
| S10 | State over the cap with a long blob and a push | Condensed, judged by Jev, `stateCondensed: true` | jev_state_cap tests |
| S11 | State still over the cap | No Jev call, local rules, `commandTooLarge` note, `failureClass: oversized` | gate subprocess test |

## Known limits

- A heredoc body fed to a shell (`bash <<EOF`) is code and is never condensed, so a padded one over the cap is judged by the local rules only, with the note shown. None of the 10,715 real commands came near the cap.
- `>& file`, `<>file` and `[[ a > b ]]` are read as before.
- The Jev failure streak shown on the board is exact while folded files are older than every live file, which the fold guarantees within one run.
- The `failureClass` path is covered by unit tests; forcing a real Jev failure in a subprocess is not deterministic.

## Live check after the release

Released as v0.6.21 at 22130ca (#32, CI green in 36 min). The dev copy `orca-jev-advisor-dev` was pulled to 22130ca. The five installed `orca-jev-mod-skills` copies match it (the gate is not part of the mod; it runs from the dev copy). The five Claude Code settings files each hold 8 gate hook entries, all pointing at the dev copy, with no duplicate.

L1 ran as a real Bash call of a Claude Code session in an Orca terminal. L2 to L5 fed Claude Code PreToolUse inputs to the installed `gate-bash.ts` hook, which decides without running the command, so a probe the gate let through could not touch anything. The protected file's hash was the same before and after.

| # | Scenario | Expected | Result |
|---|---|---|---|
| L1 | `printf '' &>>` to a gate file in the cache dir | Local refusal | `REFUSED: edits the gate's own rules`, row `local-rule` / `deny` |
| L2 | `printf ''>>` glued to the same path | Local refusal | Same refusal, row `local-rule` / `deny` |
| L3 | `printf ''&>` glued to the same path | Local refusal | Same refusal, row `local-rule` / `deny` |
| L4 | `curl` with a 17,000-character query word | Judged by Jev on the condensed state | `allow` from Jev in 582 ms, row `stateCondensed: true` |
| L5 | The same `curl` with a short query | Judged normally | `allow` (a cache hit), no `stateCondensed` key |

- **Fold.** The hourly files started on 2026-10-01, so none is older than 8 days yet. The first read after the update wrote `gate-decisions-totals.json` with no folded file and every tally at zero, and deleted nothing. The first real fold will happen on 2026-10-09. The legacy `gate-decisions.jsonl` is left alone.
- **Failure class.** No live failure happened during the check, so no row carries `failureClass` yet. See Known limits.
- **Screens.** No panel changed in this release, and the board was not photographed for it.
