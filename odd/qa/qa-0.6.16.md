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
| `npm run test:panels` (lead) | 1 | pending | 0 | |
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

Pending: filled in after the release.
