# The skills mod never installed, and the board buries what matters

## Objective
Make the skills-mod copy actually land on disk, and reorganise the Advisor
board so the families that intervene are visible instead of the families that
merely run often.

## Problem

**1. `fs.cp` is denied by the worker's permission sandbox.** Reproduced on the
author's machine with the exact flags `main.mjs` spawns the installer with:

```
OK    readdir(source)      OK   mkdir(destination)
OK    readFile(source/…)   OK   writeFile(destination/…)
FALLA cp recursive  ->  ERR_ACCESS_DENIED
```

Adding `/*` wildcards to both sides does not help. 0.3.1 replaced the symlink
with a copy *because* `fs.symlink` was denied the same way — one forbidden API
swapped for another. `install()` still returns `ok: true`, and
`modCopyWarning: 'copy-failed'` drops the underlying detail, so two successive
updates were diagnosed as "the update does not reapply the copy" when the copy
had never once succeeded. `mod-skills-measurements.jsonl` has never existed.

**2. The families table sorts by total, which buries every intervention.**
Measured over the author's 2,773 decisions: 91 families, **61 of them 100%
allowed**. The board shows the top 8 by total, so `grep` (216, zero
interventions) takes a row while `terraform` (17 asks out of 18), `git
reset/clean` (17 asks), `kubectl` (9 of 9) and `git push` (3 denies) do not
appear at all.

**3. The live status prints raw UUID pairs.** `paneKey` renders as
`1e1fff06-…:a62d09bd-…`, on a row whose project and branch are both null.

**4. An accumulated count mixes rule semantics across versions.** The 17
`ask` rows for the pipe-to-shell family look like the deny tier not working.
Five are from today — but from before 12:21, when the machine still ran 0.2.6.
A time window does not separate that; the plugin version does, and a decision
record does not carry one.

## Scope (authorized)
- `adapters/orca/install-claude-integration.mjs` (+ tests) — the copy.
- `src/core/gate_measurement.ts`, `src/core/gate_stats.ts` (+ tests) — version
  on the record, p95, per-family intervention counts.
- `adapters/orca/read-measurements.mjs` (+ test) — expose both.
- `adapters/orca/panels/board.html` — the rendering.
- `scripts/screenshot-panels.mjs` — fixtures and scenarios.

## Constraints
- No invented numbers. Avoided network calls are counted; minutes saved are
  NOT rendered — that is a count times a median, an extrapolation.
- "No scroll" is not achievable in a narrow nav panel and will not be claimed.
  The order is what is guaranteed.
- Both themes, 1440/768/390/320, every image read.

## Tasks

Reconciled against the code on 2026-09-24 (base `69e525e`) before any
source write. Route per task: **inline** unless noted; the work is one
writer on a sequential set of files, and every file was already read in
full during reconciliation (no mapping or writer trigger left to delegate).

