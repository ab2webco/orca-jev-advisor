# QA 0.6.18: a real typecheck, and the gate's last unguarded inputs

Run 2026-10-01 against the 0.6.18 release branch (on main at ff21657, with the worktree's own `npm install`, the owner's real team policies and live Jev), scratch repositories under `/Volumes/Data/jev-live-check/` (`SCR`). The writer's per-task proof is in odd/tasks/release-0.6.18.md: every type error with its verdict (real bug or annotation), and the RED and GREEN counts for each real bug. The lead re-ran every check below independently and read the push-target fix in src/core/deny_rule_shapes.ts.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm run typecheck` (lead) | 3 configs | exit 0 | | was 47 distinct errors with these configs (66 with the lead's first probe, 21 of them from the removed Node shim) |
| `npm test` (lead) | 1 | 1 (2941/2941) | 0 | privacy test exit code 0 |
| Replay of the 0.6.12 rows (lead) | 244 | 244 | 0 | only D17 allows, as in 0.6.15 to 0.6.17 |
| New rows of 0.6.13 (lead) | 38 | 38 | 0 | |
| N-09 rows of 0.6.14 (lead) | 10 | 10 | 0 | |
| 0.6.17 T1 merge rows (lead) | 11 | 11 | 0 | |
| 0.6.17 T2 own-file probes, real HOME (lead) | 16 | 16 | 0 | |
| T3 storage probes, real HOME (lead) | 9 | 9 | 0 | the cp, jq redirect and rm of the storage, its secrets and its directory are refused; a read, a test profile and another plugin's storage are not |
| T3 against the 0.6.15 false-positive corpus (writer) | 512 commands | 0 matches | | the replay sets' 303 commands: 0 matches |

No panel file changed, so `npm run test:panels` was not re-run; CI runs the screenshots as part of `npm run check`.

## The three real bugs

| Where | What happened | Test |
|---|---|---|
| gate-bash.ts, destination mirror | A mirror row without a string `label` threw inside the Jev call's try, so every command in that destination was judged as if Jev were unreachable (`kind: none`). | gate_catalog_mirror.test.ts (3 new) |
| deny_rule_shapes.ts `pushTargets` | `git -C "$X" push` and `cd "$X" && git push` were described to Jev as a push from the session's own checkout and branch. They are now unknown, as `protectedPushOutcome` already read them. | deny_rule_shapes.test.ts |
| mod-skills hooks, hold rule (0.6.16 T4) | Read a tool's arguments from `e.input`, which Claude Code never sends, so the measure-only rule never saw a failing test run. The test was sending that same wrong shape. | hooks.test.ts "0.6.16 T4" |

## Observations

- **N-19 low.** If every gate hook entry is removed from every account's `settings.json`, the worker's rescan does not reinstall them. A single removed entry is reinstalled, and `status`/`doctor` report it. It was not verified whether a running Claude Code session keeps the hooks it started with after such an edit.
- `typescript` is pinned to ^5.9.3. npm's latest (7.x, the native port) was not used, because it is a different compiler.
- There is still no package-lock.json. Orca clones the tree onto each user's machine and installs nothing, and CI keeps `npm install`.
- The file hook's latency was not re-measured after T3. A path inside the plugin's Orca data directory now pays the TypeScript load (about 30 ms); other paths are unchanged.

## Live check after the release

Pending: filled in after the release.
