# Memory module in Active, files store (track M-active-files: M10, 0.9.0)

Branch `feat/memory-active-files`, from `main` at 9140fc7. Design: sections 5.3 to 5.6 and the M10 row of 5.8 of the mods review; engine facts: `odd/research/engine-probes-2.1.296.md` (a to d); pure logic: `odd/tasks/memory-core.md`; Shadow: `odd/tasks/memory-shadow.md`.

## Objective

Ship the memory module's **Active** state for people whose memory store is Claude Code's auto-memory folder: no Engram, or Engram configured but down. Active drafts every UPDATE turn with a fork, spools each save before writing it, writes it into the auto-memory folder with its line in `MEMORY.md`, and rewrites an existing file only after a byte-for-byte backup.

Why now, from real Shadow rows on a partner's Linux machine (Engram configured but down), one day:
- 275 rows, 118 UPDATE, 101 of them `module-only`: the module would have saved something the main thread did not.
- The main thread wrote to the memory folder 6 times.
- 17 gate answers (6%) were `malformed`.

## Scope

In:
- The registry offers `off | shadow | active` again; the default stays `shadow`.
- The Active write path for the files store (M10) in the turn-end timer, and the spool replay at `session.start`.
- Row fields for Active, the weekly summary, the Modules card (es/en), the `measure-module-cost` memory line.
- README and CHANGELOG disclosure, version 0.9.0, `odd/qa/qa-0.9.0.md`.

Out (later releases): Engram writes (`mem_save`, `mem_judge`), replaying fallback copies into Engram, the `tool.call` intercept, the prompt section, tidy, the band and pane, deletes.

## Fixed facts the code relies on

- **Which backend writes.** Active writes only when the backend is `absent` or `configured-down`. With the backend `live` (whatever the permission), Active keeps measuring exactly as Shadow (1 in 5 forks, nothing written): writing to Engram arrives in a later release. Every row carries `mode` (the switch) and `effective` (what ran), so a live Engram under Active reads `mode: active, effective: shadow`.
- **Every UPDATE is drafted** in Active (no 1-in-5 sample). A turn whose next turn already started is still not forked (`turn-moved-on`, as in Shadow): the main thread keeps that turn.
- **The draft is read with `parseDraft`**: bare names only, no `MEMORY.md`, no paths, size caps. A malformed gate answer or a fork answer that is not a draft writes nothing and is counted in the row (`gate: malformed`, `fork: unparsable | no-answer`).
- **Saves go through the spool first** (`memory_spool.ts`). One file per item, written before any memory file:
  - path `<cache dir>/memory-spool/<store id>/<sessionId>/<id>.json`. The store id is an FNV-1a hash of the auto-memory folder, so a replay only ever writes the items of its own folder (account and repository);
  - no Engram: `pending -> written -> done`, the item ends in `done/` (moved with `mv`);
  - Engram configured but down: `pending -> fallback`. The file is written with `pending_engram: true` and the item stays parked in the live folder for the Engram replay of a later release.
- **Replay** runs at `session.start`, after the backend is detected, when the module is Active and the backend is not live. It uses `planReplay`: this session's items, any parked fallback item, and another session's item once it has been still for 10 minutes. A replayed save upserts `<topic_key>.md` and its index line, so a second replay changes nothing.
- **The file format** is the folder's own: `name`, a quoted `description`, and `metadata` with `node_type: memory`, `type`, `topic_key`, `originSessionId` and `modified` (checked read-only against the engine's files in the Orca account folders). `MEMORY.md` gets one `- [Title](file.md) — hook` line, replaced in place on a later save of the same topic.
- **Backups.** Before a memory file that already exists is rewritten (an update, or a save of an existing topic), it is copied byte for byte with `cp -p` to `<memory dir>/.memory-backup/<stamp>/`. When the copy fails, nothing is rewritten. `MEMORY.md` is not copied: code edits one line of it and keeps the rest.
- **Updates** (`{name, content}`, the whole new file) are applied directly after the backup, not spooled. An update naming a file that does not exist, or whose content has no frontmatter `name`, is dropped and counted.
- **Deletes are not applied in this release.** They are counted as `wouldDelete`, as in Shadow.
- **`.consolidate-lock`.** When Claude Code's own consolidation holds the folder (a lock under an hour old whose pid answers `kill -0`), nothing is written: saves stay spooled for the next replay, updates are dropped, and the row says `lockHeld: true`.
- **The main thread is not intercepted** in this release. Its own rare writes stay. The fork already reads the current files, so it updates an existing topic instead of adding a duplicate.
- **Fail open.** Any failure is swallowed and counted; `next(e)` is returned unchanged. `$` is used only in top-level functions, never in a closure declared inside `register` (JEVADV-43).
- **The row** holds counts only (`spooled`, `written`, `updated`, `backups`, `dropped`, `writeFailures`, `lockHeld`), never a title, a file name or memory text. A replay at `session.start` that found items logs one row with `event: replay` (`replayed`, `written`, `updated`, `superseded`, `writeFailures`, `lockHeld`). The summary never counts a replay row as a decision.

