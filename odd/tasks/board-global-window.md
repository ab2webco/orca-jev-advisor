# Board: one time window for every tab, modules on the board, cards that read right

## Objective
Make the Advisor board answer "what happened in the last 24 h / 7 days / this
version / ever" the same way on every tab, show the modules the owner has turned
on (memory, ci-watch, verify-done), and fix the cards that read wrong today.

## Problem
Owner, 2026-10-14, on the live 0.10.1 board: the window chips (version / 24 h /
7 days / all) sit inside Gate only, and "todo lo que se ha agregado los panels
no mejoran". A read-only audit rendered the owner's real `storage.json` (es-ES,
dark, 4 tabs at 1440 and 390; report and shots in the session scratchpad,
`board-audit/`) and found, worst first:

1. Gate defaults to "this version". Right after a release that is minutes of
   data (38 decisions vs 2,132 in 24 h), so the main screen looks empty.
2. Memory (Active, Engram: 252 decisions, 38 Engram saves), ci-watch (56
   watches, 36 polls replaced) and verify-done are never rendered by
   `board.html`, although the worker already stores `measurementsSummary.memory`
   and `.ciWatch`.
3. Consumo, model router: savings and applied/measured are 24 h with no label,
   next to a line labelled 7 days; Actividad shows 7-day router savings per
   project. The tabs disagree with no explanation. "no aplicadas" reads as a
   failure; it means measured only.
4. Consumo, token usage: 24 h, or 7 days when 24 h is empty, never says which;
   shares only, no totals; tiny models (1 step) are noise.
5. Gate calibration says "hasta ahora" while it follows the chip.
6. Gate shows two Jev latencies (window p50 vs all-time A/B of 20) unlabelled.
7. Consumo, context steward: four prose lines mixing 24 h and 7 days; the main
   steward and pre-cold read as contradicting each other.
8. Header "108 agentes" counts every stored entry, including stale ones.
9. Actividad, per project: unlabelled headline number, no units, no total,
   sorted by recency, raw slugs, a text wall of per-model costs.
10. Recomendaciones in destructive red for advice; informational lines that ask
    for no action.
11. Skills: "Acierto 0%" on 5 of 1000 samples; an all-time count next to a
    7-day line, unlabelled.
12. es-ES: verdicts ("allow") and live states ("working") untranslated; decimals
    mix dot and comma; four-digit numbers ungrouped.
13. At 390 px, 18 `.hrow .hl` labels are cut by ellipsis.
14. Actividad live rows at 390 wrap unevenly, duplicate a project, faint pills.
15. Gate interventions footnote counts "avisadas" with no matching column.

## Scope (authorized: "Claro arregla todo lo que este mal o se pueda mejorar",
"y mejora ese panel")
- `src/core/`: one shared window definition, and the summarizers it feeds,
  parameterized by `sinceMs`.
- `adapters/orca/read-measurements.mjs`, `read-consumption.mjs`,
  `read-activity.mjs`, `main.mjs` as far as the windows reach.
- `adapters/orca/panels/board.html` and its tests, `scripts/panels*.spec.mjs`,
  `scripts/screenshot-panels.mjs` fixtures.
- `odd/tasks/board-tabs-and-names.md`: note that its T2 placement (chips in
  Gate) is superseded by this file.

Out of scope: the settings panel, the gate decision logic, the router and
memory decision logic, any new measurement.

## Design
- Windows: `day` (24 h, rolling), `week` (7 days, rolling), `version` (since
  the first gate decision stamped with the running plugin version, from the
  same gate-log fold), `all`. One core function returns
  `{ key, sinceMs, available }` for all four, and every reader uses it, so
  "24 h" means the same instant on every tab. Activity moves from 7 local
  calendar days to the rolling window.
- Retention: each source keeps what it keeps (usage, router, steward hourly
  files are pruned at 8 days; check memory, ci-watch, typing, skills). Each
  summary per window carries `coverageSinceMs`, the earliest instant its data
  can honestly speak for. When a chip asks for more than a source keeps, the
  card heading says what it shows instead ("7 días, lo que se guarda"). A chip
  never silently does nothing on a card.
- Default chip: 24 h. The chip is remembered per viewer in `localStorage`,
  every access in `try/catch`; the board renders correctly without it.
- Point-in-time cards (live states, quota, waiting queue, last 10 decisions,
  A/B benchmark) say they ignore the chip, in the heading.
- Storage: store per window only the figures the cards show. Measure the real
  `storage.json` size before and after; report both.

