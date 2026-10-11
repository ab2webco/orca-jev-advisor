# QA 0.7.1: installable again, and the live check of 0.7.0 and 0.6.29

Run on 2026-10-11 against the marketplace install (`plugins/plugins.lock.json` at `v0.7.1`, commit `e2db216`), not the dev copy.

## Why

The owner could not update: Orca showed "Could not prepare this plugin for review". Orca refuses a plugin tree over 50 MiB (`src/main/plugins/plugin-content-hash.ts`, `MAX_PLUGIN_TOTAL_BYTES`); committed QA screenshots had made 0.6.29 54.6 MiB and 0.7.0 69.7 MiB. 0.7.1 moves them to the `qa-evidence` branch. The live scenarios of 0.7.0 (10 to 16 of `qa-0.7.0.md`) and of 0.6.29 (11 and 12 of `qa-0.6.29.md`) were run on this install.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3762/3762 |
| Orca's own tree inspection (`inspectPluginInstallTree`, bundled from orca-oss) | v0.7.0: `plugin exceeds the 52428800-byte limit`; v0.7.1: `ok`, version 0.7.1 |
| Live scenarios | 1 to 8 PASS |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | The size guard fails on the old tree | `scripts/install-size.test.mjs` before the move | RED over the 40 MiB budget | RED: `tracked tree is 69.7 MiB, budget 40 MiB`, largest `odd/qa/screens-0.7.0` 14.9 MiB; GREEN at 6.8 MiB | PASS |
| 2 | Orca accepts the release | the real `inspectPluginInstallTree` on a `--depth 1` clone of each tag | 0.7.0 refused, 0.7.1 accepted | `plugin exceeds the 52428800-byte limit`, then `{"ok":true,"version":"0.7.1"}` | PASS |
| 3 | Live: marketplace install at 0.7.1 (owner updated) | `plugins.lock.json`, `current`, hooks in the 5 settings files, mod markers | Everything names the same 0.7.1 root | Lock `0.7.1`, ref `v0.7.1`, resolved `e2db216`; `current` = `b8d0dff51b81`, `package.json` 0.7.1; 8 hook entries in each of the 5 settings files point at `b8d0dff51b81`; the 2 mod markers (the other 3 accounts link to the home copy) name that root | PASS |
| 4 | Live: simple turn on Haiku 5.5 (0.6.29) | a headless `claude -p` turn, router decision row | `claude-haiku-5-5`, no `fallbackReason` | `point: start`, `tier: simple`, `current: claude-sonnet-5-5`, `proposed: claude-haiku-5-5`, `applied: true`, `guard: null`, Claude Code 2.1.296 | PASS |
| 5 | Live: `engine-version.json` (0.6.29) | `~/.cache/orca-supervisor/engine-version.json` | `2.1.296` | `{"version":"2.1.296","base":"2.1.296"}` | PASS |
| 6 | Live: Gate Off from the real Orca panel | Settings, General, Modules, Gate Off; the owner clicked | The gate's 5 entries gone from every settings file, the 3 Agent hooks intact, file written | `feature-modules.json` has `gate: off`; each of the 5 files has 3 hooks of ours (the Agent ones) and its foreign hooks unchanged (33, 23, 26, 23, 21) | PASS |
| 7 | Live: a new Claude session follows it with no reload | a Bash command from a new `claude -p` | No `gate-decisions` row | The hour's file stayed at 15 rows before and after the `ls` the new session ran | PASS |
| 8 | Live: Gate back on | Gate Active; then `git --version && npm --version` from a new session | The 8 entries back, foreign hooks unchanged, the command logged | 8 hooks of ours in each file, the same foreign counts; row `commandFamily: git`, `verdict: allow`, `source: jev` at 17:27:55Z | PASS |

Scenario 7 alone is weak: `ls` may not be a command the gate logs. Scenario 8 closes that, because a logged command from a new session shows the hooks work once back on.

## Background processes (0.7.0 scenario 16)

`npm run measure-module-cost -- --since 2026-10-11T18:28:00Z --until 2026-10-11T19:29:00Z`, one hour with no panel open. Two earlier hours (15:15 and 16:10) are not used: the panel was open for part of them (the measurements summary ran 54 and 205 times, against 0 here).

| Task | Node sidecars an hour |
|---|---|
| model measurements | 234.3 |
| account quota mirror | 6 |
| measurements summary, gate authorizations, router status, consumption, activity summary | 0 |
| **Total** | **about 240** |

Before 0.7.0 the same count was about 733 an hour (T0). The board's CLI cache refreshes (45.3 an hour, from 317 agent status events) are `orca` calls, not node sidecars.

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 9 | Live: background processes with no panel | About 240 sidecars an hour (was about 730) | 240.3 an hour | PASS |

## Not covered

- A session opened before the update keeps its old mod copy until it restarts (qa-0.6.23 N-23); the new sessions used here picked up the new copy.
- Per-module Off for the router, steward, skills and board from the real panel was not clicked; Gate was the module exercised live. The others are covered by the worker and scheduler tests (`qa-0.7.0.md`, scenarios 3 to 8).