- [x] T1 manual recursive copy replacing `fs.cp`, with the real error detail
      carried through to the panel. **Already shipped** in `7be24c3`, squashed
      into `7be810a` (#14): `adapters/orca/install-claude-integration.mjs:549`
      is the manual walk; no `fs.cp`/`symlink` call remains in that file;
      `modCopyDetail` at `:719`. Not redone.
- [~] T2 `pluginVersion` on each gate decision record. **Half shipped.**
      `GateDecisionRecord.pluginVersion` (`src/core/gate_measurement.ts:48`),
      the reader guard (`read-measurements.mjs:123`) and the fold
      (`gate_stats.ts` `byPluginVersion`) exist, but the writer never stamps
      it: `adapters/claude/gate-bash.ts:574` calls `buildGateDecisionRecord`
      without `pluginVersion`, and 0 of 3,602 rows in the author's real
      `gate-decisions.jsonl` carry the key. `gate-bash.ts` belongs to PR 2
      (gate-approval-learning); coordinator notified (`msg_3479f1f617d3`).
      This PR does not touch it and does not change `GateDecisionRecord`.
      Until the writer stamps, the board's "current version" window is
      rendered as unavailable with the reason, never as an empty window.
- [x] T3 p95 beside the median. **Data already shipped** (`gate_stats.ts`
      `jevLatency.p95Ms`, test at `read-measurements.test.mjs:216`). The
      board never rendered it; rendering is part of T7.
- [x] T4 per-family `ask`/`deny`/`notRun`, and a count of families with no
      interventions. **Already shipped**: `GateCommandFamilyStat.interventions`,
      `familiesWithNoInterventions`, `gate.notRunByCommandFamily` (tests at
      `read-measurements.test.mjs:187,243`).
- [x] T10 reader: per-window gate aggregates (`version` / `day` / `week` /
      `all`), each with its interventions table (<=15 rows sorted by
      interventions, a `rest` aggregate, a `quiet` "no interventions"
      aggregate, notRun joined per family) and its own approvals summary;
      plus `gate.health` (last successful Jev call, consecutive failures).
      Slice 3a.
- [x] T11 `panel_values.mjs`: board helpers (default window, relative age,
      live-entry label) with tests, hand-copied into `board.html`. Slice 3b.
- [x] T5 board: interventions table (<=15 rows, sorted by interventions, plus
      a "N families with no interventions" row and a "rest" row, notRun
      column). Slice 3b.
- [x] T6 board: live status with name/branch chips and the UUID only in a
      tooltip. Slice 3b.
- [x] T7 board: a status strip -- last successful Jev call, consecutive
      failures, unjudged (`source: "none"`) count, p50/p95. Slice 3b.
- [x] T8 board: a window selector (current version / 24h / 7d / all), and
      the four-question order (status -> toll -> interventions ->
      calibration, recents/live below). Slice 3b.
- [x] T9 empty-log state verified and photographed (new `empty` harness
      scenario: the worker ran, every log is empty). Slice 3b.

## Scope added by this PR
- `scripts/screenshot-panels.mjs`, `scripts/fixture_shape.test.mjs` -- the
  fixtures must carry the new `windows`/`health` shape or every board
  screenshot photographs a panel nobody will see (the fixture has drifted
  four times already). Not in the dispatch's file list; recorded as a
  necessary out-of-list write.

## Follow-ups (found, not fixed here)
- Review R3-001 (3a, advisory): the interventions tie-break uses
  `localeCompare`, which is host-locale dependent; a code-point comparison
  would be deterministic everywhere, and no test pins the name tie-break.
- Review R3-002 (3a, advisory): `gate-approvals.jsonl` is now read up to
  three times per reader run (`aggregateGate`, `aggregateApprovals`,
  `aggregateNotRunByCommandFamily`); one read shared by all three would make
  them consistent under a concurrent append.
- Review R3-001 (3b+3c, advisory): the board decides "has data" from
  `gate.windows.all` only, so a summary published by an older aggregator
  (no `windows`) shows the empty card until the worker republishes. A
  fallback to `gate.totalDecisions` or a distinct message would cover it.
- Review R3-002 (3b+3c, advisory): the ES5 copies of the board helpers in
  `board.html` are checked only by grep; a parity test would prove the
  running copy.
- The Spanish catalog is complete (every key checked in both languages)
  but the harness renders English only; no ES screenshot was taken.
- `commandFamily()` still yields filename families for an env-assignment
  first token: `L=~/.cache/x/gate-decisions.jsonl; wc -l $L` is recorded
  under family `gate-decisions.jsonl` (seen in the real log). The P0 fix
  takes the basename of any token with a `/`; a `NAME=value` token should
  be skipped or fold to `other`. `src/core/gate_measurement.ts`.
- The brief's status strip also names "gate active" and "key present";
  both live in storage keys `config.html` already reads
  (`claudeIntegrationStatus`, `secretStatus`). Not in this dispatch.

## Checks
`npm test` (baseline 762), `npm run check` (tests + panel spec + shots),
plus reading every board screenshot: 1440/768/390/320, both themes, and the
empty-log scenario.

## TDD
Strict TDD (source: user CLAUDE.md, odd/CHECKPOINT.md). Runner `npm test`
(`node --test --experimental-strip-types`).

## Delivery
`ask-on-risk`; forecast ~1,100 authored lines, so the coordinator chose
**stacked-to-main**:
- **3a** (targets `main`): T10 -- reader + tests + this document.
- **3b** (targets 3a's branch): T11 helpers + fixtures, ~360 lines
  (`bf4e59b`, `1e78da4`).
- **3c** (targets 3b's branch): T5-T9, the board, ~790 lines (`a83ac17`)
  plus this document. Over the ~400 heuristic because `board.html` is one
  cohesive rewrite: the four cards, the picker and the live rows share the
  same render path and catalog, and splitting them would ship a board with
  half its questions.

## Progress
| Task | Route | Commit | Checks | Review |
| --- | --- | --- | --- | --- |
| T1 | reconcile only | `7be24c3` (in `7be810a`) | read | -- |
| T2 | reconcile only | -- (writer in PR 2's file) | 0/3,602 rows stamped | -- |
| T3, T4 | reconcile only | already shipped | existing tests | -- |
| T10 | inline | `642d815`, `b539813`, squashed as `ce20de1` (#16) | RED 11 fail -> GREEN 27/27; `npm test` 773/773 | medium, granted, approved (2 advisory) |
| T11 | inline | `bf4e59b` | RED import error -> GREEN 25/25 | under budget, carried into the 3b+3c range |
| fixtures | inline | `1e78da4` | fixture_shape 6/6 (new empty-log guard) | 3b+3c range |
| T5-T9 | inline | `a83ac17` | `npm run check`: 784/784 + panels 11/11, 96 shots, no overflow, no script errors | medium, granted, approved (2 advisory) |

## Verification evidence (screenshots read)
`npm run check`, run twice (the second after fixing a grid gap between toll
and calibration and a wrapping "Didn't run" header, both seen in the first
run's 1440 shot). Read: `ready` 1440 light+dark, 768 light, 390 light,
320 light+dark; `degraded` 768 dark; `empty` 1440 light, 320 dark;
`fresh` 390 light. At 1440x900 the four questions end around 620px, so
all four are visible without scrolling. No UUID is visible in live status.
The empty log renders one card, with no empty sections and no "undefined".
