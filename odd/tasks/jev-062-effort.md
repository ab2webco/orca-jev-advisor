# Jev Advisor 0.6.2: effort by need

## Objective
The router sets effort by what the work needs, not by the account's sticky
`xhigh`, and the person can see and change the effort each tier asks for.

## Problem
Verified on the owner's machine (2026-09-27): the account sets
`modelSettings["claude-opus-5-5"].effortLevel = "xhigh"`, and all 97 main
steps since 0.6.1 ran on Opus at xhigh:
- `src/core/model_router_stage.ts` upgrade back to the session's own model
  used `configuredEffort ?? targetEffort`, so it returned to xhigh;
- a same-rank (`same`) decision never recalculated effort.

## Constraints
- A `turn.step` effort-only rewrite rewrites the prompt cache: lowering must
  earn it (hysteresis + break-even on real output medians).
- A person's `max` or numeric effort is never lowered.
- Strict TDD (source: user CLAUDE.md "Strict TDD Mode: enabled"; runner
  `node --test --experimental-strip-types`, Playwright for panels).
- No push. RDD disabled by the owner (memory: no-gentle-ai-reviews).

## Tasks
- [x] E1 tier-driven upgrade uses the tier's effort (route: inline, 1 core file + test)
- [x] E2 effort recalculated on every person prompt within the same model (route: inline; core + hooks)
- [x] E3 per-tier effort configurable in router settings (route: inline; core + installer + main bridge)
- [x] E4 config panel Models tab: effort table, one source line, intro copy, legacy checkbox (route: inline)
- [x] E5 bump 0.6.2 + README

Route note: the brief asks for mechanical work inline and no fan-out; each task
is one coherent unit touching a known set of files already read.

- [x] E6 `pointer-prompt` guard (brief-062-pointer.md; route: inline, core + hooks tests)
- [x] E7 router rows: account email, fresh status on open/cadence, stale-save refusal (brief-062-panel-accounts.md; route: inline)
- [x] E8 status line: one `jev`, each part applied/measuring (brief-062-band.md; route: inline)

## Acceptance
`npm test`, `npm run test:panels`, `npm run shots`, hooks `tsc`, and
`adapters/orca/mod_skills_validate.test.mjs` pass; screenshots of the Models
tab at 1440 light and 390 dark read.

## Progress
- E1/E2 (+ E3 core read): RED 11 stage tests, 2 status tests, 2 start tests,
  3 mode tests + effort module missing, 5 hooks tests. GREEN: `npm test`
  2091/2091; hooks `tsc` exit 0. One pin changed on purpose: frontier on an
  account without Fable now starts at xhigh (the tier collapses for the
  model, the effort follows Jev's own tier), as the brief's "complex →
  frontier on Opus" raise requires.
- E3: RED 3 installer tests (status effort/tiers, router-effort-set write,
  rejection) and 1 main bridge test. GREEN: installer 47/47, main 100/100,
  `npm test` 2095/2095. `router-mode-status` rows now carry `effort` and
  `tiers`; `router-effort-set <target> <json>` uses the same
  re-read-before-rename writer as the mode.
- E4: RED 5 panel tests (effort table, effort save, one source line, intro
  copy, legacy label). GREEN 7/7 incl. the Models-tab touching/overflow
  check at 1440 and 390. Legacy checkbox relabelled, not removed: removing
  it would leave a stored `active: true` with no way to turn it off, and the
  classic hook already yields where the router is active
  (`adapters/claude/agent-model.ts:96`).
- E6: RED at core (missing export; then guard order). Hook tests written
  after the core was GREEN, so they passed on first run. Live check on the
  client-i vault (cccccccc) with this branch's copy loaded via `--plugin-dir`
  and the shared skills-dir copy disabled for that run only: Jev `simple`
  0.71, decision `held-by-guard`/`pointer-prompt`, `modelUsage` only
  `claude-opus-5-5`.
- E7: RED 2 worker tests, 3 panel tests; GREEN.
- E8: RED 2 core files (missing module/export) and 3 hooks tests. GREEN:
  `npm test` 2115/2115, validate 1/1, hooks `tsc` exit 0. Terminal text only:
  the rendered strings in the tests are the evidence; a live status line in a
  real session was not looked at.

## Pre-release fixes (brief-062-fixes.md, review 062-review.md)
- [x] F0 a guard never blocks an effort raise (points A, B, C) — `02303c2`
- [x] Review 1 effort floor under a guard; 2 subagent guard logged, effort
  never falls; 3 router-chosen max lowers normally; nit 8 no effort sent
  can be raised — `02303c2`
- [x] Review 4 pointer phrasings — `bb29715`
- [x] Review 5 second save; nit 6 on-open refresh and id-less status; nit 7
  explicit empty routerEffort — `467ff43`
- [x] Nit 10 person's switch in the status line; nit 11 one shared account
  list — `036c2dd`
- [ ] Nit 9 (not fixed, by design of E2): the effort medians compare output
  across whatever work each effort ran; lower efforts mostly ran easier
  prompts, so the saving is overstated and lowering is favoured. A later
  refinement: medians per (tier, effort), or a paired comparison.
- [x] F9 previous-failure and sensitive-topic become facts in Jev's state
- [x] F10 README probe wording (with F9) and `cd` as a probe
- [x] F11 client-site and scoped policies leave the router's guards (gate untouched)
