# Native Claude Code vs Jev Advisor: feature audit

Date: 2026-10-28. Claude Code installed: 2.1.312. Plugin: 0.13.11 (`main` at 1f10942). Investigation for JEVADV-109, widened to every module. Docs only: no code changed.

## Sources and how to read this

- **Native behaviour** is cited from the official docs fetched on 2026-10-28 (`D/<page>` = `https://code.claude.com/docs/en/<page>.md`, with line numbers in the fetched copy) or the local CLI changelog (`CL L<n> (<version>)` = line of `~/.claude/cache/changelog.md` under that version heading). Nothing native is claimed from memory.
- **Plugin behaviour** is cited as `file:line` in this repository (`index.ts` = `adapters/claude/mod-skills/hooks/index.ts`).
- **Measurements** come from `~/.cache/orca-supervisor` over the 7 days 2026-10-21T04Z to 2026-10-28T04Z (5 accounts, 1,992 person prompts, 4,058 turns, 48,070 tool calls), via `scripts/measure-module-cost.mjs` and ad-hoc reads of the module logs. Weekly figures unless stated.
- **Permission mode in practice:** in the last 7 days of transcripts (400 files), `permissionMode` was `bypassPermissions` on 28,346 records, `auto` on 343, `plan` on 8. That is **98.8% bypass**. In `bypassPermissions` "Allow rules have no effect" and only deny rules still block (D/permission-modes L30), and the mode is documented as "Isolated containers and VMs only" (L24). This drives most gate verdicts below.

Verdicts: **DUPLICATE** (drop ours, use native) · **OURS BETTER** · **COMPLEMENT** (native as the base, keep our layer) · **NO NATIVE EQUIVALENT**.

## 1. Feature table

### Jev calls per module (7 days, `measure-module-cost.mjs`)

| Module | Jev calls | per prompt | Hook process spawns | Hook p50 / p90 |
|---|---|---|---|---|
| gate | 21,642 | 10.86 | 74,411 | 610 / 1,334 ms (n=21,437) |
| skill-selection (skills + tools) | 29,603 | 14.86 | 0 (in the mod) | — |
| steward | 3,215 reported, **~2,714 real** (see §5) | 1.61 | 0 | — |
| model-router | 2,228 | 1.12 | 402 | — |
| verify-done, ci-watch, board | 0 | — | — | — |
| memory | 0 Jev; 1,673 Haiku gates (5.90 M in / 0.14 M out tokens), 150 session forks (1.0 M in, 31.2 M cache read) | — | 0 | — |

