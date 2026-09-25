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
- [x] **T8 version bump.** `chore(release): 0.5.0` in `package.json` and
  `orca-plugin.json` (and `package-lock.json` if it carries the version).
- [x] **T9 in-app revert claim** (added after the writer reported it as a
  gap; route: direct inline, since it is one file with a mechanical text
  change). `config.html` `integration.hint`, in `en` and `es`, said that
  "Revert everything" puts all seven things back. It now says what the
  code does: the revert removes the hook entries, the env var and the
  skills-mod copy (`install-claude-integration.mjs` uninstall); clearing
  the key deletes the key file (`write-secret-mirror.mjs:258`); the three
  JSON mirrors are never deleted. This matches the README (T7).

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
- **T1 done.** Commit: `c3bc437`.
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
- **T2 done.** Commit: `f31e4e9`. Cherry-picked
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
- **T3 done.** Commit: `d28d48b`. Verified the doc
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
- **T4 done.** Commit: `247c277`. Confirmed the exact
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
- **T5 done.** Commit: `25bc864`. Extracted the shared
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
- **T6 done.** Commit: `d4a3e45`.
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
  `emptyWindow()`: 0, `READY.measurementsSummary`'s top-level `approvals`
  (the field `aggregateApprovals()` publishes distinct from `gate.windows`,
  unused by any panel today, inherited unchanged by `DEGRADED` via its
  `...READY` spread): 0); the 5th (`EMPTY`) derives from
  `emptyWindow('all')` via spread, no separate edit needed.
  Full suite after all of T6: `npm test` 979/979 pass;
  `node --test --experimental-strip-types src/core/approval_record.test.ts
  adapters/orca/read-measurements.test.mjs scripts/fixture_shape.test.mjs`
  49/49 (fixture_shape.test.mjs's real-producer key check still passes with
  `awaiting` added on both sides).
  Follow-up commit `3cba41d` (found via advisor review, before this doc
  closed): the new `await import('./screenshot-panels.mjs')` in
  `panels.spec.mjs` was unconditional, ahead of the existing `chromium`
  try/catch -- screenshot-panels.mjs imports `playwright` itself, unguarded,
  at its own top, so a machine with no playwright would throw
  `ERR_MODULE_NOT_FOUND` before a single test registered, instead of this
  file's own documented "skips rather than fails". Guarded the `SCENARIOS`
  import the same way `chromium` already is. Verified by temporarily moving
  `node_modules/playwright` aside and confirming the two board tests report
  `skipped` with exit code 0, then restoring it.
  `npm run test:panels` and `npm run shots` results recorded in the
  Verification section below.
- **T7 done.** Commit: `6dca02f` (plus follow-up correction `d4e3723` after
  advisor review -- see "Gaps found, not fixed" and the correction note
  below). No RED (docs). Verified
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
    "link" to "copy" -- first with one fixed path
    (`~/.claude/skills/orca-jev-mod-skills`), which `d4e3723` (below) then
    corrected again: `skillsDirFor(platform, target)` is called per
    discovered config root, same as the hooks, not one fixed home path.
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
  **Correction `d4e3723`** (found via advisor review, before this doc
  closed): the first draft of this section overclaimed twice, both now
  fixed --
  (1) the skills-mod row named one fixed path; traced
  `skillsDirFor(platform, target)` and confirmed it is per config root,
  like the hooks;
  (2) "Revert everything ... removes the model hooks and the model catalog
  mirror along with everything else" overclaimed what the uninstall path
  actually does. Traced `main.mjs`'s `uninstallClaudeIntegration` ->
  `install-claude-integration.mjs uninstall`, whose own doc says it only
  touches the hook entries, the env var and the skills-mod copy.
  `write-secret-mirror.mjs` has no delete mode for `catalog.json`/
  `policies.json`/`models-catalog.json` at all (`grep -n "rm(" 
  write-secret-mirror.mjs` -> only `MIRROR_PATH`, the key file, inside
  `clear()`); those three mirrors are only ever overwritten, never
  deleted, by anything in this plugin. Corrected both the writes-table
  intro and the Models section's revert paragraph. A first fix
  (uncommitted at the time) also left the intro self-contradicting --
  claiming the key file "is never deleted" one sentence after confirming
  `clear()` deletes it -- caught on a second advisor pass and rewritten
  before `d4e3723` landed.
