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
- [x] **T2 pluginVersion stamp.** Main never writes `pluginVersion` on gate
  decision records, so the board's "This version" filter can never enable.
  Cherry-pick `e399240` (already reviewed and approved in B1b), with RED
  observed first.
- [x] **T3 Agent duration field.** `src/core/model_measurement.ts:118` reads
  `durationMs`/`duration_ms`. Neither exists in the Agent `tool_response`;
  the documented field is `totalDurationMs`
  (https://code.claude.com/docs/en/hooks, Agent section). Read the
  documented field only.
- [x] **T4 readiness self-fulfilment.** `src/core/model_measurement.ts`
  readiness counts decisions that active mode applied as "matches". Exclude
  applied decisions from `comparable` and `matches`.
- [x] **T5 sidecar EPIPE.** `adapters/orca/main.mjs` writes to child stdin
  (around `:162` and `:799`) with no `'error'` listener. A child that exits
  early crashes the whole background worker. Handle it once, for both sites.
- [x] **T6 calibration card.** `board.html` "How is calibration going?"
  divides by `asked`, but only shows approved, rejected and notRun, so asks
  still inside the wait window are unlabeled and the percentages do not sum
  to 100. Add an `awaiting` count to `ApprovalSummary` and a fourth legend
  row (en and es).
- [x] **T7 README.** "What it writes outside itself" still says four things,
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
- **T2 done.** Commit: (recorded after commit below). Cherry-picked
  `e399240` from `fabolivark/gate-approval-learning-b1b`, already reviewed
  and approved in B1b, `git apply --check` verified clean on this branch
  point before starting.
  RED: applied only the test hunk (`git show e399240 -- adapters/claude/
  gate-bash.test.mjs | git apply`), ran
  `node --test --experimental-strip-types adapters/claude/gate-bash.test.mjs`
  -- failed 1/58, `a written gate-decision record carries the real plugin
  version`: `AssertionError [ERR_ASSERTION]: the row must carry the shipped
  plugin version, not be missing the field` -- `actual: undefined`,
  `expected: '0.4.0'` at `gate-bash.test.mjs:269:10`.
  Fix: applied the `gate-bash.ts` hunks (`git show e399240 -- adapters/
  claude/gate-bash.ts | git apply`) -- reads `orca-plugin.json`'s version
  once at module load via `PLUGIN_ROOT`/`readPluginVersion()`, stamps it on
  every appended gate-decision record.
  GREEN: same command, 58/58 pass. `grep -c pluginVersion
  adapters/claude/gate-bash.ts` -> 3. Full suite: `npm test` 975/975 pass.
- **T3 done.** Commit: (recorded after commit below). Verified the doc
  claim two ways before touching code: fetched
  https://code.claude.com/docs/en/hooks and confirmed the Agent
  tool_response table (`status`, `agentId`, `content`, `resolvedModel`,
  `modelsUsed`, `totalTokens`, `totalDurationMs` -- "Wall-clock duration of
  the subagent run", `totalToolUseCount`, `usage`); `durationMs` and
  `duration_ms` do not appear on that table at all (the `duration_ms` hits
  elsewhere in the page belong to unrelated hook fields). Cross-checked
  against this repo's own bundled type defs
  (`adapters/claude/mod-skills/claude-code.d.ts:12420-12489`), whose Agent
  tool_response union has `totalDurationMs: number` on the `"completed"`
  variant and no duration field at all on `"async_launched"` /
  `"remote_launched"`.
  RED: edited `src/core/model_measurement.test.ts` to feed a doc-shaped
  input (`totalDurationMs: 4321`, no `durationMs`), plus a new "never reads
  the invented durationMs or duration_ms fields" test and a new
  async_launched-shaped test; also switched the fixture in
  `adapters/claude/agent-model.test.mjs` and
  `adapters/claude/agent-model-hook.test.ts` from `durationMs` to
  `totalDurationMs`. Ran `node --test --experimental-strip-types
  src/core/model_measurement.test.ts` -- failed 2/24: "buildModelOutcomeRecord
  reads resolvedModel, status, usage tokens and totalDurationMs (as
  durationMs) defensively" (`actual.durationMs: null` vs `expected: 4321`)
  and "buildModelOutcomeRecord never reads the invented durationMs or
  duration_ms fields" (`111 !== null`, i.e. the old fallback still read the
  invented field).
  Fix: `buildModelOutcomeRecord` now reads only `response.totalDurationMs`
  (`isNumber` guarded), dropping both invented fallbacks; comment cites the
  docs URL.
  GREEN: `model_measurement.test.ts` 24/24,
  `adapters/claude/agent-model.test.mjs` 4/4,
  `adapters/claude/agent-model-hook.test.ts` 18/18. Full suite: `npm test`
  975/975 pass (net test count unchanged: 4 old duration tests replaced by
  4 new ones).
- **T4 done.** Commit: (recorded after commit below). Confirmed the exact
  field: `ModelDecisionRecord.applied: boolean` (`model_measurement.ts:80`,
  written by `agent-model-hook.ts` when active mode rewrites the request to
  the recommendation), already summed as `summary.applied` at line 296 but
  never excluded from the `comparable`/`matches` join at lines 322-333.
  RED: added "an applied decision's outcome is excluded from comparable and
  matches" to `src/core/model_measurement.test.ts` -- two judged decisions,
  one `applied: true` with a matching outcome, one `applied: false` with a
  matching outcome; expected `comparable: 1, matches: 1` (only the
  non-applied one). Ran `node --test --experimental-strip-types
  src/core/model_measurement.test.ts` -- failed 1/25:
  `AssertionError: the applied decision's trivially-matching outcome must
  not count -- 2 !== 1`.
  Fix: the `comparable`/`matches` loop now `continue`s when
  `decision.applied` is true, before joining the outcome.
  GREEN: same command, 25/25. Full suite: `npm test` 976/976 pass.
- **T5 done.** Commit: (recorded after commit below). Extracted the shared
  spawn logic from `runSecretMirrorScript` (`:162-163`, "generic sidecar
  helper") into a new `spawnSidecar(argv, execOptions, stdin)`, as a pure
  refactor first (same behavior, still no stdin error listener), and routed
  `runReadModelMeasurementsScript` (`:799-800`) through it too, passing
  `JSON.stringify(catalog)` as stdin -- it cleanly fit, same permission-flag
  shape. Exported `spawnSidecar` for `node --test` only, following this
  file's existing named-export convention.
  RED: added "spawnSidecar settles an ordinary failure, never an unhandled
  error, when the child exits before reading stdin" to
  `adapters/orca/main.test.mjs` -- writes a throwaway script
  (`process.exit(0)`) into the test's own temp dir, calls `spawnSidecar`
  with a 2 MB stdin payload against it. Ran `node --test
  --experimental-strip-types adapters/orca/main.test.mjs` -- failed 1/57
  with an uncaught `Error: write EPIPE` (`code: 'EPIPE'`, `syscall:
  'write'`) from `WriteWrap.onWriteComplete`, exactly the unhandled-error
  shape the task described (the test runner attributed it to the test
  rather than crashing the whole run).
  Fix: added `child.stdin.on('error', ...)` to `spawnSidecar`, resolving
  `{ ok: false, reason: 'stdin-write-failed', detail }` -- safe even if the
  `execFile` callback also fires, since a Promise only ever settles once.
  GREEN: same command, 57/57. Full suite: `npm test` 977/977 pass.
- **T6 done.** Commit: (recorded after commit below).
  Data layer (`src/core/approval_record.ts`): added `ApprovalSummary.awaiting`
  (asked, no outcome, still inside `UNRESOLVED_AFTER_MS`), counted directly
  in `summarizeApprovals`'s existing loop alongside `notRun`, so
  `approved+rejected+notRun+awaiting === asked` holds by construction, never
  negative.
  RED (data layer): added 4 assertions/tests to
  `src/core/approval_record.test.ts` (join test, notRun test, the "still on
  screen" test renamed to say "-- it is awaiting", and a new
  "awaiting...always sums to asked" test). Ran `node --test
  --experimental-strip-types src/core/approval_record.test.ts` -- failed
  4/18, all `undefined !== 0/1` (the field did not exist yet).
  GREEN (data layer): same command, 18/18.
  Trace to the board: `adapters/orca/read-measurements.mjs`'s
  `approvalsSummary()` explicitly copies `asked/approved/rejected/notRun`
  from the summary -- added `awaiting` there too (both the per-window
  `gate.windows[key].approvals` and the top-level `approvals`, since both
  reuse the same function).
  RED (trace): added "approvals.awaiting -- a pending record still inside
  the wait window is reported under awaiting" to
  `adapters/orca/read-measurements.test.mjs`. Ran `node --test
  --experimental-strip-types adapters/orca/read-measurements.test.mjs` --
  failed 1/28, `undefined !== 1`.
  GREEN (trace): same command, 28/28.
  UI (`adapters/orca/panels/board.html`): added a 4th `renderApprovals`
  segment/legend row (`cls: 'v2'`, the one unused hue in this card's
  existing v1/vd/v3 palette -- muted-foreground, distinct from primary/
  destructive/ring), keyed `approvals.awaiting`, in both the `en`
  ('Awaiting') and `es` ('Esperando respuesta') string tables. No hint
  added -- unlike `notRun`, `awaiting` names no ambiguity to explain, so it
  follows `approved`/`rejected`'s no-hint precedent, not `notRun`'s.
  RED (UI): extended `scripts/panels.spec.mjs` with `openBoardPanel`
  (board.html's own `renderBoardPanel`/host-bridge harness, alongside the
  existing config.html one) and imported `SCENARIOS` from
  `scripts/screenshot-panels.mjs` (real producer-derived fixture, per
  `scripts/fixture_shape.test.mjs`'s own discipline) rather than a second
  hand-typed board fixture. Added two tests: legend-values-sum-to-asked, and
  no-raw-i18n-key. To observe true RED, temporarily reverted just the 4th
  segment literal in `renderApprovals` and ran `node --test
  --test-name-pattern="calibration card" scripts/panels.spec.mjs` -- failed
  1/2: `AssertionError: legend rows ["81","1","15"] do not sum to asked
  (106) -- 97 !== 106` (the exact 81/1/15/106 numbers from this task's own
  problem statement, since `SCENARIOS.ready`'s default window is `week` =
  `READY_ALL`). Restored the segment, reran -- GREEN, 2/2.
  Fixtures: added `awaiting` (never hand-guessed -- each value is
  `asked - approved - rejected - notRun` for that same fixture's own
  numbers) to all 4 literal `approvals` blocks in
  `scripts/screenshot-panels.mjs` (`READY_DAY`: 9, `READY_ALL`: 9,
  `emptyWindow()`: 0, `DEGRADED`'s top-level `approvals`: 0); the 5th
  (`EMPTY`) derives from `emptyWindow('all')` via spread, no separate edit
  needed.
  Full suite after all of T6: `npm test` 979/979 pass;
  `node --test --experimental-strip-types src/core/approval_record.test.ts
  adapters/orca/read-measurements.test.mjs scripts/fixture_shape.test.mjs`
  49/49 (fixture_shape.test.mjs's real-producer key check still passes with
  `awaiting` added on both sides). `npm run test:panels` and `npm run shots`
  results recorded in the final verification section below.
- **T7 done.** Commit: (recorded after commit below). No RED (docs). Verified
  every claim against code before writing, not against the task text alone:
  - The "seven things" truth text lives in `adapters/orca/panels/
    config.html`'s `integration.hint` (en/es) -- copied item-for-item into
    the README table.
  - Hook count/shape confirmed in `adapters/orca/install-claude-
    integration.mjs`'s own module doc and `hookSpecs()`: 4 Bash-matcher
    (PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied, gate-
    bash.ts/gate-outcome.ts) + 3 Agent-matcher (PreToolUse/PostToolUse/
    PostToolUseFailure, agent-model.ts) = 7, all in `settings.json` per
    config root (`discoverTargets()` still returns the home target plus one
    per Orca account) -- confirms the README's existing "every config root"
    claim was already correct, only the hook count was stale.
  - Caught and fixed a real factual error while verifying: the README said
    "a link to the skills mod"; `install-claude-integration.mjs`'s own doc
    says explicitly it is a copy, not a symlink (`installModCopy`). Changed
    "link" to "copy" and named the real path
    (`~/.claude/skills/orca-jev-mod-skills`).
  - Mirror filenames confirmed in `adapters/orca/write-secret-mirror.mjs`
    (`catalog.json`, `policies.json`, `models-catalog.json`).
  - Readiness thresholds (1000 comparable, 0.70 match rate) confirmed in
    `src/core/mod_skills_readiness.ts`'s `DEFAULT_MOD_SKILLS_READINESS_
    THRESHOLDS`, reused by model readiness via `src/core/model_measurement.ts`.
  - Gate order/conditions for an active rewrite confirmed in
    `src/core/model_decisions.ts`'s `decideModelRewrite` (mode==="active"
    -> ready -> permissionAllowsRewrite (`bypassPermissions` only) ->
    confidence >= `DEFAULT_MODEL_REWRITE_CONFIDENCE` (0.7)) and its call
    site in `agent-model-hook.ts:183-188`. Wrote this as "needs all of the
    following" rather than the task text's "triple-gated" -- that phrase
    undercounts by one against the code (four conditions, not three); the
    task text names the same four conditions itself, so this is a wording
    correction, not a scope change.
  - "Off by default" confirmed: `agent-model-hook.ts:129`,
    `mode = mirror.active ? "active" : "measurement"`, with
    `parseModelsMirror` defaulting `active: false`.
  - The revert action confirmed as the single existing "Revert everything"
    button (`config.html`'s `integration.revert`) / `advisor.uninstallClaude`
    command (`orca-plugin.json`, titled "Revert the Claude Code side") --
    there is no separate models-only revert.
  Added the "Models" section (between "Command gate" and "What is
  measured") and one bullet under "Not ready yet", stating plainly that a
  live end-to-end active rewrite has not been run in an installed session.

## Next step

Delegate T1..T8 to one writer.
