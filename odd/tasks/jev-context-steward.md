# Jev context steward

## Objective
Re-read context is most of what a long session costs. At the end of each
main-conversation turn above a context threshold, Jev judges whether a unit
of work just closed; if so, the plugin compacts the session with
instructions that keep the plan and the open work, and on a topic change it
also suggests `/clear`.

## Evidence (generic)
Measured on real sessions: cache reads are most of the spend, and Opus 5.5
and Sonnet 5 re-read at the same price, so model switching barely touches
them. Compacting a main context once it passes about 120k tokens would have
saved about half of the re-read context (an upper bound: it does not model
detail lost to compaction).

## Engine surface (claude-code.d.ts)
- `$.session.usage()`: free; `context.tokens`, `context.percent`, `context.window`.
- `$.session.compact({ instructions })`: `session.compact`, trigger `plugin`;
  rejects while a turn runs; resolves `{ messages, tokensBefore?, tokensAfter? }`
  or `{ skip }`.
- `turn.complete`: `agentId` set on a subagent's turn.
- `$.clock.after(ms, fn)`: a timer that outlives the dispatch (reference:
  "Work that outlives a dispatch"); the compaction runs from it, once the
  turn has ended.
- A plugin cannot run `/clear`: it is only suggested.

## Behaviour
1. Main `turn.complete` (reason `answer`) schedules the steward on a timer.
2. Context ≥ threshold (default 120k, per account) or ≥ 80% of the window:
   one Jev question, `boundary` / `mid-task` / `new-topic`, over a redacted,
   capped state (last two person-prompt excerpts, the turn's tool counts and
   commit/push/PR/test flags, context size, person turns since the last
   compaction). No file contents.
3. `boundary` ≥ 0.70: compact with preserving instructions.
4. `new-topic` ≥ 0.70: compact and suggest `/clear`.
5. `mid-task`, low confidence or Jev failure: nothing, except ≥ 80% of the
   window (hard limit): compact anyway.
6. Never twice within 3 person turns; never a subagent; never in measure mode.

## Modes
`off` / `measure` (default) / `active`, per account, in the router options
of the account's settings.json (`stewardMode`, `stewardThreshold`), shown in
the config panel's Models tab next to the router.

## Tasks
- [x] S1 core: `src/core/context_steward.ts` (gate, Jev state/question,
  decision, preserving instructions, record, status text) + tests
- [x] S2 hooks: `turn.complete` → timer → Jev → compact/log/status + hooks tests
- [x] S3 settings: `stewardMode`/`stewardThreshold` read/write (core, installer
  `steward-set`, main bridge) + tests
- [x] S4 panel: Models tab steward row (mode + threshold) + panel tests + shots
- [x] S5 consumption: prune `context-steward-decisions-*.jsonl`; board
  Consumption line (compactions applied, estimated tokens no longer re-read)
- [x] S6 live check: low threshold in a scratch session; cacheRead drops

## Acceptance
- Tests (RED first): boundary above threshold compacts with preserving
  instructions; `mid-task` does not; hard limit compacts; 3-turn cooldown;
  measure changes nothing; a subagent is never compacted; Jev failure means
  no compaction except at the hard limit.
- `npm test`, `npm run test:panels`, `npm run shots` (4 images read), hooks
  `tsc -p adapters/claude/mod-skills/tsconfig.json`,
  `adapters/orca/mod_skills_validate.test.mjs` green.
- Live: the step after a steward compaction reads fewer cached tokens.

## Progress
- S1: RED (module missing), GREEN 30/30 core tests. Commit `3ee297d`.
- S3 core: RED (missing exports), GREEN; `342e4b1`. Installer/bridge: RED 4,
  GREEN 163/163; `505691d`.
- S2: RED 18/18 (no `turn.start`/`turn.complete` hooks), GREEN 18/18; hooks
  `tsc` exit 0; validate 1/1; `d012311`.
- S5: RED 3 core + 3 sidecar, GREEN; `1842d64`. S4/S5 panels: RED 3 config +
  2 board Playwright tests, GREEN; `03ccac1`.
- Live check (interactive session, scratch git repo, threshold 30k, Sonnet 5):
  Jev judged the commit a boundary, the session compacted to about a tenth of
  its conversational context, the next step's cached re-read fell by about
  half (what remains is the fixed system/tools prefix), and the next answer
  named the branch, the last commit and the feature document's next step
  from the summary alone.
- Found live: `$.session.compact` is refused in a headless (`-p` / SDK)
  session. The log now says why a compaction was not applied
  (`notApplied`: measure, turn-running, rejected, headless, skipped) and a
  headless refusal is not retried; `bddc98c`.
- Seen in screenshots at 320px: the threshold's unit wrapped away from its
  number; fixed, `0139289`. Looked at: Models tab and Consumption tab at
  1440, 768, 390 and 320, light and dark (router-ready scenario).

## Known gaps
- Headless (`-p` / SDK) sessions are logged, never compacted: the engine does
  not offer plugin compaction there yet.
- The Consumption estimate is per later step (context freed), not a total:
  the logs carry no session id and one account runs several sessions.
- The steward's status part stays until its next decision (a later turn
  below the threshold leaves the last compaction's line up).