### Gate (command gate, `PreToolUse` on Bash and file tools)

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Generic risk judgment of every Bash command (Jev or Clef), `adapters/claude/gate-bash.ts:2266`, `askJev` :1925 | Auto mode classifier, server-side by default (CL L2468, 2.1.278). Permission rules and modes (D/permissions L56-58, D/permission-modes L13-30). | **COMPLEMENT** | 22,723 gate rows: Jev 22,723, of which 21,337 allow (94%), 1,345 advise, 40 deny, 1 ask; `stopReason: risk` on 20,679. Sessions run in bypass, so today nothing native judges risk at all. In `auto` mode the engine's classifier would make the generic call at no Jev cost. | Up to ~20,700 Jev calls/week (the `risk` rows), and the 610 ms p50 hook wait on those calls |
| Deny tier, 9 rules (force push, protected push, `rm -rf /`, discard, DROP/TRUNCATE, kubectl delete, terraform apply/destroy, `curl \| sh`), `gate-bash.ts:690`, `deny_tier_config.ts:47` | Deny rules `Bash(...)`, which "block in every mode, including bypassPermissions" (D/permission-modes L30). Built-in critical-path `rm` prompt (L34). | **OURS BETTER**, mirrored as a COMPLEMENT backstop | Ours parses command shape (`deny_rule_shapes.ts`, `git_discard.ts:1460`). It only refuses a discard that would lose work, and names the work and a stash command (`discard_loss.ts:362`). Native rules match a pattern and cannot tell a lossless `git checkout` from a lossy one. 78 local-rule denies a week. | 0 Jev (already local); gains a guard that holds with the plugin off |
| Tier 1a safe list (read-only commands pass locally), `gate_safe_command.ts:354` | Allow rules (no effect in bypass); in auto mode the classifier decides | **OURS BETTER** (under bypass) | No network call. Still, 3,654 Jev calls a week go to read-only-looking families (cat, grep, ls, sed, echo, ...; `commandFamily` in `gate-decisions`). | n/a (a plugin-side widening, ticket 7) |
| Own-config guard (model cannot write the gate's or router's files), `gate_own_paths.ts:12-38`, `adapters/claude/gate-files.ts` | Deny rules `Edit(path)` / `Write(path)`, effective in bypass (D/permission-modes L30) | **COMPLEMENT** | The file-tool half is exactly what native deny rules do. The Bash half (redirects, `cp`, `sed -i` into those paths) has no native rule shape. Sandboxing covers shell writes but is off by default and leaves file tools to permission rules (D/sandboxing L23-42). | One hook process spawn per Edit/Write/MultiEdit/NotebookEdit |
| Secret redaction and name pseudonyms before Jev/Clef/Haiku, `secret_redaction.ts:697`, `jev_pseudonyms.ts:99` | None | **NO NATIVE EQUIVALENT** | Exists because we send text to third parties. It shrinks with every Jev call removed. | — |
| Secret publish guard (stage, commit or push of a secret path asks), `secret_publish.ts:314` | None (rules match the command, not the staged files) | **NO NATIVE EQUIVALENT** | Needs the staged paths. | — |
| Local allow (own branch push, guarded git ops, own-tree, trusted programs, contained temp effects), `push_own_branch.ts:475`, `contained_effect.ts:1470-1493`, `trusted_programs.ts:123` | Allow rules (no effect in bypass) | **OURS BETTER** | These are cheap Jev skips that reason over branch and remote reach; native rules are prefix patterns. 431 own-tree, 321 trusted, 88 contained, 34 local-allow a week. | — |
| Deploy/publish floor, `deploy_publish.ts:67` | Ask rules `Bash(npm publish:*)`; "explicit ask rules still prompt" in auto (D/permission-modes L328) | **COMPLEMENT** | Native ask rules carry the floor in auto mode. Ours also tells Jev the fact and covers bypass. | 0 Jev |
| Cross-repo acting location, destinations, policies, team owners, protected-branch reach, `acting_location.ts:45`, `cross_repo_context.ts:76-173`, `decisions.ts:448`, `team_owners.ts:44` | None (rules are not destination- or policy-aware) | **NO NATIVE EQUIVALENT** | Org policy (permit, prohibit, requires_human) per repo and destination. | — |
| Advice retry, delivery authorizations, queue mode, approval recorder, `gate_advice_retry.ts:30`, `gate_authorizations.ts:18`, `queue_mode.ts`, `gate-outcome.ts:87` | `PermissionDenied` hook `retry` (CL L6942, 2.1.89), `updatedPermissions` on PermissionRequest (D/hooks L2114-2125) | **NO NATIVE EQUIVALENT** | Remembered per repo and per class for 30 days, plus a human queue on the board; native remembers per rule only. | — |
| Jev / Clef provider cascade, A/B benchmark, `provider_cascade.ts:161`, `ab_benchmark.ts` | Auto mode classifier model (`CLAUDE_CODE_AUTO_MODE_MODEL`, client-side only, CL L432, 2.1.302) | **COMPLEMENT** | If the generic call moves to native, the cascade only serves policy questions. | follows row 1 |
| Gate transport: a settings.json command hook, one process per call, `install-claude-integration.mjs:400` | Mod `tool.check` / `tool.call`, in process (`claude-code.d.ts:3962-3976`) | **COMPLEMENT** | 74,411 spawns a week at p50 610 ms. The mod already runs in process. Unverified: whether `tool.check` fires in bypass, and whether `cc-plugin-sec-default` (Team/Enterprise) delivers it (it skipped some of our mod hooks this session, see §3). | ~74k process spawns a week |

