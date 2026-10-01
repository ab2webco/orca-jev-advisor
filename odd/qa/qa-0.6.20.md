# QA 0.6.20: agent-team teammates seen and routed

Run 2026-10-01 against the 0.6.20 release branch (the worktree's own `npm install`). The probe facts behind the change are T1 in odd/tasks/release-0.6.20.md. The writer's per-task proof, with RED and GREEN counts, is in the same file. The lead re-ran every check below independently.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm run typecheck` (lead) | 3 configs | exit 0 | | |
| `npm test` (lead) | 1 | 1 (3028/3028) | 0 | main had 3008; privacy test exit code 0 |
| `npm run test:panels` | 1 | CI | | no panel changed; CI runs it in `npm run check` |
| Gate replays | | not re-run | | no gate file changed in this release |
| Band screenshots (writer 16, lead opened 2) | 16 images | looked at | | 200/120/80/40 columns, en and es, dark and light; lead opened es 200 dark and en 40 light |

## Scenarios

| # | Scenario | Expected | Covered by |
|---|---|---|---|
| S1 | A teammate's first step, the lead's `Agent` call kept, router active | One Jev decision; model and effort applied to every later step; one row with `point: "teammate"`, `teammateTask: "matched"` | hooks tests |
| S2 | The same in measure mode | Nothing changed; band shows "would use" | hooks tests |
| S3 | A teammate whose task was not kept (reload) | No change; row `jev-failed`, `teammateTask: "missing"` | hooks tests |
| S4 | Router off | Nothing judged, nothing written | hooks tests |
| S5 | A teammate's step reaching the main-loop router | No main row; `routerSticky` untouched | hooks tests |
| S6 | An unnamed subagent | Routed at `agent.spawn` exactly as in 0.6.19 | 0.6.16 hooks tests, unchanged and green |
| S7 | Band: an agent no spawn recorded | Model from its answer (`usage.model`), effort from its step; reason teammate / started before the plugin loaded / not seen at launch | band and status tests, screenshots |
| S8 | A teammate's own `turn.complete` | Its row stays while the host lists it running | status tests |

## Known limits

- The board's decision summary counts `start`, `stage` and `subagent` rows only; teammate rows are skipped, not miscounted.
- For a teammate the router leaves on its model, the work-kind effort cap reads the lead's model, because the teammate's own model is only reported after its answer.
- Split-pane teammates (separate processes) are expected to be routed as a main session in their own process. Not verified.

## Live check after the release

Released as v0.6.20 at 027e0f5 (#30, CI green in 26 min). The dev copy `orca-jev-advisor-dev` was pulled to 027e0f5. The five installed `orca-jev-mod-skills` copies hold `src/core/teammate_route.ts` and match it, except for the test and tsconfig files that are not shipped. The five Claude Code settings files each hold 8 gate hook entries with no duplicate.

A real Claude Code session (Sonnet 5.5, the second Orca account, router mode active, work-kind switch on measure) ran in an Orca terminal with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `--teammate-mode in-process`. It was told to create one teammate named `reader` (list the files) and then one unnamed subagent (print the directory). Results from the shared decision log and the session's transcripts:

| # | Scenario | Expected | Result |
|---|---|---|---|
| L1 | Teammate `reader`, first step | A `teammate` row, task matched, judged like a subagent | Row `point: "teammate"`, agentId `areader-<hex>`, `teammateTask: "matched"`, tier simple (confidence 1), Sonnet 5.5 → Haiku 4.5, `applied: true`, work kind execute (measure) |
| L2 | Teammate's model on every step | The decided model | All 4 model fields in the teammate's transcript are `claude-haiku-4-5-20251001`; the lead's 9 stay `claude-sonnet-5-5` |
| L3 | Unnamed control subagent | Routed at spawn as in 0.6.19 | Row `point: "subagent"`, tier simple, Sonnet 5.5 → Haiku 4.5, applied; its 4 model fields are Haiku 4.5 |

## Observations

- **N-22.** A first attempt ran the same session in a private tmux server outside Orca. The plugin was listed as enabled, but it wrote no row of any kind: no teammate, no subagent, no measurement. The same session in an Orca terminal wrote every row. The mod depends on what an Orca terminal provides; launches outside Orca are not a supported way to check it. Not investigated further.
- The band was only seen in passing in the terminal tail while the teammate ran ("Haiku 4.5"), not captured cleanly; the band's layout is covered by the 16 screenshots above.
- Whether the effort sent with a teammate's step takes effect is still not observable: the transcript records no effort.
