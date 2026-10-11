# QA 0.8.0: verify the "done" (module M1)

Run on 2026-10-11 against `feat/verify-done-module`, from `main` at 0.7.1.

## Why

The failure Rule 7 exists for: "it said it was done and it was not". This release measures it in shadow, on the turns that edited files and have no passing test to show for it, so that a week of data decides whether a blocking state is worth building. Plan and design decisions: `odd/tasks/verify-done-module.md`.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3799/3799 |
| `npm run test:panels` (output to a file) | 222/222 |
| `npm run measure-module-cost` (last 7 days, before release) | 130 of 1,252 person turns are candidates: about 0.1 Jev calls per prompt; 0 verify-done rows (the module is not live yet) |
| Shots of the Modules section, 1440/768/390/320, light and dark | 24 on the `qa-evidence` branch under `odd/qa/screens-0.8.0/` (3 scenarios, 8 each); harness: no horizontal overflow, no script errors |
| Live marketplace install | Pending |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Pure rules: candidate, state, question, decision, record, file name, summary | `src/core/verify_done.test.ts` (V1, 93bf4a0) | Candidate only with edits and no passing test; a secret never reaches the state, redacted before the cut; malformed answer is a failure; floor 0.7 inclusive; hourly file name | RED: module missing (`ERR_MODULE_NOT_FOUND`); GREEN 21/21 | PASS |
| 2 | Registry: verify-done offers off and shadow, defaults to shadow; the five earlier modules still default to active | `src/core/feature_modules.test.ts` (V2, cde36d5) | `verify-done: "shadow"` with no file; `active` refused for it; every hook still has one owner | RED 6 of 30 (entry missing); GREEN 30/30 | PASS |
| 3 | Every consumer of the registry agrees | installer, `main`, scheduler, secret-mirror and `fixture_shape` tests (V2, cde36d5) | Installer status reports `verify-done` shadow with no hooks; save and read round-trip six modules | RED 12 failures in the full suite (five-module maps); GREEN, full suite 3784/3784 | PASS |
| 4 | Mod: off makes no Jev call and writes no row | `hooks.test.ts` V3 tests (V3, 4f5e5b1) | 0 fetches, 0 rows; a timer scheduled before the switch asks nothing | GREEN (a negative test, passing before the wiring too) | PASS |
| 5 | Mod: shadow asks once on a candidate turn and never on any other | `hooks.test.ts` V3 tests (V3, 4f5e5b1) | Candidate: exactly 1 call and 1 row; no edit or passing tests: 0 calls; subagent turn, aborted, error or refusal: nothing; `next(e)`'s result unchanged in every branch | RED 4 of 8 (`0 !== 1` Jev calls); GREEN 8/8 | PASS |
| 6 | Mod: a Jev failure is logged, never guessed, and the turn ends as it would have | `hooks.test.ts` (V3, 4f5e5b1) | One `jev-failed` row, claim and confidence null | RED with scenario 5; GREEN | PASS |
| 7 | What is sent to Jev | `hooks.test.ts` and `verify_done.test.ts` | The message redacted then cut, plus counts; no secret, file contents or paths of the turn's tools | GREEN | PASS |
| 8 | Measurement: verify-done row, would-block count, candidates from transcripts | `src/core/module_cost.test.ts` (V5, 89cd322) | Calls, failures, per prompt, latency p50/p90 from rows; would-block and claims in the window; candidate turns by the module's own rule | RED: `finishTranscriptTally` not exported, and 2 of 21 record tests (no `latencyMs`); GREEN 17/17, 21/21, 8/8 | PASS |
| 9 | Measurement on this machine | `npm run measure-module-cost` | A verify-done row and line | 130 of 1,252 person turns are candidates (0.1 per prompt); 0 rows | PASS |
| 10 | The real panel's six-module map is accepted by the real writer | `write-secret-mirror.feature-modules.test.mjs`, `panels.spec.mjs` (V4, 5d76a82) | The panel offers a card per registered module with the registry's states; every map it builds is saved by the real `feature-modules-save` sidecar | RED 2 of 15: the real sidecar refused the panel's map (`verify-done needs one of: off, shadow.`); GREEN 15/15 | PASS |
| 11 | The Verify done card | `panels.spec.mjs` Modules tests in `ready`, `modules-mixed` (verify-done off) and `modules-skipped` (V4, 5d76a82) | Off and Shadow only, Shadow pressed by default; what it measures, that it blocks nothing, what it sends Jev, 0.1 Jev calls per prompt, in English and Spanish | RED 5 of 13 Modules tests (no card); GREEN 13/13 | PASS |
| 12 | One version everywhere | `scripts/release-docs.test.mjs` (V6) | package.json, orca-plugin.json, newest CHANGELOG entry and newest README section all 0.8.0 | RED 1 of 2 after the bump (CHANGELOG `0.7.1`, expected `0.8.0`); GREEN 2/2 | PASS |
| 13 | Shots of the Modules section | `npm run shots` scenarios `ready`, `modules-mixed`, `modules-skipped`, 1440/768/390/320, light and dark | Card readable, no overflow | 24 images on `qa-evidence`. Read: `ready` General light 1440 and dark 320, `modules-mixed` General dark 768, `modules-skipped` General light 390. The Verify done card shows Off and Shadow only; Shadow selected in `ready` and `modules-skipped`, Off in `modules-mixed`; text wraps, no overflow. The other 20 were not read | PASS |
| 14 | Live: marketplace install at 0.8.0 | `plugins/plugins.lock.json`, `current`, mod markers | Everything names the same 0.8.0 root | Pending the release | PENDING |
| 15 | Live: the Verify done card in the real Orca panel | Settings → General → Modules | Six cards; Verify done in Shadow with Off and Shadow only | Pending on 14 | PENDING |
| 16 | Live: a candidate turn writes one row | a new Claude session: edit a file, run no test, end the turn | One row in `verify-done-decisions-<hour>.jsonl`, one Jev call | Pending on 14 | PENDING |
| 17 | Live: a verified turn writes none | edit a file, run a passing test, end the turn | No new row | Pending on 14 | PENDING |
| 18 | Live: Off writes none | Modules → Verify done → Off, then a candidate turn | `feature-modules.json` has `"verify-done": "off"`; no new row, no Jev call | Pending on 14 | PENDING |