### Model router

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Main-session tier and work-kind routing per prompt (model and effort on `turn.step`), `index.ts:1351`, `model_router_decide.ts:425` | `opusplan` (plan→Opus, execute→Sonnet; CL L9077, 1.0.77), `/model`, `/effort`, `ultrathink` (2.1.311+), fallback chains on overload only (D/model-config). No per-task router. | **OURS BETTER** | Native routes only by plan vs execute. Ours: 2,023 rows, 317 applied (Opus→Haiku 70, Haiku→Opus 70, Haiku→Sonnet 25, ...). Guards: quota, context floor, cache warmth, Orca pins. It already runs on the native mod hook `turn.step` (D/mods-events L291). | — (2,228 Jev calls stay) |
| Person `/model` lock, `index.ts:1462`, `:4596` | `PreModelSwitch` sees only user switches (D/hooks L3332-3460) | **NO NATIVE EQUIVALENT** | Needed only because the router exists. | — |
| Subagent and teammate routing at spawn (router-subagent), `index.ts:1795`, `:1860` | Subagent `model` / `effort` frontmatter, `CLAUDE_CODE_SUBAGENT_MODEL` (D/sub-agents L302, L355-360); mod `agent.spawn`, whose model "overrides the per-call parameter" (D/sub-agents L362) | **COMPLEMENT** | Ours uses the native `agent.spawn` and treats a declared effort as a floor. | — |
| Legacy Agent model hook (`PreToolUse` on Agent), `adapters/claude/agent-model-hook.ts:135` | Same native `agent.spawn` as the row above | **DUPLICATE** (of our own router-subagent, built on native) | Rewrites only in active mode, ≥1000 decisions at 70% match, `bypassPermissions` and confidence ≥0.7. 200 decisions and 200 outcomes a week in `model-reclassifications`, alongside 216 router-subagent rows for the same spawns. | ~200 Jev calls a week and its share of the 402 router hook spawns |
| Cache warmth from the transcript tail, `cache_warmth.ts:53` | `cache_ttl` and `prompt_cache_warm` on PreModelSwitch/PostModelSwitch input (`claude-code.d.ts:7826-7834`, 7918); `prompt_cache` on status-line stdin (CL L3568, 2.1.251); `prompt_cache_likely_expired` on a resume SessionStart (`claude-code.d.ts:11668`) | **COMPLEMENT** | Native fields exist, but on classic hooks, which Team/Enterprise orgs withhold from installed plugins (CHANGELOG.md:185). Keep the tail as the fallback. | No Jev; less file reading |
| Account quota mirror (`quota.json` every 10 min), `main.mjs:457` | `$.session.usage()` returns `rateLimits` (D/mods-reference L216); status-line `rate_limits` (CL L7213, 2.1.80) | **COMPLEMENT** | Native is live for the running account; ours is cross-account (Orca rotates accounts). Read native for the current session, keep the mirror for the others. | worker sidecars |
| Subagent status band, `subagent_band.ts:212` | `subagentStatusLine` with `tasks[]` (status, model, effort, tokens; D/statusline L1100-1126), `/tasks`, agent view | **COMPLEMENT** | Ours adds why (router reason) and where (worktree or branch, `agent_place.ts:106`). 0 Jev. | — |
| Turn usage log, `index.ts:667` | OpenTelemetry `token.usage` by model, skill, plugin and agent (D/monitoring-usage L642-649); `/usage` | **COMPLEMENT** | Ours joins usage with router and steward decisions per session (used by `verifyStewardSaving`, `summarizePreCold`). OTel needs a collector. | — |

