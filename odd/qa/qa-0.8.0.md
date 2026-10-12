# QA 0.8.0: verify the "done" (module M1)

Run on 2026-10-11 against `feat/verify-done-module` (scenarios 1 to 13) and on 2026-10-12 against the marketplace install, 0.8.1 (scenarios 14 to 18).

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
| Live marketplace install | Scenarios 14, 16, 17, 18 PASS on the installed 0.8.1 (it contains 0.8.0); 15 pending the owner's look at the real panel |

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
| 14 | Live: marketplace install (0.8.1 contains 0.8.0) | `plugins.lock.json`, `current`, the 5 settings files, mod copy | Everything names the same root | Lock `0.8.1`, ref `v0.8.1`, resolved `df31c3b` (another session released 0.8.1 on 2026-10-12; the owner updated to it); `current` = `b3a13b883706`, `package.json` 0.8.1; 8 hook entries naming that root in each of the 5 settings files, no other root; the mod copy holds `verifyDoneAfterTurn`; `feature-modules.json` has no `verify-done` key, so the default `shadow` applies | PASS |
| 15 | Live: the Verify done card in the real Orca panel | Settings → General → Modules | Six cards; Verify done in Shadow with Off and Shadow only | The installed `config.html` holds both labels (`Verify done`, `Verificar «hecho»`). Not looked at in the real Orca window: that needs the owner | PENDING (owner) |
| 16 | Live: a candidate turn writes one row | new headless sessions: create a file, no test, say it is done | One row, one Jev call | 11 rows from real interactive sessions of the owner (5 projects, 3 accounts, from 05:09Z to 20:42Z): 7 `not-claimed`, 2 `would-block`, 1 `no-claim`, 1 `claimed-unverified-low-confidence`; latency 186 to 353 ms. My run (project `vd-live`): `claude -p` with a stream-json input held open for 25 s wrote exactly one row, `would-block`, `claimed-done`, confidence 1, `filesEdited: 1`, `testsRun: 0`, 207 ms. A plain `claude -p` wrote none: the process exits before the 250 ms timer fires | PASS |
| 17 | Live: a verified turn writes none | create `add.mjs` and its test, run `node --test`, it passes, end the turn | No new row | Rows 12 before and 12 after; the session reported 1 test, 1 pass | PASS |
| 18 | Live: Off writes none | `"verify-done": "off"` in `feature-modules.json`, then the same candidate turn as 16 | No new row, no Jev call | Rows 12 before and 12 after, the same prompt that wrote a row in shadow; the file was set by hand (the panel was not used) and restored to its five-module content afterwards | PASS |

## Notes from the live run

- The installed version is 0.8.1, not 0.8.0: another session released 0.8.1 (secret guard and cold-cache switches) before this check. It carries the 0.8.0 module unchanged.
- **Limit found:** a print-mode session (`claude -p`) that ends right after its answer never reaches the 250 ms timer, so it leaves no row. Interactive sessions and print sessions that stay open do. A print-mode turn is therefore undercounted, which suits a measure that must not overcount.
- Real use already shows the question works as designed: the two real `would-block` rows are `claimed-done` turns with 1 and 12 files edited and no test run; a low-confidence claim (0.4) and the unsure ones lean `not-claimed`, as specified.
- Scenario 15 stays open until the owner confirms the card in the real panel.
