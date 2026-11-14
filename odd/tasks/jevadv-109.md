# JEVADV-109: hold long sessions under 200k re-read per step

Baseline (2026-10-15..22, 740 sessions): main-agent steps above 200k were 45%
of steps and 66% of the re-read (4.96 B of 7.48 B); 49% of the steward's
checks waited on a "mid-task" verdict.

## Done in this repo

- [x] T1 Settled tier (`src/core/context_steward.ts`). At or above
  `SETTLED_LIMIT_TOKENS` (200k), a turn that ended at a settled boundary
  compacts at turn end whatever Jev says (`decision: "settled-limit"`,
  tier `settled-200k`). It follows the steward's own mode (measure logs it,
  active compacts) and its threshold and cooldown. The compaction keeps the
  step in progress (`settledInstructions`).
- [x] T2 Boundary rule (`settledBoundary`, pure, unit-tested). Since the
  person's last prompt: every tool call has its result (`pending-tool`), none
  went to the background (`background-task`), the last edit landed
  (`edit-failed`) and no test run after it failed (`tests-failing`). Any hold
  keeps the session as it is. Each row at or above 200k logs `settledHold`
  (null when settled).
- [x] T3 Board: Consumption → "Main-agent steps re-reading over 200k, per
  day" (`longStepsByDay`, last 8 local days, cache read > 200k) and the 7-day
  re-read above 200k, the upper bound of the saving.

## Not in this repo

- Lead rotation (hand a lead over to a fresh session past a threshold) lives
  in orca-oss's orca-game lead; asked separately.
- Live check in a lead pane and a game member pane: the steward reads usage
  and messages and calls `$.session.compact` as before; nothing new is read
  from or written to a pane.
