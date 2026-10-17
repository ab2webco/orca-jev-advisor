# QA 0.12.2: game mode (0.12.0, 0.12.1) and memory cost cuts (0.12.2)

Live check run on 2026-10-17 at about 02:35Z on the owner's Mac, against the marketplace install of v0.12.2 (`main` at a2262df). The installed tree is `24c41b06…`, installed at 02:31:56Z. Plans: `odd/tasks/game-mode-advisor-state.md` and PR #78.

## Why

In 0.12.0, Jev stopped drawing its status line and band in an Orca game pane and started publishing them as `advisor` state for orca-game to draw (ORCA-586 T5). In 0.12.1, a game pane with its HUD off counts as no game. In 0.12.2, Memory skips a fork whose saves would all be dropped, and makes no Haiku call for prompts a plugin submitted.

## Summary

| Check | Result |
|---|---|
| `npm test` (on PR #78) | 4377/4377 |
| CI on PRs #76, #77, #78 and on `main` (93a2c41, a2262df) | Pass |
| Live | 1-6 PASS; 7 PENDING (no qualifying turn yet); 8 NOT VERIFIED (the game is not released) |
| Finding | The mod had no TypeSafe key from 17:22Z to about 02:24Z; it was logged as `jev-failed` (see Findings) |

## Method

- **Install.** Read `current` and `orca-plugin.json` in the marketplace install. Hashed every mod copy's `hooks/index.ts` against `git show v0.12.2:…`. There are 5 copies: `~/.claude` and the 4 Orca accounts.
- **Validate.** Ran `claude plugin validate --json` (Claude Code 2.1.302) on the installed `~/.claude/skills/orca-jev-mod-skills`.
- **Game mode.** Ran a scratch harness that imports the *installed* `hooks/index.ts`. Its minimal host lists two running agents. For each env case the harness runs `session.start`, then the AbovePrompt band with a sentinel beneath. It records `$.ui.status` calls, whether the band returned the sentinel, and the `advisor` value.
- **Game side.** Bundled orca-oss `resources/claude-plugins/orca-game/hooks/allies.ts` with esbuild (branch `feat/orca-593-orchestrator-mode`). Fed it the `advisor` value the installed hook wrote, then ran `advisorOf` and `allyRowsOf`.
- **Memory.** Imported the installed `src/core/memory_decide.ts` and ran `freeChecks` on the latest real plugin prompt from this session's transcript, and on a person's prompt. Read `memory-decisions-*.jsonl` after the install.
- **Band picture.** `npm run shots:band` (16 shots). The repo hook is byte-identical to the installed one (same hash). Read `band-es-80-dark.png`.
- **Live pane.** `orca terminal read` on the orca-oss pane, which is not a game pane, after the update.

## Scenarios

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Install | v0.12.2 installed; every mod copy on it | `orca-plugin.json` is 0.12.2. All 5 copies hash `c23bdc24…`, which equals `v0.12.2:adapters/claude/mod-skills/hooks/index.ts`, and each has `ORCA_GAME_HUD` and `fork = 'main-saved'`. The installed `memory_decide.ts` has `plugin-prompt` | PASS |
| 2 | Contract | Installed copy validates and declares `advisor` | `success: true`, 0 hook errors, state list includes `orca-jev-mod-skills.advisor` | PASS |
| 3 | Game pane, `ORCA_GAME_MODE=on` and `zen` | No `$.ui.status`; band returns what is beneath; `advisor` written | `statusCalls: []`; band returned the sentinel; `advisor` v1, `es`, `line: "jev · agentes: 2"`, 2 subagents with verdict "antes de cargar" | PASS |
| 4 | Game pane with HUD off (`ORCA_GAME_HUD=0`), and no game | Line and band drawn as before; no `advisor` | Both: `statusCalls: ["jev · agentes: 2"]`, band is a `Box`, `advisor: null` | PASS |
| 5 | orca-game reads what Jev writes | `advisorOf` accepts the installed hook's real value and draws rows | Parsed with 2 subagents, 0 CI, 0 notices. Rows: `line: jev · agentes: 2`, `agent: ↳ Reading the spec · antes de cargar`, `agent: ↳ Find the band hook · antes de cargar`. A full value (model, effort, CI failure, warn notice) also gives 4 rows | PASS |
| 6 | Non-game band and line, live | Unchanged | `band-es-80-dark.png`: 10 rows, no overflow. The live orca-oss pane after the update shows "Agentes en curso: 3" with the rows and `jev · agentes: 3` | PASS |
| 7 | Memory: plugin prompt not judged; no fork when the main thread saved | `plugin-prompt` skip; `fork: main-saved` rows | The installed `freeChecks` on the real CI note returns `{pass:false, skip:"plugin-prompt"}`, and on a person's prompt `{pass:true}`. Since the install, only 1 memory row (orca-wa-inbox, no gate) and no plugin-prompt turn and no main-saved turn have happened | PENDING: next such turns |
| 8 | Jev drawn inside the game scene | The scene shows Jev's rows | orca-game is on an unreleased orca-oss branch; not looked at | NOT VERIFIED |

## Findings

1. **For about 9 hours the mod's Jev asks had no TypeSafe key.**
   - **Router.** `model-router-decisions-*.jsonl` shows 0-1 `jev-failed` per day from 2026-10-12 to 10-15. Then 136/359 on 10-16 and 30/42 on 10-17. From 18Z to 01Z almost every ask failed (for example 43/43 at 21Z). The first failures came at 17:22:47Z, 4 minutes after Orca installed 0.12.1 (17:18Z). Asks succeeded again from 02:24Z.
   - **Steward and gate.** The steward failed in the same window. The gate had no `source: "jev"` rows from 18:02Z to 00Z.
   - **Cause.** Another session found it (Engram #5455, 2026-10-16). The owner's `~/.config/orca-supervisor/env` was gone: the worker's secret mirror (`write-secret-mirror.mjs` `clear()`) removes the key when Orca's secret store has none, and deletes the file when nothing else is left. A plugin update re-runs the mirror, which fits the 17:18Z install. The file was rewritten at 02:31:57Z with the 0.12.2 install. The fix is in that session's work: clear is per name, with a pin test. The owner should save the key in Config → TypeSafe key, not in the plaintext file.
   - **Gap this check found.** With no key, the router writes `tier: null` and logs `jev-failed`. That is indistinguishable from a real Jev failure, which is why this read first as a Jev outage. Next step: log `no-key` apart, and record `jevFailureOf(error)` for real failures.
   - **0.12.x code.** Not involved: 0.12.0-0.12.2 do not touch the key or `callJev`.
2. **orca-game review** (sent to the orca-oss agent on 2026-10-17): Jev cannot follow `/quest off` or a live config change, because it reads the env once. The ask is for orca-game to publish its effective absorbing state. Details: `odd/tasks/game-mode-advisor-state.md` G6.

## Notes

- The harness is a scratch script and is not part of the repo. It imports the installed hook directly, so it tests the code users run.