### Steward (context and compaction)

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Turn-end steward (Jev: boundary / mid-task / new-topic, compact with keep-list), `context_steward.ts:97`, `:249`, `:327` | Auto-compact at the window (default about 967K on 1M; `autoCompactWindow` 100K-1M; D/model-config), `/compact [instructions]` (D/commands L73) | **OURS BETTER** | Native compacts on size or idleness only, and mid-turn. Ours compacts at a work boundary between turns: 126 applied in 9 days, mean 315k freed; 94% of its ≥200k calls are in sessions resumed within 54 min (§4). | — (about 383 Jev calls a day stay; see ticket 2) |
| Soft 400k and hard 600k tiers, `context_steward.ts:40-44` | `autoCompactWindow` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | **COMPLEMENT** | Native at 600k would compact mid-turn (the research `odd/research/steward-1m.md` measured a median 145 s); ours waits for the turn end. Set the native window a little above our hard limit as a backstop. | 0 Jev (same call) |
| What the summary keeps, `stewardInstructions` / `preColdInstructions` (`context_steward.ts:327-348`) | `# Compact instructions` section in CLAUDE.md, applied to compactions (D/costs L269); mod `session.compact` can rewrite `instructions` on any trigger, `auto` included (`claude-code.d.ts:4380-4390`, `:10803-10864`); classic PreCompact can only block (D/hooks L3272-3300) | **COMPLEMENT** | Today our keep-list reaches only our own compactions. Native auto and idle compactions use the generic prompt. | 0 Jev (no call needed) |
| Pre-cold tier (compact an idle session before its 1h cache expires), `steward_pre_cold.ts:119` | Idle compaction: ≥200K, 1h TTL, about 54 min idle, on by default, `idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` ≥100K (CL L644-645, 2.1.299; `/config` row CL L433, 2.1.302; D/settings-reference L2417-2470) | **DUPLICATE** at ≥200K · **COMPLEMENT** for 120K-200K | 623 due wakes in 9 days, 27 fired, mean cost 204,615 input-equivalents. The 13 in-zone fires cost 365k-745k each. Native was observed only on 1 of 5 accounts (10 events), and the other accounts cannot be observed (classic hooks withheld). | 0 Jev (the tier makes none); ~5.6 M input-equivalents in 9 days from in-zone fires |

### Skill and tool selection

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Skill selection (Jev ranks all skills per prompt, then fits the top 3; active injects the SKILL.md and withholds the listing), `index.ts:4042`, `skill_decisions.ts:256` | The model picks from the listed descriptions. Listing capped by `skillListingBudgetFraction` (default 0.01); least-used skills lose descriptions over the cap (D/settings-reference L2501-2512); `skillOverrides` on, name-only, user-invocable-only or off (L3752-3775, not for plugin skills); `disable-model-invocation` (D/skills L397-416). No native relevance ranker. | **COMPLEMENT** | 5,540 decisions (66 candidates, 32k-char listing on average); a skill picked in **855 (15%)**, "nothing fits" in 4,685. Most of the cost buys a "no". Native budget and overrides shrink the listing every turn at zero Jev. | Most of the ~4,700 "no skill" decisions' calls, if Jev runs only on prompts a cheap pre-check flags (ticket 3) |
| Tool selection (Jev over all tools incl. MCP, injects `<tool_relevance>` advice), `index.ts:4308`, `tool_decisions.ts:290` | Tool search defers MCP tools by default; "only tool names and server instructions load at session start" (D/mcp L1687, `ENABLE_TOOL_SEARCH`, D/env-vars L470); `--disallowedTools`, subagent `tools` | **DUPLICATE** (likely; confirm with its own agreement data) | Advice only, and native tool search already narrows MCP tools on demand. 5,520 decisions, a pick in 2,667. The module logs which tool was used first (`tool.call`, 4,381 observation rows), so agreement can be measured before dropping it. | Its share of the 29,603 module calls (wide batches plus a fit stage per prompt) |
| Typing lead time, `typing_lead_time.ts:47` | None | **NO NATIVE EQUIVALENT** | Measurement only, 0 Jev. | — |

