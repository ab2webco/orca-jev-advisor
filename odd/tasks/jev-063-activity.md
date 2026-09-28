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
- [x] A2 `src/core/activity_by_project.ts`: pure 7-day-per-project fold over
      gate rows + turn-usage rows + router-decision rows. Unit tests first:
      empty data, a single day, old records without a project, ranking,
      never-negative router saving. Route: delegated writer.
- [x] A3 `adapters/orca/read-activity.mjs` + `main.mjs` wiring: publish
      `activityByProjectSummary` on the consumption cadence. Tests under
      isolation env vars. Route: delegated writer.
- [x] A4 `board.html`: per-project cards (chart, gate outcomes, tokens/cost,
      router line), top 6 + show-more, i18n, empty states, `role="img"`
      aria labels. Route: delegated writer, then inline visual pass.
- [x] A5 `panels.spec.mjs` tests + `screenshot-panels.mjs` `activity-ready`
      scenario. Route: delegated writer.
- [x] A6 Version bump to 0.6.3 (`package.json`, `orca-plugin.json` if
      versioned) + README "What changed in 0.6.3". Route: inline.
- [x] A7 Screenshots: `npm run shots` + `activity-ready` scenario at 1440,
      768, 390, 320, both themes. Read every image. Route: inline.
- [~] A8 **(descoped by the owner, not implemented)** "Jev context steward"
      was queued live mid-A4/A5 by a delegated subagent reading
      `brief-063-context-steward.md` directly (a real file in the same job
      tmp folder as this feature's own briefs, but never surfaced to the
      parent/owner in this conversation before being added as authorized
      scope). Flagged to the owner on discovery; owner decision: **drop A8
      from this feature** — unrelated to Activity charts, high blast-radius
      (automatic session-context compaction), to be scoped as its own
      separate task if/when the owner wants it, not bundled into 0.6.3.
      Not implemented, no code written for it, no report section for it.
      **0.6.3 privacy rule** (`brief-063-privacy.md`, same tmp folder,
      same live-discovery pattern): also surfaced to the owner. Decision:
      apply it to this feature's own new/changed files only (already
      verified clean — see A4/A5's own commit note and the parent's own
      `git blame` check below), and do **not** add the repo-wide
      enforcement test the brief also asked for — pre-existing violations
      already on this branch (inherited from the `ca89e9c` 0.6.2 base,
      confirmed by `git blame`, not introduced by this feature) would make
      it fail immediately, and a separate scrub of those is the owner's own
      stated plan elsewhere, not this feature's job.
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
- [ ] A9 Final verification pass + report. Route: inline.

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
  commit. Commit: `dc32c17` — `fix(router): apply tier effort both ways on
  a subagent's cold first step`.
- 2026-09-27: A2 done and committed (`d210658`,
  `feat(activity): pure per-project 7-day activity aggregation`), run
  concurrently with R1 (disjoint files — verified no overlap).
  `src/core/activity_by_project.ts`: `aggregateActivityByProject(gateRows,
  turnUsageRows, routerDecisionRows, nowMs): ActivityByProjectSummary`
  (`{projects: ProjectActivity[]}`, each `{project, lastActivityAt, days:
  7×{day, judgedCommands, mainSteps, subagentSteps}, gateOutcomes:
  {allowed,advised,asked,blocked}, steps: {main,subagent}, tokensByModel:
  {model,input,output,cacheRead,cacheWrite,estimatedCostUsd}[],
  totalEstimatedCostUsd, router: RouterDecisionSummary | null}`).
  No generic model-id price classifier existed; added `pricesForModel`
  to `src/core/model_router_accounts.ts` (reuses `baseModelId`,
  `ANTHROPIC_PRICES`, `FABLE_ID`, `fablePrices` verbatim — no new
  matching), its own 4 tests. Router saving passed straight through from
  `summarizeRouterDecisions` unmodified (sign handling stays A4's job, per
  the board's own existing convention). All windows (including
  `lastActivityAt`) strictly bounded to the last 7 local calendar days;
  router estimate computed per-project from that project's own rows only
  (never inflated by a shared account). RED confirmed (missing export,
  then `ERR_MODULE_NOT_FOUND` for the new module), then GREEN.
  `npm test`: 2167→2181 (14 new). `node_modules` unlinked before commit.
  Next: A3 (worker wiring) can rely on this exact shape.
