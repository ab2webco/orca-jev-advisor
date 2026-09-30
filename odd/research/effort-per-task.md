# Effort per task: should Jev Advisor choose it? (2026-09-30)

Research only; nothing in the plugin changed. Accounts are A–D and agent
types type-1…n; no prompt text or project names. Dollar figures are
API-equivalent at list prices.

## Answer

Do not build per-turn effort switching. Choose effort per task or work phase
(held for 5+ turns), leave fixed-model subagents at their definition's or
session's effort, and first build the measurement below. The 2026-09-26
finding ("effort lowered to medium: negative at every granularity") does not
hold on Opus 5.5 in the main session: medium was about 20% cheaper per turn
with fewer steps. The quality signal is too thin to switch anything on.

## 1. What the docs say (fetched 2026-09-30)

| Source | What it says |
|---|---|
| https://code.claude.com/docs/en/model-config | Levels `low`, `medium`, `high`, `xhigh`, `max` on Opus 5.5, Sonnet 5.5, Fable 5.1; an unsupported level falls to the highest supported below it. |
| same | Resolution: (1) `CLAUDE_CODE_EFFORT_LEVEL` / `--effort` / `/effort`; (2) settings (`modelSettings` per model, or `effortLevel`); (3) the model default: `high`, except `medium` on Opus 5.5 and Sonnet 5.5. |
| same | "A top-level `effortLevel` in your user settings file doesn't count for Opus 5.5 … Levels are saved per model under the `modelSettings` key." `max` is not accepted in either settings key. |
| same | Guidance: `low` for quick reviewed exchanges and renames; `medium` for day-to-day scoped work; `high` where verification or edge cases matter; `xhigh` for deeper reasoning at higher spend; `max` "may show diminishing returns and is prone to overthinking, so test before adopting it broadly". Opus 5.5 at `medium` "matches or exceeds Opus 5 at `high`". |
| same | Skill and subagent frontmatter `effort` overrides the session level while that agent runs (not the environment variable). `ultrathink` adds an in-context instruction; it does not change the API effort. |
| https://code.claude.com/docs/en/sub-agents | Without frontmatter `effort`, "the subagent inherits the session's effort level". Not documented when the Agent call gives a different model (unverified; observed in §2.4). |
| `adapters/claude/mod-skills/claude-code.d.ts` | An agent definition has `effort?: level \| integer`; `TurnStepInput.effort` is "the session's setting or the model's default" and a hook may rewrite it; hook input `effort.level` is the active level after any downgrade (`CLAUDE_EFFORT`). |
| https://platform.claude.com/docs/en/build-with-claude/effort | Effort changes all output tokens: text, tool calls and arguments, thinking. "Lower effort also means fewer and terser tool calls." It is "a behavioral signal, not a strict token budget". API default `medium` on Opus 5.5, `high` elsewhere (Sonnet 5.5 included). |
| same | "Changing the top-level effort value between requests invalidates prompt caching"; Opus 5.5, Sonnet 5.5, Fable 5.1 and Opus 5 support per-message effort (beta `mid-conversation-output-config-2026-07-01`) "which preserves the prompt cache". Vary effort "across workloads rather than within a conversation that relies on cache hits". `low` suits "simpler tasks … such as subagents". Run an effort sweep on your own evals. |
| https://platform.claude.com/docs/en/about-claude/pricing | Opus 5.5 4/5/8/0.20/20; Sonnet 5.5 2/2.5/4/0.20/10; Fable 5.1 10/12.5/20/0.25/50; Haiku 4.5 1/1.25/2/0.10/5 (input / 5m write / 1h write / cache read / output, $/MTok). Effort changes token counts, not prices. |
| Claude Code 2.1.286 binary (string search) | `per-turn-control-2026-07-01`, `per_message_effort`, `perTurnEffort`, `midConvFallback`, `midConvCachePromotionRejected`: a per-turn effort path with fallbacks. Transcripts carry `perTurnEffort` on 58% of Opus 5.5 steps. Whether every switch keeps the cache is not documented (measured in §2.3). |

