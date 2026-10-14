# Memory module in Active, Engram live (track M9, 0.10.0)

Branch `feat/memory-active-engram`, from `origin/fix/engram-health-old-engram` (0.9.1, PR #68, still open when this branch was cut; rebase onto `main` once it merges). Design: sections 5.3 to 5.8 and the M9 row of 5.8 of the mods review; files store: `odd/tasks/memory-active-files.md`; pure logic: `odd/tasks/memory-core.md`; Shadow: `odd/tasks/memory-shadow.md`.

## Objective

Active writes to Engram when Engram is usable. Every save is spooled first, then saved with `mem_save`; `user` and `feedback` saves are also mirrored into the auto-memory folder, so they are in `MEMORY.md` every session. Conflicts Engram reports are judged by Haiku when the verdict is clear and left pending in Engram otherwise. A failed save falls back to a file tagged `pending_engram`, and the next session start with Engram usable passes it to Engram.

## Scope

In:
- The Engram write path in the turn-end timer: spool, `mem_save`, the mirror, the judge, the fallback.
- The double-save rule: a turn whose main thread already called `mem_save` writes nothing of the fork's.
- The replay of parked fallback items into Engram at `session.start`.
- Row fields (counts only), the weekly summary, the Memory card (es/en), the `measure-module-cost` memory line.
- README and CHANGELOG, version 0.10.0, `odd/qa/qa-0.10.0.md`.

Out: the M11 `tool.call` intercept and prompt section, tidy, deletes, the band and pane, Windows, any edit to the person's CLAUDE.md.

## Fixed facts the code relies on

- **When Active writes to Engram.** `engramUsable`: the backend is `live`, a server is named, and the health check was not refused. A refused check (`permission: refused`) keeps Active measuring as Shadow (`effective: shadow`), as in 0.9.0.
- **Every UPDATE is drafted** in Active, as for the files store. The fork's `updates` and `deletes` are not applied while Engram is the store: updates are counted `dropped`, deletes `wouldDelete`.
- **Spool first.** Each save is written to its spool item before `mem_save`. On success the item records the observation id and `candidates[]`, then moves to `done/`.
- **The `mem_save` args** are the main thread's own: `title`, `type` (Engram's category: `policy` for feedback, `learning` for user, `discovery` for project and reference), `content`, `topic_key`, `capture_prompt: false`. No `project`: Engram detects it from its working directory, as `mem_current_project` does.
- **The answer.** Engram 2.x answers a JSON envelope (`id`, `judgment_required`, `candidates[]`). An older Engram answers plain text (`Memory saved: "<title>" (<type>)`) with no id and no candidates; both are a success. A tool error, a rejection or no answer within `MEMORY_ENGRAM_TIMEOUT_MS` is a failure.
- **Store split by type (design 5.3).** `user` and `feedback` are mirrored as a file with `engram_id` and `topic_key` in the frontmatter and their `MEMORY.md` line; `project` and `reference` go to Engram only.
- **Judging.** Only when `mem_judge` is listed (`engramHasTool`); otherwise each candidate is counted `judgeUnavailable`. For each candidate, its text comes from `mem_get_observation` (read only, when listed); Haiku reads only the two observations' text and names a relation and a confidence. `decideVerdict` decides who may record it:
  - below 0.7, or `supersedes`/`conflicts_with` touching an architecture, policy or decision, is left pending in Engram (`judgePending`): a background job cannot ask the person;
  - the owner's exception from `odd/tasks/memory-shadow.md` stays: a confident `supersedes` between two `policy` observations (feedback replacing feedback) is recorded;
  - anything else goes to `mem_judge` with that candidate's own `judgment_id`.
  A candidate whose text could not be read, or whose Haiku answer or `mem_judge` call failed, is not judged and counted `judgeFailed`; it also stays pending in Engram.
