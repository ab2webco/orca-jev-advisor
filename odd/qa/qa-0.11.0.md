# QA 0.11.0: one time window for the whole board, modules on the board

Live check run on 2026-10-14 on the owner's Mac, against the marketplace install of v0.11.0 (`main` at e428a0f). Plan: `odd/tasks/board-global-window.md`.

## Why

The owner said that on the live 0.10.1 board the window chips sat inside Gate only, and that "everything added, yet the panels don't improve". A read-only audit of the real `storage.json` ranked 15 problems. Release 0.11.0 fixes them.

## Summary

| Check | Result |
|---|---|
| `npm test` | 4355/4355 |
| `npm run typecheck` | Clean |
| `npm run test:panels` | 267/267 |
| CI on PR #72 and on `main` (e428a0f) | Pass |
| Live | 1–7 PASS; 8 PENDING (needs the board opened) |

## Method

- **Install.** The installed board (`plugins/ab2web.orca-jev-advisor/<current>/adapters/orca/panels/board.html`) was rendered in headless Chromium against the live `storage.json` that the installed 0.11.0 worker wrote. The render used es-ES, dark, at widths 1440, 390 and 320. Keys holding secrets were not loaded.
- **Interaction.** For each width, each chip (24 h, 7 days, this version, all) was clicked and then each tab, recording:
  - the window label of every card;
  - the card's text;
  - horizontal overflow;
  - clipped `.hl` labels.
- **Screenshots.** Taken at the 24 h chip: the 4 tabs at 1440, and Gate and Consumo at 390. Each image was read.
- **Version window.** The installed `read-measurements.mjs` was run on a copy of the cache (`ORCA_SUPERVISOR_CACHE_DIR`). The real cache was not touched.

## Scenarios

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Install | v0.11.0 installed, with every hook on it | `current` is `ee4e74ae…`, `orca-plugin.json` is 0.11.0, and `~/.claude` plus all 4 accounts have 8 hooks each on `ee4e74ae` | PASS |
| 2 | Chips above the tabs, default 24 h | One chip row above the 4 tabs, 24 h pressed on load | Chip row above the tabs at all 3 widths; 24 h pressed on load | PASS |
| 3 | Every card follows the chip or says why not | Each windowed card changes across the 4 chips; each point-in-time card's heading says it does not follow | Windowed cards: text differs for all 4 chips (4/4) and the label names the window. Point-in-time cards keep one text and say why. Details below | PASS |
| 4 | No horizontal scroll, no clipped labels | No overflow and 0 clipped `.hl` at 1440, 390 and 320, under every chip and tab | 0 overflow and 0 clipped in all 48 combinations; 0 page errors | PASS |
| 5 | Modules show the stored numbers | Memory, CI watcher and verify-done cards equal the `measurementsSummary.modules.*.windows.day` figures | Equal. Details below | PASS |
| 6 | Tabs agree | Same window, same totals across tabs | 24 h: Gate 2,316 decisions = Actividad 2,316 commands judged. Actividad 4,627 steps = Consumo 4,627 steps. Router saving 0.11 US$ on both tabs | PASS |
| 7 | Version window follows the release | Version window starts at the first 0.11.0 gate decision | Installed reader on the cache copy: `version` = 0.11.0 since 14:21:46Z, 9 decisions. Gate log rows after the update are stamped 0.11.0 | PASS |
| 8 | Board shows "This version (0.11.0)" | Chip label switches once the board refreshes | Stored summaries are from 14:16:23Z, before the first 0.11.0 decision, so the chip still reads 0.10.1. Summaries refresh only while a panel is open (`boardPanelSeen`, last 05:04Z), by design | PENDING: owner opens the board |

**Scenario 3, per card.**
- Windowed cards: `card-toll`, `card-interventions`, `card-calibration`, `card-projects`, `card-consumption`, `card-memory`, `card-ciwatch`, `card-verifydone` and `card-skills`.
- Under "all", `card-projects` and `card-consumption` say "solo los últimos 8 días, lo que se guarda".
- Point-in-time cards:
  - `card-recent`: "las últimas 10, no siguen la ventana".
  - `card-speed`: "todas las comparaciones, no sigue la ventana".
  - `card-live`: "ahora, no sigue la ventana". Its text changed once during the run because live state moved, not because of the chip.

**Scenario 5, per module.**
- Memory: 182 turns evaluated, 4 saved to Engram, 7 files written, 38 main-thread saves, 9 pending conflicts, 77% agreement.
- CI watcher: 55 watches, 660 `gh` calls, 34 polls avoided, 25 finished, 1 failed.
- Verify-done: 25 turns reviewed, 6 "done" claims, 2 would-stop.

## Notes

- **Account quota error.** The Consumo quota row shows one account with "error". The cause is in Orca, not the plugin: `orca account list --json` gives that account `quota.status: error` with the message "Claude usage refresh is waiting for the live Claude terminal to rotate its credentials". The board shows "error" with no reason. Showing Orca's reason is a candidate follow-up.
- **Unpruned logs under "all".** Memory, CI watcher, verify-done and mod-skills logs are never pruned, so the "all" window reads them in full on each 15 s refresh. This is tracked in the task file.
