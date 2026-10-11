# QA 0.7.0: feature modules

Run on 2026-10-11 against `feat/feature-modules`, merged with `main` at 0.6.29.

## Why

The owner, 2026-10-10: "Me gustaria tener un plugin base que se encargue de la configuracion y autenticacion de proveedores y los demas sean addons o plugins que se complementen y que pueda instalar lo que necesite o activar y desactvar", and "cual me recomiendas para mejorar el performance y que Orca no se ponga lento y ademas que sea algo que pueda ir agregando o quitando facilmente". Plan and evidence: `odd/tasks/feature-modules.md`.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` (merged tree) | 3761/3761 |
| `npm run test:panels` (merged tree, before the integration-text change) | 220/220 |
| Shots `odd/qa/screens-0.7.0/` on the `qa-evidence` branch | 30 images, retaken after the merge; harness: no horizontal overflow, no script errors |
| Live marketplace install | Pending |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Registry defaults equal today's behaviour | `feature_modules.test.ts` (T1, 2cb6fbc) | All active; per-field fallback; each hook has one owner | RED (module missing), GREEN 23/23 | PASS |
| 2 | The agent cannot write the module file | unit, `gate-files` and `gate-bash` subprocess tests (T2, dcb3eb0) | Edit, Write, heredoc, `sed -i`, `cp`, `mv`, `rm` refused | RED 3, GREEN 3 | PASS |
| 3 | Installer follows the modules | `install-claude-integration.test.mjs` (T3, 9a0e2df) | Gate off removes exactly its hooks, foreign hooks intact, on restores, idempotent, corrupt file = defaults | RED 8 of 11, GREEN 107/107 | PASS |
| 4 | Off mod feature makes no Jev call | `hooks.test.ts`, `steward.test.ts` (T4, c0ff4a4) | 0 fetches, 0 writes, shadow = measure | RED 11 of 13 and 4 of 4, GREEN | PASS |
| 5 | Off module runs no worker job | scheduler and `main.activate.test.mjs` with real sidecars (T4, d745c75) | 0 jobs, 0 timers, 0 handlers when all off; shared job runs while an owner is on | RED 2 of 2 against 0.6.28, GREEN | PASS |
| 6 | Classic Agent hook follows the router module | `agent-model-hook.test.ts`, `agent-model.test.mjs` (d90c9fe) | Off records nothing, shadow only measures | RED 2 + 1, GREEN | PASS |
| 7 | Display-only refreshes stop with no panel | `module-scheduler.test.mjs` (T4b, 75e51e0) | 1 run per hour with no panel (was 241) | RED 14 of 27, GREEN | PASS |
| 8 | Panel saves through the worker | sidecar `feature-modules-save`, `main.test.mjs`, `panels.spec.mjs` (T5, 6f1e90b, 9d26d90) | Validated, atomic write, installer run, scheduler applied, result shown; `skipped` under a newer install | RED 8 of 12, 8 of 175, 11 of 12; GREEN | PASS |
| 9 | Modules section looks right | read: `ready` General light 1440 and dark 320; `modules-mixed` General light 1440 and dark 320, Models dark 1440; `modules-skipped` General dark 768 | Readable, no overflow, states and install lines match the fixture | As expected; Haiku 5.5 still rank 4 on Models after the merge | PASS |
| 10 | Live: marketplace install at 0.7.0 | `plugins/plugins.lock.json`, `current`, hooks in the 5 settings files, mod markers | Everything names the same 0.7.0 root | Pending the owner's update | PENDING |
| 11 | Live: simple turn on Haiku 5.5 (from 0.6.29) | router decision rows, Claude Code 2.1.296 | `claude-haiku-5-5`, no `fallbackReason` | Pending on 10 | PENDING |
| 12 | Live: `engine-version.json` (from 0.6.29) | cache directory | `2.1.296` | Pending on 10 | PENDING |
| 13 | Live: Gate off from the real Orca panel | Settings → General → Modules → Gate Off | Gate's 5 entries gone from every settings file, the 3 Agent hooks intact, `feature-modules.json` written | Pending on 10 | PENDING |
| 14 | Live: a new Claude session follows it with no reload | a Bash command in a new session | No `gate-decisions` row | Pending on 13 | PENDING |
| 15 | Live: Gate back on | Modules → Gate Active | Entries back; next Bash command logged | Pending on 13 | PENDING |
| 16 | Live: background processes | `npm run measure-module-cost` over an hour, Orca plugin audit log | About 240 sidecars an hour with no panel open (was about 730) | Pending on 10 | PENDING |
