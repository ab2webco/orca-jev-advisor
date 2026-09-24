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
- [ ] T1 manual recursive copy replacing `fs.cp`, with the real error detail
      carried through to the panel.
- [ ] T2 `pluginVersion` on each gate decision record.
- [ ] T3 p95 beside the median in the latency fold.
- [ ] T4 per-family `ask`/`deny`/`notRun`, and a count of families with no
      interventions.
- [ ] T5 board: interventions table (<=15 rows, sorted by interventions, plus
      a "N families with no interventions" row).
- [ ] T6 board: live status with name/branch and the UUID only in a tooltip.
- [ ] T7 board: a status strip — last successful Jev call, consecutive
      failures, unjudged count.
- [ ] T8 board: a window selector (current version / 24h / 7d / all).
- [ ] T9 empty-log state verified and photographed.

## Checks
`npm run check`, plus reading every screenshot.

## TDD
Strict TDD (source: user CLAUDE.md). Runner `node --test --experimental-strip-types`.

## Delivery
`ask-on-risk`. T1-T4 delegated writers; T5-T9 inline.
