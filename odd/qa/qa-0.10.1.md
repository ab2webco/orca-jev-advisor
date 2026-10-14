# QA 0.10.1: the router finds moved transcripts, memory lines stay readable

Run on 2026-10-14 against `fix/router-find-symlink`, from `main` at 3a42d62 (0.10.0). Plans: `odd/tasks/router-cache-ttl.md` (R5 follow-up) and `odd/tasks/memory-active-engram.md` (M9 follow-up).

## Why

- Owner's Mac, router stage rows since 2026-10-13T22:30Z, checked against the next main request in each transcript (`cache_read` vs `cache_creation`): every warm/cold verdict that had no model switch behind it matched (Netsat 28/28, home 10/10, Koombea 3/3). The mismatches were switches the router applied and priced (`switchCost`), and one server-side prefix miss 22 minutes into a 1h cache with no switch. One session (`orca-oss`, Koombea account) said `cacheUnknown: tail-failed` on 10 of 10 stage rows: its worktree was removed, so its own path missed, and the `find` fallback returned nothing because `projects` is a symlink on every Orca account.
- Owner's `orca-oss` `MEMORY.md`: 203 lines, 27,539 bytes. The module's mirrored feedback rule (Engram #5299) was its line 203. Claude Code 2.1.299 loads `MEMORY.md` up to 200 lines and 25,000 bytes (`ZN=200`, `tie=25000` in the binary), so a fresh session never read it. A second index on this Mac is at 219 lines.

## Summary

| Check | Result |
|---|---|
| RED: `find` through a symlinked `projects` (real filesystem) found nothing | Observed |
| RED: three `upsertIndexLine` window tests | Observed |
| GREEN: both | PASS |
| `npm test` | 4333/4333 |
| `npm run typecheck` | Clean |
| Panels | Not run: no UI change |
| Live | 5, 6, 7 PASS; 8 PENDING (needs use) |

## Scenarios

| # | Scenario | Where | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | `transcriptFindArgv` passes `-H` | `src/core/cache_warmth.test.ts` | `["find", "-H", "<config>/projects", ...]` | as expected | PASS |
| 2 | `find` through a symlinked `projects` finds the transcript | `src/core/cache_warmth.test.ts` (temp dir, real `find`) | the moved transcript's path | as expected; without `-H` it was null | PASS |
| 3 | A new index line past 200 lines or 25,000 bytes goes above the first entry; under a heading it stays under it | `src/core/memory_draft.test.ts` | first entry line; nothing dropped | as expected | PASS |
| 4 | A replaced line past the window moves up; one inside stays in place | `src/core/memory_draft.test.ts` | as stated | as expected | PASS |
| 5 | Live: GNU `find` on the partner's Fedora (read-only) | his symlinked `projects` folders | without `-H` 0 hits, with it 1 | 2 symlinked accounts: 0 and 1 each | PASS |
| 6 | Live: the installed 0.10.1 finds the owner's moved `orca-oss` transcript | marketplace install, the Koombea account's `projects` | the transcript path | Install root `0f0a8b7b` (0.10.1; 8 hooks on it in `~/.claude` and all 4 accounts): its `transcriptFindArgv` gives `find -H <account>/auth/projects …` for the Koombea account, which finds the moved session's transcript under its removed worktree's folder (0.10.0: nothing) | PASS |
| 7 | Live: the installed 0.10.1 places a line in the owner's `orca-oss` index inside the window | a copy of that index | the line above the first entry | Installed `upsertIndexLine` on a copy of the 203-line index: the mirrored rule moves from line 203 to line 1, still 203 lines; a new line lands at line 1. Applying it to the real index was refused by the Jev gate (`never_write_to_main`, the shell was on `main`); left to the owner | PASS (copy) |
| 8 | Live: no `tail-failed` from moved sessions after the update | `model-router-decisions-*.jsonl` | none, or a reason other than the symlink | Pending use | PENDING |

## Not covered

- Windows (no `tail`/`find`; unchanged).
- Indexes already past the window: lines Claude Code itself appended there stay unread until the index is tidied (the tidy phase of `odd/tasks/memory-active-files.md`).
