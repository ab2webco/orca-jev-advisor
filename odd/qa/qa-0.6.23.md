# QA 0.6.23: each agent's worktree and branch in the agents band

Run on 2026-10-01 against the 0.6.23 release branch: both writer branches cherry-picked, then rebased on main. The writers' RED and GREEN counts are in odd/tasks/release-0.6.23.md. The lead re-ran every check below on the integrated branch.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm run typecheck` (lead) | 3 configs | exit 0 | | |
| `npm test` (lead) | 1 | 1 (3172/3172) | 0 | main had 3142; privacy test exits 0 |
| Band screenshots (lead) | 16 images | looked at, all 16 | | 200, 120, 80 and 40 columns; es and en; dark and light; `odd/qa/shots-0.6.23/` |
| Gate replay sets | n/a | | | no gate file changed (`gate-bash`, `decisions` and the gate's core are untouched) |

## What the screenshots show

The screenshots come from `npm run shots:band`, which paints the real hook's band tree cell by cell. Its fixture has 10 agents; three of them have a place: one in another worktree on `feature/login`, one on the lead's worktree on `main`, and one pending isolation.

- **200 columns:** every column is there. The apart row reads `app-feature · feature/login`, the lead's row reads `main`, and the pending row reads `new worktree` / `worktree nuevo`.
- **120 columns:** the effort column has gone, and the place is whole.
- **80 columns:** the place stays. In en it is the branch alone (`feature/login`). In es, where the reasons are longer, the branch is cut from the left (`…ature/login`, `…ktree nuevo`). Rows with a place cut their description to 16 cells. Rows without one lend those cells to their description, so most of those descriptions stay whole.
- **40 columns:** two lines per agent. The branch sits on the second line, after the model and before the description: `Opus 5.5  feature/login  Adding the…`.
- No line crosses the band's edge at any width.

The first version gave the place up at 80 and at 40. The lead changed that (446ab50, RED 1 then GREEN) because 80 columns is a common terminal, and the place is what this release is for.

## Scenarios

| # | Scenario | Expected | Covered by |
|---|---|---|---|
| S1 | Edit, Write or NotebookEdit `file_path` | Its directory | agent_place tests |
| S2 | Bash `cd a && cd b`, `cd ~/x`, a relative `cd`, `git -C d` | The last directory, expanded and resolved | agent_place tests |
| S3 | Read, Grep, Glob; `cd $(…)` | No directory | agent_place tests |
| S4 | git: normal, detached HEAD, failure, a repeated directory | A branch / null / null / no second git run | agent_place tests (fake runner) |
| S5 | Stored rows without `place`, or with a malformed one | The row parses; a bad `place` is dropped | subagent_status tests |
| S6 | The tool-call hook | `next(e)` unchanged; the lookup is queued after the call; the band render runs no git | hooks tests |
| S7 | An Agent call with `isolation: "worktree"` | Pending place at spawn | hooks tests |
| S8 | Branch prefix | Dropped only when two or more shown branches share it | subagent_band tests |
| S9 | Layout at 200, 120, 80 and 40, es and en | Every line fits; the place survives at 80 and 40 | subagent_band tests, screenshots |

## Known limits

- A `cd` inside `( … )` or `bash -c` is not read. Neither is isolation set in an agent's definition file; only the Agent call's own `isolation` is.
- A teammate has no place until its first write, `cd` or `git -C`, because teammates never go through `agent.spawn`.
- A call in a folder outside any repository keeps the last known place.
- Reads never move an agent. One that only reads in another worktree shows the place it last wrote in.

## Live check after the release

Pending.
