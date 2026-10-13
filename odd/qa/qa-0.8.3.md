# QA 0.8.3: the router's cache state on Team and Enterprise accounts, Jev without credit

Run on 2026-10-13 against `fix/router-cache-ttl`, from `main` at 61efc64 (0.8.2 and its live QA). Plan: `odd/tasks/router-cache-ttl.md`.

## Why

- On the owner's Mac, 72 of 100 router stage rows of the day had `cacheWarm: null`, all on the two Team-organization accounts; a teammate on the same organization saw null in 29 of 29 rows across 14 sessions (Orca, terminal, cmux, SDK).
- Claude Code 2.1.296 seats the built-in `cc-plugin-sec-default` outermost for Team and Enterprise organizations; its description says it keeps the organization's classic hooks out of reach of the plugins a person installs. The TTL was read only in `on('classic.Stop')`.
- A partner's Fedora machine on 0.8.2: every Jev call since 2026-10-06T16:34Z answered HTTP 402, and the notice said "Jev unreachable".

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 4281/4281 (4270 with the router and Jev changes; 4281 with the CI band) |
| `npm run test:panels` | 239/239 |
| Shots | None: no panel text changed (the CI band is drawn in the terminal) |
| Live marketplace install | PASS (scenarios 9 and 10); 11 waits for the partner's update |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Reproduce: a Team account never learns the TTL | an interactive Haiku session on the Team account, three turns | `cacheWarm` null after a Stop | Stage rows null on turns 1 and 2; the same session shape on the personal-plan account (with the Team account's extra Stop hook added through `--settings`) gave true, so the hook was not the cause | REPRODUCED |
| 2 | The parser was not the cause | `readCacheTail` on the real tails of four null sessions | A TTL | 1h on all four | PASS |
| 3 | R5: the TTL from the router's own path | `cache_warmth.test.ts`, `hooks.test.ts` R5 | With `classic.Stop` never fired, the second stage row is warm or cold | RED: module functions missing; stage rows `[null, null]`. GREEN: `[true, false]` from the session's transcript path, `[true, true]` through `find` | PASS |
| 4 | R6: why the cache is unknown | `cache_warmth.test.ts`, `model_router_decide.test.ts`, `hooks.test.ts` R6 | `cacheUnknown` on every null row, absent when known | RED: no `cacheUnknownOf`, type rejected the field, rows `[undefined, undefined]`. GREEN 317/317 | PASS |
| 5 | R7: the cost of quality switches | `model_router_stage.test.ts`, `model_router_decide.test.ts`, `hooks.test.ts` R7 | Applied upgrade, floor-restore and effort-raise log `switchCost`; decisions identical warm, cold or unknown | RED: no `qualitySwitchCost`, `switchCost null`. GREEN 386/386; 80k context on Opus 5.5 logs $0.64, 0 when cold | PASS |
| 6 | G8: Jev 402 | `jev_call.test.ts`, `gate_unreachable_notice.test.ts`, i18n catalogs, `hooks.test.ts`, `steward.test.ts` G8 | The gate notice names a key without credit (es, en); router, steward and subagent rows `jev-payment` | RED per file; GREEN 358/358. The gate's notice is covered by pure functions and the catalog only: the gate cannot be pointed at a fake Jev end to end | PASS |
| 7 | One version everywhere | `scripts/release-docs.test.mjs` | 0.8.3 in package.json, orca-plugin.json, CHANGELOG, README | RED after the bump (`0.8.2` vs `0.8.3`); GREEN 2/2 after the notes | PASS |
| 8 | CI watcher band text | `ci_watch.test.ts`, `hooks.test.ts` ci-watch | Branch, sha, running workflows, elapsed and usual time; slower than usual; waiting stops after 4 min; passed/failed with duration; at most one extra `gh` call per watch inside the ceiling | RED: `ciIsSlow` not exported; 12 hook tests failed once the core changed. GREEN: ci_watch 55/55, hooks 238/238 (three new: the usual-time lookup shown once, left out on failure or under 3 runs, never asked with no run or the module off) | PASS |
| 9 | Live: marketplace install at 0.8.3 | lock, `current`, hooks | Same 0.8.3 root everywhere | `current` = `1ca8c1f2…` (version 0.8.3, provenance recorded); all 32 hook commands in the four Orca accounts and 8 in `~/.claude/settings.json` point at `1ca8c1f2` | PASS |
| 10 | Live: a Team-account session knows its cache | `model-router-decisions-*.jsonl` | Stage rows after the first turn with `cacheWarm` true or false, no null without `cacheUnknown` | the Team account, real work in Orca terminals. Before the update (22:15Z) session `b6066d4b` logged `cacheWarm: null`; after it, the same session logged `true` at 22:30:59Z and 22:31:13Z. A new session in another client project logged `false` on its first turn (22:30:33Z) and applied an upgrade with `switchCost: 0`, which is the cold-cache case the fix exists for. No null rows after the update. Headless `-p` writes only a `start` row (origin `sdk`), as designed | PASS |
| 11 | Live: the partner's Linux shows the no-credit notice | read-only look at the gate rows and notice there | 402 rows; the notice text names the key | Pending the partner's update | PENDING |

## Not covered

- The engine-started turn's `floor-restore` (`routeEngineTurn`) still logs no `switchCost`.
- verify-done still logs `jev-failed` on a 402.
- Windows: `tail` and `find` are not there, so the TTL stays unknown and the row says `tail-failed`.