- **T8 done.** Commit: `f57b2a9`. No RED (version
  bump). Bumped `package.json` and `orca-plugin.json` (0.4.0 -> 0.5.0).
  `package-lock.json` carries the root package's own version twice (top-
  level `version` and `packages[""].version`); bumped both locally, left
  every dependency entry (e.g. playwright 1.63.0) untouched -- but
  `package-lock.json` is itself `.gitignore`d (`.gitignore:11`, "Orca
  clones this repo onto every user's machine and never installs anything,
  so a lockfile for a dev-only screenshot tool is weight every user
  carries for a tool no user runs"), so this file is not part of this or
  any commit; the bump only keeps this worktree's own local file
  consistent. Re-ran the T2 test
  (`node --test --experimental-strip-types adapters/claude/gate-bash.test.mjs`)
  -- 58/58, including "a written gate-decision record carries the real
  plugin version", which reads the manifest dynamically via
  `expectedPluginVersion()` rather than a hardcoded literal, so it stayed
  green across the bump with no test edit needed. Full suite: `npm test`
  979/979 pass.

## Verification

1. `npm test` (plain, no `env -u`) -- 979/979 pass.
2. `npm run test:panels` -- 46/46 pass (44 config.html + 2 new board.html
   tests), rerun after `3cba41d` to confirm the guard fix did not change
   the count.
3. `npm run shots` -- "112 screenshots written to .screenshots/", "no
   horizontal overflow and no script errors at any width". Read all 16
   `ready-board-*`/`degraded-board-*` images (1440/768/390/320, light and
   dark). All 16 are English (headings read "How is calibration going?",
   never "¿Cómo va la calibración?"; the `es` label is grep-verified only,
   not image-verified). `ready-board-*` (all 8): the `7 days` window is
   selected by default (`chosenWindow` starts `null`, `defaultWindowKey`
   picks `week` -- confirmed in the image, not assumed), four legend rows
   -- 81 Approved (76.4%), 1 Rejected (0.9%), 15 Did not run (14.2%), 9
   Awaiting (8.5%) -- summing to 100.0% and 106. `degraded-board-*` (all
   8): the `This version (0.4.0)` window is selected by default (it is
   `available`, and no other window ranks ahead of it in
   `defaultWindowKey`'s order), three legend rows (the zero-value Rejected
   segment is correctly dropped by `stackedBar`/`legendList`, not a bug)
   -- 71 Approved (79.8%), 9 Did not run (10.1%), 9 Awaiting (10.1%) --
   summing to 100.0% and 89. Nothing clipped at 320 in either scenario or
   theme. The "0.4.0" version label is `DEGRADED`'s own hardcoded fixture
   value (see "Gaps found, not fixed" below) -- expected, not a defect.
4. `git diff --stat origin/main` -- 20 files, 804 insertions(+), 66
   deletions(-) immediately before this close commit; see "Deviations
   from the plan" below for the reading and the final total (this close
   commit itself adds more doc lines on top).
5. `git diff origin/main | grep -nE '^\+.*(console\.log|debugger|: any\b|as any)'`
   -- four matches, all false positives, none of them code:
   - `adapters/orca/panels/board.html` (two hits): `// ... for as long as
     any prompt stayed unanswered.` and `// ... for as long as any prompt
     was still pending.` -- English prose, "as any" is a substring of "as
     long as any", not the TypeScript cast `as any`.
   - `src/core/approval_record.ts`: `* ... for exactly as long as any
     prompt is unanswered ...` -- same substring, in a doc comment.
   - `odd/tasks/release-prep-0.5.0.md`: `` No `console.log`/`debugger`/`any`. ``
     -- this file's own "Scope and constraints" section quoting the rule
     itself (added in the T1 commit, since this doc's first draft
     predates this close commit), not a rule violation.
