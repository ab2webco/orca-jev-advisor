# Release 0.6.16: effort that fits the work, subagents first

## Objective
Send the effort the work needs instead of the tier's or the parent's
default, where the data says it pays: at subagent spawn (one decision per
run, its own cache, no switch cost). The main session is only measured, and
one probe settles whether a mid-turn effort change keeps the cache. Close
the two effort gaps found in the research. Source and numbers:
odd/research/phase-effort.md (and effort-per-task.md for the per-effort
cost ratios).
Authorized by the owner 2026-09-30 ("que se lance el modelo y esfuerzo
correcto según la tarea"; "sigue con la guardia de privacidad y demás
tareas que están en prioridad").
Plane: JEVADV-89.

## Scope
- T1 Fixes regardless of phase (research §6 C).
  - Router decision rows (`model-router-decisions-*.jsonl`) carry
    `sessionId`, `turnId` and, for a subagent, `agentId`, so a decision can
    be joined to its steps without a time window (§2: 215 of 504 decisions
    could not be matched).
  - `low` is never sent on work that may edit. Today `TIER_EFFORT.simple =
    "low"` and half of the edit turns were rated simple (§2). Unless a
    person set `low` for the tier themselves (Models tab, 0.6.2 E3), the
    router's own `low` becomes `medium` on a main-session turn, and on a
    subagent unless T2's work kind is `read` or `execute`. Low on
    interactive editing has never been measured, so it is not sent until it is.
- T2 Work kind at subagent spawn (§6 A). The spawn already asks Jev for a
  tier (`routeSubagent` → `askTierJudgment`). That judgment also returns a
  work kind, `execute | read | review | implement | design`, with its own
  confidence. The keyword rules from the research are the fallback when Jev
  does not answer, and are logged next to Jev's kind as a cross-check.
  - Effort for `execute` and `read` runs: Sonnet 5 is capped at `high` (never
    `xhigh`); Opus 5.5 and Sonnet 5.5 get `medium` (their Claude Code
    default). The effort is set at spawn and never changed mid-run.
  - `review`, `implement`, `design`: unchanged (reviews think the most per
    step, §5).
  - Guards, all of them: never below an agent definition's declared effort
    (T3); never touching a person's `max` or numeric effort; not when the
    sensitive-topic or failure guards fire; kind confidence ≥
    `CONFIDENCE_FLOOR`; a client destination keeps the session effort.
  - Its own switch, `off | measure | active`, default `measure`, shown and
    changeable in the Models tab next to the router mode (fully connected:
    UI, stored option, applied). In `measure` each subagent row logs the
    kind, its source (jev/keywords), and the effort it would have sent.
  - Accept on real spawns, not on made-up descriptions: label the Agent
    spawns in the transcripts of 2026-09-22..30 (the §5 set, 434 runs) by
    what each run did (edit share, EXEC share). Run the classifier offline
    on each spawn's description and prompt. Publish the precision of
    `execute|read` (share of flagged runs that edited). It must beat the
    keyword stand-in (0.57 precision at 80% recall of read-only runs), and
    flagged runs that edited must stay ≤ 20%. Otherwise T2 ships
    measure-only and says so.
- T3 An agent definition's declared effort is respected.
  `readAgentDefinitionModel` reads only `model`, and an unguarded tier
  effort overrides the step effort both ways in `subagentStepEffort`. Read
  the definition's `effort` frontmatter too. When it is declared, the router
  may raise the effort but never lower it (T2's cap included), and the band's
  source reads `frontmatter` (0.6.15 T4c).
- T4 Main session: measure only (§6 B). Each `turn-usage` step row gains:
  - the previous step's phase label and the current EXEC run length;
  - the effort the would-be hold rule sends: lower only after 5 consecutive
    EXEC steps with no tool error, no failed test and no edit in the last 2,
    from `high`/`xhigh` only; raise on an error, a failure, an edit, a
    delegation, a subagent result, and at turn end; never on Sonnet 5, or on
    Sonnet 5.5 with `between_tools`;
  - whether `perTurnEffort` was present;
  - the uncached share of the next step after any effort change (already
    partly logged by 0.6.15 T4c; extend, do not duplicate).

  No effort sent changes.
- T5 Cache probe. A throwaway session on Opus 5.5 in `SCR` (the scratch
  repos in /Volumes/Data/jev-live-check), driven through the hook, forces
  about 30 mid-turn effort changes. Record the uncached share of the step
  after each change against same-effort control pairs. The result goes in
  odd/research/phase-effort.md as a dated addendum: the miss rate with its
  95% bound, and whether the hook's effort rewrite takes the per-message
  path. Budget: small context (≥ 20k so a miss is visible), one session,
  its cost reported. This decides whether a later release may act in the
  main session (go only at ≤ 2% misses); 0.6.16 itself does not act there.
- T6 README (latest "What changed"), CHANGELOG, QA in
  `odd/qa/qa-0.6.16.md`, release, live check.

## Checklist
- [x] T1 decision rows joinable; no router `low` on work that may edit. RED: model_router_decide.test.ts 49/53 (TIER_EFFORT simple medium, a held simple judgment on Opus sends medium by default and the person's `low` when set, the record's new keys, ids carried through); model_router_mode.test.ts 15/20 (defaults with simple medium, a person's simple `low` stored); hooks.test.ts 112/115 (main row and step carry `sessionId`/`turnId`, step `index`; subagent row carries `agentId` and its own `turnId`; simple work held on Opus at session `low` goes out at medium). GREEN: 53/53, 20/20, 115/115, npm test 2843/2843. How a person's tier effort is told apart from the default: only overrides that differ from TIER_EFFORT are stored (`routerEffort` in the router options), and the Models tab always sends all four tiers, so with simple's default at `low` a person's own simple `low` could never be stored or told apart. Decision: TIER_EFFORT.simple is now `medium`; no default is `low` any more, so every `low` in the per-tier map is the person's own, stored by the existing write and sent as set (standard/complex/frontier `low` were already stored). The Models tab shows simple at Medium by default. Router decision rows now carry `sessionId`, `turnId` and `agentId` (subagent rows: the subagent's own turn id and agent id, written at its first step); every turn-usage row carries `sessionId`, `turnId`, `index` and `agentId` (null on main). The subagent `read`/`execute` exception to the medium floor is T2's (it needs the work kind).
- [x] T2 work kind at spawn, capped effort for execute/read, switch in the Models tab. RED: work_kind.test.ts 0/1 (module missing; 10 tests); model_router_mode.test.ts 0/1 (workKindModeFromSettings, planWorkKindWrite, routerEffortPersonTiers missing; 23 tests); install-claude-integration.test.mjs 68/70 (`workKind` in router-mode-status, `work-kind-set`); main.test.mjs 139/140 (a `workKind` request runs work-kind-set); panels.spec.mjs 0/2 (the switch per account, measure by default, its save sending only `workKind`; the Spanish text); hooks.test.ts 117/123 (active cap on Sonnet 5 with one call carrying both questions; measure logs the would-send effort; off asks only the tier; keyword fallback logged and never acting; review, sensitive topic and client site hold; the simple tier's own `low` on read work unless the person set simple). GREEN: 10/10, 23/23, 70/70, 140/140, the panel tests, 123/123, model_router_decide.test.ts 54/54, npm test 2875/2875. What ships: the spawn's existing Jev call (`askTierAndKind`, which `askTierJudgment` now wraps) adds a `kind` choice (execute, read, review, implement, design; "a task that asks to change, write, fix, create or commit anything is implement"), asked only while the switch is not off. `kindStepEffort` (src/core/work_kind.ts): on a confident (>= CONFIDENCE_FLOOR) execute or read kind, Sonnet 5 is capped at high and Opus 5.5 / Sonnet 5.5 at medium (a cap: it never raises), then the declared effort (T3) is a floor; it holds on a pointer prompt, a sensitive topic, a client-site destination, a person's `max` or numeric budget (the step's or the definition's), a step with no effort and any other model. The keyword categories (the research's, first match wins) are the fallback kind when Jev gives none and are logged next to Jev's kind; a keyword kind has no confidence, so it never acts. The effort is computed from the step the run would send, so it is the same on every step (set at spawn, never changed mid-run). Decision rows of `point: "subagent"` carry `workKind: {mode, kind, confidence, source, keywords, effort, hold, applied}` (null when off). Switch: `workKindMode` in the router options (default `measure`), read by router-mode-status, written by `work-kind-set`, shown in each account's Models tab row "Work kind (subagents)" / "Tipo de trabajo (subagentes)" with a hint, applied in the hook whether the router is in measure or active (router `off` asks Jev nothing, so there is no kind either). T1's exception lives here: the simple tier's own `low` is sent only with the switch active on a confident read/execute kind and when the person did not store a simple effort (`routerEffortPersonTiers`). Decisions: the cap is a ceiling for Opus 5.5 / Sonnet 5.5 too (a `low` the step already carries stays); fixed-model subagents (an Agent call's `model`, a definition's) are included, since the research's execute/read spend is mostly explicit `sonnet` spawns and the definition's declared effort guards intent; the failure guard has nothing to read at spawn (the router's own subagent decision passes no previous-turn activity), so it is not an input.
  Offline evaluation (live Jev, the same call and state the hook sends: buildTierState on description + prompt, tier + kind questions, destination unknown). Corpus: every Agent/Task spawn of 2026-09-22..30 in the Orca account stores and `~/.claude/projects` (`find -L` equivalent walk, de-duplicated by real path and message id), joined to its subagent transcript: 439 runs, labelled by what they did (252 edited; 125 read-only = at least 90% execute steps and no edit). The corpus holds prompt text and stays in the scratchpad. 300 live Jev calls, 0 errors: a seeded 100-run development sample (question written once before it, not changed after) and a disjoint 200-run held-out sample. Held-out, execute|read at confidence >= 0.7: 44 flagged, precision (flagged runs that were read-only) 0.66 (95% CI 0.51-0.78), recall of read-only runs 0.53, flagged runs that edited 3/44 = 7% (95% CI 2-18%). The keyword stand-in on the same 200: 62 flagged, precision 0.53, recall 0.60, 29% edited (the research's own figure on its 434-run set: 0.57 at 80% recall, 30% edited). All 300: 76 flagged, precision 0.63, recall 0.56, edited 6/76 = 8% (95% CI 4-16%). Verdict: precision beats the stand-in and the edited share stays under 20% (its upper bound included), so T2 ships active-capable, default measure. Caveat: Jev flags fewer runs (recall 0.53 against the keywords' 0.60 here, 0.80 in the research), so the saving is a smaller share of the research's $80-200 estimate; the 3 flagged runs that edited wrote a report or a few lines inside long read or run tasks. Looked at: the Models tab router section (`#model-router-section`, the router-ready fixture: three accounts, one with the switch active, one row with no `workKind` showing measure) at 1440, 768, 390 and 320, light and dark, English, plus Spanish at 390 light and 1440 dark: 10 images in odd/qa/shots-0.6.16/, every one opened; no overflow and no script errors reported; at 390 and 320 "Save work kind" wraps under the buttons as the steward's save does; at 768 the section renders the same as at 1440 (the panel's own max width). Follow-up in its own commit: the full panel suite (`npm run test:panels`, not part of `npm test`) then failed 3/168 (three older router-row tests whose statuses carry no `workKind` counted the new row's buttons); the row is now drawn only when the status carries `workKind` (the installer always sends it), the two T2 panel tests give it explicitly, and the shot fixture's third account too; the retaken shots are byte-identical to the ones looked at. Panel suite after it 168/168, npm test 2885/2885.
- [x] T3 an agent definition's declared effort is a floor. RED: model_router_subagent.test.ts 25/27 (the declared level as a floor, guarded or not, a raise still passing; a declared `max` or numeric budget leaves the step as it is); subagent_band.test.ts 12/13 (`alto (definición)` / `high (definition)`); subagent_status.test.ts 13/15 (the `frontmatter` source, and a stored one reading back); agent_definition.test.ts 0/1 (declaredEffort missing); hooks.test.ts 116/117 (a definition declaring `high` with the tier asking `medium` kept `high`, stored source `frontmatter`, decision row effort `high`; the raise case passed already). GREEN: 27/27, 13/13, 15/15, 5/5, 117/117, npm test 2852/2852. Fix: the spawn reads the definition once (`readAgentDefinition`, same lookup as before: the project's `.claude/agents`, then the account's) for both its model and its `effort`; `subagentStepEffort` takes the declared effort as a floor (a declared `max` or number: the step is not touched); the band's source is `frontmatter` whenever what is sent is the declared level. T2's cap goes through the same floor.
- [x] T4 main-session phase and would-be effort logged, nothing sent changes. RED: step_phase.test.ts 0/1 (module missing; then 0/1 again for toolFailed); hooks.test.ts 123/126 (the phase fields and the hold rule on seven read steps, a failed test and a new turn raising it back, `prevEffort`/`promptTokens` on the first step after an effort change). GREEN: step_phase.test.ts 7/7, hooks.test.ts 126/126, npm test 2885/2885. Each main turn-usage row now also carries `phase` (the research's labels: EDIT, DELEGATE, VERIFY, RUN, WAIT, READ, ANSWER, TEXT, OTHER, OTHER taking the previous step's side), `prevPhase` (null on a turn's first step), `execRun` (the EXEC steps just before it in the turn) and `holdEffort` (what the would-be rule sends: medium after 5 EXEC steps with no failed tool or test among them, from high/xhigh only; any other step, a failure and a new turn put it back; never on Sonnet 5 or Sonnet 5.5, since a hook cannot see whether Sonnet 5.5 runs `between_tools` thinking, so it is excluded whole). A failed main-loop tool (an error, a refusal, or a test command whose output reports a failure) is read in `tool.call` and marks its step. The first step after an effort change, which 0.6.15 already gives `effortChanged` and `uncachedShare`, now also carries `prevEffort` and `promptTokens`; no field is duplicated. The effort sent is untouched (asserted on every step of the test). Not done, on purpose: `perTurnEffort` is not in `TurnStepInput`, `TurnStepResult` or `$.session.messages()` (claude-code.d.ts), only in the transcript file, which the hook would have to re-read whole each step (over 4 MiB it cannot); the row's `sessionId`, `turnId`, `index` (T1) and exact usage join it to the transcript offline instead, which is what T5 does.
- [x] T5 cache probe run, addendum published (odd/research/phase-effort.md, "Addendum 2026-09-30"). No code change, so no RED/GREEN: a measurement. One headless Claude Code 2.1.286 session on Opus 5.5 on the second account (CLAUDE_CONFIG_DIR as instructed), in a throwaway repository under /Volumes/Data/jev-live-check, user settings not loaded (`--setting-sources project`: the debug log shows only the probe plugin loaded, so the installed dev copy was not run and not touched). The branch's own plugin was not run for it: the probe is a throwaway `--plugin-dir` plugin kept outside the repository (nothing to remove before commit) whose `turn.step` does the router's own rewrite, `next({ ...e, effort })`, on a fixed high/medium plan every two steps. 65 steps at 35-36k context: 0/32 switches missed (uncached share max 0.99%), 0/32 same-effort controls missed; every transcript step's `effort` equals what the hook sent and `perTurnEffort` equals `effort`, so the rewrite takes the per-message path. Miss rate 0/32, 95% upper bound 10.9% (exact); not enough switches to show the ≤2% go bar (about 150 needed). Cost $0.98 (probe $0.72, 7-step smoke run $0.26). The probe session's transcript stays in that account's projects store under the throwaway directory's name.
- [ ] T6 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD per task: RED observed, then GREEN, `npm test` green.
- T2's offline evaluation is published with its size and numbers, and the
  switch ships `active`-capable but defaults to `measure`.
- No change to the effort sent in the main session (T4 rows only).
- Models tab with the new switch photographed at 1440/768/390/320, dark and
  light, at least one Spanish. Every image opened.
- Privacy test exit code 0; nothing private in the evaluation files. The
  labelled corpus stays out of the repository, only aggregates go in.

## Checks
`npm test`; `node --test scripts/private-data.test.mjs` (exit code);
`npm run shots` for the Models tab; the offline T2 evaluation script's
output; the T5 probe's rows.
