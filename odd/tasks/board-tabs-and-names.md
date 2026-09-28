# Advisor board: tabs, and names instead of ids

## Objective
Make the Advisor nav panel short enough to scan by splitting it into tabs,
and show people-readable names wherever it shows a raw id today.

## Problem
Owner review of the live 0.6.0 panel (2026-09-27, two screenshots):
- `adapters/orca/panels/board.html` stacks every section in one long page
  (gate health, cost, where it intervenes, calibration, last gate decisions,
  live states, per project, skills mod, consumption with token usage, account
  quota and recommendations). It no longer fits on a screen.
- Account quota rows read `Cuenta acct0002`, `Cuenta acct0003`, ... because
  `accountShortLabel` prints the first 8 characters of the account id, although
  `orca account list --json` returns each account's `email`.
- "Estados en vivo" rows print `repo:769240ab-2e9b-4607-85ea-dd5781029790`,
  `github:ab2webco/orca-oss`, or `(worktree desconocido)`, because
  `liveEntryView` shows the raw `projectId`. "Por proyecto" already shows short
  names (`orca-jev-advisor`, `service-a`), so the two sections
  disagree about what a project is called.

## Why
The owner uses this panel to decide where usage goes and which sessions are
live. An id has to be looked up somewhere else before it means anything, and a
page that needs scrolling through eleven sections gets skimmed or ignored.

## Scope (authorized)
- `adapters/orca/main.mjs`: resolve names in the worker, not in the browser.
- `adapters/orca/read-consumption.mjs` and the quota mirror, only as far as
  needed to carry `email` through.
- `adapters/orca/panels/board.html`: tabs, and labels from the resolved names.
- Tests beside each change (`*.test.mjs`, `scripts/panels.spec.mjs`), and the
  existing fixtures in `main.test.mjs` / `scripts/screenshot-panels.mjs`,
  extended only with fields the real CLI returns.

Out of scope: `src/core/model_router_*` (dirty in the 0.6.1 worktree
`jev-061-origin`), the gate, the settings panel, any new measurement, the CI
screenshot budget.

## Constraints
- Name sources are the real CLI: `orca account list --json` gives
  `result.accounts[].email`, and `orca repo list --json` gives
  `result.repos[].{id, displayName, gitRemoteIdentity.canonicalKey}`
  (`github.com/owner/name`, while a projectId reads `github:owner/name`).
- The raw id is never lost: it moves to the element's `title`.
- If a name cannot be resolved, keep an honest fallback. Never invent a name.
- "Estados en vivo" and "Por proyecto" must name the same project the same way.
- Fixtures use synthetic addresses (`@example.com`), never real emails.
- Tabs: both i18n catalogs (`es`, `en`); ARIA tabs (`tablist`/`tab`/`tabpanel`,
  `aria-selected`, arrow keys); every existing section is reachable under
  exactly one tab. Remembering the last tab in `localStorage` is a per-viewer
  convenience, so every read and write goes in `try/catch`, and the panel must
  render correctly without it.
- No horizontal page scroll at 320 px.
- Visual evidence: `npm run shots:all` at 1440 / 768 / 390 / 320, light and
  dark (the board has a `prefers-color-scheme: dark` theme). The parent reads
  every image before anything is called done.

## Proposed tab grouping (the owner may adjust it)
- Gate: is the gate working, what it costs, where it intervenes,
  calibration, last gate decisions.
- Activity: live states, per project.
- Consumption: token usage, account quota, recommendations, and any
  model/router card.
- Skills: skills mod.
The writer maps the real section list first. If a section exists that is not
listed here, it goes in the closest tab and the report says so. The window
chips (this version / 24 h / 7 days / all) stay global above the tabs,
unless they only affect one tab; the writer checks and reports which.

## Tasks
- [x] T1 Names instead of ids: account email in quota rows, and project names
  in live states resolved in the worker, sharing the "Por proyecto" naming.
  Unresolvable rows keep a fallback. RED first, then GREEN. One commit.
- [x] T2 Tabs, with ARIA, keyboard, remembered tab, es/en labels, and a
  panels spec proving every section sits under exactly one tab. RED first,
  then GREEN. One commit.
