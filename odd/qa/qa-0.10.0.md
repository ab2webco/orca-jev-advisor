# QA 0.10.0: the memory module's Active state with Engram live

Run on 2026-10-13 against `feat/memory-active-engram`, cut from `origin/fix/engram-health-old-engram` (0.9.1, PR #68, still open at the time). Plan: `odd/tasks/memory-active-engram.md`.

## Why

- 0.9.0's Active wrote only when Engram was absent or down; with Engram live it measured and wrote nothing. Engram is the store of record in the design (mods review 5.3), so Active must write there.
- The spool did not keep `mem_save`'s `candidates[]` (memory-core hand-off), so a conflict could not be judged after a crash.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 4329/4329 |
| `npm run test:panels` | 242/242 (4 shards) |
| Shots | The Memory card in Active with Engram live and a week of Engram figures: English at 1440 and 390, Spanish at 390, light. No colour added, so no dark shot. Kept outside the repository |
| Live | 14 and 17 PASS and 15 FAIL (fixed in 0.10.1) from normal use on the owner's real Engram; 16, 18, 19, 20 PENDING |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | The spool keeps the candidates and the observation id | `memory_spool.test.ts` E1 | A successful save stores `engramId` and `candidates[]` in the item's file; a later failure keeps them; a 0.9.0 item without the field reads as none; a malformed entry is skipped, a non-list is a bad file | RED: `candidates` undefined. GREEN | PASS |
| 2 | An older Engram's answer | `memory_spool.test.ts` E1 | Plain `Memory saved: …` is a success with no id and no candidates; other plain text and any tool error are failures | RED: unreadable. GREEN | PASS |
| 3 | Only the item's own fallback copy is removed | `memory_spool.test.ts` E1 | A copy without `pending_engram`, from another session or on another topic is left with its line; a copy already gone only loses its line; a copy not read is not touched | RED: removed regardless. GREEN | PASS |
| 4 | Effective mode | `memory_active.test.ts` | Active with Engram usable (health ok, or tools only on 1.12.0) is `active`; a refused check is `shadow` | RED: `shadow` for live. GREEN | PASS |
| 5 | Rows and summary | `memory_shadow.test.ts`, `memory_judge.test.ts` | Decision and replay rows carry the Engram counts (counts only); the weekly summary adds them; judge tokens join the Haiku tokens; `mem_get_observation`'s envelope is unwrapped | RED: fields missing, `readObservationResult` missing. GREEN 216/216 memory core | PASS |
| 6 | Active + Engram live: save and mirror | `hooks.test.ts` E2 | The item is in the spool before `mem_save`; `mem_save` gets `title, content, type: policy, topic_key, capture_prompt: false`; the feedback file has `engram_id` and `topic_key`, no `pending_engram`, and its `MEMORY.md` line; the item ends in `done/` with `store: engram`; row `effective: active, engramSaved 1, mirrored 1`, no text | RED (7 of 7 E2 cases). GREEN | PASS |
| 7 | Project and reference go to Engram only | `hooks.test.ts` E2 | Two `mem_save` calls of type `discovery`; the memory folder is byte for byte unchanged; a drafted file update is not applied (`dropped 1`) | as expected | PASS |
| 8 | A failed save falls back | `hooks.test.ts` E2 | Rejected, tool error and a 10 s timeout each: one attempt, the file with `pending_engram: true` and its line, the item parked in state `fallback`, row `engramFailed 1` | as expected | PASS |
| 9 | Double saves | `hooks.test.ts` E2 | The main thread's own `mem_save` this turn: the fork still drafts, the module calls no `mem_save`, spools and writes nothing; row `droppedMainSaved 2` | as expected | PASS |
| 10 | Judging | `hooks.test.ts` E2 | Five candidates: each read with `mem_get_observation`; Haiku gets only `<new>` and `<existing>` (no session text); `related 0.9` and `supersedes 0.95` between two policies recorded with their own `judgment_id`; `compatible 0.5` and `conflicts_with` on a decision left pending; a non-verdict counted failed; row `judged 2, judgePending 2, judgeFailed 1`, judge tokens summed; the spool item keeps 5 candidates | as expected | PASS |
| 11 | No `mem_judge` listed; Engram 1.12.0 | `hooks.test.ts` E2 | Candidates counted `judgeUnavailable`, no Haiku judge, no read; on 1.12.0 (no health tool) the plain answer is a save on `plugin_engram_engram`, the mirror has no `engram_id` | as expected | PASS |
| 12 | Replay into Engram | `hooks.test.ts` E3 | Parked feedback and project copies are saved at the next start with Engram live; the feedback copy becomes a mirror with `engram_id`; the project copy is removed with its line after a `cp -p` backup that is byte for byte the old file; both items in `done/`; replay row `replayedToEngram 2, fallbackMirrored 1, fallbackRemoved 1`; a second start saves nothing, changes nothing and logs nothing; a changed copy is left with its line; a save that fails again stays parked and is not counted as replayed | RED (3 of 3). GREEN | PASS |
| 13 | Card, `measure-module-cost`, one version | `panels.spec.mjs` memory cases, `module_cost.test.ts`, `release-docs.test.mjs` | Per backend what Active does (en/es, tú); the week in Engram, "nothing yet" or "could not be read", never zeros; the pending line with why nothing is lost; hidden in Shadow and with no Engram; the cost report's `memory (Active, Engram)` line; 0.10.0 everywhere | RED: 4 of 8 card cases, 1 cost case, release-docs after the bump. GREEN | PASS |
| 14 | Live: Active + Engram live writes a save to a scratch Engram | `ENGRAM_DATA_DIR=<scratch>`, Active, a turn with a rule to remember | The observation is in the scratch Engram (`mem_search`); its spool item is in `done/`; row `effective: active, engramSaved 1` | Seen on the owner's real Engram instead of a scratch one (normal use, 2026-10-14): rows 03:41Z (`orca-oss`) and 03:59Z (`orca-wa-inbox`) `effective: active, engramSaved 1`; observations #5299 and #5301 exist with the drafted text and the right project; both spool items in `done/` with their `engramId` | PASS (real Engram) |
| 15 | Live: user/feedback mirror | the memory folder | A file with `engram_id` and `topic_key`, and its `MEMORY.md` line; a fresh session reads it without a tool call | Both feedback saves mirrored: files with `engram_id` 5299 / 5301 and `topic_key`, and their index lines. The `orca-oss` line is line 203 of a 203-line, 27,539-byte index, past what Claude Code loads, so a fresh session would not read it: fixed in 0.10.1 (`odd/qa/qa-0.10.1.md`) | FAIL, fixed in 0.10.1 |
| 16 | Live: a candidate conflict judged or left pending | two contradicting rules in two turns | Either a `mem_judge` verdict in Engram (`judged 1`) or the conflict still pending in Engram (`judgePending 1`); the card's pending line matches | Pending | PENDING |
| 17 | Live: the main thread saves in the same turn | ask the agent to save with `mem_save` itself | The module's row says `droppedMainSaved` > 0 and Engram has only the main thread's observation | Seen in normal use: row 02:42Z (`orca-oss`) `mainEngramSaves 1, toEngram 1, droppedMainSaved 1, engramSaved 0` | PASS (real Engram) |
| 18 | Live: Engram killed mid-session | stop the scratch Engram server, then a turn; then a new session with it back | A fallback file with `pending_engram: true` and a parked item; the next start saves it to Engram and removes the file (project/reference, with a backup) or turns it into a mirror (user/feedback); a second start changes nothing | Pending | PENDING |
| 19 | Live: Engram 1.12.0 (no `mem_judge`) | an install with Engram 1.12.0 | Saves land; rows say `decidedBy: tools`; any candidates are `judgeUnavailable` (1.12.0 is expected to report none) | Pending | PENDING |
| 20 | Live: the card's Engram figures match the log | the card against `jq` over `memory-decisions-*.jsonl` | Same saved, failed, mirrored, judged, pending and dropped counts | Pending | PENDING |

## Not covered

- The `tool.call` intercept of the main thread's own `mem_save` (M11), the prompt section, tidy, deletes, the band and pane: later releases. Without the intercept the main thread keeps its own Engram habits, and its `judgment_required` answers still reach the model.
- A failed save does not re-detect the backend: every later save in the session tries Engram again (each with its own 10 s clock) and falls back on failure.
- The fork's prompt with Engram live still reads the topic keys from the auto-memory files, not from Engram's own topic list.
- Without `mem_get_observation` listed, a candidate's text cannot be read, so it is not judged (`judgeFailed`).
- A judgment that stays pending is counted, not shown one by one; resolving it with the person (the band's Resolve) is M13.
- Windows (not tested): as in 0.9.0, `mv`, `cp`, `mkdir -p` and `kill -0` are not there.
