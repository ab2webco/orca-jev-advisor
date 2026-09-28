# Jev Advisor 0.6.3: Activity per project, with charts

## Objective
Replace the flat "By project (whole log)" bar list on the Advisor board's
Activity tab with one card per project: a 7-day activity chart, gate
outcomes, tokens/cost by model, and router savings — real numbers, board's
existing visual system, both themes.

## Problem
`turn-usage-*.jsonl` and `model-router-decisions-*.jsonl` carry no project
field today, so per-project activity can only be shown for the gate log.
The current "By project (whole log)" section is a single flat bar list with
no time dimension and no per-project breakdown of steps/tokens/cost/router
savings. Plane: JEVADV-57.

## Why
Owner's request (brief `brief-063-activity.md`): make Activity "look
professional" — per-project charts showing what really happened, not a
flat lifetime tally.

## Scope
- `src/core/project_name.ts` (new) — shared `modSkillsProjectName(orcaContext)`
  extracted from `adapters/orca/read-measurements.mjs:429-438`, imported by
  both `read-measurements.mjs` and the mod-skills hook, so the two never
  drift (mirrors the existing header comment there asking to check
  `main.mjs:2193/2219` agree).
- `adapters/claude/mod-skills/hooks/index.ts` — `project: string | null` on
  the turn-usage JSONL record and on `RouterDecisionRecord`.
- `src/core/model_router_decide.ts` — `project` field on
  `RouterDecisionRecordInput`/`RouterDecisionRecord`.
- `src/core/consumption.ts` — `project` field on `TurnUsageRecord`.
- `adapters/orca/read-consumption.mjs` — parse `project` off turn-usage and
  router-decision rows.
- `src/core/activity_by_project.ts` (new) — pure 7-day-per-project fold.
- `adapters/orca/read-activity.mjs` (new sidecar) — reads gate-decisions +
  the hourly turn-usage/router files, calls the fold, prints the summary.
- `adapters/orca/main.mjs` — wires the new sidecar on the consumption
  cadence, publishes `activityByProjectSummary`.
- `adapters/orca/panels/board.html` — Activity tab: per-project cards
  replacing "By project (whole log)"; keep `#card-live` as is.
- `scripts/screenshot-panels.mjs` — `activity-ready` scenario.
- `scripts/panels.spec.mjs` — ordering, show-more, empty state, per-card
  numbers, aria labels.
- Unit tests for every new/changed `src/core` function and sidecar.

## Out of scope
Any change to the gate itself, to what the router actually decides, to the
live-status list's own logic, or to `consumptionSummary`'s own card.

## Constraints
- Strict TDD (repo default): RED observed before GREEN, every task.
- No `any`. No `console.log`/`debugger` left in. No backup files.
- No mocks/fake data outside real test fixtures and the screenshot scenario.
- Tests never touch real `~/.config/orca-supervisor`, `~/.cache/orca-supervisor`,
  `~/.claude*` — isolation env vars / temp dirs, same as every existing test
  in this repo.
- `node_modules`: symlinked while testing, `unlink`ed before every commit
  (this worktree ships without it).
- JEVADV-43 rule in `hooks/index.ts`: `$` only passed to top-level functions
  declared in that same file; a closure declared inside `register` may read
  plain data (like a cached `OrcaContext`) but must not receive `$` itself.
  Keep `mod_skills_validate.test.mjs` green.
- Inline SVG only for the new chart — the panel shell allowlists tokens, no
  chart libraries reach `board.html` (precedent: `advisor-board-charts.md`).
  No new colors: reuse the existing `--viz-1..3`/destructive tokens
  (`board.html:132-149`) and `--fb-*` fallbacks.
- Router "saving" is never shown negative (existing honesty rule,
  `board.html:1722-1729`) — reuse `summarizeRouterDecisions` as-is, filtered
  to one project's rows, rather than reimplementing the math.
- Cost is a list-price **estimate**, always labelled as such in copy — reuse
  `ANTHROPIC_PRICES`/`fablePrices` from `src/core/model_router_accounts.ts`,
  never a new price table.