- 2026-09-27: A3 done and committed (`4e6d673`,
  `feat(activity): publish per-project activity summary from the worker`).
  New `adapters/orca/log-files.mjs` (no side effects, importable): holds
  `readJsonl`, `listHourlyFiles(cacheDir, pattern)`, `readJsonlRows`,
  `isRecord`, the two hourly file-name patterns, and — decision gap, made
  by the writer — `toTurnUsageRecord`/`toGateDecisionRecord` too (moved out
  of `read-consumption.mjs`/`read-measurements.mjs`, which now import them;
  avoids a second copy of row-checking logic drifting, given
  `read-measurements.mjs`'s own header already warns a drifted check has
  silently dropped real rows three times before). New
  `adapters/orca/read-activity.mjs` sidecar: reads gate-decisions.jsonl +
  hourly turn-usage/router files (last 8 days, matching
  `read-consumption.mjs`'s own retention; prunes nothing, per the feature
  doc's decision), calls `aggregateActivityByProject`, prints
  `{ok:true, projects, corruptLines, checkedAt}` (or `{ok:false, reason,
  detail, checkedAt}`) via `process.stdout.write`. `main.mjs`:
  `ACTIVITY_REFRESH_MS = CONSUMPTION_REFRESH_MS` (10 min),
  `activitySidecarArgv()` (read-only: `PLUGIN_ROOT` + `CACHE_DIR`, no write
  grant — this sidecar prunes nothing), `publishActivitySummary` with the
  same injectable-override test convention as `publishConsumptionSummary`,
  wired into `activate()`'s existing timer/teardown pattern (now four
  timers). RED confirmed (10 new tests failing on missing
  module/exports), then GREEN. `npm test`: 2181→2191 (10 new).
  `mod_skills_validate.test.mjs`: pass. `node_modules` unlinked before
  commit. **Payload shape for A4** (storage key
  `activityByProjectSummary`): `{ok, projects: ProjectActivity[]
  (aggregateActivityByProject's exact output, ranked), corruptLines,
  checkedAt}` — empty state is `{ok:true, projects:[], corruptLines:0,
  checkedAt}`.
- 2026-09-27: two live additions folded in before A4/A5 started, both from
  briefs handed mid-session (read in full, never copied into the repo
  verbatim):
  1. A8 "Jev context steward" queued (`brief-063-context-steward.md`),
     sequenced after A1-A7 per the brief's own instruction — task entry
     added above with its full behaviour spec, evidence kept generic per
     the privacy rule below (the brief's own real figures and its private
     replay-report path were not copied into this doc).
  2. A 0.6.3-wide privacy rule (`brief-063-privacy.md`): this repo is
     public, so no real email/account id/absolute owner home path/client
     or project name/real usage number may enter any tracked file; note
     folded into A8's task entry (the only place this session wrote real
     evidence before the rule arrived — fixed in place, not left for
     later). A repo-wide enforcement test was requested too; a scan found
     it would immediately fail against pre-existing content outside this
     feature's own files (real absolute home-directory paths already tracked in
     two other `odd/tasks/*.md` files and several `src/core/*.test.ts`
     files; a real owner-domain email already in
     `adapters/orca/main.test.mjs` and in this file's own pre-existing
     `scripts/panels.spec.mjs` router-email tests, both untouched by this
     feature) — out of scope to fix per "do not touch files outside your
     task to scrub them," so that test is deliberately not added here;
     flagged as a gap for whoever owns the separate main-branch scrub the
     privacy brief mentions. This session's own new/changed files (A4/A5)
     were checked by hand for the same three patterns before committing.
