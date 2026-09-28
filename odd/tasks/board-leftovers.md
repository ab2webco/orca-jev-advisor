# Advisor board: close the leftovers of tabs-and-names

## Objective
Finish what `board-tabs-and-names` (cf5a046, af4ebcd, 3d7f9dd on 0.6.2) left
open, so no part of the board shows a raw id, stays unphotographed, or
pretends to remember something it cannot.

## Problem
Open items recorded at the close of `odd/tasks/board-tabs-and-names.md`:
- The skills-mod rows in "By project" still show the raw projectId (49 rows in
  the owner's log), while the gate rows show names. `adapters/orca/read-measurements.mjs`
  counts `d.orcaContext.proyecto` for the gate (~line 429), but the skills-mod
  rows come from another path.
- No screenshot scenario has skills-mod data, so the Skills tab has only ever
  been photographed empty.
- The board remembers the last tab in `localStorage`, which throws inside
  Orca's sandboxed iframe. Inside Orca the tab is never remembered.

## Why
The owner: "no dejes nada incompleto". A remembered tab that never persists is
a half-done feature (global rule 1). An id in "By project" is the same defect
the owner already reported for live states.

## Scope (authorized by the owner 2026-09-27; split agreed with the 0.6.2
coordinating session)
- L1: `adapters/orca/read-measurements.mjs` (+ its test). The skills-mod rows
  in "By project" use the same naming as the gate rows.
- L2: a NEW scenario in `scripts/screenshot-panels.mjs` with skills-mod data
  shaped like the real log, and NEW tests in `scripts/panels.spec.mjs`.
  Additive only: no edits to existing blocks. The CI budget is unchanged.
- L3: `adapters/orca/panels/board.html`. Persist the last tab through the host
  storage bridge the config panel already uses (its `read()`/`write()`
  helpers over `storage.get`/`storage.set` via postMessage), with no worker
  change. If that bridge is not available to `board.html`, remove the
  `localStorage` persistence and its claims instead.

Out of scope, per the coordinator:
- `adapters/orca/main.mjs`, `config.html` and `install-claude-integration.mjs`,
  which the 0.6.2 writer is editing now.
- Every router file and the router README lines. The router leftovers (the
  README line ~162, `cd` as a probe, a live status check) belong to the 0.6.2
  session.

## Constraints
- If L1 cannot be done without `main.mjs`, stop and report the minimal
  change needed. Do not make it.
- Fixtures are synthetic (`@example.com`, made-up repos) and shaped like the
  real `mod-skills-measurements.jsonl` rows, fed through the real read path.
  Never real data.
- Never use `any`. No debug statements. Artifacts are in English. ARIA and
  i18n (es/en) are kept.
- Visual evidence: the new scenario at 1440 / 768 / 390 / 320 in light and
  dark, for the Skills and Activity tabs. The parent reads the images.

## Tasks
- [x] L1 skills-mod rows in "By project" named like the gate rows. RED first. One commit.
- [x] L2 new screenshot scenario with skills-mod data, plus additive spec tests. RED first. One commit.
- [x] L3 last tab persisted through the host storage bridge, or its `localStorage` code removed. RED first. One commit.
- [x] L4 evidence: the new scenario's images, read by the parent.
- [x] L5 Skills card: each skills-mod figure a labelled number, no shared bar
  scale, labels never cut. RED first. One commit.
- [x] L6 Live status: newest first, one row per project and branch with a
  count, stale working/waiting shown as no signal, a 24 h window with a
  show more toggle. New `live-busy` scenario. RED first. One commit.

## Route per task
- L1-L3: delegated direct, one writer run sequentially. The writer trigger
  fired: read-measurements, board.html and the harness/spec are 2+
  non-trivial files.

## Checks
- TDD: enabled. Source: global `~/.claude/CLAUDE.md` "Strict TDD Mode:
  enabled". Runners: `npm test`, `npm run test:panels`.
- RDD: disabled/unmanaged per the owner's decision.

## Delivery
- Branch `dev/board-leftovers` from jev-062-effort 036c2dd, worktree
  `/home/dev/Projects/orca-supervisor-board-leftovers`. `node_modules`
  is a symlink and is never staged. No upstream, no push.
