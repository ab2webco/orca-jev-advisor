# Release prep 0.5.0: close what a user would find half-done

## Objective

Ship 0.5.0 from `main` with nothing half-wired for the people who use the
plugin. The two pre-release checks (full suite plus screenshots, and a code
audit of everything merged since v0.4.0) passed their tests but found seven
gaps. Close all seven, then bump the version.

## Problem

- `npm run check` on `2e70130` passes (974/974, 44/44, 112 screenshots) only
  with `env -u ORCA_USER_DATA_PATH`. The board and the Models feature still
  carry user-visible holes the tests do not catch.
- Evidence: audit report and visual review of `ready-board-light-1440.png`
  (coordinator session, 2026-09-25).

## Why

The user asked for a release where everything works for plugin users, with
nothing shipped half-done (2026-09-25).

## Scope and constraints

- Branch `fabolivark/release-prep-0.5.0` from `origin/main` `2e70130`,
  worktree `../orca-supervisor-release`. One PR to `main`.
- Out of scope: the gate-approval-learning chain (#29, B1b..C2), except
  cherry-picking its already-reviewed pluginVersion fix (`e399240`).
- Artifacts in English. No `console.log`/`debugger`/`any`. No mocks or fake
  data in production code. Tests and docs travel with each fix.

## Tasks

Route for every task: **delegated direct** (one writer). Trigger: the change
touches 7+ non-trivial files, which fires the writer trigger.

- [x] **T1 test isolation.** `adapters/claude/gate-mention.test.mjs` `decide()`
  spreads `...process.env` into the hook and leaks the real
  `ORCA_USER_DATA_PATH`. With the plugin disabled in Orca, the hook passes
  through, and "actually invoking it is still refused" fails. Pin
  `ORCA_USER_DATA_PATH` to a temp path, and sweep the other hook subprocess
  tests for the same leak.
- [ ] **T2 pluginVersion stamp.** Main never writes `pluginVersion` on gate
  decision records, so the board's "This version" filter can never enable.
  Cherry-pick `e399240` (already reviewed and approved in B1b), with RED
  observed first.
- [ ] **T3 Agent duration field.** `src/core/model_measurement.ts:118` reads
  `durationMs`/`duration_ms`. Neither exists in the Agent `tool_response`;
  the documented field is `totalDurationMs`
  (https://code.claude.com/docs/en/hooks, Agent section). Read the
  documented field only.
- [ ] **T4 readiness self-fulfilment.** `src/core/model_measurement.ts`
  readiness counts decisions that active mode applied as "matches". Exclude
  applied decisions from `comparable` and `matches`.
- [ ] **T5 sidecar EPIPE.** `adapters/orca/main.mjs` writes to child stdin
  (around `:162` and `:799`) with no `'error'` listener. A child that exits
  early crashes the whole background worker. Handle it once, for both sites.
- [ ] **T6 calibration card.** `board.html` "How is calibration going?"
  divides by `asked`, but only shows approved, rejected and notRun, so asks
  still inside the wait window are unlabeled and the percentages do not sum
  to 100. Add an `awaiting` count to `ApprovalSummary` and a fourth legend
  row (en and es).
- [ ] **T7 README.** "What it writes outside itself" still says four things,
  while the plugin now writes seven (matches `config.html` in-app text). Add
  a Models section: measurement by default, active mode off by default,
  readiness 1000 decisions at 70%, a live active rewrite never run end to
  end.
- [ ] **T8 version bump.** `chore(release): 0.5.0` in `package.json` and
  `orca-plugin.json` (and `package-lock.json` if it carries the version).

## Acceptance criteria

- Plain `npm test` (no `env -u`) passes on the developer machine with the
  plugin disabled in Orca.
- A new gate decision record carries `pluginVersion`.
- The calibration legend sums to 100 percent of `asked`, in en and es.
- Board screenshots read at 1440/768/390/320, light and dark.
- `npm run test:panels` and `npm run shots` pass: no overflow, no script
  errors.

## Checks

- TDD: strict (source: session configuration, "Strict TDD Mode: enabled").
  Runner: `npm test` = `node --test --experimental-strip-types`. Also
  `npm run test:panels` and `npm run shots`.
- Delivery: `ask-on-risk`. Forecast about 300 authored lines, under the 400
  budget, so one PR.
- RDD: on (global). Review boundary is the branch point `2e70130`.

## Coordination

- After this merges, PR #29 (B1) must be rebased onto the new main, since
  `gate-bash.ts` will likely conflict.
- B1b must drop `e399240` when it rebases; confirm that
  `git log main..b1b` shows no empty-diff commit.
- The gate-approval-learning worker is stopped. Its session exited during
  the B2a review, so update its SDD tasks artifact when the chain resumes.

## Progress

- Worktree and branch created from `origin/main` `2e70130`.
- **T1 done.** Commit: (recorded after commit below).
  RED: `node --test --experimental-strip-types adapters/claude/gate-mention.test.mjs`
  failed 1/2 -- `actually invoking it is still refused`:
  `AssertionError [ERR_ASSERTION]: 'allow' !== 'deny'` at
  `gate-mention.test.mjs:65:10`. Cause: `decide()`'s spawned env spread
  `...process.env` without pinning `ORCA_USER_DATA_PATH`, so
  `pluginDisabledInOrca()` read the developer's real Orca profile (plugin
  disabled there) and `gate-bash.ts` passed every command through.
  Fix: pinned `ORCA_USER_DATA_PATH` to a nonexistent path under the test's
  own temp `home`, matching the pattern already used in
  `gate-bash.test.mjs`'s `run()`.
  Swept every other test that spawns a hook/sidecar with `...process.env`
  for the same leak (`gate-bash.test.mjs`, `gate-outcome.test.mjs`,
  `agent-model.test.mjs`, `agent-model-hook.test.ts`,
  `adapters/orca/read-model-measurements.test.mjs`,
  `adapters/orca/write-secret-mirror.write-guard.test.mjs`,
  `adapters/orca/read-measurements.test.mjs`,
  `adapters/orca/install-claude-integration*.test.mjs`,
  `scripts/fixture_shape.test.mjs`). Only two source files ever read
  `ORCA_USER_DATA_PATH`/call `pluginDisabledInOrca` when reached as a
  subprocess target: `gate-bash.ts` and `agent-model.ts`. Every test that
  spawns either of those already pinned or deliberately deleted the
  variable (`gate-bash.test.mjs` pins it; `agent-model.test.mjs` pins it;
  `install-claude-integration*.test.mjs` deliberately `delete env.ORCA_
  USER_DATA_PATH` to exercise the no-userData path). No other spawned
  script (`gate-outcome.ts`, `read-model-measurements.mjs`,
  `write-secret-mirror.mjs`, `read-measurements.mjs`) reads that variable
  at all, so no further change was needed there.
  GREEN: same command, 2/2 pass. Full suite: `npm test` (plain, no
  `env -u`) 974/974 pass after `npm install --no-audit --no-fund` (needed
  once in this fresh worktree; playwright wasn't installed yet).

## Next step

Delegate T1..T8 to one writer.