- [x] T3 Evidence: `npm run shots:all` in both themes at the four widths.
  The parent reads every image. Fixes found this way go in their own commit.

## Route per task
- T1, T2, T3: delegated direct, one bounded writer run sequentially. The
  writer trigger fired: `main.mjs`, `board.html`, and their tests and spec are
  2+ non-trivial files. The mapping of the section list and of the name
  sources is part of the writer's first step, with the parent's orientation
  (locations above) passed in.

## Checks
- TDD: enabled. Source: global `~/.claude/CLAUDE.md` "Strict TDD Mode:
  enabled". Runner: `npm test` (`node --test --experimental-strip-types`), plus
  `npm run test:panels` (`node --test scripts/panels.spec.mjs`).
- Full closure: `npm run check` (test + quick shots + panels spec), and
  `npm run shots:all` for the full matrix.
- RDD: disabled/unmanaged per the owner's decision (no Gentle AI reviews).
  Verification is by tests, screenshots read by the parent, and probes.

## Delivery
- Strategy: `ask-on-risk`. Forecast is about 450 authored changed lines
  (T1 ~200, T2 ~250), above the ~400 budget, so the chain strategy is asked
  once before any PR is opened. Proposed slices: S1 = T1, S2 = T2 + T3.
- Branch `dev/board-tabs-names` from `origin/main` 2370e17 (0.6.0),
  worktree `/home/dev/Projects/orca-supervisor-board-tabs`. Upstream
  tracking removed so nothing can be pushed to `main` by accident.
  `node_modules` is a symlink to the main checkout and is never staged.
- Push, PR and merge are the owner's decisions.

## Progress
- 2026-09-27: document created. Worktree ready. Writer not started.
- 2026-09-27 T1 done (route: delegated writer). Commit `7373901`
  `feat(board): name accounts by email and live rows by project`.
  - Email: joined onto the `consumptionSummary` storage payload in the worker
    (`withAccountEmails` in `publishConsumptionSummary`, from
    `orca account list --json`). `quota.json` stays email-free, as its own
    test pins, so `read-consumption.mjs` and the quota mirror are unchanged.
    No email, or an unreadable list: the old `Account <8>` label.
  - Project names: `boardProjectName` in `main.mjs` uses the rule
    gate-bash.ts's `projectName()` uses for "Por proyecto": the `origin`
    remote's last segment, then the projectId's last segment
    (`github:owner/name` becomes `name`), then, for `repo:<id>`, the checkout's
    folder name, then Orca's displayName. The brief's canonicalKey to
    displayName mapping was not used: on the real machine displayName differs
    from the origin's short name for 8 of 43 repos (this one:
    `orca-supervisor` against `orca-jev-advisor`), and canonicalKey follows
    `upstream` for forks, so the two sections would still disagree.
    Every entry is renamed on each board write. `orca repo list --json` is
    cached for 30 s like the worktree list (`ORCA_CLI_ARGUMENTS.repoList`).
  - Fallbacks on the live row: `global-floating-terminal` (Orca's own id)
    reads "Floating terminal" / "Terminal flotante". A project the worker
    could not name reads "(unknown project)", and a row with no project reads
    "(unknown worktree)". Raw ids go to `title`. An entry written before this
    release reads "(unknown project)" until the next status event renames it.
  - RED observed: 7 unit tests (`TypeError: repoNameSources is not a
    function`, `onAgentStatusChanged is not a function`, missing email,
    `getBoard` accepting `projectName: 42`) and 3 spec tests (visible text
    `Account acct-pri · ok`, `github:example/orca-jev-advisor`, no
    `Terminal flotante`).
  - GREEN: `npm test` 2035/2035; `npm run test:panels` 80/80;
    `node scripts/screenshot-panels.mjs --scenario consumption-ready`: no
    overflow and no script errors at any width.
  - Residual, out of scope: the mod-skills rows of "Por proyecto" still carry
    the raw projectId (`read-measurements.mjs:429`). 49 such rows exist in the
    real log, far below the gate's counts, so they do not reach the top 8 today.
- 2026-09-27 T2 done (route: delegated writer). Commit `596c42e`
  `feat(board): split the Advisor board into tabs`.
  - Real section list mapped from `board.html`: 12 sections plus the window
    chips. Final grouping:
    - Gate: window chips, empty state, is the gate working, what it costs,
      where it intervenes, calibration, last gate decisions, plus two sections
      the proposal did not list: "How long each one takes to decide" (the
      Jev and model A/B comparison) and "What these numbers do not measure".
      Both are about the gate's numbers, so Gate is the closest tab.
    - Activity: live status, per project.
    - Consumption: token usage, account quota, recommendations and the model
      router (all one card).
    - Skills: skills mod.
  - Window chips: they filter only the gate's windows (status, cost,
    interventions, calibration). Last decisions, per project, speed,
    consumption and skills ignore them. So they sit inside the Gate tab, not
    above the tabs. The header, its agent count and the worker note stay
    above the tabs.
  - Tabs are a hand-copy of config.html's tablist: `tablist`/`tab`/`tabpanel`,
    `aria-selected`, roving tabindex, arrow keys with wrap, and Home/End.
    `localStorage` key `jevAdvisor.boardPanel.activeTab`, every access in
    `try/catch`. Per config.html's own note, `localStorage` throws inside
    Orca's opaque-origin iframe, so there the board opens on Gate each time.
  - No blank tab: the live and skills cards now always show, each with its
    own empty sentence. The Consumption card already did.
  - `screenshot-panels.mjs` photographs every board tab in the full matrix.
    `--quick` still takes each panel's first tab only, so CI stays at 4
    images.
  - RED observed: 11 spec tests failed (no `#board-tabbar`; clicks on
    `#tab-*` timed out; `expected the board tabs, found []`).
  - GREEN: `npm test` 2035/2035; `npm run test:panels` 90/90;
    `npm run shots`: 4 images, no overflow, no script errors.