### Memory, verify-done, CI watch

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Memory save (Haiku SKIP/UPDATE gate, a fork drafts, active writes Engram or auto-memory files), `memory_decide.ts:96`, `index.ts:3200` | Auto memory: Claude writes user, feedback, project and reference notes, MEMORY.md loads each session, on by default (D/memory L475-560; CL L7709, 2.1.59) | **DUPLICATE** for the files backend · **COMPLEMENT** for Engram | Native already writes the same files itself. The main thread made 1,798 Engram calls (456 saves) in the week. Our gate costs 1,673 Haiku calls (5.90 M input tokens) plus 150 forks (31.2 M cache read). | ~5.9 M Haiku input, 1.0 M fork input and 31 M cache-read tokens a week, if limited to Engram gaps |
| memory-tidy and memory-ui features, `feature_modules.ts:336-337` | — | **Incomplete**: registered, no handler in `index.ts` | `memory_tidy.ts:407` exists but nothing calls it. | — |
| Verify done (Jev: was a "done" claim verified), `verify_done.ts:37`, `index.ts:2559` | `/goal` (a session Stop-hook evaluator that "doesn't run commands or read files", D/goal L54, L118-125; CL L5972, 2.1.139); Stop hooks `decision: block` (D/hooks L2798-2827); TaskCompleted exit 2 | **COMPLEMENT** | Default off, 0 rows this week. If ever activated, deliver it as a Stop hook so it can act, not a shadow call. | 0 today |
| CI watch (`gh` polling after push or PR, band row, toast, note to the agent), `ci_watch.ts:264`, `index.ts:2723` | Monitor tool (deadline 5 min default, 30 max; D/tools-reference L362-376; CL L6739, 2.1.98); PR badge without CI state (CL L8111, 2.1.20); `/loop`; `/autofix-pr` (cloud) | **OURS BETTER** | Watches up to 60 min with no model tokens: 615 watches, 9,662 `gh` calls, 0 Jev, 270 notes. Native Monitor caps at 30 min and runs through the model; the main thread still made 1,551 CI polls and 541 sleeps of 10 s or more. | — |

### Board, status line, Orca and developer tooling

| Plugin feature | Native equivalent (version) | Verdict | Why, with evidence | Saved if we lean on native |
|---|---|---|---|---|
| Cross-worktree board and panels (gate health, cost, consumption, memory, CI), `adapters/orca/panels/board.html:433-542`, `main.mjs:2764` | `/usage` (`/cost`, `/stats`), `/insights`, OTel metrics (D/commands L77, D/costs L117-125, D/monitoring-usage) | **NO NATIVE EQUIVALENT** | Native is per session or per user; ours is cross-worktree and cross-account inside Orca, with plugin decisions. | — |
| Status line parts (skill, tool, router, agents, steward), `status_line.ts:22`, `index.ts:4002` | Mod `$.ui.status`, cut at 200 chars or two rows (D/mods-interface L344-350); `statusLine` command | **COMPLEMENT** (already native) | Built on the native mod API. | — |
| Orca game advisor state, Orca report (model, effort, picks), `advisor_state.ts:28`, `orca_report.ts:65` | None | **NO NATIVE EQUIVALENT** | Orca-specific. | — |
| `advisor.decide` (Jev on a list of proposed actions), `main.mjs:2825` | Native advisor tool: a stronger model the agent consults; "no setting to cap or force advisor calls", Anthropic API only, uncached full transcript per call (D/advisor L88-180) | **NO NATIVE EQUIVALENT** | Different job: ours judges risk and approval of actions; native gives a second opinion on the approach. | — |
| Installer (8 settings.json hooks, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, mod copy per config root), `install-claude-integration.mjs:311`, `:400` | Plugins and mods packaging (D/plugins, D/plugins-reference; mods CL L1543, 2.1.287) | **Not evaluated** | Out of the cost scope; packaging as a native plugin would change install and revert, not Jev use. | — |
| Jev health CLI, module cost report, pre-push privacy guard | None | **NO NATIVE EQUIVALENT** | Developer tooling. | — |

## 2. Why each OURS BETTER

- **Deny tier.** It parses command shape instead of matching a prefix. It refuses a git discard only when work would be lost, and says what and how to stash it (`discard_loss.ts:362`). Native deny rules cannot tell a lossless `git checkout` from a lossy one, and would either block safe commands or miss variants.
- **Safe list and local allows.** Under bypass (98.8% of records) allow rules do nothing (D/permission-modes L30). Ours turns cheap local facts into no-Jev allows: own branch not shared, contained temp writes, trusted programs. That is 874 local passes a week.
- **Model router.** Native has no per-task router: only `opusplan` (plan vs execute), user `/model` and `/effort`, and overload fallbacks (D/model-config). Ours applied 317 switches in the week, both down (Opus→Haiku 70) and up (Haiku→Opus 70, Haiku→Sonnet 25), and holds them against quota, context floor, warm cache and Orca pins.
- **Turn-end steward.** Native compacts on size (at the window, mid-turn) or idleness (≥200K, 54 min). Ours compacts at a work boundary between turns, at 120K and up, with a keep-list of task docs, branches, commits and PRs. 92 of its 104 ≥200K compactions were followed by the person resuming within 54 min, which native would never have touched.
- **CI watch.** No model tokens, a 60-minute watch, and a note to the agent when idle. Native Monitor is capped at 30 min and spends model turns; native PR badges show review state, not CI.

