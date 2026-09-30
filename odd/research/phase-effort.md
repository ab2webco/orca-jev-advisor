# Work-phase effort: research for 0.6.16 (JEVADV-89, 2026-09-30)

Research only. Aggregates and redacted shapes; non-built-in agent types are
type-N; dollar figures are API-equivalent at list prices (re-checked at
https://platform.claude.com/docs/en/about-claude/pricing).

## Answer

A main session's work phase cannot be predicted from the previous steps
well enough to lower effort mid-turn: execute steps are 82% of all steps and
no rule on the previous steps beats 0.87–0.88 precision on the next one
(base rate 0.82), while every rule that lowers effort on long execute runs
also lowers it on 30–50% of the steps that matter (the final answer, the
edit, the delegation that end the run). At turn level phases do not last
(an execute-dominant turn is followed by another 29% of the time). The
saving per execute step is small (on Opus 5.5, output per execute step at
high ≈ medium; controlled for context, execute/mixed turns at high cost
×1.13 (0.96–1.30), not significant), and whether a switch misses the cache
depends on a behaviour nobody has verified (§4): at the measured
turn-boundary miss rate (4 of 14) every hold rule loses money.

Build it at subagent spawn first: one decision per run, own cache, no switch
cost. The data supports capping execute/read-type subagents at high, never
xhigh (≈ $80–200 per 9 days, 3–8% of subagent spend). For the main session,
0.6.16 only measures (step phase and what the policy would have done) plus
one probe that settles the cache behaviour of a mid-turn effort change.

## Data

Transcripts from every Orca account store and `~/.claude/projects`
(symlinks followed, de-duplicated by real path and message id): 1,568 files,
147.5k steps, 1,077 Agent spawns. Window: the Opus 5.5 period 09-22 → 09-30
(main session 18,822 steps, $3,066, Opus 5.5 $1,401; subagents 434 runs,
34,520 steps, $2,553). Router log 621 decisions (504 `stage`/`start`);
turn-usage 16,266 steps.

## 1. Phases

Each step labelled by the tools it calls, first match: EDIT (Edit, Write,
MultiEdit, NotebookEdit), DELEGATE (Agent/Task), VERIFY (Bash test, build,
lint, typecheck), RUN (other Bash, git writes, gh, MCP), WAIT (TaskOutput,
Monitor, SendMessage, sleep/poll), READ (Read, Grep, Glob, web, graft,
read-only shell, git status/log/diff), ANSWER (no tool, ends the turn). EXEC
= VERIFY + RUN + WAIT + READ.

| | Main | Subagents |
|---|---|---|
| EXEC share of steps / cost | 81.5% / 81% | 83.7% / 82% |
| EDIT, ANSWER/text, DELEGATE | 3.8%, 13.0%, 1.7% | 14.2%, 2.0%, 0.2% |
| Unit | 2,411 turns: median 4 steps (p90 17), 0.5 min (p90 6.6) | runs: median 47 steps (p90 197), 11 min (p90 62) |
| EXEC run length | median 3, mean 6.0, p90 13 | median 3, mean 7.8, p90 19 |
| EXEC steps in runs ≥3 / ≥5 / ≥10 | 90 / 79 / 56% | 92 / 85 / 72% |
| Phase changes per step (units ≥5 steps) | 0.23 | 0.19 |

Long EXEC stretches broken by one-step decision points (edit, answer,
delegate) — the steps where effort matters. Mean output per step on Opus 5.5
(thinking in brackets), medium/high/xhigh: READ 406 (171) / 411 (166) / 571
(309); RUN 590 / 606 / 724; WAIT 448 / 505 / 681; EDIT 1,834 / 2,024 / 1,958.
On EXEC steps high ≈ medium; only xhigh adds ~150 tokens (~$0.003). A mean
EXEC step costs ~$0.10–0.13, mostly re-reading cached context.

## 2. Today's router stage against the phases

Matched by time (≤120 s) and model: 206 unambiguous, 215 ambiguous, 83
unmatched (the router log has no session or turn id). Answer-only turns
(n=56): simple 82%. Exec-dominant (n=50): simple 48%, complex 38%, standard
14%. Edit (n=47): simple 51%, standard 30%, complex 19%. Delegating (n=19):
simple 53%, complex 37%. The stage measures difficulty, not phase; it is
chosen once per prompt. **Risk in active mode:** `TIER_EFFORT.simple =
"low"`, so half the edit turns (rated simple) would run at low effort, which
has never been measured on interactive work.

## 3. Signals before a step

The hook sees the previous steps' tools and errors (`$.session.messages()`),
the prompt, the stage, `e.index`, `e.effort` (`TurnStepInput`). Main session,
16,411 decision points; base rates next step EXEC 0.82, next 3 all EXEC 0.59,
next 5 all EXEC 0.46:

| Rule | Fires | P(next EXEC) | Recall | P(next 3 EXEC) | Lowered share of EDIT / ANSWER / DELEGATE |
|---|---|---|---|---|---|
| last step EXEC | 93% | 0.84 | 0.95 | 0.61 | 81 / 88 / 90% |
| last 3 EXEC | 66% | 0.87 | 0.69 | 0.67 | 49 / 50 / 51% |
| last 3 EXEC, no tool error | 56% | 0.86 | 0.59 | 0.67 | 40 / 45 / 46% |
| last 5 EXEC | 50% | 0.88 | 0.53 | 0.70 | 36 / 31 / 36% |
| last 3 read-only | 6% | 0.89 | 0.07 | 0.70 | 8 / 3 / 4% |
| last step an edit | 4% | 0.72 | 0.04 | 0.38 | 17 / 3 / 5% |

In subagents "last 5 EXEC" has 0.93 precision and still lowers 18% of edits
and 62% of final answers. No last-step state predicts a decision step; a
failed command is followed by more EXEC 94% of the time (diagnosis: an
argument against lowering after a failure). A Jev question was not measured
offline; as a stand-in at subagent spawn, keyword categories on the
description found 80% of read-only runs at 0.57 precision (30% of flagged
runs edited), so Jev must beat that.

## 4. Hold rules: savings against cache risk

Docs (https://platform.claude.com/docs/en/build-with-claude/effort): a
per-message effort change keeps the cache on Opus 5.5, Opus 5, Sonnet 5.5
and Fable 5.1 (beta `mid-conversation-output-config-2026-07-01`; "the new
level takes effect from the next user turn"); Sonnet 5 has none (a change
restarts the cache) and is the bulk of subagents; Sonnet 5.5 with
`thinking: between_tools` returns 400 on a per-message change. Transcripts:
every Opus 5.5 step carries `perTurnEffort` equal to `effort`. Switches
within 1 h at ≥20k context: turn boundaries 4 of 14 full misses; within a
turn 0 of 3; same-effort pairs ~1%. Whether a hook's `effort` rewrite takes
the per-message path is unverified.

Simulated (main, Opus 5.5, 9 days): lower after N consecutive EXEC steps,
only from high/xhigh; raise at the first non-EXEC step or turn end (two
switches per hold); a miss costs context × ($8 − $0.20)/MTok.

| N | Held cost at high/xhigh | Switches | Mean context | Saving at 3% / 11.5% / 23% | Switch cost at 29% / 1% / 0% miss | Decision steps at lowered effort |
|---|---|---|---|---|---|---|
| 3 | $393 | ~1,150 | ~390k | $12 / $45 / $90 | $1,016 / $35 / $0 | 589 answers, 230 edits, 92 delegations |
| 5 | $271 | ~730 | ~370k | $8 / $31 / $62 | $615 / $21 / $0 | 340, 181, 62 |
| 10 | $135 | ~330 | ~317k | $4 / $16 / $31 | $235 / $8 / $0 | 140, 84, 28 |

Main-session Opus 5.5 spend in the window: $1,401. Only if per-message
switches keep the cache (≤1% miss) and lower effort also means fewer steps
does any N win: at best $10–55 per 9 days (1–4%). At the measured boundary
miss rate every N loses $200–1,000.

## 5. Subagents

| Description category | Runs | Cost | Median steps | EXEC share | Edit share | Thinking/step | Main model, effort |
|---|---|---|---|---|---|---|---|
| implement / fix | 116 | $1,235 | 106 | 0.81 | 0.17 | 362 | Sonnet 5 high 73, xhigh 10 |
| other | 114 | $647 | 58 | 0.80 | 0.12 | 434 | Sonnet 5 high 58, xhigh 16 |
| run / verify tests | 55 | $182 | 42 | 0.86 | 0.06 | 318 | Sonnet 5 high 35 |
| read / explore / research | 87 | $177 | 21 | 0.86 | 0.04 | 372 | Sonnet 5 high 54, xhigh 13 |
| review / audit | 42 | $136 | 20 | 0.82 | 0.05 | 811 | Sonnet 5 high 30 |
| watch / wait for CI | 13 | $87 | 102 | 0.85 | 0.06 | 355 | Sonnet 5 high 6, xhigh 4 |

Explore is 94% EXEC with no edits ($48, 48 runs). Read-only runs (≥90%
EXEC, no edits) are 28% of runs but 8% of cost ($201). Execute/read-type
runs: 201, $585 (Sonnet 5 high $290, Sonnet 5 xhigh $192, Opus 5.5 high
$54); an xhigh parent passes xhigh to 29 of them. Reviews think the most per
step and should keep their effort.

## 6. Recommendation for 0.6.16

A. **Subagent effort at spawn** (active behind a switch, measure first): one
Jev question in `routeSubagent` on the description and prompt (`execute |
read | review | implement | design` with confidence; the keyword rules as
fallback and logged cross-check). Execute/read runs: Sonnet 5 capped at
high, never xhigh (top-level, set at spawn, never changed mid-run); Opus 5.5
and Sonnet 5.5 at medium (their Claude Code default). Review, implement,
design: unchanged. Guards: never below an agent definition's declared
`effort` (today `readAgentDefinitionModel` reads only the model, and an
unguarded tier overrides the step effort both ways in `subagentStepEffort`:
a gap to close); never below a person's `max` or numeric effort; not when the
sensitive-topic or failure guards fire; confidence ≥ `CONFIDENCE_FLOOR`;
client destinations keep the session effort. Expected: xhigh→high on
execute/read runs ≈ $192 × 41–68% ≈ $80–130 per 9 days, Sonnet 5
high→medium unmeasured (0–20% of $290): ≈ $80–200 per 9 days total.

B. **Main session: measure only.** Log per step the previous step's label and
the EXEC run length, the effort the policy would send (N=5, from high/xhigh
only), the effort sent and whether `perTurnEffort` was present, the uncached
share of the next step after any change, output/thinking tokens and tool
errors. Would-be rule: lower only after 5 consecutive EXEC steps with no tool
error or failed test and no edit in the last 2; raise on an error or
failure, an edit or delegation, a subagent result, and at turn end; never on
Sonnet 5 or Sonnet 5.5 with `between_tools`. Probe: ~30 forced mid-turn
switches on Opus 5.5 through the hook in a throwaway session (0/30 misses
puts the rate under ~10% at 95%). Go only if the probe shows ≤2% misses and
a randomised A/B (seeded per turn) shows ≥10% saving on held steps with no
rise in corrections.

C. **Fixes regardless of phase:** log `sessionId`, `turnId`, `agentId` on
router decisions; do not send `low` from `TIER_EFFORT.simple` on turns that
may edit (half the edit turns were rated simple; low is unmeasured).

Confidence: phase distributions and run lengths high; the subagent xhigh
saving moderate (rests on effort-per-task.md's ×2.31); the main-session case
hinges on the unverified per-message cache behaviour; quality effects
unmeasured throughout.

## Addendum 2026-09-30: cache probe of a mid-turn effort change (0.6.16 T5)

**Result: 0 of 32 mid-turn effort switches missed the cache (95% upper
bound 10.9%, exact two-sided; rule of three 9.4%), and the hook's effort
rewrite takes the per-message path.**

Set-up. One headless Claude Code 2.1.286 session (`claude -p`) on Opus 5.5,
on the owner's second Orca account, in a throwaway repository under
/Volumes/Data/jev-live-check (`SCR`). User settings were not loaded
(`--setting-sources project`), so no other plugin or hook ran; the debug log
shows only the probe plugin loaded. The probe was a throwaway `--plugin-dir`
plugin outside the repository whose `turn.step` hook rewrites the main
loop's effort exactly as the router does (`next({ ...e, effort })`), on a
fixed plan: steps 0-1 high, then two medium, two high, and so on, so every
even step from 2 on follows a switch and every odd step from 1 on is a
same-effort control. The session effort was `--effort high`; the prompt had
the model make 64 single `echo` tool calls, one per response, in one turn
(65 steps). Context 35-36k tokens per step (a 600-line neutral padding in the
appended system prompt kept it above 20k), cache writes and reads within
seconds of each other.

| Steps | n | Missed (>50% of the prompt uncached) | Uncached share, mean / max |
|---|---|---|---|
| After a switch (high↔medium) | 32 | 0 | 0.31% / 0.99% |
| Same-effort control | 32 | 0 | 0.58% / 9.4% (the first control, right after the session's first cache write) |

Path. Every one of the 65 transcript steps records `effort` equal to what
the hook sent and `perTurnEffort` equal to `effort` (`high` or `medium`,
switching every two steps): the rewrite goes out as a per-message effort,
not a top-level one, and the prompt cache survives it. A smoke run of 7
steps before it (3 switches) showed the same.

Cost: $0.72 for the probe session and $0.26 for the smoke run, $0.98 in
all (Claude Code's own `total_cost_usd`, API-equivalent).

What it settles and what it does not. The docs' per-message path is the one
a hook's rewrite takes on Opus 5.5, and 0/32 misses rules out the 29%
turn-boundary rate of §4 for mid-turn switches. It does not establish the
≤2% go bar: with 32 switches the bound is 10.9%, and a ≤2% bound at 95%
needs about 150 clean switches. It covers one model (Opus 5.5), switches
seconds apart at 35k context, and a headless session; Sonnet 5 (no
per-message effort) and Sonnet 5.5 with `between_tools` were not probed.
Nothing in 0.6.16 acts on the main session; the next step is a longer probe
(or the T4 rows, whose `effortChanged` steps carry `uncachedShare`,
`prevEffort` and `promptTokens`) before any hold rule is switched on.
