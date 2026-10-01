# Release 0.6.19: the QA 0.6.5 backlog, closed

## Objective
Close what the independent QA of 0.6.5 (2026-09-28) left open in JEVADV-70, 72, 73 and 74. Each finding was re-verified on main fbba819 (0.6.18) on 2026-10-01. Findings already fixed or not defects are closed with their evidence in Plane: M1 (0.6.11 pseudonyms), M10 (0.6.13 exact refspec), M11 (documented design), private-data packaged skip (0.6.17), policies read twice, UTC sampling day, negative savedEstimate, the reload() catch and the worker-request delete order. This release fixes everything that is still open.
Authorized by the owner 2026-10-01 ("dale, sigue con esas").
Plane: JEVADV-70, 72, 73, 74 (and 58, their parent).

## Scope
- T1 JEVADV-70, the gate hook:
  - **M2.** `passThroughWithNotice` must not emit `permissionDecision: 'allow'` on the no-key, unreachable and auth-rejected paths. It emits the notice only, so Claude Code's own permission flow decides, as its comment already says. Update the two tests that pin `allow`.
  - **M3.** The gate's top-level `await main()` gets a catch that exits 0, as agent-model.ts does. `gate-outcome.ts` and every other hook entry point get the same check: fails open, never a stack trace.
  - **M4.** Every `execFileSync('git', …)` in the gate goes through one helper with a timeout (about 1.5 s) and a kill signal. A timeout means "unknown", never a crash.
  - **M9.** `decideAction`'s doc says it fails open, matching the code.
  - **M12.** `resolveCommandTargetDirs` resolves redirections without a space (`>../x`, `>>../x`, `1>../x`, `2>>file`), as the spaced form does.
  - **M11.** One README sentence states the advice-retry design: the same session, the same exact command, within 10 minutes, and a visible line when the retry runs.
- T2 JEVADV-72, the panels:
  - **M13.** An empty or zero `logMaxEntries` can no longer wipe the decision history:
    - the input is `required`;
    - `readConfig` keeps only an integer ≥ 1;
    - `isPluginConfig` rejects values below 1;
    - `recordDecision` clamps.
  - **M14.** Hostile-input coverage for every `esc()` sink on the board and every catalog, policy and destination name shown in the config panel. Use strings with `<`, `>`, `"`, `'` and `&`. `config.html`'s `innerHTML = t('integration.hint')` either becomes text-only or is proven to take only catalog text.
  - **Sync tests.** The hand-copied ES5 functions in board.html and config.html get tests that run the same cases as their `.mjs` originals (the pattern of board_html_models.test.mjs).
  - **Small UI fixes:**
    - `querySelector('a')` in the models source line uses an `id`;
    - dynamic `<label>`s get `for` and the controls get ids;
    - `<html lang>`: check how Orca's panel shell sets it, and add a default `lang` if nothing does.
- T3 JEVADV-73, data hygiene:
  - **M8.** `$.clock.now()` in the mod-skills `skill.prompt` handler is inside the try. The handler always reaches `next(e)`.
  - **M15.** The hourly gate-decision files are pruned at 8 days, like the turn-usage, router and steward files, and every reader is checked. `model-reclassifications.jsonl` rotates hourly, and its readers read the rotated files plus the legacy one. The A/B results file is capped or rotated.
  - **M16.** An owner-raised `ready` survives the boot mirror. Design it so that a legitimate loss of readiness is still visible, for example an explicit owner override the mirror never lowers, shown on the panel. Record the decision. This is the 5th recurrence: the field report counts it as P9.
- T4 JEVADV-74, the cleanup:
  - **Dead code and the broken script:** delete `src/core/catalog.ts` and `src/core/policies.ts` (with their tests and tsconfig entries, after checking nothing uses their types), and remove the `self-check` npm script.
  - **Small fixes:**
    - `passThrough(): never`;
    - the `ModPathEnv` doc matches the code (XDG only for a Linux home);
    - `secrets.ts` resolves its paths lazily;
    - the A/B CLI appends results before it rewrites the queue.
  - **Installer:**
    - hook entries are owned by an explicit id field, not by `statusMessage`, and old entries are still recognised;
    - `discoverTargets()` takes only directories that hold a Claude config;
    - the install state is written before the first settings write, or per target, so a kill at the 8 s timeout leaves something to restore from.
  - **Duplicates.** Measure the overlap of `skill_decisions.ts` and `tool_decisions.ts`. If it is substantial, extract the shared core with no behaviour change. If it is not, record the numbers and leave them.
- T5 README (latest "What changed"), CHANGELOG, QA in `odd/qa/qa-0.6.19.md`, release, live check.

## Checklist
- [ ] T1 gate hook robustness (M2, M3, M4, M9, M12, M11 doc)
- [ ] T2 panels (M13, M14, ES5 sync tests, UI fixes)
- [ ] T3 data hygiene (M8, M15, M16)
- [ ] T4 cleanup (dead code, self-check, nits, installer ownership/targets/state, duplicates)
- [ ] T5 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for every behaviour change: RED observed, then GREEN.
- `npm run typecheck` exits 0 and `npm test` is green.
- `npm run test:panels` is green (panels change; it takes about 17 minutes).
- The gate replay sets of 0.6.13–0.6.18 keep every refusal.
- Panel changes are photographed at 1440/768/390/320, dark and light, at least one in Spanish. Every image is opened.
- Privacy test exit code 0.

## Checks
`npm run typecheck`; `npm test`; `npm run test:panels`; `node --test scripts/private-data.test.mjs` (exit code); the replay scripts in the session scratchpad (0618/).