- es/en copy, accented, no " -- ". New i18n keys get their own key-parity +
  accent test in `panels.spec.mjs` (`src/core/i18n_catalogs.test.ts` never
  reads `board.html`'s inline `CATALOG`).
- No bars on a shared scale for different units (L5 lesson in
  `advisor-board-charts.md`) — steps, gate outcomes, tokens and cost each
  get their own presentation, never one shared axis.
- `touchingControls(page)` must still return `[]` for the board unless the
  "show more" toggle is deliberately exempted the same way the live-list
  toggle already is.
- Never push. Conventional Commits, no AI attribution / Co-Authored-By.

## Decisions (resolved here, not left open for writers to improvise)
- **Project field type**: `string | null` everywhere (matches the gate log's
  own convention). Absent field on an old record parses to `null`. `null`
  always renders as the existing `'(unknown project)'`/`'(proyecto
  desconocido)'` catalog key via the board's existing `projectLabel()`.
- **Getting `orcaContext` into `turn.step`**: thread the existing
  `orcaContextCache` (already resolved lazily per session inside
  `prompt.submit`, see `hooks/index.ts:1168,1322-1326`) into `handleTurnStep`
  and into the three `appendRouterDecision` call sites as a plain parameter
  (data, not `$`) — not a fresh `resolveOrcaContext` call per step. If no
  prompt has resolved it yet this session, record `project: null`; this is
  an honest "not yet known" state, not a bug.
- **Day bucketing**: local calendar day (`Date#getFullYear/getMonth/getDate`,
  system timezone — worker and board run on the same machine), key format
  `YYYY-MM-DD`, oldest → newest, always 7 entries even when a day is empty.
- **Ranking**: projects sorted by `lastActivityAt` descending (nulls last);
  ties broken by total interactions (judged commands + steps) descending.
- **Gate outcome labels**: `verdict` → `allow`→allowed, `advise`→advised,
  `ask`→asked, `deny`→blocked (`source: 'none'` is out of scope here, per
  `advisor-board-charts.md` T7 — not this feature's job).
- **New sidecar vs. extending `read-consumption.mjs`**: a new
  `read-activity.mjs`, because it also needs `gate-decisions.jsonl` (a
  single ever-growing file, a different shape than the hourly turn-usage/
  router files) — folding that read into `read-consumption.mjs` would blur
  its existing single responsibility. It reuses `read-consumption.mjs`'s
  hourly-file listing helpers rather than reimplementing them, and does its
  own pruning of nothing (pruning stays owned by `read-consumption.mjs`,
  which already runs on the same cadence, to avoid two sidecars racing on
  `rm`).
- **Publish cadence**: reuses `CONSUMPTION_REFRESH_MS` (10 min) outright —
  same reasoning as the consumption sidecar's own note (this scans the same
  bounded hourly-file set, far heavier than the 15s gate cadence was sized
  for).
- **Chart form** (per `dataviz` skill, form picked before color): 7 discrete
  daily points of one magnitude (activity count) → a small bar-per-day
  strip, not a line/sparkline (no meaningful between-day interpolation).
  One hue (`--viz-1`) for the bars; gate outcomes as labelled numbers, not
  a stacked bar (four different-meaning counts, not one whole); "blocked"
  in `--destructive` (`.vd`), "advised" in `--viz-3`/ring (`.v3`) to read as
  distinct, "allowed"/"asked" in normal text color — no invented fifth hue.
- **Tokens/cost breakdown**: compact labelled rows per model (input/output/
  cache read/cache write counts + estimated USD), no bar at all (four
  different units again) — a small table-like list, same pattern as the
  consumption card's per-model rows.

## Tasks
- [x] A1a `src/core/project_name.ts`: extract `modSkillsProjectName`,
      re-export from `read-measurements.mjs` unchanged (its own tests stay
      green). Route: delegated writer. Trigger: writer (2 files).
- [x] A1b `hooks/index.ts` + `model_router_decide.ts`: `project` on the
      turn-usage record and on `RouterDecisionRecord`, threaded from
      `orcaContextCache` per the Decisions section above. Unit tests first
      (RED against the current shape), then GREEN. Keep
      `mod_skills_validate.test.mjs` and hooks `tsc` green.
      Route: delegated writer. Trigger: writer (2+ files, JEVADV-43-sensitive).
- [ ] A2 `src/core/activity_by_project.ts`: pure 7-day-per-project fold over
      gate rows + turn-usage rows + router-decision rows. Unit tests first:
      empty data, a single day, old records without a project, ranking,
      never-negative router saving. Route: delegated writer.
- [ ] A3 `adapters/orca/read-activity.mjs` + `main.mjs` wiring: publish
      `activityByProjectSummary` on the consumption cadence. Tests under
      isolation env vars. Route: delegated writer.
- [ ] A4 `board.html`: per-project cards (chart, gate outcomes, tokens/cost,
      router line), top 6 + show-more, i18n, empty states, `role="img"`
      aria labels. Route: delegated writer, then inline visual pass.
- [ ] A5 `panels.spec.mjs` tests + `screenshot-panels.mjs` `activity-ready`
      scenario. Route: delegated writer.
- [ ] A6 Version bump to 0.6.3 (`package.json`, `orca-plugin.json` if
      versioned) + README "What changed in 0.6.3". Route: inline.
- [ ] A7 Screenshots: `npm run shots` + `activity-ready` scenario at 1440,
      768, 390, 320, both themes. Read every image. Route: inline.
- [x] R1 **(added live, unrelated to Activity, must land before STATUS: DONE)**
      Bugfix: subagent cold-first-step effort must apply the tier's effort
      in both directions, and the router-decision log must match what the
      step actually sends. Root cause, confirmed by reading the code:
      `subagentStepEffort` (`src/core/model_router_subagent.ts:115-122`)
      unguarded branch does `EFFORT_RANK[target] < EFFORT_RANK[current] ?
      target : current` — lower-only, contradicting 0.6.2 rule F0 ("no
      guard ever blocks an effort raise"). Separately, the point='subagent'
      router-decision log line is written in `routeSubagent`
      (`hooks/index.ts:1012-1013`) at **spawn** time, using `targetEffort`
      — before the inherited effort is even known (that only arrives on
      the first real `turn.step`) — so log and step can diverge even after
      the direction fix (e.g. a guard preserving a higher inherited value).
      Fix, both parts:
      1. `subagentStepEffort`: unguarded → adopt the tier's effort outright
         (both directions, mirrors `decideStart`'s unguarded branch);
         guarded → higher of current/target (mirrors `guardedEffort`,
         guard blocks lowering only, never raising). Person's `max`/numeric
         effort untouched either way (existing early-return, keep as is).
         Explicit parent model → no target is ever set (existing
         `explicitModelGiven` gate in `routeSubagent`, unchanged) → no
         effort change, per the brief.
      2. Move the `point: 'subagent'` router-decision log write (or its
         `effort` field) so it is written from the value `handleTurnStep`
         actually computes and sends on the subagent's first (`index ===
         0`) step, not the raw pre-computed target captured at spawn —
         these must never be able to diverge.
      3. Update the existing tests that currently assert the buggy
         behavior as correct — flip, don't just add:
         `model_router_subagent.test.ts:88-91` ("never raises") and
         `hooks.test.ts:1312-1322` ("JEV-061 ... never raised, even when
         the chosen tier asks for more" — this is the exact live bug
         scenario, expected result flips from `"low"` to `"high"`). Add a
         new test asserting the logged `effort` equals the step's sent
         `effort` for both the plain-upgrade and the guarded-higher-
         inherited cases.
      4. Update the stale "never raises"/"only ever a LOWERING" doc
         comments in both files (`model_router_subagent.ts:14-24,110`,
         `hooks/index.ts:967-976,978,1029`, `model_router_decide.ts:413`)
         to describe the corrected behavior. Do NOT edit README (folded
         into A6's 0.6.3 changelog instead) and do NOT edit the historical
         "0.6.1" changelog section (accurate record of what 0.6.1 shipped).
      Route: delegated writer, strict TDD (RED on the flipped assertions
      first). **Sequenced after A1b commits** — both touch
      `hooks/index.ts`; do not run concurrently with it.
- [ ] A8 Final verification pass + report. Route: inline.

## Acceptance
`npm test`, `npm run test:panels`, `npm run shots`,
`tsc -p adapters/claude/mod-skills/tsconfig.json`,
`adapters/orca/mod_skills_validate.test.mjs`.

## Delivery
Strategy: `ask-on-risk`. Forecast: ~750-950 authored lines across 8 tasks
(new pure module, new sidecar, hook + router + consumption type changes,
board card redesign, Playwright tests, screenshot fixture) — over the
~400-line heuristic; kept as one feature (not split) because the pieces are
one coherent user-visible change and each needs the others' shapes to test
against.
TDD: strict (repo default). Runner: `node --test --experimental-strip-types`
(unit), `node --test scripts/panels.spec.mjs` (panels).

## Progress
- 2026-09-27: mapping pass completed (delegated, read-only). Findings
  folded into Scope/Constraints/Decisions above. Task file created before
  first write.
- 2026-09-27: R1 added live (subagent cold-first-step effort bug, found by
  the owner in this session, unrelated to Activity). Mapping pass
  (delegated, read-only) completed; root cause and fix folded into R1's
  task entry above. Sequenced after A1b since both touch `hooks/index.ts`.
- 2026-09-27: A1a+A1b done and committed (`bf9ddb4`,
  `feat(activity): record project on turn-usage and router-decision
  records`). `src/core/project_name.ts` (+6 tests) extracted from
  `read-measurements.mjs:429-438`, re-imported there unchanged (its 33
  tests stayed green). `project: string | null` threaded onto
  `RouterDecisionRecord`/`RouterDecisionRecordInput`
  (`model_router_decide.ts`), `TurnUsageRecord` (`consumption.ts`), the
  turn-usage JSONL write and all router call sites in `hooks/index.ts`
  (resolved once per closure via `modSkillsProjectName(orcaContextCache)`,
  never `$` itself — JEVADV-43 preserved), and `read-consumption.mjs`'s
  `toTurnUsageRecord` parsing (tolerant default to `null`).
  RED observed before GREEN throughout (module-not-found for the new file,
  two new `model_router_decide.test.ts` assertions verified via a real
  stash/reapply cycle, three new `hooks.test.ts` cases).
  Decision-gap notes from the writer: (a) `project_name.ts` couldn't use
  `node:path`'s `basename` — the hooks tsconfig has no Node types by
  design — wrote a small local `basenameOf` instead, behavior-equivalent
  for Orca's POSIX-style paths; (b) found and fixed a real test-fixture bug
  along the way: `submitPrompt(...)`'s hardcoded `origin: {kind:"user"}`
  isn't in `isPersonPromptOrigin`'s closed set, so it silently skipped the
  router call in a naive combined test — switched to
  `submitOrigin(handlers, engine, "composer")`; (c) `read-consumption.mjs`'s
  new `project` parsing has no observable behavior change yet (surfacing
  it per-row is A2's job) — flagged as not a true RED rather than faked one.
  `npm test`: 2155→2167 (12 new, 0 failing). `tsc -p
  adapters/claude/mod-skills/tsconfig.json`: clean.
  `mod_skills_validate.test.mjs`: pass. `node_modules` unlinked before
  commit.
- 2026-09-27: R1 done and committed (delegated writer, strict TDD).
  `subagentStepEffort` (`src/core/model_router_subagent.ts`): unguarded
  branch now `return target;` (both directions, mirrors `decideStart`'s
  unguarded branch); guarded branch unchanged (already raise-only, correct).
  Flipped `model_router_subagent.test.ts:88-91` (unguarded low→tier's value,
  not left low) and `hooks.test.ts`'s JEV-061 slice 2 "never raised" test
  (now asserts `"high"`, the live bug scenario) — RED observed first via a
  real stash/reapply cycle on `model_router_subagent.ts` (1 failing, as
  expected), then GREEN.
  Log-write redesign: **moved** (not a two-write correction) — the
  `point: 'subagent'` `appendRouterDecision` call was removed from
  `routeSubagent` (`hooks/index.ts`) entirely; `routeSubagent` now only
  computes and hands `handleTurnStep` a `SubagentEffortTarget` per spawned
  agentId carrying everything the log line needs (account, decision,
  applied, quotaBand, project, effort target, guarded, effortEligible,
  logged: false). `handleTurnStep`'s subagent branch appends the one
  `point: 'subagent'` line, with `effort` = what `subagentStepEffort`
  actually computed and sent (or `null` when not effort-eligible), on that
  agent's first (`index === 0`) step only, then flips `logged: true` so a
  later re-occurrence of index 0 (a new turn on the same agentId) can't
  double-log. Picked over the two-write alternative because
  `summarizeRouterDecisions` (`src/core/model_router_summary.ts`) counts
  every parsed `point='subagent'` row toward `total`/`byPoint` regardless
  of `applied` — a spawn-time write plus a later correction would have
  double-counted every subagent decision in the board's own router-decision
  stats; a single deferred write has no such risk and is the more coherent
  change once the downstream reader was checked.
  Six existing tests that asserted `routerDecisionLines(...)` right after
  `spawnThrough` (with no follow-up step) had to gain one `stepThrough(...,
  { agentId: "agent-1", index: 0, ... })` call each before their decision
  assertions, since the line no longer exists until that step:
  `hooks.test.ts` — "router, active, subagent: no explicit model", "router,
  measure, subagent: logs, changes nothing", "router, active, subagent:
  guards hold the parent's model", "F11, point B", "0.6.2 E6 (hook,
  subagent)", "F0 (hook, subagent)" (this last one's guard/effort
  assertions were also reordered to after the step, and a
  logged-effort-equals-sent-effort assertion added — the guarded higher-
  inherited case). A second logged-effort assertion for the plain unguarded
  case was added to the flipped "0.6.3 F0" test. This was not anticipated
  by the prompt's assumptions (it named only two tests to flip); the six
  additional test-shape updates were required by the chosen "moved" log
  design and are mechanical (adding a step call), not behavior changes.
  Doc comments updated in both files and in `model_router_decide.ts`'s
  `RouterDecisionRecord.effort` field (searched both files for "never
  rais"/"LOWERING", none remain). README and the 0.6.1 changelog section
  untouched, per constraints.
  `npm test`: 2181 pass, 0 fail (includes unrelated concurrent A2 work
  landed in this same worktree during the run). `tsc -p
  adapters/claude/mod-skills/tsconfig.json`: clean.
  `mod_skills_validate.test.mjs`: pass. `node_modules` unlinked before
  commit. Commit: see git log (`fix(router): ...`).