- The final hash goes to the 0.6.2 coordinating session, which cherry-picks
  it onto 0.6.2 before release.

## Progress
- 2026-09-27: document created, split agreed with the coordinator. Writer not started.
- 2026-09-27 L1 done (route: delegated writer). Only `read-measurements.mjs`
  and its test changed; no `main.mjs` data was needed.
  - Finding: the gate rows are named when gate-bash.ts writes them
    (`projectName()`: origin's last segment, else `basename(cwd)`), and the
    sidecar runs under `--permission` with read access to the cache dir only,
    so it cannot run git or see `orca repo list`. It does not need to: the
    new `modSkillsProjectName()` applies the gate's rule to what the row
    carries. `github:owner/name` becomes `name`; `repo:<id>` (Orca's id for
    a checkout with no remote) and a missing projectId become the worktree's
    folder name; nothing usable stays `(unknown)`, never the id.
  - Parity checked on the owner's machine, read-only: the gate log's biggest
    project is `orca-jev-advisor` (5650 rows), which is the last segment of
    the skills rows' `github:ab2webco/orca-jev-advisor`. The real skills log
    has no `repo:` rows today. Residual: a fork whose Orca identity follows
    `upstream` would be named after the upstream repo, the same as
    `boardProjectName()` without a repo list.
  - RED: `modSkills.byProject names each project the way the gate names it,
    never by its raw Orca id` (actual keys `github:example/orca-supervisor`,
    `gitlab:example/helpdesk.git`, `repo:5f0c...`) and `modSkills.byProject:
    a repo:<id> row with no worktree to name it counts as unknown, never as
    the id` (actual key `repo:5f0c...`, no `app`). 31/33 in the file.
  - GREEN: the file 33/33; `npm test` 2144/2144.
- 2026-09-27 L2 done (route: delegated writer). Additive only: 0 deleted
  lines in `scripts/screenshot-panels.mjs` and `scripts/panels.spec.mjs`.
  - Scenario `skills-ready` = `ready` with `measurementsSummary.modSkills`
    replaced by the real read path: the harness writes 20 synthetic decision
    rows and 9 observations, shaped like `skill_measurement.ts`'s records
    (made-up repos under `/Users/dev/...`, synthetic prompts), to a
    throwaway `ORCA_SUPERVISOR_CACHE_DIR` and runs the real
    `read-measurements.mjs` over it. Four projects, one per way the mod
    records where it ran: `github:example/orca-supervisor` (two worktrees,
    also a gate project), `github:example/project-c`, `repo:<uuid>`
    (`scratch-notes`), and the `cwd` fallback (`workdir`).
  - Registered with `SCENARIOS['skills-ready'] = ...` after the literal, so
    the existing scenario list is untouched. `--quick` still resolves to
    `ready` only: CI still shoots the same 4 images.
  - RED: both new spec tests, `skills-ready: every "By project" row is a
    name, and the skills mod's rows join the gate's` and `skills-ready: the
    Skills tab shows what the mod recorded, not its empty sentence`, failed
    with `screenshot-panels.mjs has no skills-ready scenario`.
  - GREEN: `npm test` 2144/2144; `npm run test:panels` 107/107;
    `node scripts/screenshot-panels.mjs --scenario skills-ready`: 80 images,
    no overflow, no script errors at any width.
  - Looked at by the writer: all 16 board images of `skills-ready`, the
    Activity and Skills tabs at 1440, 768, 390 and 320, light and dark. By project reads orca-supervisor 1,214
    (gate 1,204 + skills 10, one row), orca-oss 618, (unknown project) 91,
    project-c 5, scratch-notes 3, workdir 2: no id anywhere. Skills: 14
    suggested, 60,190 listing characters not sent, 88.9% match rate. At 320
    and 390 long labels end in an ellipsis with the full name in `title`,
    the existing `.hl` behaviour ("Skills suggest...", "Listing chara...",
    "orca-supervis..." are cut there). At 320 the live row's `working` chip
    wraps under its branch, also existing. Nothing else found.
  - Not observed: a RED run of the L2 spec against the pre-L1 aggregator
    (the local gate refused overwriting `read-measurements.mjs` from
    036c2dd). The dependence is by construction: the scenario's `modSkills`
    is the live aggregator's output.
  - For the coordinator: `realModSkillsSummary()` spawns a child when
    `screenshot-panels.mjs` is imported. `panels.spec.mjs` and
    `fixture_shape.test.mjs` turn an import failure into `SCENARIOS = null`
    and skip as "playwright is not installed", so a failing spawn would
    skip these tests rather than fail them. A test asserting `SCENARIOS` is
    non-null whenever `chromium` is would close that.
  - Pre-existing, untouched: a `byProject` key of `(unknown)` renders
    literally, since `projectLabel` only maps null/'' to the i18n label.
- 2026-09-27 L3 first stopped: both options the brief allowed broke the
  existing reload test `the board reopens on the tab this viewer chose
  last time`. The coordinator then chose a design that keeps it.
- 2026-09-27 L3 done (route: delegated writer). `board.html`, plus spec tests
  (added lines only) and one comment edit the coordinator approved.
  - Two paths, one key (`jevAdvisor.boardPanel.activeTab`). A person's
    choice (click or arrow keys, `chooseTab`) is written to localStorage (in
    try/catch) and through the host bridge (`call('storage.set', ...)`,
    with person priority). On open, the localStorage tab (or Gate) is
    activated at once, and `restoreTabFromHost`, which runs after the bridge
    helpers exist, asks the host with `read()`. A valid host answer wins.
    Restoring never writes, so it cannot overwrite what the host holds.
  - No flash of the wrong tab: `<body class="tabs-restoring">` hides the tab
    panels (`visibility: hidden`), but not the header or the tab bar, until
    the host answers or 300 ms pass. A later answer is ignored, and a click
    during the wait wins and shows at once.
  - `projectLabel` maps the skills mod's `(unknown)` key to
    `stats.unknownProject`, so it merges with the gate's null row.
  - The bridge comments in board.html ("This panel only reads", and the
    Spanish queue note) now say the panel writes its tab. The spec comment
    at ~239 ("board.html only ever calls storage.get, never storage.set")
    was corrected with the coordinator's approval: the board also writes
    its active tab through storage.set.
  - RED (6 of 8 new tests failed): `L3: clicking a board tab stores it
    through the host storage bridge...` (waitForFunction timed out: no
    storage.set), `...host storage holds activity opens on Activity...`
    (actual gate), `...host's stored tab wins over localStorage...` (actual
    skills), `...a host that never answers still gets the board on screen
    within the 300 ms bound...` (`showed after 0 ms, without waiting for the
    host`), and the `(unknown)` label tests, en and es (`"(unknown)" printed
    literally`). Green at RED, as guards: `...never answers and an empty
    localStorage open the board on Gate`, and `the screenshot harness imports
    whenever playwright does...` (it makes a harness import failure fail
    instead of skip).
  - GREEN: `npm test` 2144/2144; `npm run test:panels` 115/115, including
    the existing reload and throwing-localStorage tests, unchanged.
  - Not re-photographed: the harness waits 6 s before each shot, and no
    scenario has a `(unknown)` key, so no image changes.

- 2026-09-27 L5 done (route: delegated writer). Found by the parent in the
  skills-ready images: "Skills suggested" (14, prompts) and "Listing
  characters not sent" (60,190, characters) were bars on one shared scale,
  so 14 was an empty sliver, and at 390/320 both labels were cut.
  - `board.html`: `renderSkills` now uses a new `figures()` helper: a
    `<dl class="figures">` of labelled numbers, number above label
    (`column-reverse`, so `<dt>` stays first for assistive technology), with
    labels that wrap (`overflow-wrap: anywhere`) and never cut. The match
    rate line and the empty state are unchanged.
  - RED: `L5: skills-ready's Skills card shows each figure as a labelled
    number, with no bar` (4 bar elements), and `L5: no Skills card label is
    cut at 320px` en (`["Skills suggested","Listing characters not sent"]`)
    and es (`["Skills sugeridas","Caracteres de listado no enviados"]`).
    Green at RED, as a guard: `L5: a skills mod with nothing recorded still
    shows only its empty sentence`.
  - GREEN: `npm test` 2144/2144; `npm run test:panels` 119/119;
    `--scenario skills-ready`: 80 images, no overflow, no script errors.
  - Found in the first re-shoot, at 320: with one label wrapped, the numbers
    sat at different heights (`column-reverse` packs to the bottom). Fixed
    with `justify-content: flex-end`, re-shot, and `test:panels` re-run
    (119/119).
  - Looked at by the writer: the Skills tab at 1440/768/390/320 in light
    and dark (320 light and dark again after the alignment fix). Each figure
    reads as a number with its whole label; at 320 "Listing characters not
    sent" wraps onto two lines.

- 2026-09-27 L6 done (route: delegated writer). Owner request via the
  coordinator, from the live panel with 63 agents: within each status the
  rows ran oldest first, rows marked working were three days old, and
  project-a/main repeated more than ten times.
  - `board.html`, view only (the worker's entries are unchanged): one row
    per project + branch (`projectName`, else `project`, plus `rama`) with
    the group's latest state, last-seen time and `×N sessions` / `×N
    sesiones` when N > 1; newest first across every status. A row with no
    project is keyed by its worktreeId, else its paneKey (floating terminal
    panes, which share one worktree id, by paneKey), so unknown sessions
    never merge. A working or waiting row silent for over 1 h reads `no
    signal` / `sin señal`, muted (dotted border, muted colour, normal
    weight); done stays done. Rows last seen within 24 h show by default;
    the rest wait behind `show more (N)` / `ver más (N)` (a button with
    `aria-expanded` and `aria-controls="live-list"`), then `show less` /
    `ver menos`, and focus returns to the toggle after it re-renders. With
    nothing seen in 24 h: `Nothing seen in the last 24 h.` / `Nada visto en
    las últimas 24 h.`, plus the toggle.
  - New scenario `live-busy` (added lines only): project-a/main x12, a
    working three days old, a working 3 h silent and a waiting 2 h silent,
    unnamed and floating-terminal rows, a `repo:` row, and three rows older
    than 24 h. Real ISO ages from harness load, no 'now' sentinel, because
    only the harness's own hostBridge resolves it and the spec reads the
    scenario through its own. The first run of the live-busy spec test
    caught that.
  - RED (7 of 7 new tests failed): `L6: live rows run newest first overall`
    (actual `alpha, charlie, delta, bravo`), `...one row per project and
    branch...` (13 project-a rows), `...rows with no project name never
    merge...` (actual oldest first, 7 rows), `...silent for over an hour
    reads "no signal"...` (no state tag), `...over 24 h ago wait behind
    "show more (N)"...` (actual old rows listed first), `...when nothing was
    seen in 24 h...` (2 rows shown), and `...Spanish with its accents...`
    (no state tag). The `live-busy` scenario test was written after GREEN,
    as a guard on the scenario itself.
  - GREEN: `npm test` 2144/2144; `npm run test:panels` 127/127 (the existing
    live-row name and floating-terminal tests unchanged and passing);
    `--scenario live-busy`: 80 images, no overflow, no script errors.
  - Looked at by the writer: the Activity tab at 1440/768/390/320 in light
    and dark. Nine rows, project-a `×12 sessions`, two `no signal` rows
    muted, `show more (3)`. At 390 and 320 a long row wraps its count or
    time onto a second line, as before this change. The header still
    counts entries ("24 agent(s)"), not rows; unchanged and out of scope.
- 2026-09-27 L4 done (route: parent). The parent re-ran both runners at
  0692a65: `npm test` 2144/2144, `npm run test:panels` 127/127, 0 skipped.
  Images read by the parent:
  - `skills-ready` before L5, Skills tab: 1440 light, 768 dark, 390 light,
    320 dark. This is where the one-scale bars and the cut labels were
    found, which became L5.
  - `skills-ready` before L5, Activity tab: 1440 dark, 768 light, 390 dark,
    320 light. No raw ids.
  - `skills-ready` after L5, re-shot at 0692a65, Skills tab: 1440 light,
    768 dark, 390 light, 320 dark. Two labelled numbers, no bars, labels
    whole, wrapping at 320.
  - `live-busy` after L6, Activity tab: all eight (1440/768/390/320, light
    and dark). Newest first, project-a `×12 sessions`, `no signal` muted,
    `show more (3)`, no horizontal overflow.

## Next step
The coordinator cherry-picks 612871e..HEAD onto 0.6.2.