- **Double saves.** When the main thread called `mem_save` in the same turn (the Shadow observer's `mainEngramSaves`), the fork's saves are dropped: nothing is spooled or written, and the row counts `droppedMainSaved`.
- **Failure.** A failed `mem_save` writes the 0.9.0 fallback file (`pending_engram: true`) and the item stays parked in the live spool folder.
- **Replay into Engram.** At `session.start` with Engram usable, this folder's spool is replayed with 0.9.0's `planReplay` rules. A parked fallback item is saved to Engram, then its fallback file is turned into a mirror (`user`/`feedback`: `pending_engram` dropped, `engram_id` added) or removed (`project`/`reference`). A file is removed only when its frontmatter says `pending_engram: true` and its `originSessionId` and `topic_key` are the item's, after a `cp -p` backup; its `MEMORY.md` line goes with it. A second replay changes nothing.
- **Fail open.** Any failure is swallowed and counted; `next(e)` is returned unchanged. `$` is used only in top-level functions (JEVADV-43).
- **The row** holds counts only: `engramSaved`, `engramFailed`, `mirrored`, `judged`, `judgePending`, `judgeUnavailable`, `judgeFailed`, `droppedMainSaved`, and on a replay `replayedToEngram`, `fallbackRemoved`, `fallbackMirrored`. Haiku judge tokens go in `judgeTokens`.

## Checklist

Strict TDD: a test written and observed failing, then green, then refactor and one Conventional Commit. A box is ticked only with observed proof.

- [x] E0 Task file (this file).
- [x] E1 Pure core:
  - the spool item keeps `candidates[]` (0.9.0 items read as none);
  - an older Engram's plain `Memory saved:` answer is a success;
  - a fallback copy is removed only when its frontmatter is the item's (`originSessionId` read by `parseFrontmatter`);
  - `effectiveMemoryMode` is Active with Engram usable and Shadow when the check was refused;
  - `mem_get_observation`'s envelope is read;
  - the row, the replay row and the weekly summary carry the new counts.
- [x] E2 Mod wiring, the turn: spool, `mem_save`, mirror, `done/`; a failure or a timeout gives the fallback file; the double-save drop; judging (recorded, pending, unavailable, failed). Tests in `hooks.test.ts` with the fake host.
- [x] E3 Mod wiring, the replay into Engram: the fallback copy becomes a mirror or is removed after a backup; a file that is not the item's own copy is left; a second replay changes nothing.
- [x] E4 Card (es/en): per backend, what Active does now; the week's Engram figures and the pending line; `panels.spec.mjs` cases; screenshots.
- [x] E5 `measure-module-cost` memory line: the Engram counts.
- [x] E6 Release 0.10.0: README and CHANGELOG, version, `odd/qa/qa-0.10.0.md`.
- [x] E7 (0.10.1) Index line inside Claude Code's load window (200 lines, 25,000 bytes): live qa-0.10.0 #15 found a mirrored rule at line 203 of a 203-line index. RED: three `upsertIndexLine` tests in `src/core/memory_draft.test.ts`; GREEN 31/31, suite 4333/4333 (`odd/qa/qa-0.10.1.md`).

## Acceptance criteria

- With Engram usable, an Active turn makes at most one Haiku gate, one fork, one `mem_save` per drafted save, and per candidate at most one `mem_get_observation`, one Haiku judge and one `mem_judge`.
- A save is in the spool before `mem_save` is called; a failure leaves a fallback file and a parked item that the next start with Engram usable finishes once.
- `project` and `reference` saves never become a file while Engram takes them.
- A refused check writes nothing and every row says `effective: shadow`.
- Every hook returns `next(e)`'s result unchanged; any failure is swallowed.
- The card says, per backend, what Active does, and shows the week's Engram figures with the pending explanation, in es and en.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, and screenshots of the Memory card only: 1440 and 390, light (dark only if colours are added).

## Live check (later, by the lead, against a scratch Engram via `ENGRAM_DATA_DIR`)

Listed in `odd/qa/qa-0.10.0.md`.

## Outcome

- `npm run typecheck` exit 0; `npm test` 4329/4329; `npm run test:panels` 242/242.
- The Memory card was photographed in Active with Engram live and a week of Engram figures: English at 1440 and 390, Spanish at 390, light. No colour was added, so there is no dark shot. The images are kept out of the repository.
- Decisions taken while building:
  - The judge keeps the owner's exception from `odd/tasks/memory-shadow.md` (`decideVerdict`): a confident `supersedes` between two `policy` observations is recorded, not left pending.
  - `mem_save` gets no `project`: Engram detects it from its working directory, the same answer `mem_current_project` gives.
  - The Engram call clock is 10 s (`MEMORY_ENGRAM_TIMEOUT_MS`), longer than the 3 s health check, since a save also runs Engram's candidate search.
  - A candidate whose text cannot be read (no `mem_get_observation`, or the read failed) is not judged on its title alone: it is counted `judgeFailed` and stays pending in Engram.
  - On a double-save turn the fork still runs, so the drop is measured.
  - The card's pending figure is `judgePending + judgeFailed`: both stay pending in Engram.