6. `git log --oneline origin/main..HEAD` -- see "Commits" below: one
   commit per task (T1..T8) plus two post-review correction commits found
   by advisor calls before this close commit, recorded against the task
   they actually belong to, not folded silently into the original eight.

## Deviations from the plan

- **Commits: 11, not "one per task".** T1..T8 landed as 8 commits
  (`c3bc437`, `f31e4e9`, `d28d48b`, `247c277`, `25bc864`, `d4a3e45`,
  `6dca02f`, `f57b2a9`), matching the task boundaries. Two advisor-review
  passes then found real defects in already-committed work: `3cba41d`
  (T6 -- panels.spec.mjs would throw instead of skip with no playwright)
  and `d4e3723` (T7 -- two README claims that did not hold up against the
  code). Both are new commits, never amended history, and both are
  recorded against the task they correct in the notes above. This close
  commit is the 11th.
- **Authored lines: over the ~300 forecast.** `git diff --stat
  origin/main` after this commit is the number to cite; before it, 804
  insertions + 66 deletions = 870, of which 379 is this feature doc's own
  bookkeeping (progress notes, RED/GREEN evidence) -- ~491 authored
  code/test/README lines. Nothing was trimmed, minified, or had its
  comments removed to chase the forecast; the excess is real TDD evidence
  (a RED test per behavior change, several with new test infrastructure --
  T5's `spawnSidecar` extraction, T6's board.html Playwright harness) and
  a genuinely seven-item README table, not padding.

## Gaps found, not fixed

Out of T1..T8's scope; reported, not touched.

- **(Closed by T9.) `adapters/orca/panels/config.html`'s `integration.hint`
  (both `en` and `es`) said "Revert everything puts it all back" for all
  seven things.**
  Traced while writing T7 (see T7's `d4e3723` correction note above): the
  revert action only touches three of the seven (hook entries, env var,
  skills-mod copy). The API key file has its own separate clear action
  (`clear-key` button); the three JSON mirrors (`catalog.json`,
  `policies.json`, `models-catalog.json`) are never deleted by anything in
  this plugin. The README (this task's actual scope) was corrected to say
  so; `config.html`'s own copy carries the same overclaim, uncorrected,
  in both locales.
- **`read-measurements.mjs`'s top-level `approvals` field
  (`aggregateApprovals()`, distinct from `gate.windows[key].approvals`) is
  published but read by no panel.** `board.html` only ever reads
  `w.approvals` inside `gate.windows`; `config.html` reads neither.
  `awaiting` was added to this field too, for consistency with the window
  approvals it shares a function with, but nothing renders it today.
- **`scripts/screenshot-panels.mjs`'s `DEGRADED` fixture hardcodes
  `pluginVersion: '0.4.0'`** for its synthetic per-version window (see
  that fixture's own comment: "synthetic -- the real log cannot show it
  until gate-bash.ts stamps pluginVersion"). After this release's version
  bump, `degraded-board-*` screenshots read "This version (0.4.0)" against
  a 0.5.0 install. Not a defect -- it is explicitly synthetic fixture
  data, unrelated to T2's real `pluginVersion` stamping fix -- but worth
  naming before it is mistaken for one.

## Next step

This branch is ready for its PR to `main`. After it merges:
PR #29 (B1) must be rebased onto the new main (`gate-bash.ts` will likely
conflict); B1b must drop `e399240` when it rebases (`git log main..b1b`
should show no empty-diff commit); the gate-approval-learning worker's SDD
tasks artifact needs updating when that chain resumes, since its worker
session exited during the B2a review.
