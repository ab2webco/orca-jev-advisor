# QA 0.6.16: effort that fits the work, subagents first

Run 2026-09-30 against the 0.6.16 release branch (rebased on main at
7b288af), scratch repositories under `/Volumes/Data/jev-live-check/`
(`SCR`). The writer's per-task proof, with the RED and GREEN counts, is in
odd/tasks/release-0.6.16.md; the lead re-ran the suites below independently
and read the core diff (model_router_decide, model_router_subagent,
agent_definition, work_kind, the spawn path of the mod hook).

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm test` (lead) | 1 | 1 (2896/2896) | 0 | privacy test exit code 0 |
| `npm run test:panels` (lead) | 1 | 1 (168/168) | 0 | |
| T2 work kind, held-out real spawns (writer) | 200 runs | see below | | live Jev, 300 calls in all, 0 errors |
| T5 cache probe (writer) | 32 switches + 32 controls | 0 misses | | 95% bound 10.9%; $0.98 |
| Screenshots, Models tab work-kind row | 10 images | looked at | | 1440/768/390/320, both themes, two in Spanish |

## T2: work kind at spawn, offline evaluation

439 Agent/Task spawns of 2026-09-22..30 from the transcripts, labelled by
what each run did (252 edited; 125 read-only). The question was written
before looking at the data and tuned on a seeded 100-run sample; the
numbers are from 200 other runs, used for nothing else:

| | Flagged execute/read | Precision | Recall | Flagged runs that edited |
|---|---|---|---|---|
| Jev (confidence ≥ 0.7) | 44 | 0.66 (CI 0.51–0.78) | 0.53 | 3/44 = 7% (CI 2–18%) |
| Keywords, same 200 | 62 | 0.53 | 0.60 | 29% |

It beats the keyword stand-in and stays under 20% flagged-that-edited even
at the upper bound, so the switch ships active-capable, default measure.
Jev flags fewer runs than the research's keyword stand-in did (recall 0.53
against its 0.80), so the saving in active mode will be a smaller share of
the $80–200 per 9 days estimated there; the two precisions were compared at
different recalls. The corpus holds prompt text and stays out of the
repository.

## Observations

- **N-15 low.** At 390 px light, the Max button of the Analyse row carries a
  darker outline than its neighbours (a focus ring left by the capture
  script, not a selected state; the selected one is filled).
- **N-16 low.** At 768 and 1440 the Models tab captures are identical byte
  for byte: the panel's content is capped at 760 px (`.wrap`) and the
  captures are clipped to it. Not a defect; the page around it is not shown.
- The hook cannot see Claude Code's `perTurnEffort` (only the transcript has
  it), so T4 rows carry `sessionId`, `turnId` and `index` to join them to
  the transcript instead.
- The would-be hold rule of T4 leaves Sonnet 5.5 out entirely, because the
  hook cannot see whether it runs with `between_tools` thinking.
- T1 changes what active mode sends on the main session: a turn rated
  simple on a model that takes effort now goes at medium, not low, unless
  the person set `low` for that tier.
- Quality at lower effort is still unmeasured; the switch starts in measure
  and its rows are the data for turning it on.

## Live check after the release

Released as v0.6.16 at a192df6 (#22, CI green in 22 min). The dev copy
`orca-jev-advisor-dev` was pulled to a192df6, and the five installed
`orca-jev-mod-skills` copies (the default config dir and four Orca accounts)
match it file by file (53 files each, none differ, `work_kind.ts` present).
A real Claude Code session (Sonnet 5.5, a second Orca account whose router
is in active mode, work-kind switch at its default, measure) was opened in
`SCR/feat-app` and told to launch two subagents in one message and report.
Results from the session transcript and the router and turn-usage rows,
joined by the session id (T1):

| # | Subagent | Router decision | Work kind (measure) | Effort |
|---|---|---|---|---|
| 1 | `Report recent commits` (git log and status, no edits) | simple, applied: Haiku 4.5 | `execute`, confidence 1, source jev; keywords none | none sent (Haiku takes no effort): hold `none-sent` |
| 2 | `Add a helper to math.js` (created one file) | standard, not changed | `implement`, confidence 1, source jev; keywords `implement` | medium, unchanged: hold `not-read-work` |

Both decision rows carry `sessionId`, `turnId` and `agentId`; the main
session's start row carries `sessionId` and `turnId`. The main steps log
`phase` (READ, DELEGATE, ANSWER), `execRun` and `holdEffort` (medium: the
would-be rule acts only from high/xhigh), with the effort sent unchanged
(medium, source `default`). Both subagents did their work (two commits
reported; `src/math.js` with `clamp` created, then removed by the lead).
graft, loaded by that session, wrote `.gitignore`/`.ignore` and a `graft/`
cache in the scratch repository; nothing else changed.

Not seen live: a cap that actually lowers an effort (an execute/read run on
Sonnet 5 at xhigh, or on Opus 5.5 at high, with the switch active). It is
covered by the hook tests; the measure rows are the data for turning it on.
