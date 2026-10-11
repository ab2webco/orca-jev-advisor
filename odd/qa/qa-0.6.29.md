# QA 0.6.29: the simple tier routes to Haiku 5.5

Run on 2026-10-11 against `release/0.6.29-models` (PR #48, merged as `bd8aa6b`), released as `v0.6.29`.

## Why

The owner, 2026-10-11, after Claude Code's model picker listed new models: "Revisa e investiga los modelos ya argregaron nuevos modelos", then "Optimizalo y ajustalo para actualizacion en el plugin".

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3623/3623 |
| `npm run test:panels` | 208/208 |
| CI `check` on PR #48 | pass, 28m55s |
| Models tab shots, 1440/768/390/320, light and dark | 16 committed in `screens-0.6.29/` (`router-ready`, `baseline`) |
| Catalog pin | `orcalab-plugins` `orca-marketplace.json` names `v0.6.29` (Follow releases, run 38122592180) |
| Live marketplace install | Pending: Orca still runs 0.6.28 |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Full suite after docs and version | `npm run typecheck && npm test` | 0 errors, all pass | typecheck exit 0; 3623 pass, 0 fail | PASS |
| 2 | An untouched old default migrates to Haiku 5.5 | `model_seed_notice.test.ts`, `models-worker` test (2ac0459) | Simple tier on `claude-haiku-5-5`; edited Haiku 4.5 rows, an existing Haiku 5.5 row or another simple-tier model left alone | RED (module missing; worker test against a no-op), GREEN 14/14 and 27/27 | PASS |
| 3 | A long Haiku 5.5 prompt takes the over-100K card | `model_cost.test.ts`, `activity_by_project` (834a0d5) | 150K prompt on 0.50/2.50, 50K on 0.10/0.50, priced per request | RED, GREEN 9/9 and 11/11 | PASS |
| 4 | The docs check reads both Haiku 5.5 rows as one entry | `parseModelPricing` tests | One entry with `longPrompt`; a lone row yields nothing | RED 2, GREEN 14/14 | PASS |
| 5 | Haiku 5.5 effort default | `effort_source` test (92b1b21) | `medium`; Haiku 4.5 none | RED 1, GREEN 4/4 | PASS |
| 6 | An engine older than 2.1.293 never gets Haiku 5.5 | `engine_support`, `model_router_accounts`, `hooks.test.ts`, Agent hook tests (4283b80) | Tier falls back to Haiku 4.5 with `fallbackReason: "engine-too-old"`; unknown version reads as supported with `engineVersionUnknown` | RED (module missing, 5 hook, 3 Agent-hook), GREEN 7/7, 28/28, 154/154, 31/31 | PASS |
| 7 | The mod's version read passes the real validator | `mod_skills_validate.test.mjs` | Accepted | RED (`$` as a `WeakMap` key refused), GREEN after a per-load module variable | PASS |
| 8 | Panel shows Haiku 5.5 on the Ask tier with an effort control | `router-ready-config-light-1440-models.png`, `router-ready-config-dark-320-models.png`, read | Ask = Haiku 5.5 at Medium on every account; ladder rank 4 Haiku 5.5 | As expected; no horizontal overflow at 320 | PASS |
| 9 | Catalog follows the release | `gh workflow run follow-releases.yml -R ab2webco/orcalab-plugins` | Pin `v0.6.29` | Pin `v0.6.29` | PASS |
| 10 | Live: marketplace install at 0.6.29 | `plugins/plugins.lock.json`, `current`, hooks in the settings files, mod markers | Everything names the same 0.6.29 root | Pending: lock still `0.6.28` / ref `v0.6.28` at 07:49Z. The owner refreshes the catalog and updates the plugin in Orca | PENDING |
| 11 | Live: a simple turn routes to Haiku 5.5 | router decision rows after the update, Claude Code 2.1.296 here | `claude-haiku-5-5`, no `fallbackReason` | Pending on scenario 10 | PENDING |
| 12 | Live: `engine-version.json` written by the mod | cache directory after the update | `2.1.296` | Pending on scenario 10 | PENDING |

## Observed, not changed

- At 320 px the tier names in the per-account effort table break inside the word ("Impleme/nt", "Deep reasonin/g"). The layout does not overflow. 0.6.29 did not change this table's layout (the only panel source change is the shipped-labels block).
- The panel has no tier editor, so an account cannot pin Haiku 4.5 back to the simple tier from the panel; editing the stored row is the only way, and an edited row is never migrated.
