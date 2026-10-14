# QA 0.9.0: the memory module's Active state on the files store

Run on 2026-10-13 against `feat/memory-active-files`, from `main` at 9140fc7 (0.8.3 and its live QA). Plan: `odd/tasks/memory-active-files.md`.

## Why

- A partner's Linux machine with Engram configured but down, one day of Shadow rows: 275 rows, 118 UPDATE, 101 of them `module-only` (the module would have saved something the main thread did not). The main thread wrote to the memory folder 6 times.
- 17 gate answers (6%) were `malformed`, so a malformed answer must write nothing and be counted.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 4304/4304 |
| `npm run test:panels` | 241/241 (4 shards) |
| Shots | The Memory card in Active (no Engram), English, 1440 and 390 light; no colour added, so no dark shot. Kept outside the repository |
| Live marketplace install | 16 and 17 PASS; 18 to 21 PENDING |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | The engine's own metadata | `memory_draft.test.ts`, `memory_spool.test.ts` | `node_type: memory` and `modified` in every written file | RED: the frontmatter lacked both. GREEN 194/194 memory core tests | PASS |
| 2 | Effective mode, spool root, update and lock rules, row and summary | `memory_active.test.ts`, `memory_shadow.test.ts` | Active runs only when the backend is not live; one spool root per memory folder; an update needs an existing file with frontmatter; a lock under an hour old with a live pid holds; replay rows are never decisions | RED: module missing, `NO_WRITES` not exported. GREEN 203/203 | PASS |
| 3 | Registry offers Active | `feature_modules.test.ts` | `off`, `shadow`, `active`; default `shadow`; a stored `active` reads as written | RED: `["off","shadow"]`, then the shadow rule without `ownSwitch`. GREEN 32/32 | PASS |
| 4 | The card per backend (en, es) | `panels.spec.mjs` memory cases | Off, Shadow, Active; Active says where it saves: the auto-memory folder (no Engram), the folder with `pending_engram` (down), nothing yet with Engram live ("With Engram live, Active keeps measuring; writing to Engram arrives in a later release"); the cost line says every UPDATE gets a fork in Active; the week's writes, or "nothing yet", or "could not be read", never zeros; Off and Active go through the real writer | RED: 6 of 7 failed. GREEN 7/7 | PASS |
| 5 | Off | `hooks.test.ts` "M8 memory off" | 0 Haiku calls, 0 rows, 0 writes, nothing scheduled | as expected | PASS |
| 6 | Shadow unchanged | `hooks.test.ts` M8 cases | Rows with `mode: shadow, effective: shadow` and zero write counts; nothing written | as expected | PASS |
| 7 | Active, no Engram | `hooks.test.ts` A4 | An UPDATE outside Shadow's sample is drafted; the item is written to the spool before the memory file, the file before its `MEMORY.md` line; the item ends in `done/`; row `spooled 1, written 1` with no title or file name | RED: no fork, no file. GREEN | PASS |
| 8 | Active, Engram configured but down | `hooks.test.ts` A4 | The file carries `pending_engram: true`; the item stays parked in the live folder in state `fallback` | as expected | PASS |
| 9 | Active, Engram live | `hooks.test.ts` A4 | 0 writes; Shadow's 1 in 5 sample; rows `mode: active, effective: shadow` | as expected | PASS |
| 10 | Malformed gate or draft | `hooks.test.ts` A4 | A gate that is neither SKIP nor UPDATE, a fork answer that is not JSON and a fork with no answer write nothing; the row says `malformed`, `unparsable` or `no-answer` | as expected | PASS |
| 11 | Update and backup | `hooks.test.ts` A4 | The old file is copied byte for byte to `.memory-backup/<stamp>/` before the rewrite; a save of an existing topic does the same; one `MEMORY.md` line, never two; an update of a missing file or without frontmatter is refused (`dropped`); a failed copy rewrites nothing (`writeFailures`); deletes are never applied | as expected | PASS |
| 12 | `.consolidate-lock` | `hooks.test.ts` A4 | `kill -0 <pid>` asked; nothing written in the memory folder; the save stays `pending` in the spool; row `lockHeld: true` | as expected | PASS |
| 13 | Replay at session start | `hooks.test.ts` A5 | A save a crashed session left is written once, its item moved to `done/`, one `event: replay` row; a second start changes nothing and logs nothing; a save the lock held back is finished at the next start; another session's item that moved a minute ago is left alone; Shadow and Engram live replay nothing | RED: nothing replayed. GREEN 257/257 hooks tests | PASS |
| 14 | `measure-module-cost` | `module_cost.test.ts` | A line for Active's writes: turns that wrote, files written and rewritten, backups, spooled, replayed, failures, refused, lock | RED: no line. GREEN 21/21 | PASS |
| 15 | One version everywhere | `scripts/release-docs.test.mjs` | 0.9.0 in package.json, orca-plugin.json, CHANGELOG, README | RED after the bump; GREEN 2/2 after the notes | PASS |
| 16 | Live: marketplace install at 0.9.0 | lock, `current`, hooks | Same 0.9.0 root everywhere | `current` is root `1200d4cf…` (`"version": "0.9.0"`); the 4 Orca accounts and `~/.claude/settings.json` each have 8 hook commands on it and 0 on the 0.8.3 root; the mod-skills copies match the root's; the first row after the update (2026-10-14T00:51:05Z) carries `effective` | PASS |
| 17 | Live: Active on a machine without Engram (or with it down) | the memory folder, `memory-decisions-*.jsonl` | A remembered fact appears as a file with the folder's frontmatter and one `MEMORY.md` line; the row says `effective: active, written: 1`; a fresh session reads the fact without a tool call | Owner's Mac, memory set Active, an interactive session in a scratch repo with `--strict-mcp-config` (Engram configured but not reachable: `backend: configured-down`). One turn stated a deploy command and a package preference and told the main thread not to write memory. Row 2026-10-14T00:55:34Z: `mode: active, effective: active, gate: update, fork: drafted, spooled: 2, written: 2, writeFailures: 0, mainAutoMemoryWrites: 0`. The folder got `project-deploy-make-ship-staging.md` and `user-prefers-pnpm.md` (frontmatter `name`, quoted `description`, `node_type: memory`, `type`, `topic_key`, `pending_engram: true`, `originSessionId`, `modified`) and 2 `MEMORY.md` lines. A new `-p` session answered "`make ship`, and you prefer pnpm over npm" in 1 turn with no tool. The 2 spool items stay parked under `memory-spool/<store>/<session>/` because the backend is down, as designed (Engram replay is a later release) | PASS |
| 18 | Live: an update leaves a backup | `.memory-backup/` | A byte-for-byte copy of the old file (`cmp`) next to the rewritten one | Pending | PENDING |
| 19 | Live: a crash between the fork and the write | kill the session after the row's fork, then start a new one | The spool item is written once at the next start (or 10 minutes later for another session) and moves to `done/` | Pending | PENDING |
| 20 | Live: Engram live under Active | the owner's machine | No write in the memory folder; rows `mode: active, effective: shadow`; the card says Active keeps measuring | Pending | PENDING |
| 21 | Live: the card's weekly counts match the log | the card against `jq` over `memory-decisions-*.jsonl` | Same written, rewritten, spooled and replayed counts | Pending | PENDING |

## Not covered

- Engram writes and judging, the replay of fallback copies into Engram, the `tool.call` intercept of the main thread's own memory writes, tidy, the band and pane, deletes: later releases.
- An update is applied after its backup and is not spooled: a crash between the copy and the rewrite loses only that update (the old file and its copy stay).
- A turn whose next turn already started is not drafted in Active either (`turn-moved-on`).
- Windows (not tested): `mv`, `cp`, `mkdir -p` and `kill -0` are not there. A new memory file is still written, but its spool item cannot move to `done/` (counted as a failed write and retried at each start), and no existing file is rewritten, since its backup cannot be made.