- 2026-09-27 T3 done (route: delegated writer for the fix). `npm run check`
  exit 0 (2035/2035, 4 quick shots with no overflow, 90/90), then
  `npm run shots:all`: 800 images, no overflow, no script errors at any
  width.
  - The parent read these `router-ready` board images:
    - 1440: all 4 tabs light, plus gate, activity and consumption dark, plus
      `fresh-board-light-1440-skills`.
    - 768: gate light, activity light, consumption dark, skills dark.
    - 390: gate light, activity dark, consumption dark, skills light.
    - 320: gate dark, activity light, consumption light, skills dark.
  - Finding: at 320px the tab bar wrapped onto two rows only while
    Consumption was selected, with "Skills" alone on the second row. The
    bold selected tab made the row too wide, so the content below jumped on
    every switch.
  - Fix, in commit `fix(board): keep the tab bar on one row at narrow
    widths`: the bar no longer wraps (`flex-wrap: nowrap`, tabs `flex: none`)
    and scrolls sideways on its own if it ever cannot fit, so the page still
    never does. Tab padding drops from 12px to 9px at 400px and below, and
    all four labels then fit without scrolling in English and in Spanish at
    320 and 390.
  - RED: `the board tab bar stays on one row at 320px, whichever tab is
    selected` failed with `consumption selected: tab-gate:106
    tab-activity:106 tab-consumption:106 tab-skills:140`. The 390px case
    already passed.
  - GREEN: `npm test` 2035/2035, `npm run test:panels` 92/92. The 16
    `router-ready` board images at 320/390 (both themes, all 4 tabs) were
    re-photographed in place with the harness's own settings: no overflow,
    no script errors. Other scenarios' 320/390 board images in
    `.screenshots/` predate the fix until the next `npm run shots:all`.

## Open items (recorded, not fixed)
- No scenario photographs the Skills tab with data: every fixture's skills
  mod has recorded no decision.
- The skills-mod rows of "Por proyecto" still show raw projectIds
  (`read-measurements.mjs:429`, out of scope).
- The remembered tab does not persist inside Orca: its sandboxed
  opaque-origin iframe throws on `localStorage`, so the board opens on Gate
  every time there, the same as config.html.
- The diff is about 1090 authored lines (912 without this document) against
  the ~450 forecast: `7373901` 616, `596c42e` 480. The chain strategy is
  still to be asked before any PR, per `ask-on-risk`.

## Next step
The owner decides the chain strategy, then push and PR. Nothing is pushed.