## 3. DUPLICATE and COMPLEMENT: the change and its risk

| Feature | Change to lean on native | Risk |
|---|---|---|
| Gate generic risk | Start Orca sessions in `auto` instead of `bypassPermissions`, so the native classifier does the generic call. Ask Jev only when a policy, destination, deploy floor, secret or protected-branch question applies (the `risk` stop reason becomes rare). Keep every local rule. | Orca launches sessions in bypass; that is the lead's and Orca's decision. Auto mode pauses after 3 blocks in a row or 20 in total, not configurable (D/permission-modes L552-559). The server classifier needs network and denies on no verdict (L554). Risk judgments change source: measure agreement on the A/B benchmark first. |
| Deny tier backstop | Also install the 9 rules as native `permissions.deny` patterns (prefix forms only), so they hold with the plugin off or hooks skipped. | A prefix rule is broader or narrower than our shape parser. Keep ours as the precise layer and choose the native patterns conservatively. |
| Own-config guard, file tools | Replace the `gate-files` PreToolUse hook with native `Edit(...)`/`Write(...)` deny rules on those paths. Keep the Bash part. | Path syntax and home expansion in rules; must cover every config root Orca creates. |
| Deploy floor | Mirror as native ask rules for non-bypass sessions. | In bypass, native ask rules do not apply (only deny rules hold, D/permission-modes L30), so ours stays the only floor there. |
| Gate transport | Move the in-process checks to the mod's `tool.check`/`tool.call` and drop the per-call process. | Unverified whether `tool.check` fires in bypass and whether `cc-plugin-sec-default` delivers it on Team/Enterprise. This session showed it skipping our `prompt.attachment` and `classic.Stop` hooks. Probe first. |
| Legacy Agent model hook | Remove it; `router-subagent` on `agent.spawn` already decides the same spawns. | Lose its readiness measurement series; check the board does not depend on `model-reclassifications`. |
| Cache warmth | Read `cache_ttl` / `prompt_cache_warm` from Pre/PostModelSwitch where delivered; keep the transcript tail as the fallback. | Classic events are withheld on Team/Enterprise (CHANGELOG.md:185), so the fallback stays primary there. |
| Quota mirror | Read `$.session.usage().rateLimits` for the running account; keep the Orca mirror for other accounts. | Two sources can disagree for a few minutes. |
| Steward keep-list | Register a mod `session.compact` hook that sets our instructions on `auto` compactions (idle and threshold), or ship a `# Compact instructions` block (D/costs L269). | Delivery of `session.compact` on Team accounts is unverified. A CLAUDE.md block is user-visible and per project. |
| Hard limit | Set `autoCompactWindow` slightly above our 600k as a backstop. | A native compaction can still land mid-turn if ours is off. |
| Pre-cold | Treat "≥ zone, 1h TTL, idleCompaction not false" as engine-owned even when the engine is unseen. Optionally set `env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` to the steward threshold, keeping pre-cold only where native is off. | Native was unseen on 4 of 5 accounts. 10 in-zone fires at ≥200K (Oct 20-23) found sessions native had not compacted at 54 min. The env change is user-visible ("Compacted while idle"). Needs a live check per account. |
| Skill selection | Shrink the native listing with `skillListingBudgetFraction` and `skillOverrides` (name-only for rare skills). Run the Jev ranker only when a cheap local pre-check (keywords, recent use) suggests a skill. | `skillOverrides` does not apply to plugin skills (D/settings-reference L3752-3775). A pre-check may miss skills Jev would find; compare recall against the 855 picks. |
| Tool selection | Measure agreement (advice vs first tool used) from its own rows; if low, set it Off and rely on native tool search. | Losing a hint for built-in tools that tool search does not cover. |
| Memory (files backend) | Leave the files backend to native auto memory; keep the module for Engram only, or for gaps native misses (measure on shadow rows). | Native writes when the model decides; ours guarantees a pass per turn. Overlap in content is unmeasured. |
| Verify done | If activated, implement it as a Stop hook (block plus reason) instead of a shadow `turn.complete` call. | Stop hooks are capped at 8 consecutive continuations (D/hooks L2798-2827). |
| Subagent band, turn usage, status line | No change; they already sit on native mod APIs. | — |

