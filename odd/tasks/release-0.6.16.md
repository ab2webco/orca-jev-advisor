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
- [ ] T2 work kind at spawn, capped effort for execute/read, switch in the Models tab
- [ ] T3 an agent definition's declared effort is a floor
- [ ] T4 main-session phase and would-be effort logged, nothing sent changes
- [ ] T5 cache probe run, addendum published
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
