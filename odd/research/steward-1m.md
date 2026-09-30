# Context steward on 1M-token windows: hard limit or not? (JEVADV-87)

Research for 0.6.15 T4, 2026-09-30. Scratch scripts stayed out of the
repository; only aggregated numbers are here.

## TL;DR

- On 1M-token sessions, the money is where the steward does nothing: calls at
  ≥400k context are **68%** of this account's API-equivalent spend; sessions
  that ever passed 400k are 57 of 493 but **90%** of spend. Without a limit
  they run until Claude Code's own auto-compact at ~967k, which fires
  *mid-turn* and takes a median 145 s.
- A fixed limit will almost always land on a turn Jev calls "mid-task" (93–96%
  of logged turn-ends above every threshold tested are mid-task or
  low-confidence). That label is weak evidence of harm: Jev is told "when
  unsure, choose mid-task" and its criteria count "waiting on the person" as
  mid-task, true of nearly every turn end; ~18–20% of "low-confidence" turns
  committed or opened/merged a PR.
- Simulated on real transcripts (upper bound, Opus 5.5 prices): an absolute
  limit at **400k saves ~38%** of spend, 300k ~44%, 500k ~31%, 600k ~26%. The
  compaction's own cost is <1% of what it saves.
- **Recommendation: two tiers.** Above 400k, compact at turn end unless Jev
  says mid-task with confidence ≥0.8; above 600k, compact unconditionally
  (replacing 80%-of-window for 1M windows; keep 80% for 200k). Measure mode
  first, with the extra logging in §6.
- Two defects found on the way: the log drops Jev's verdict on low-confidence
  rows (so "lower the confidence floor" cannot be evaluated from today's
  data), and the hard limit uses the *current* model's window, so a router
  drop to Haiku (200k) caused 9 compactions at 160–230k in one session.

## 1. How compaction works in Claude Code (fetched 2026-09-30)

| Fact | Source | Status |
|---|---|---|
| Native-1M models (Sonnet 5+, Fable, Opus 4.7+ on the Anthropic API) "compact before the window fills, at about 967K tokens by default"; change with `/autocompact 500k`, `--autocompact`, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K–1M). | https://code.claude.com/docs/en/model-config | Verified |
| 45 of 49 auto-compactions in the transcripts fired at 966k–1.0M. | transcripts (`compact_boundary.compactMetadata`) | Measured |
| What survives: CLAUDE.md, unscoped rules, auto memory, plan file, git status re-injected from disk; up to 5 recently modified files re-read (>5k tokens become a reference); skill bodies re-injected (5k each, 25k total); path-scoped rules and nested CLAUDE.md are summarized away. | https://code.claude.com/docs/en/context-window ("What survives compaction") | Verified |
| The summary request is "a separate request with the same system prompt, tools, and history … plus a summarization instruction"; with a warm cache it reads the prefix from cache and "costs a fraction of what the context size suggests". Compaction invalidates the conversation layer; the next turn rebuilds the cache for the summary only. | https://code.claude.com/docs/en/prompt-caching | Verified |
| Anthropic's own guidance: "Run `/compact` at a natural break in your work, such as between tasks, instead of waiting for auto-compaction to trigger mid-task." | same page | Verified |
| PreCompact/PostCompact receive `compaction_trigger` = `manual`, `auto`, or `"plugin"`; PreCompact can block. | https://code.claude.com/docs/en/hooks | Verified |
| `$.session.compact({instructions})` is "the same call `/compact` makes, between turns", rejects while a turn runs, can be vetoed by a hook (`{skip}`): the steward never compacts mid-turn, unlike auto-compact. | `adapters/claude/mod-skills/claude-code.d.ts` | Read |
| The transcripts record the steward's compactions with trigger `manual`. | transcripts | Measured; how other hooks see them is unverified |
| The steward is in active mode on this account (424 of 425 log rows `mode: active`), although the code default is `measure`. | steward log | Measured |

