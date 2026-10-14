# QA 0.9.1: an older Engram reads as live

Run on 2026-10-13 against `fix/engram-health-old-engram`, from `main` at b6640ae (0.9.0). Plan: `odd/tasks/memory-active-files.md` (follow-up of M1 detection in `odd/tasks/memory-core.md`).

## Why

- A partner's Fedora machine: 309 memory rows, every one `backend: configured-down`, 306 of them `decidedBy: health`; in 27 of those turns the main thread saved to Engram itself.
- Read-only check of that machine: the Engram plugin starts `engram mcp --tools=agent` from Homebrew's `engram` 1.12.0. Its `tools/list` has `mem_save`, `mem_search`, `mem_context`, `mem_update` and seven more, but no `mem_current_project` and no `mem_judge`.
- The module's health call is `mem_current_project`, so it failed on every session start and every turn re-check.

## Summary

| Check | Result |
|---|---|
| RED: a hook test with Engram 1.12.0's tool list made 2 `mem_current_project` calls | Observed |
| GREEN: no Engram call, row `backend: live, decidedBy: tools` | PASS |
| `npm test` | 4309/4309 |
| `npm run typecheck` | Clean |
| Live | PENDING (scenarios 3 and 4) |

## Scenarios

| # | Scenario | Where | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | `engramHasTool` per server | `src/core/memory_detect.test.ts` | true only for the named server's listed tool; 1.12.0 has neither `mem_current_project` nor `mem_judge` | as expected | PASS |
| 2 | Session with Engram 1.12.0's tools | `adapters/claude/mod-skills/hooks.test.ts` | no `$.mcp.call`; the row says `live` by `tools` | as expected | PASS |
| 3 | Live: owner's Mac (Engram with `mem_current_project`) | `memory-decisions-*.jsonl` | rows still `decidedBy: tools+health` | Pending the release | PENDING |
| 4 | Live: the partner's Linux after his update | his `memory-decisions-*.jsonl`, read-only | rows `backend: live, decidedBy: tools` | Pending his update | PENDING |

## Not covered

- Windows.