Mismatches in this repository and configuration:
- `seed/models.json` gives Sonnet 5.5 `defaultEffort: high` (the API default);
  Claude Code's default is `medium`, and the data agrees (17 of 19 Sonnet 5.5
  subagents under a `high` parent ran at `medium`).
- A top-level `effortLevel: high` is a no-op for Opus 5.5; only
  `modelSettings.claude-opus-5-5` counts. On the owner's accounts two set it
  to high and two do not (Opus 5.5 runs at medium there).

## 2. Data

All transcripts under the Orca account stores and `~/.claude/projects`
(1,564 unique files, 10,946 tasks, 148k de-duplicated steps, 2026-07-30 →
09-30), `turn-usage-*.jsonl` (15,738 steps, 09-27 → 09-30) and the router log
(612 decisions). The transcript's per-step `effort` matches what the plugin
logged as sent on 99.7% of 14,656 matched steps.

A task is a main-session turn (one real prompt to the next) or a whole
subagent run. Cost is actual tokens at list price, 1h writes included (100%
of Opus 5.5 first-step writes were 1h). Quality proxies: the next prompt is a
correction (bilingual regex) or an interrupt; tool errors per step; a commit
landed; the last test command green; for subagents, a retry (same parent and
type, similar description, within 45 min). Opus 5.5 data starts 09-22: nine
days, about $5,547 over 2,804 tasks (55% main session, 45% subagents).

### 2.1 Main session, Opus 5.5 (1,534 prompted turns)

| Effort | n | Median/mean steps | Mean/median $ per turn | Corrections | Tool errors/step | Commit % | Mean context at start |
|---|---|---|---|---|---|---|---|
| medium | 705 | 3 / 6.8 | 0.77 / 0.30 | 12/613 (2.0%) | 0.039 | 9.9 | 307k |
| high | 412 | 5 / 8.7 | 0.92 / 0.48 | 3/390 (0.8%) | 0.065 | 10.0 | 363k |
| xhigh | 417 | 4 / 8.0 | 1.10 / 0.48 | 8/394 (2.0%) | 0.039 | 6.0 | 471k |

Cost split: cache reads 56%, 1h cache writes 33%, output 11% (an Opus 5.5
cache read costs 0.05× input while a 1h write costs 2×).

Regression on log outcome, controlling for task kind (no tools / read-run /
edit / delegate), log starting context, log prompt length and account, 95%
bootstrap intervals, vs medium:

| | Cost | Steps | Output | Cache read |
|---|---|---|---|---|
| high | ×1.24 (1.10–1.41) | ×1.13 (1.02–1.23) | ×1.10 (0.95–1.27) | ×1.09 (0.94–1.24) |
| xhigh | ×1.25 (1.11–1.43) | ×1.17 (1.08–1.31) | ×1.12 (0.92–1.34) | ×1.11 (0.96–1.28) |

By kind: read/run turns (n=868) high ×1.23, xhigh ×1.22 cost, both
significant; edit turns (n=159) no detectable difference (high ×0.99, xhigh
×1.10, wide); delegating turns xhigh ×1.74 cost, ×1.61 steps. Router stage
"simple" only (n=222, high vs medium): cost ×1.15 (0.88–1.47), steps ×0.93,
not significant. Within the same session (10 sessions with two levels or
more, 1,143 turns), cost relative to the session mean: medium ×0.84, high
×1.13, xhigh ×1.09. Corrections, medium 2.0% vs high 0.8%: Fisher p = 0.18,
suggestive only.

### 2.2 Re-test of 2026-09-26

Not reproduced on Opus 5.5: medium had 12–15% fewer steps and was ~20%
cheaper per turn after controls. Not re-testable on Opus 5 (99.9% of its
interactive turns ran at high). The only `low` data (80 turns) is one-shot
scripted calls, so low effort on interactive work is unmeasured.

### 2.3 Cost of switching effort mid-session (Opus 5.5)

Uncached share of the first step's prompt, next turn vs previous turn, same
model:

| Gap | Same effort | Effort switched |
|---|---|---|
| < 5 min | 1.2% (full miss 1% of 959) | 31% (full miss 3 of 9) |
| < 1 h | 3.0% (full miss 3% of 361) | 21% (full miss 1 of 5) |

