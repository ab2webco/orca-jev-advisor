# QA 0.6.19: the QA 0.6.5 backlog, closed

Run 2026-10-01 against the 0.6.19 release branch (on main at fbba819, the worktree's own `npm install`, the owner's real team policies, live Jev), scratch repositories under `/Volumes/Data/jev-live-check/` (`SCR`).

On 2026-10-01 every finding in JEVADV-70, 72, 73 and 74 was re-verified against main before this release. The table is in odd/tasks/release-0.6.19.md, which also has the writer's per-task proof with the RED and GREEN counts. The lead re-ran every check below independently and opened the new panel captures.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm run typecheck` (lead) | 3 configs | exit 0 | | |
| `npm test` (lead) | 1 | 1 (3008/3008) | 0 | privacy test exit code 0 |
| `npm run test:panels` (writer) | 1 | 1 (190/190) | 0 | CI runs it again in `npm run check` |
| Replay of the 0.6.12 rows (lead) | 244 | 244 | 0 | only D17 allows, as since 0.6.15 |
| New rows of 0.6.13 (lead) | 38 | 38 | 0 | |
| N-09 rows of 0.6.14 (lead) | 10 | 10 | 0 | |
| 0.6.17 T1 merge rows (lead) | 11 | 11 | 0 | |
| 0.6.17 T2 own-file probes (lead) | 16 | 16 | 0 | |
| 0.6.18 T3 storage probes (lead) | 9 | 9 | 0 | |
| Screenshots (writer 64, lead opened 3) | 64 images | looked at | | log-size field, save row, destination row, ready override; 1440/768/390/320, both themes, en and es |

Against the writer's 0.6.18 run, row by row, no replay outcome changed.

## Findings closed

| Finding | Before | 0.6.19 |
|---|---|---|
| M2 | No key, unreachable or rejected key: the gate returned `allow`, which skipped Claude Code's prompt | The notice only; Claude Code's permission rules decide (bypass mode unchanged) |
| M3 | The gate's `await main()` had no catch | Every hook entry point fails open with exit 0 |
| M4 | Five git calls with no timeout | One helper with a timeout; a timeout reads as unknown |
| M9 | `decideAction` doc said it fails closed | The doc says it fails open, as the code does |
| M12 | `>../x` resolved no target | `>../x`, `>>../x`, `1>../x` and `2>>file` resolve (`&>file` and `word>file` remain, JEVADV-98) |
| M11 | Design not stated in the README | One README sentence |
| M13 | An empty log size saved 0 and wiped the history | At least 1 in the input, the stored config and the writer |
| M14 | One hostile-input test | Every escaped sink on the board and the config panel tested; a mutation of `esc()` fails the board test |
| ES5 copies | No sync test; `liveEntryView` had drifted | Copy-sync tests; the original now matches the board |
| M8 | The skills mod's clock was outside the try | Inside; the handler always calls `next` |
| M15 | Model reclassifications and A/B results grew forever | Hourly reclassification files; A/B results capped at 5,000. Gate files are not pruned (JEVADV-98, below) |
| M16 | The boot mirror lowered an owner-raised `ready` (5 recurrences) | An owner override in Orca storage, applied by every mirror |
| JEVADV-74 | Dead modules, a broken script, nits, installer ownership, target discovery, the install-state race | Fixed. Ownership is by the hook's script, because Claude Code's schema allows no extra field. Install state is written per target. The skill/tool decision files were measured (28 lines of truly shared logic) and left separate |

Closed without a change, with evidence in Plane:
- **Already fixed:** M1 (0.6.11 pseudonyms), M10 (0.6.13 exact refspec) and the packaged privacy test (0.6.17).
- **Not defects:** the policies read twice, the UTC sampling day, a negative `savedEstimate` (shown as extra cost), the generic `reload()` message and the order in which worker requests are deleted.

## Observations

- **N-20 low (JEVADV-98).** The gate's hourly decision files are still not pruned. Pruning at 8 days would silently turn the board's "all time" window into "last 8 days". The right fix folds old files into a running total first, then prunes. Measured: about 77 KB per active hour, plus a 5.0 MB pre-0.6.17 file. The readers use Node's `readFile`, so no 4 MiB limit applies.
- **N-21 low.** The capture of the emptied log-size field cuts Chromium's validation bubble at the bottom edge. This is the capture's framing, not the panel.
- M2 was not tried against a real Jev outage or a rejected key. Those paths share the function the no-key tests cover.

## Live check after the release

Released as v0.6.19 at 595d931 (#28, CI green in 26 min). The dev copy `orca-jev-advisor-dev` was pulled to 595d931. The five installed `orca-jev-mod-skills` copies match it file by file (53 files each, none differ).

After the update, every one of the five Claude Code settings files holds 8 gate hook entries with no duplicate. That is the check for the installer's new ownership by script, which recognises entries written by older versions.

A real Claude Code session (Sonnet 5.5, a second Orca account) in `SCR/feat-app` was told to run each command once, with no retry and no workaround. Results from the session transcript:

| # | Command | Expected | Result |
|---|---|---|---|
| 1 | `echo qa >../demo-app/qa-0619.txt` (a redirection without a space into a checkout on main) | refuse | `REFUSED` never_write_to_main (M12: the target is now resolved) |
| 2 | `git push --force origin feature/qa-work` | refuse | `REFUSED` force push, local rule |
| 3 | `time git status --short` | allow | ran |

Afterwards demo-app had no `qa-0619.txt` and feat-app's remote was unchanged.