## 4. Context detail (the original JEVADV-109 question)

- Turn-end steward Jev calls: 2,965 in 9 days, **383 a day** on full days; 95.1% end without compaction (mid-task 1,541, low-confidence 1,274).
- **1,160 calls (39%) come right after a confident (≥0.8) mid-task verdict in the same session; 1,103 of them again led to nothing.** A back-off saves about 120 calls a day.
- Overlap with native idle compaction: of 2,050 calls at ≥200K, **1,921 (94%) were in sessions resumed within 54 min**, 58 were followed by ≥54 min idle and then resumed, and 63 were never resumed. So skipping Jev "when native will act" saves essentially nothing.
- The pre-cold tier calls no Jev; its in-zone fires cost 365k-745k input-equivalents each (about 2× context, which looks like a cold write, not the 0.1× warm read the design assumed).

## 5. Side findings

- `stewardJevCalls` (`src/core/module_cost.ts:133`) counts pre-cold rows and `engine-idle-compact` events as Jev calls. The report shows 3,215 calls and 111 failures; the real figures are about 2,714 and 6.
- memory-tidy and memory-ui are registered (`feature_modules.ts:336-337`) with no handler: an incomplete feature.
- 554 pre-cold `ttl` skips at about 255 s idle (a 5-minute TTL read) happened before Oct 25 and none after; not investigated.

## 6. Proposed follow-up tickets, ranked (the lead decides; none created)

1. **Gate: native auto mode for generic risk, Jev for policy only.** Up to ~20,700 Jev calls a week (the `risk` rows), plus most of the 610 ms p50 hook waits. Needs Orca to start sessions in `auto`, and an agreement run (A/B benchmark) before switching.
2. **Steward back-off after a confident mid-task** (inside JEVADV-109). About 120 calls a day (~840 a week), risking delay on at most 57 compactions in 9 days.
3. **Skill selection: a pre-check before Jev, plus a smaller native listing.** Targets the ~4,700 weekly "no skill" decisions; native `skillListingBudgetFraction` and `skillOverrides` cut listing tokens on every turn.
4. **Tool selection: measure agreement, then Off if it is low** (native tool search). Its share of the 29,603 module calls.
5. **Memory: leave the files backend to native auto memory.** About 5.9 M Haiku input tokens and 31 M fork cache reads a week at stake.
6. **Steward on native compaction:** a `session.compact` keep-list hook or a `# Compact instructions` block, pre-cold deferring in the native zone, and an `autoCompactWindow` backstop. 0 Jev; better summaries; avoids 365k-745k in-zone fires.
7. **Gate transport and local coverage:** move to mod `tool.check` (~74k spawns a week), add native deny rules for the deny tier and the own-config file paths, and widen the safe list for the 3,654 read-only-looking Jev calls a week.
8. **Remove the legacy Agent model hook** (duplicate of router-subagent). About 200 Jev calls a week.
9. **Hygiene:** fix the `stewardJevCalls` overcount; wire or remove memory-tidy and memory-ui.
10. **Cache warmth and quota from native fields** where delivered (PreModelSwitch/PostModelSwitch, `usage().rateLimits`). No Jev; fewer transcript reads and sidecars.

## Not verified

- Whether `tool.check` and `session.compact` mod hooks are delivered to this plugin on Team/Enterprise accounts under `cc-plugin-sec-default`, and whether `tool.check` fires in `bypassPermissions`.
- Whether native idle compaction dispatches `session.compact` as `auto` or `precompute` (the VS Code pre-written summary).
- Why native idle compaction was observed on only one account (the feature flag, or classic hooks withheld).
- The content overlap between native auto memory and the plugin's memory drafts.
- Server-side auto-mode classifier cost and latency per call (not in the docs read).