## 2. Prices, cache, 1M availability (fetched 2026-09-30)

https://platform.claude.com/docs/en/about-claude/pricing (USD per MTok)

| Model | Input | 5m write | 1h write | Cache read | Output | Window |
|---|---|---|---|---|---|---|
| Fable 5.1 | 10 | 12.50 | 20 | 0.25 | 50 | 1M |
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 | 1M |
| Sonnet 5.5 | 2 | 2.50 | 4 | 0.20 | 10 | 1M |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 | 200k |
| Opus 5 (most of the history) | 5 | 6.25 | 10 | 0.50 | 25 | 1M |
| Fable 5 | 10 | 12.50 | 20 | 1.00 | 50 | 1M |

- No long-context premium: "Claude 4.6 and later models … include the full 1M
  token context window at standard pricing (A 900k-token request is billed at
  the same per-token rate as a 9k-token request.)" (pricing page; windows from
  https://platform.claude.com/docs/en/build-with-claude/context-windows).
- Claude Code "requests the one-hour TTL only on a Claude subscription within
  your plan's included usage" for the main conversation; compaction and the
  rest get 5 minutes (https://code.claude.com/docs/en/prompt-caching). The
  transcripts show 99.8% of cache writes are 1-hour: this account is inside
  its subscription, so every dollar here is API-equivalent. How cache reads
  weigh against Max-plan weekly limits is not publicly documented
  (unverified).
- `seed/models.json`'s `cacheWrite` equals the 1-hour write price, consistent
  with the docs.

## 3. Long context versus compaction: evidence

| Claim | Source | Strength |
|---|---|---|
| "As token count grows, accuracy and recall degrade, a phenomenon known as context rot." | https://platform.claude.com/docs/en/build-with-claude/context-windows | Vendor statement, no numbers for current models |
| Attention budget grows n²; compaction must balance recall and precision; "overly aggressive compaction can result in the loss of subtle but critical context." | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Vendor guidance, qualitative |
| 18 models (Claude 4 included) degrade non-uniformly with input length; "significantly higher performance on focused prompts compared to full prompts", Claude with "the most pronounced gap" on LongMemEval. | https://www.trychroma.com/research/context-rot (Jul 2025) | Moderate: controlled, synthetic, older models; authors: "not exhaustive of real-world use cases" |
| Accuracy is best at the start or end of the context, degrading in the middle. | Liu et al., TACL 2023, https://arxiv.org/abs/2307.03172 | Strong for 2023 models; relevance to 2026 models unverified |
| At 32K, 11 models fall below 50% of their short-context baseline without a literal match. | NoLiMa, ICML 2025, https://arxiv.org/abs/2502.05167 | Strong for 2025 models |
| Compaction is lossy: "artifact tracking" (which files were touched) scores 2.19–2.45/5 for every method; Anthropic's compaction 3.44/5 overall. | https://factory.com/news/evaluating-compression | Weak–moderate: vendor-run, LLM-judged |
| Compression causes "blocked actions, repeated exploration, and instability across runs". | https://arxiv.org/abs/2608.06503 (Aug 2026) | Moderate: AppWorld, no rates in the abstract |
| MRCR 1M or another long-context score for Opus 5.5 / Fable 5.1 | search | Not found (unverified) |

Net: both harms are real and neither is quantified for current Claude models
on coding work; nothing measures "one turn-end compaction at 400k" against
"carrying 400k–967k". The one documented asymmetry: today these sessions end
in a mid-turn auto-compact, which Anthropic's docs name as the worst moment.

## 4. Measured on this account's data

Data: 517 main-conversation transcripts (2026-07-30 → 2026-09-30, 74,984 API
calls, de-duplicated by message id; subagents and gateway calls excluded;
advisor calls counted at their last executor iteration) and the steward log
(425 rows, 2026-09-28 → 2026-09-30, all joined to a session by exact
`contextBefore` and time).

### 4.1 What is re-read today

- 1M sessions (493): 28.8 B cache-read tokens over 72.6k calls, mean 397k per
  call. Per session: median 83k per call (p90 259k), 551k per person-turn; in
  the 57 sessions that passed 400k, median 3.9 M per turn.
- Cache reads are **72%** of API-equivalent spend ($13.4k of $18.6k at the
  models actually used). By context band: <100k 2.9%, 100–400k 29%,
  **400k–1M 68%**. The 10 largest sessions are 61% of spend; each reached
  966k–1.0M.
- 200k windows: 18 pure-Haiku main sessions, all tiny (~$2), and 2 "mixed"
  Opus 5.5 ↔ Haiku router sessions ($127). No meaningful 200k-only workload;
  the 80% rule plus auto-compact already covers it.

### 4.2 Real compactions

- `postTokens` (the log's `contextAfter`): median 16.4k (p10 12.2k, p90 24.1k)
  — the conversation only. The first real request after a compaction carries
  a median **76k** (p10 61k, p90 97k), against 61k for a brand-new session
  (system prompt, tools, CLAUDE.md, memory, re-read files). The simulation
  uses 76k.
- Latency (median `durationMs`): turn-end compactions <300k 72 s (n=20);
  300–600k 69 s (n=4, max 211 s); auto-compactions ≥600k **145 s** (n=45, max
  216 s).
- Regrowth after turn-end compactions (n=31): the first turn afterwards grows
  a median 77k, ~21× the session's median per-turn growth (4k). A rough proxy
  for re-exploration that cannot be separated from "a new task started": an
  upper bound on detail lost.

### 4.3 Hard-limit simulation (1M sessions, 493)

Method: at each person-turn end, if the simulated context is ≥ L and 3 turns
have passed since the last simulated compaction, compact. Later calls carry
`context − (C − A)` fewer prefix tokens, taken from cache reads first, then
writes, then input (A = 76k). Each compaction costs a summary call reading C
from cache plus 8k output, and the first call after it pays the 1-hour write
price instead of the read price for A tokens. The offset resets at each real
compaction. The work is assumed unchanged (no extra regrowth), so these are
**upper bounds**.

| Limit L | Sessions affected | Compactions | Saved, models used | Saved, Opus 5.5 prices | Saved, Fable 5.1 prices | Compaction overhead (Opus 5.5) |
|---|---|---|---|---|---|---|
| 200k | 142 | 538 | 54.9% | 49.4% | 43.3% | $110 |
| 300k | 75 | 265 | 48.0% | 43.6% | 39.0% | $59 |
| **400k** | 57 | 155 | 41.5% | **37.8%** | 34.3% | $38 |
| 500k | 44 | 122 | 34.0% | 31.2% | 28.7% | $32 |
| 600k | 34 | 73 | 28.2% | 25.9% | 23.5% | $21 |

- A 20k-token summary moves the 400k/Opus 5.5 figure from 37.8% to 37.5%.
  With the 16k `contextAfter` instead of 76k, savings rise by 4–7 points (46%
  at 400k, models used): the looser bound.
- At 400k each compaction saves ~$24 at Opus 5.5 prices and costs ~$0.25 plus
  ~70 s. 400k → 300k adds 6 points for 71% more compactions; 300k → 200k adds
  6 points for twice as many again.
- The 2 mixed 200k/1M sessions: a 200k limit saves 17%, 300k 11%, ≥400k 0–3%.

### 4.4 How many compactions would land mid-task

Most simulated compactions fall before the log begins (unlabelled), so the
log's own rates are used (16 1M sessions; a small sample). Share of logged
turn-ends ≥ L that are mid-task or low-confidence: 200k 96%, 300k 95%, 400k
96%, 500k 95%, 600k 93%. Waiting for a "boundary" after first crossing L:
median 8–13 logged turns (p90 18–56), context growing a median ~69k
meanwhile; 2–6 sessions per threshold never reached one within the log.

Above 400k: confident mid-task 76 rows (median confidence 0.88);
low-confidence 54 rows (median 0.50, verdict not logged).

What the labelled turns did: low-confidence (n=148) committed 18% and created
or merged a PR 20%; mid-task (n=242) committed 7%, PR 7%, ended with a
question 20%; boundary: 10 of 12 committed. The signal is conservative by
design, so "mid-task" overstates the risk.

## 5. Recommendation

Two tiers for windows larger than 200k; unchanged below:

1. Unchanged: ≥120k compacts on a boundary or new topic with confidence ≥0.7.
2. **Soft limit 400k:** at turn end, compact unless Jev says mid-task with
   confidence ≥0.8. Roughly half the turn-ends above 400k qualify, so it
   should act within 1–2 turns; expected savings near the 400k row (~35–38%
   at Opus 5.5 prices, upper bound).
3. **Absolute limit 600k:** compact at turn end regardless of Jev.
   `hardLimit = min(80% × window, 600k)`, where `window` is the session's
   **main** model window, not the router's current model. Worth ~26% on its
   own, and it removes the mid-turn auto-compact at ~967k (~145 s).
4. Regardless of thresholds: log `verdict` on every row plus a session id and
   a turn index; narrow the mid-task criterion "asked the person a question
   or is waiting on them", which describes almost every turn end.

Why these numbers: 400k captures most of the savings (38% of the 49%
available even at 200k) with 3.5× fewer compactions than 200k and a 4.8×
margin over the post-compaction floor (~76k). 300k adds ~6 points for 71%
more compactions of unknown quality cost; 500k gives up ~7 points. The
unconditional tier sits at 600k, where the cost is certain and the only
alternative (auto-compact at ~967k) is known to be worse.

Tradeoffs: compactions labelled mid-task will happen (at turn end, with the
steward's instructions and the five-file re-read, but detail will be lost;
§3, §4.2). ~70 s per compaction at 300–600k. Savings are upper bounds and
exclude extra re-reading. The label sample is 16 sessions over 2.5 days.
Subscription-limit weighting is unverified. Alternatives considered: a single
400k limit (simpler; ~2–3 points more savings for more mid-task compactions);
only lowering the confidence floor (cannot be evaluated today, and cannot
bound the worst case).

## 6. What to measure before switching it on

1. Every row: `verdict`, `confidence`, session id, turn index, the main
   model's window, the current model, and which tier would have fired
   (`soft-400k`, `hard-600k`, `boundary`).
2. Would-have-fired rate per tier per day (target: soft + hard at 400k gives
   ~3 per session that crosses 400k).
3. The prize: daily cache-read tokens in calls ≥400k and ≥600k.
4. Mid-turn auto-compacts (`compact_boundary`, trigger `auto`, pre-tokens
   ≥900k) per week: the baseline to drive to zero.
5. The loss proxy from real turn-end compactions over the next 3 turns:
   context growth, the share of Read calls on files read before the
   compaction, `/rewind` use, and prompts that restate earlier constraints
   (counted, never logged as text). Compare boundary compactions with
   would-be soft-tier ones once some are allowed.
6. Switch in stages: 600k active only for one week; then 400k on alternating
   sessions (session-id parity); compare tokens per commit or PR and the loss
   proxies between the halves before enabling it everywhere.

Unverified or not measured: how Max-plan limits weight cache reads;
long-context scores for Opus 5.5 and Fable 5.1; the quality cost of a
mid-task compaction for this workload; whether other PreCompact hooks see the
steward's compactions as `manual` or `plugin`.

## Decision (lead, 2026-09-30)

Adopted for 0.6.15 T4, staged because this account runs the steward in active
mode: the 600k absolute limit and the main-window fix ship active; the 400k
soft limit ships in measure only (logs `would-fire: soft-400k`) for a week;
every row logs `verdict`, session id, turn index, main window and current
model. The mid-task criterion is narrowed only after the week's data.