## Checklist

Strict TDD: a test written and observed failing, then green, then refactor and one Conventional Commit. A box is ticked only with observed proof.

- [x] A0 Task file (this file).
- [x] A1 `renderMemoryFile` writes the folder's own metadata: `node_type: memory` and `modified`; the spool passes its clock.
- [x] A2 `src/core/memory_active.ts` and `memory_shadow.ts`:
  - the effective mode from the switch and the backend;
  - the spool root per store;
  - the update check;
  - the row's Active fields and the replay row;
  - the weekly summary's Active counts.
- [x] A3 Registry and card:
  - memory offers Off, Shadow and Active; default Shadow;
  - the card's Active text per backend, the cost line for every-UPDATE forks, the week's written and updated counts (es/en);
  - `panels.spec.mjs` cases for the Active choice and its lines.
- [x] A4 Mod wiring, the write path in the turn-end timer. Tests in `hooks.test.ts`:
  - Off: 0 Haiku calls, 0 rows, 0 writes;
  - Shadow: unchanged, 0 writes;
  - Active, no Engram: spool, then the file and its `MEMORY.md` line, then the item in `done/`;
  - Active, Engram configured but down: the file carries `pending_engram: true` and the item stays parked;
  - Active, Engram live: 0 writes, the row says `effective: shadow`;
  - a malformed gate or draft writes nothing and is counted;
  - an update: a byte-for-byte backup, then the rewrite;
  - a lock: nothing written, the item stays spooled;
  - a subagent turn or a turn that did not end with an answer does nothing.
- [x] A5 Replay at `session.start`: a pending item is written once; a second replay adds nothing; a replay row is logged.
- [x] A6 `measure-module-cost` memory line: written, updated and spooled counts.
- [x] A7 Release 0.9.0: README and CHANGELOG disclosure, version, `odd/qa/qa-0.9.0.md` with test scenarios and pending live ones.

## Acceptance criteria

- In Active with the files store, a turn makes at most one Haiku call and one fork, and writes only:
  - spool items under the cache dir;
  - memory files and `MEMORY.md` in the session's auto-memory folder;
  - backups under its `.memory-backup/`;
  - one row.
- A save is on disk in the spool before any memory file is touched; a crash at any step leaves an item the next replay finishes.
- With Engram live, Active writes nothing and every row says so.
- Off makes no call, no row and no write, and schedules nothing.
- Every hook returns `next(e)`'s result unchanged; any failure is swallowed.
- The card says, per backend, what Active does, and every control goes through the real `feature-modules-save` writer.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, and screenshots of the Memory card only: 1440 and 390, light (dark only if colours are added).

## Live check (later, by the lead, on the marketplace install)

- A machine with no Engram, or Engram down: a remembered fact appears as a file plus one `MEMORY.md` line, and a fresh session reads it without a call.
- An update leaves a byte-for-byte copy under `.memory-backup/`.
- Killing a session between the fork and the write leaves a spool item that the next session start writes once.
- With Engram live, Active writes nothing and the card says it keeps measuring.
- The card's weekly counts match the log.

## Outcome

- `npm run typecheck` exit 0; `npm test` 4304/4304; `npm run test:panels` 241/241.
- The Memory card was photographed in Active with no Engram, English, at 1440 and 390, light. No colour was added, so there is no dark shot. The images are kept out of the repository.
- Decisions taken while building:
  - "Live" means the backend `live` whatever the permission: a refused health check still keeps Active measuring, since the main thread can use Engram.
  - The spool root carries a store id (a hash of the memory folder), so a replay never writes another repository's or account's items into this folder.
  - The replay runs at session start only, not at turn end; an item held by the lock waits for the next start.
  - A replay row is logged only when the replay did something (or found the lock), so a parked fallback copy does not log a row at every start.