4 of 14 switches within an hour missed the cache fully; the other 10 kept it.
A full miss on a 400k context costs ≈ 400k × ($8 − $0.20)/MTok ≈ $3.1. The
medium-vs-high saving is ~$0.18 per turn, so one switch (~0.29 × $3.1 ≈ $0.9
expected) costs about five turns of savings. With n = 14 the miss rate is
anywhere from ~12% to 55%, and some misses may have other causes.

### 2.4 Subagents

Observed inheritance (parent effort at spawn → subagent): same model takes
the parent's level (high→high 22, medium→medium 7, xhigh→xhigh 6); another
model mostly gets its own resolved level (Opus 5.5 medium → Sonnet 5 high
100/100; Opus 5.5 high → Sonnet 5.5 medium 17/19); a session-scoped xhigh
often carries over (Opus 5.5 xhigh → Sonnet 5 xhigh 56, high 39). The exact
rule is unverified.

| Model, effort | n | Median steps | Mean/median $ | Thinking tokens | Commit % | Retried |
|---|---|---|---|---|---|---|
| Sonnet 5 high | 259 | 43 | 4.79 / 1.65 | 27k | 24 | 6% (16) |
| Sonnet 5 xhigh | 55 | 81 | 8.96 / 5.18 | 60k | 49 | 0% |
| Opus 5.5 medium | 19 | 38 | 4.28 / 2.42 | 19k | 42 | 0% |
| Opus 5.5 high | 36 | 67 | 6.93 / 3.47 | 13k | 56 | 8% |
| Opus 5.5 xhigh | 8 | 113 | 19.45 / 19.54 | 54k | 62 | 0% |

Controlled for agent type and starting context, Sonnet 5 xhigh vs high costs
×2.31 (1.70–3.10) with ×2.01 steps (1.54–2.57): in subagents, more effort
means more steps. xhigh had fewer retries (0/55 vs ~3.3 expected, p ≈ 0.04),
worth ~$0.29 per task against ~$4.2 extra: it does not pay for itself on
cost; unseen quality is unmeasured.

Confounders: effort was mostly set per account or session, not by the router
(5% of router decisions applied, most with `effort: null`), so it tracks
account, time and work phase; xhigh sessions started larger and were likely
harder; the correction regex and retry heuristic are noisy; nine days of
Opus 5.5 data dominated by a few long sessions. Natural variation, not an
experiment.

## 3. Answers

1. Lower effort on simple work: medium vs high on Opus 5.5 in the main
   session saves ~20% per turn with fewer steps (moderate confidence on
   cost; quality 2.0% vs 0.8% corrections, not significant, cannot be ruled
   out). Low: no interactive data.
2. xhigh/max on hard work: not on cost (main ×1.25 cost, subagents ×2.3), no
   fewer corrections; one weak positive (fewer subagent retries). max: no
   data.
3. Where to build: main session per task or phase, never per turn (a switch
   risks a ~$3 cache miss, recovered only after ~5 turns at the new level);
   subagents are the cheapest place (one task, own cache) and the evidence
   favours capping — e.g. not letting a session xhigh leak into Sonnet
   subagents (95 inherited xhigh or high from an xhigh parent); fixed-model
   subagents keep today's rule (no plugin effort). Fixes first: Sonnet 5.5
   `defaultEffort` → `medium` in `seed/models.json`; treat top-level
   `effortLevel` as irrelevant for Opus 5.5.

## 4. What measure mode must log before anything is switched on

Per turn and per subagent: the effort the plugin would choose, the effort
sent and its source (environment, `/effort`, `modelSettings`, frontmatter,
default, plugin); the stage and its confidence; whether the model was fixed;
turn or agent id, steps, the four token classes per step (1h vs 5m writes);
starting context and the uncached share on the first step after any effort
change; outcomes: next-prompt correction or interrupt, retry or re-spawn,
last test result, commit or PR landed.

Then a randomised A/B, not natural variation: medium vs high assigned per
task (seeded by turn or agent id) for Opus 5.5 read/run turns and for
non-fixed subagents. ~400 tasks per arm detect a 20% cost difference and a
~2-point correction difference. Switch on only if cost falls ≥15% with no
rise in corrections or retries.