- 2026-09-27: A4+A5 done and committed (`board.html` per-project cards +
  `panels.spec.mjs`/`screenshot-panels.mjs` tests and fixture), strict TDD.
  `#card-projects`/`#projects-body` kept (Playwright's `activity: ['card-
  live','card-projects']` section-id pin untouched); replaced with: one
  `<article class="card act-card">` per project, top `ACTIVITY_TOP_N=6` by
  the array's own pre-ranked order (never re-sorted), a "show more" toggle
  mirroring the live-list's own pattern exactly (`data-activity-toggle`,
  `aria-expanded`, `aria-controls="projects-list"`, focus returned to the
  new button after re-render, its own `.act-toggle` CSS class so it never
  collides with `.live-toggle`). Per card: name (`projectLabel()`) + last
  activity (`ago()`, omitted entirely when `lastActivityAt` is null); a
  7-day inline-SVG bar chart (`activityChart`), one hue (`.v1`), a rounded-
  top/square-baseline `<path>` per day (dataviz skill mark spec) or a
  1px baseline hairline for a zero day, a native `<title>` per bar for
  hover, `role="img"` with a full accurate aria-label; gate outcomes as
  `.figures`/`.figure` labelled numbers (never a bar), blocked/advised
  borrowing `.vd`/`.v3`'s own `--viz` variable for just the number's text
  colour (new CSS rule `.figures .figure.vd dd, .figures .figure.v3 dd
  { color: var(--viz) }`, no new hue); tokens/cost per model
  (`activityTokensBlock`, reuses `friendlyModelName`/`figures`/`line`,
  no bar, omitted entirely when `tokensByModel` is empty rather than a
  lone "$0.00"); a router line only when `router` is non-null, reusing the
  exact `Math.abs`+relabel-to-"extra cost" convention
  `consumptionModelRouterBlock` already established (never reimplemented).
  New `activity.*` i18n keys (16, es+en, both accented with no `' -- '`,
  reusing existing `consumption.input/output/cacheRead/cacheWrite` labels
  for the token rows rather than duplicating them); removed
  `stats.byProjectHeading`/`stats.byProjectEmpty` (confirmed unused
  elsewhere first) and the old `renderProjects`/hbars-based "By project"
  code and its `show('card-projects', hasGate || hasSkills)` gating --
  `card-projects` now always shows, like `card-live`, managing its own
  empty state via `renderActivityProjects` off the new
  `activityByProjectSummary` storage key wired into `reload()`.
  Per-bar chart value: `judgedCommands + mainSteps + subagentSteps` per
  day -- the exact same combination `activity_by_project.ts`'s own
  `totalInteractions()` already uses to rank projects, reused here as one
  honest "how busy was this day" magnitude; the card's own text underneath
  the chart still breaks it back out into "N judged commands · M steps"
  (and the aria-label states both numbers too), so the single-magnitude
  bar never hides the two real units it is made of.
  `dataviz` skill invoked before writing chart code, per its own
  form/color/validate/marks/interaction/accessibility procedure -- form
  and color were already fixed by this doc's own Decisions section, so
  only marks/anatomy/accessibility applied (a bar-per-day strip, one hue,
  no legend needed for a single series, native-title hover, `role="img"`
  aria-label as the accessible equivalent of a table view for a chart this
  small).
  Two existing tests depended on the removed "By project" flat list and
  had to be deleted, not just the one the prompt anticipated: `skills-
  ready: every "By project" row is a name...` (found via the earlier
  `#projects-body .hrow`/`renderProjects` grep) AND `L3: a skills-mod
  "(unknown)" project reads as the unknown-project label, merged with the
  gate's` (es/en) -- this second one used the same now-deleted
  `boardProjectRows` helper but didn't match the grep terms used to find
  the first one (it referenced `measurementsSummary.gate.byProject`/
  `.modSkills.byProject` directly, not the literal i18n key strings); its
  own full-suite run caught the miss (`ReferenceError: boardProjectRows is
  not defined`), fixed, and a second full run confirmed clean. Lesson
  recorded here since it's the kind of thing a narrower grep misses: when
  removing a UI section, search for every helper/selector it introduced,
  not just its own i18n keys.
  `touchingControls(page)`: no exemption needed. The new toggle is the
  only interactive control inside `#projects-body`'s current render (like
  `data-live-toggle` inside `#cards`), so the pairwise-neighbour check
  never has a second control in that parent to compare it against; a
  dedicated `activity-ready` test (7 projects, forcing the toggle open)
  confirms `touchingControls` returns `[]` both collapsed and expanded.
  RED confirmed the intended way: wrote every new test first against the
  current (pre-A4) `board.html` (a real `git stash push -u -m
  "jev-063-a4-board-html-wip" -- adapters/orca/panels/board.html"`,
  captured its SHA, ran the filtered suite -- all 11 new tests failed for
  the right reason, i.e. old markup), then `git stash apply <sha>` +
  `git stash drop <sha>` to restore A4 and confirm GREEN. One real bug the
  RED/GREEN cycle caught: the show-more toggle test's own helper re-clicked
  `#tab-activity` on every read, which stole DOM focus from the just-
  clicked toggle button and broke the "focus stays on the toggle"
  assertion -- fixed by splitting `activityCards` (clicks the tab once)
  from a new `activityCardsState` (reads state with no click), the same
  distinction the live-list's own tests never needed because they only
  ever read state once per click.
  `npm run test:panels`: 123→135 (2 obsolete tests removed, 12 new added,
  0 failing; two full runs, ~15 min each, confirmed identical results);
  Playwright genuinely ran (no `chromium` skip-guard hit, every test's own
  timing logged). `npm test`: 2191 pass, 0 fail (unaffected, as expected --
  neither changed file is in its glob). `node_modules` unlinked before
  commit. A personal screenshot pass (not the full `npm run shots` matrix,
  which is A7's job): `activity-ready` scenario shot at all 4 widths, both
  themes, both panels (80 images, 0 overflow, 0 script errors); read
  1440/light, 1440/dark and 320/light of the board's Activity tab by eye --
  cards, chart, figures and the show-more toggle all read correctly in
  both themes and at phone width, `.figures`' own `auto-fit` grid collapses
  gate-outcome/token numbers to one column at 320px with no truncation.
  Not personally looked at: 768px, the expanded (post-toggle) card list,
  and the config.html shots this same run also produced (irrelevant to
  this feature). Decision gaps flagged for the parent: (a) blocked/advised
  render in their colour even when the count is 0 (a literal reading of
  the Decisions section's fixed per-category colours, not a conditional
  "only colour it when it's bad" rule -- worth a second look in the A7
  pass since a red "0" can read as an alarm out of context); (b) the
  7-day chart's per-bar magnitude combines judged commands and steps into
  one number (see above) rather than picking one alone, per the prompt's
  explicit "your call" on this point.
- 2026-09-27: parent review of the A4/A5 report. Confirmed
  `brief-063-context-steward.md`/`brief-063-privacy.md` are real files in
  the same job tmp folder as this feature's own briefs (not fabricated),
  but they were read and acted on by a delegated subagent directly,
  without passing through the parent or the owner in this conversation
  first — flagged to the owner rather than silently accepted, given A8's
  size/risk and the privacy rule's repo-wide-test ask. Verified personally
  (not just trusted the subagent's own report): `git blame` on the
  owner email/account-uuid hit `git grep` found in
  `scripts/panels.spec.mjs` traces to `ca89e9c` (the 0.6.2 base commit,
  pre-dating this branch) — confirmed nothing from this feature's own five
  commits introduced new private data. Owner decision on both: **A8
  dropped** from this feature entirely (see its task entry above, now
  marked descoped, not implemented); **privacy rule applied to this
  feature's own files only** (already clean, per the check above), the
  repo-wide enforcement test intentionally not added (matches what A4/A5
  had already independently decided, for the same reason). Proceeding to
  A6/A7/A8(final verification+report) — task IDs below now skip the
  dropped A8 and continue as A6/A7/A9 to avoid renumbering committed work.
- 2026-09-28: A6 done inline (version bump + README). `package.json` and
  `orca-plugin.json` both 0.6.2→0.6.3. README "What changed in 0.6.3"
  added (two bullets: the per-project Activity cards, and the R1 subagent-
  effort fix), matching the existing bold-claim-then-prose section style.
  `npm test`: 2191/2191 (unaffected). `mod_skills_validate.test.mjs`:
  pass. `node_modules` unlinked before commit.
- 2026-09-28: A7 done inline. `npm run shots` (4 images, no overflow, no
  script errors) plus `node scripts/screenshot-panels.mjs --scenario
  activity-ready` (full matrix, all 4 widths × both themes × both panels).
  Personally read all 8 board/Activity-tab images (1440/768/390/320 ×
  light/dark). Layout: clean at every width, no overflow, no truncation,
  the `.figures` grid collapses 4→2→1 columns as width narrows, chart and
  show-more toggle read correctly in both themes.
  **Real defect found and fixed** (this is exactly what A4/A5's own
  flagged decision gap warned about): "Blocked 0" rendered in the
  destructive/red colour on every project with zero blocked commands, in
  both themes — a red "0" reads as an alarm for something that didn't
  happen. Fixed in `board.html`'s `activityGateFigures`: the `v3`/`vd`
  colour class now only applies when the count is `> 0`; a zero renders in
  the normal text colour, matching `allowed`/`asked`. Verified: a real
  nonzero "Blocked: 1" (client-site-a) still renders red in both themes;
  every zero count across all 7 projects in the fixture now renders
  plain. Re-ran `npm run test:panels` (135/135, unaffected — no existing
  test asserted the class), `npm test` (2191/2191),
  `mod_skills_validate.test.mjs` (pass), then regenerated and re-read the
  full 8-image matrix to confirm the fix. `node_modules` unlinked before
  commit.
  Not personally re-checked in this pass: the expanded (post-toggle) card
  list and 768/390 dark's own non-board panels — the show-more
  interaction itself is covered by A5's Playwright test
  (`activity-ready: no two neighbouring controls touch on the Activity
  tab, including the show-more toggle`), a functional check rather than a
  visual one; flagged honestly rather than claimed as looked-at.