## Tasks
- [x] W1 Shared windows: core window function, summarizers take `sinceMs`,
  readers emit per-window summaries with `coverageSinceMs`, activity on the
  rolling window. Invariant test: for one fixture and one window, per-project
  router savings sum to the Consumo router total. Retention table in this
  file. RED, GREEN, one commit.
  Proof: `src/core/board_windows.test.ts` (9, RED on the missing module
  first); `model_router_summary.test.ts` "W1: per-project router savings sum
  to the router total when two projects share one account" (RED on the
  missing `routerByProject`, two projects interleaved on one account plus a
  row with no project); `activity_by_project.test.ts` rewritten (12, rolling
  windows); `consumption.test.ts` "summarizeTurnUsageForWindow";
  `read-consumption.test.mjs` (26), `read-activity.test.mjs` (9, including
  the reader-level invariant against read-consumption.mjs),
  `read-measurements.test.mjs` (43), `gate-log-fold.test.mjs` (11),
  `scripts/fixture_shape.test.mjs` (11, two new: the windowed consumption and
  activity fixtures against the real readers), `panel_values.test.mjs` (51).
  Notes: the summarizers keep their `windowMs` parameter; readers pass
  `windowSpanMs(window)`, clamped to what the log keeps (log-files.mjs
  `perBoardWindow`), so a row about to be pruned is never counted in a window
  that says it does not reach it. Two items moved here from later tasks
  because the new data shape forced them: the default window is now 24 h on
  every card (W2's default), and Actividad renders the new per-project rows
  (W6's #9: labelled cost, totals, ranked by cost, no per-model text wall).
  Storage after W1, readers run on a copy of the real cache, substituted into
  a copy of the real `storage.json` (2-space JSON, as Orca writes it):
  351,974 -> 300,756 bytes (Actividad 119,721 -> 62,642).

### Retention (read from code, 2026-10-14; earliest file on the owner's disk in brackets)
| Source | Kept by code | Earliest on disk | What a window can speak for |
|---|---|---|---|
| `turn-usage-*` (usage, Actividad steps/cost) | 8 days, deleted by read-consumption.mjs | 10-06T06 | `all` and an older `version`: the last 8 days, said in the heading |
| `model-router-decisions-*` | 8 days, same | 10-06T06 | same |
| `context-steward-decisions-*` | 8 days, same | 10-06T06 | same |
| `typing-*` | 8 days, same | 10-13T00 (module new) | same |
| `gate-decisions-*` | files folded into `gate-decisions-totals.json` after 8 days, totals kept forever | 10-05T15 | Gate: every window whole (totals); Actividad per project: 8 days |
| `gate-approvals.jsonl` | never pruned | single file | whole |
| `mod-skills-measurements*` | never pruned | 09-29T21 | whole |
| `memory-decisions-*` | never pruned | 10-13T00 (module new) | whole |
| `ci-watch-decisions-*` | never pruned | 10-13T01 (module new) | whole |
| `verify-done-decisions-*` | never pruned | 10-12T05 (module new) | whole |
| `ab-benchmark-results.jsonl` | never pruned | single file | point-in-time card, ignores the chip |

The never-pruned logs grow without bound; once the module cards follow the
chip (W3), `all` reads them whole on every 15 s measurement refresh (today
~186 KB for memory, 21 MB for mod-skills, which is already read whole).
Retention is out of scope here; worth a follow-up.
- [ ] W2 Global chips above the tabs, default 24 h, every card follows the
  chip or says why not, window named in every card heading, remembered chip.
  Panels spec flips the T2 placement test. RED, GREEN, one commit.
- [ ] W3 Modules on the board: memory (mode, backend, decisions, Engram saves,
  files written, agreement, pending judge), ci-watch (watches, gh calls, polls
  replaced), verify-done (mode and its key numbers), each with its Off /
  Shadow / Active state, following the chip. Numbers match
  `measurementsSummary.memory` / `.ciWatch`. RED, GREEN, one commit.
- [ ] W4 Meaning fixes: audit #5, #6, #7, #8, #10, #11, plus #3's "measured
  only" wording and #4's totals and small-model threshold. RED, GREEN, one
  commit.
- [ ] W5 es-ES and narrow screens: `Intl` number and currency formatting in the
  board's locale, translated verdicts and live states (#12); labels above
  bars below about 480 px (#13). RED, GREEN, one commit.
- [ ] W6 Actividad and interventions: #9, #14, #15. RED, GREEN, one commit.
- [ ] W7 Evidence: re-run the audit render against the owner's real
  `storage.json`, 4 tabs at 1440 and 390, dark (8 images), and read each.

## Acceptance
- Every card heading names the window it shows.
- Switching the chip changes every card, or the card's label says why not.
- Gate is not near-empty by default.
- Memory, ci-watch and verify-done are on the board with their real numbers.
- No horizontal scroll at 390 and 320; no clipped labels at 390.
- Both catalogs (`es`, `en`) carry every new string.

## Checks
- `npm test`, `npm run typecheck`, the panels spec.
- The audit render on real data, 8 images read.
- Live, after release: the installed board on the owner's Mac, chips switch
  every tab, recorded in `odd/qa/qa-0.11.0.md`.
