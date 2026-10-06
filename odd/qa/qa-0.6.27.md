# QA 0.6.27: the panel shows the verified compaction saving

Run on 2026-10-06 against `feat/verified-compaction-saving`.

## Why

The owner asked whether the plugin really saves Claude plan usage, and said: "esto que sea real me preocupa tu cambio y que sea invento". The steward's per-step figure on the board came from Claude Code's `tokensAfter`. That value leaves out the system prompt and tools reloaded after a compaction, and the board never added anything up.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3292/3292 |
| `npm run test:panels` (writer, after T3) | 194/194 |
| `node --test --test-name-pattern=steward scripts/panels.spec.mjs` (after the 24 h label) | 8/8 |
| Real-data run of `read-consumption.mjs` | reproduces the hand-verified figure, see below |
| Board shots (`router-ready`, Consumption tab) | 1440, 768, 390 and 320, light and dark; no horizontal scroll |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Context per step counts input, cache read and cache write, never output | `context_steward.test.ts`, rule 1 | RED without the function, GREEN after | RED: missing export, then 7 assertion failures against a `null` stub; GREEN 47/47 | PASS |
| 2 | Subagent rows never count | rule 1 test (subagent row in the same session) | Excluded | Excluded | PASS |
| 3 | Drop = last main step before minus first main step after; skip a missing side or a drop ≤ 0 | rules 3 and 4 tests | As specified | As specified | PASS |
| 4 | Steps stop at the next applied compaction in the session | rule 4 test | Counted up to the next one | Counted up to the next one | PASS |
| 5 | Main steps without a session id still count as context read | `91e1de2`; rule 1 assertion `mainContextTokens: 560_000` | RED, then GREEN | RED, then GREEN | PASS |
| 6 | Reader adds `steward.verified` over 7 days | `read-consumption.test.mjs` | A compaction 48 h old appears in `verified` | RED 2, then GREEN 19/19 | PASS |
| 7 | Board shows the verified line and hides the per-step estimate | panels spec, `withSteward` + `verified` | New line present, old one absent | RED, then GREEN | PASS |
| 8 | Board without a verified saving keeps the old line | panels spec, `verified: 0` | Old line present | Present (it guards today's behaviour, so it passed before the change) | PASS |
| 9 | The applied line names its window | panels spec asserts `Compactions applied (24 h): 2` | RED, then GREEN | RED 2/8, then GREEN 8/8 | PASS |
| 10 | Real data reproduces the hand-verified report | `node --experimental-strip-types adapters/orca/read-consumption.mjs` → `steward.verified` | About 32 verified and 1.38 B not re-read; 28% over the 8 retained days | `compactions 50, verified 32, steps 4941, tokensNotReread 1,383,188,100, mainContextTokens 2,948,220,274, share 0.319`. Over the 8-day denominator: 0.283 | PASS |
| 11 | Compactions without a session id come only from older code | Gate log `pluginVersion`, hour by hour | Only 0.6.10, or before 0.6.15 | 2026-10-03 13:14 to 2026-10-04 21:25: 0.6.10 hours. Before 2026-09-30 23:37: before 0.6.15 (which arrived around 21:00). None since. | PASS |
| 12 | Live: the marketplace install shows the verified line | Orca → Settings → Plugins → Check for update (owner, 2026-10-06), then Advisor → Consumo | Lock at 0.6.27; the board shows "Ahorro verificado (7 días)" | `plugins.lock.json` 0.6.27 (ref v0.6.27), `current` = `73de1279a271`; 8 hook entries in each of the 5 settings files point at `73de1279a271`; the 5 mod markers name that root, mod `plugin.json` 0.6.27. Board: "Compactaciones aplicadas (24 h): 11 · Ahorro verificado (7 días): 1,388,177,106 tokens que el agente principal no releyó, un 32% de su contexto. Medido sobre el uso real en 32 de 47 compactaciones." Evidence: `shots-0.6.27/live-consumption-steward.png` | PASS |

## Hand verification it reproduces

For each applied compaction with a session id: the main agent's context on the last step before it and on the first step after it, from `turn-usage`.
- The plugin's `contextBefore` matched usage exactly in 32 of 32 compactions.
- Its `contextAfter` was lower than usage by a median of 47 k tokens: the reloaded system prompt and tools.
- The real drop is a median 84% of what the plugin reported.

## Findings

1. The board formats Spanish numbers with commas (`1,388,177,106`), like every other figure on the panel. It is consistent, but not the Spanish convention. Out of scope here.
2. `package-lock.json` is out of sync on main, so `npm ci` fails. CI uses `npm install` and is not affected. Out of scope here.
