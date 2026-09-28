  - SETTLED by the owner (2026-09-27): the identity note is not built. The README says plainly that, after a switch, the model may still name the configured model if asked.
# Jev Advisor 0.6.0 slice 2: model and effort by need

Status: design approved by the owner's direction on 2026-09-26. The implementer is Sonnet; an Opus review follows. This document is the spec: implement exactly this, and return any gap instead of guessing.

## 1. Goal and non-goals

**Goal.** Stretch a Claude Max subscription's weekly usage without lowering quality. Jev (fast, cheap typed judgments, ~300 ms) chooses the model, and where it matters the effort, that each piece of work needs:
- a cheap model and low effort for simple work;
- a strong model for hard work;
- the quality floor always wins.

**Non-goals.**
- Per-message switching inside a warm conversation. It costs more than it saves (§2).
- Changing the session's configured model in settings.
- Touching the gate (`gate-bash.ts`).

## 2. Evidence (verified on the owner's machine, 2026-09-26)

1. **Usage is dominated by cache re-reads.** Over 3 days of real transcripts:
   - Sonnet: 74% cache reads, 25% writes, 1% output.
   - Opus 5.5: 57% reads, 32% writes, 10% output.
   - The average context re-read per response is 243k tokens (Sonnet) and 379k (Opus).
2. **The prompt cache is per model.** A live demo routed 4 turns to 4 models in one session. Each switch had `cache_read = 0` and a cache write of 58-82k tokens.
3. **A `turn.step` rewrite of `effort` also rewrites the cache.** Test, one session on Opus 5.5 with effort low → xhigh → low:
   - turn 2: read 12.4k, write 30.4k;
   - turn 3: read 42.9k, write 1.4k (it reused turn 1's low-effort cache).

   Each effort level keeps its own cache beyond a shared first ~12k tokens.
4. **Prices** (list, $/MTok; subscription usage is token-weighted in the same proportions per the Claude Code costs docs):

   | Model | Input | 1h cache write | Cache read | Output |
   |---|---|---|---|---|
   | Haiku 4.5 | 1 | 2 | 0.10 | 5 |
   | Sonnet 5 | 2 | 4 | 0.20 | 10 |
   | Opus 5.5 | 4 | 8 | 0.20 | 20 |
   | Fable 5.1 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

   Fable prices are unknown: price it as ≥ Opus, a parameter that is configurable and defaults to 2× Opus.
5. **Orca accounts.** Orca sets `CLAUDE_CONFIG_DIR=<orca>/claude-accounts/<uuid>/auth`. The provider comes from that vault's `settings.json` `env`. On this machine:
   - Accounts bbbbbbbb, aaaaaaaa and cccccccc are Anthropic direct.
   - Account dddddddd is a z.ai gateway: `ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3`, `…SONNET…=glm-5.2`, `…HAIKU…=glm-4.5-air`, `ANTHROPIC_MODEL=glm-5.3`.
6. **Subagents.**
   - The function-hooks event `agent.spawn` (`AgentSpawnInput`) lets a hook set `model` (an alias or a full id).
   - There is no effort field, so subagent effort is out of scope.
   - A family alias (`opus`) collapses to the parent's exact model when the parent is already in that family. **Always emit full model ids.**
7. **Available signals.**
   - `turn.step` gives `model`, `effort`, `agentId`, `index`; its result gives `usage` (the 4 token counts plus the answering model).
   - Slice 1 writes hourly `turn-usage-*.jsonl` with `{at, agent, model, effort, input, output, cacheRead, cacheWrite, stopReason, account}`, and the worker mirrors `quota.json` per account (`sessionUsedPercent`, `weeklyUsedPercent`, `resetsAt`, `fableWeekly`, `status`).

## 3. Where decisions happen

A decision is free (no cache lost) only in a cold context:

| Point | Engine hook | What is decided | Default |
|---|---|---|---|
| **A. Session start**: first main-loop step of a session, meaning no assistant message yet in `$.session.messages()` | `turn.step` (main loop, `agentId` absent, `index === 0`) | model and effort for the session | measure |
| **B. Subagent spawn** | `agent.spawn` | model (full id) | measure |
| **C. Stage change mid-session**: first step of a turn (`index === 0`) | `turn.step` | switch model and effort only if the rules in §6 say so | measure |

After a decision at A or C, the chosen model and effort are **sticky**. Every later step of the session reuses them (rewrite `e.model` / `e.effort` to the sticky values) until a new stage decision at C changes them. Keep the sticky state in `$.state` (session-scoped) as described in the plugin API, not in module variables.

**Warm sessions.** Sometimes the sticky state is empty although the session already has assistant messages: the mode was switched on mid-session, or the module hot-reloaded.
- On the first such step, adopt `e.model` / `e.effort` as the sticky values and change nothing.
- From then on, only point C applies, with its hysteresis.

A switch is therefore only visible in a **fresh** session. The live tests (§10) must use fresh sessions.

## 4. Tiers

`simple` | `standard` | `complex` | `frontier`

- **simple**: greetings, short questions, running commands, reading and summarising.
- **standard**: implementing a clear plan, routine edits and tests.
- **complex**: design, debugging across modules, reviews, security-sensitive work.
- **frontier**: formal reasoning, hard algorithms, the hardest architecture calls.

Tier → effort (applied only where the model supports effort; Haiku has none, so omit it):
- simple → `low`
- standard → `medium`
- complex → `high`
- frontier → `xhigh`

## 5. Per-account model resolution (pure, `src/core/model_router_accounts.ts`)

**Input:**
- the vault `settings.json` env (read with `$.fs` from `CLAUDE_CONFIG_DIR`);
- the plugin models catalog (`models-catalog.json`, with availability and ranks);
- `quota.json` for the account.

**Output:** a map `tier → { modelId, label, supportsEffort, prices }`.
- **Anthropic direct:**
  - simple → `claude-haiku-4-5-20251001`
  - standard → `claude-sonnet-5`
  - complex → `claude-opus-5-5`
  - frontier → `claude-fable-5-1`

  Fable qualifies only when the catalog marks it available AND the quota shows a `fableWeekly` window that is not exhausted. Otherwise frontier maps to Opus 5.5.

  On this machine today, only account aaaaaaaa has a `fableWeekly` window, and its weekly quota is at 100%. So on the accounts a live test can use, frontier resolves to Opus 5.5. That is correct behaviour, not a failure: do not chase a Fable pass.
- **Gateway** (`ANTHROPIC_BASE_URL` set to a non-Anthropic host):
  - simple → `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  - standard → `…SONNET…`
  - complex and frontier → `…OPUS…`

  Mark prices UNKNOWN, which disables break-even-based downgrades on that account. Only guard-driven upgrades and session-start choices apply.
- **Collapse:** if two tiers resolve to the same id, they are the same tier.
- **Never** return a model the account cannot serve.
- **Filesystem grant.** Reading `<CLAUDE_CONFIG_DIR>/settings.json` through `$.fs` needs an explicit fs-read grant, the same class as the `~/.claude.json` grant slice 1 added in commit 0da7c4c. Add it the same way.

## 6. Decision rules (pure, `src/core/model_router_decide.ts`)

### 6.1 Jev question
One Choice question over the 4 tiers. The context carries:
- the prompt text of this turn, redacted with the existing `redactSecretsForJev`, first 2,000 chars;
- a compact activity summary of the previous turn: number of tool calls, files edited, tests run and failed, errors;
- the destination kind from the catalog, when known (`client-site`, `service`, `project`);
- the quota pressure band.

The answer is a tier plus confidence. Reuse the existing Jev client (`src/core/jev.ts`) and its timeout and fail-open conventions. On any Jev failure, make no change.

### 6.2 Quality guards (hard, evaluated after Jev)
Never go **below** the session's configured model when ANY of these holds:
- the destination is `client-site` or matches a `requires_human` / `prohibits` policy;
- the turn text or activity mentions security, credentials, release, deploy, migration or production (a word list in code, with a test);
- the previous turn had a tool error or a failing test;
- Jev's confidence is < 0.70.

Upgrading is always allowed.

### 6.3 Session start (point A)
Choose `resolved[tier]`, subject to the guards. With quota pressure (§6.5), shift simple/standard down one tier when the guards allow it.

### 6.4 Stage change (point C)
Let `current` be the sticky model and `proposed` be `resolved[tier]`.

**Upgrade** (proposed rank stronger than current):
- switch immediately, when Jev's confidence is ≥ 0.70, or when a guard requires it (the previous turn failed on the weaker model).

**Downgrade:**
- require the same lower tier on **2 consecutive turns** (hysteresis);
- AND break-even is positive:
  - `contextTokens` = last main step's `input + cacheRead + cacheWrite + output` (from the latest turn-usage record of this session);
  - `switchCost = contextTokens × writePrice(proposed)`;
  - `stepSaving = contextTokens × (readPrice(current) − readPrice(proposed)) + avgOutput × (outPrice(current) − outPrice(proposed))`;
  - `expectedSteps` = median steps per turn in this session × 3, with a floor of 5 and a default of 10;
  - switch only if `stepSaving × expectedSteps > 1.2 × switchCost`.

Effort changes follow the same rule: a change of effort alone costs a cache rewrite. Treat it as a switch with `readPrice` equal, so the saving comes only from output. In practice, effort changes only together with a model change or at session start.

### 6.5 Quota pressure bands
From `quota.json` for this account (`weeklyUsedPercent`):
- `< 80` → normal: no shift, 2-turn hysteresis.
- `80–94` → economy: shift simple/standard down one tier where the guards allow, and relax hysteresis to 1 turn.
- `≥ 95` → strong economy: also allow standard → simple for read-only turns.

A missing or stale quota (> 30 min) means normal.

## 7. Modes

- `off`.
- `measure` (**default**): decide, log, change nothing.
- `active`: opt-in, per account.

**The switch exists from the first work unit (part of T6).**
- Declare it in the mod-skills plugin manifest's `userConfig`: `routerMode: { type: "string", options: ["off", "measure", "active"], default: "measure" }`.
- Per the plugin API, a string field with `options` becomes a picker in Claude Code's own config menu, and a change reloads the module with the new `options`.
- Verify where `pluginConfigs` is stored when `CLAUDE_CONFIG_DIR` is set (the account vault's settings.json, which makes the switch per account). Write down what you found.
- The Orca config panel (T9) later wraps this same setting. It never adds a second source of truth.

Every decision appends to `model-router-decisions.jsonl` (hourly files, like turn-usage):
`{at, account, point: "start"|"stage"|"subagent", tier, confidence, current, proposed, applied, reason, guard, contextTokens, switchCost, stepSaving, expectedSteps, quotaBand}`

No prompt text.

## 8. Visibility

- **Status line** (active and measure), in the person's locale:
  - es: "jev · modelo: Sonnet 5 · esfuerzo medio (etapa: implementar)"
  - measure mode prefixes "mediría:" / "would use:".
- **Model identity.** When active and the model differs from the session's configured one, give the model one note for that turn: "This turn runs on <label> (<id>)". The model otherwise believes the system prompt's model name, as observed live.

  `additionalContext` is a classic-hook field; `turn.step` has none. Find the declared event in `claude-code.d.ts` that can add this note (the system prompt's sections, or the first message's context blocks). If no event fits, return it as a decision gap. Do not invent one.
- **Board.** The Consumption card gains a "Model router" section with:
  - decisions by point and tier;
  - applied vs measured;
  - estimated tokens saved = Σ(stepSaving × steps actually taken after a switch) − switchCost, from real turn-usage records after each applied switch, labelled as an estimate.

## 9. Tasks (Strict TDD: RED first for every task)

**Step 0.** Run `/plugin-types` in your session and read `claude-code.d.ts`. Take every event input, `$` method and field this document names by concept from the declared types: `turn.step`'s input (`index`, `agentId`), `$.state`, `$.session.messages()`, `agent.spawn`, `userConfig`. Where a declared type contradicts this document, the type wins. Record it as a gap.

**Order.** The goal is a switch the owner can try on this machine as early as possible.
- **Work unit 1** (one commit or a short series): T1, T3, T2, then T6 with the `routerMode` picker (§7), then the status line half of T10.
  - End it with a live check: `claude --plugin-dir <installed copy>` in a FRESH session, `routerMode=active`, a simple prompt, then a complex one.
  - The API-reported `usage.model` of each step must match the decision.
  - Write the result to the report before moving on.
- **Work unit 2:** T4, T5, T7.
- **Work unit 3:** T8. For its live check, the installed 0.5.3 classic `agent-model.ts` PreToolUse:Agent hook would also rewrite, so disable one of the two for the test and say which.
- **Work unit 4:** the identity-note half of T10, then T9 and T11.

- **T1 Account resolver** (§5). Pure, with unit tests: Anthropic direct; the Fable gate (catalog × quota); gateway mapping; collapse; never an unavailable model.
- **T2 Jev tier question** (§6.1). A question builder and answer parser, with tests against a fake Jev: the redaction is applied, the context fields are present, failure means no change.
- **T3 Guards** (§6.2). Pure, with tests for each guard, including "upgrade always allowed".
- **T4 Break-even and hysteresis** (§6.4). Pure. Tests:
  - the worked example: 80k context, Opus→Haiku; saving per step `80k×0.1e-6 + 700×15e-6` vs switch cost `80k×2e-6`; decide only with enough expected steps;
  - the 2-turn hysteresis;
  - upgrade immediacy;
  - unknown prices disable downgrades.
- **T5 Quota bands** (§6.5). Pure, with tests, including stale and missing quota.
- **T6 Session-start routing** in the function-hooks plugin (`adapters/claude/mod-skills/hooks/index.ts`). A `turn.step` hook at point A, plus stickiness on every later step via `$.state`. Measure vs active. Hook tests with the existing fake `$`:
  - measure changes nothing;
  - active rewrites `model` (and `effort` only when supported);
  - Jev failure changes nothing.

  Keep the engine static rules:
  - `$` is passed only to top-level same-file functions;
  - `$.noun.method()` is spelled that way at the call site;
  - `$.env.get` takes a literal;
  - `register` is named.

  `adapters/orca/mod_skills_validate.test.mjs` must stay green.
- **T7 Stage switching** (point C). Hook tests for:
  - an upgrade on failure;
  - a downgrade after 2 turns with positive break-even;
  - no downgrade under a guard.
- **T8 Subagent routing** (point B). Add an `agent.spawn` hook. Test that it:
  - uses the resolver and the decision with the subagent's prompt;
  - emits full ids;
  - applies the guards;
  - respects an explicit `model` the parent passed. That is intent: never downgrade it, only upgrade on a guard.

  Reconcile with the existing classic Agent hook (`adapters/claude/agent-model.ts`) so the two never both rewrite. Pick one and document the choice. The function hook is preferred.
- **T9 Config panel switch** (off / measure / active) and the board "Model router" section. i18n es/en, accented, no " -- ". Playwright tests. The existing controls-touching check must pass. Screenshots at 1440 light and 390 dark, read.
- **T10 Status line and identity note** (§8). Tests for both modes and both locales.
- **T11 README section and version bump to 0.6.0**. The README states the evidence in plain words and what is measured.

## 10. Verification before merge

- `npm test`, `npm run test:panels`, `npm run shots` (quick) all green.
- A live check, as the prototype did: in a real session with `active` on a sandbox, 4 prompts (simple, standard, complex, frontier).
  - The API-reported `usage.model` must match the decision.
  - Stickiness: a follow-up simple turn after a complex one does NOT downgrade until hysteresis and break-even allow it.
  - Record `cache_read` / `cache_write` per step.
- Opus review of the full diff against this document before merge. It runs on the client-i or z.ai account, not on bbbbbbbb.

---

## 11. Progress (writer's record)

TDD: strict, from the owner's global instructions; runner `node --test --experimental-strip-types` (`npm test`). Delivery strategy: ask-on-risk; the branch is one feature, not pushed. RDD: off by the owner's standing request (verification by tests, live checks and the Opus review in §10).

Step 0: this machine runs Claude Code 2.1.283; the repo's `claude-code.d.ts` came from 2.1.277. It was regenerated from the 2.1.283 engine's own declaration file (the plugin-authoring skill writes it; `/plugin-types` writes the same file). Every name used below was checked against it.

### Base

Rebased on 2026-09-27 at the owner's request onto `devuser/jev-060-consumption` (slice 1 finished; 0.6.0 ships slices 1 and 2 together from this branch). The owner named `492ae8e`; that branch's tip was `cf27f3e` (a docs commit on top of `492ae8e`), so the base is `cf27f3e`. No conflicts; `npm test` 1960 pass, 0 fail. Commits before → after the rebase: `ba51c8f`→`de4175a`, `6c952f1`→`55106fe`, `6a26c8a`→`a776f4a`, `680ceac`→`062b47a`, `f93a87e`→`3547bb0`.

### Checklist

- [x] T1 Account resolver: `src/core/model_router_accounts.ts` (route: inline).
- [x] T3 Guards: `activeGuards` in `src/core/model_router_decide.ts` (inline).
- [x] T2 Jev tier question: `buildTierState` / `buildTierQuestions` / `interpretTier` (inline).
- [x] T6 Session-start routing + stickiness in `hooks/index.ts`; `routerMode` userConfig picker (`src/core/model_router_mode.ts`, installer manifest); `$.state` contract `adapters/claude/mod-skills/types/index.d.ts` (inline).
- [x] T10 (status-line half): `src/core/model_router_status.ts`, `src/core/i18n_model_router.ts` (inline).
- [x] WU1 live check (fresh sessions, `--plugin-dir`, `routerMode=active`).
- [x] T4 Break-even and hysteresis: `src/core/model_router_stage.ts` (inline).
- [x] T5 Quota bands: `quotaBandOf`, `hysteresisTurns`, `shiftForPressure` (inline).
- [x] T7 Stage switching (point C) in `hooks/index.ts`, with per-session usage stats in `$.state` (inline).
- [x] WU2 live check (one session, six turns).
- [x] T8 Subagent routing (point B): `src/core/model_router_subagent.ts`, `agent.spawn` in `hooks/index.ts`; the classic `agent-model.ts` yields when the router is active (inline).
- [x] WU3 live check (subagent).
- [x] T10 (identity-note half): not built, by the owner's decision on G9; the README states the consequence.
- [x] T9 Config panel switch (per account, off/measure/active) + board "Model router" section + short account label on the quota rows (owner request). Route: delegated (Sonnet writer, mechanical panel/worker/Playwright work); reviewed, re-verified and one alignment fix by the parent. TDD note: the worker, script and sidecar tests were observed RED first; the board/config markup and its Playwright tests were written together, not red-first (the writer's own report).
- [x] T11 README 0.6.0 section + version 0.6.0 (`package.json`, `orca-plugin.json`).

Route note: WU1 was written inline, against the delegation trigger, because the pure modules and the hook share one set of types decided while writing them; the mechanical panel/copy work (T9) is the delegated part.

### WU1 live check (2026-09-27, account cccccccc, Anthropic direct)

`claude -p` with `--plugin-dir <installed copy built by planModSkillsCopy>`, `--settings` carrying `pluginConfigs.orca-jev-mod-skills.options.routerMode`, `--output-format stream-json`. A same-named installed plugin is not loaded: the engine logs "the name orca-jev-mod-skills is already taken by a session-only plugin (--plugin-dir), which takes precedence".

| Run | Session model | Decision | API `usage.model` per step | cache_read / cache_write per step |
|---|---|---|---|---|
| simple, active | Opus 5.5 | simple (conf 1.0) → Haiku 4.5, no effort | haiku-4-5-20251001 | 12,821 / 15,607 |
| complex, active | Sonnet 5 | complex (conf 0.99) → Opus 5.5, high | opus-5-5 | 0 / 39,973 |
| simple + Read tool, active | Opus 5.5 | simple → Haiku 4.5 | haiku, haiku (sticky on step 2) | 12,821 / 15,616; 28,437 / 434 |
| simple, measure | Opus 5.5 | would use Haiku; `applied:false` | opus-5-5 | 10,131 / 23,228 |

### Decisions taken where the spec was silent (review these)

1. A tier's model the catalog marks unavailable falls to the next STRONGER available model, then to the strongest weaker one. A catalog row that is missing (no mirror yet) does not make Haiku/Sonnet/Opus unavailable; Fable needs an explicit `available: true`.
2. Gateway: a missing `ANTHROPIC_DEFAULT_*_MODEL` falls up to the next declared one, then `ANTHROPIC_MODEL`; `supportsEffort` is false on a gateway (no evidence any gateway model takes effort).
3. The live process env fills the vault env's gaps (`{...processEnv, ...vaultEnv}`); the vault wins.
4. When a guard holds the floor, the session's own EFFORT is kept too, not only its model.
5. A session model the account's tiers do not include (e.g. an older id) counts as "not comparable" and is never gone below under a guard.
6. The person (or the engine's fallback) moving the session off the model the router took over from wins: the router adopts it and stops rewriting.
7. Effort is left out of the request when the chosen model takes none (Haiku, gateway); `max` and numeric efforts are the session's own and never produced by the router.
8. The router's status line and the skill/tool status line are shown together (one status entry per plugin).
9. Status-line copy: stages es "consultar / implementar / analizar / razonar a fondo", en "ask / implement / analyse / deep reasoning"; effort es "bajo / medio / alto / muy alto", en "low / medium / high / extra high". Measure mode: "jev · mediría: <model> ..." / "jev · would use: <model> ...".
10. The quota.json account row is matched by exact `id === <uuid from CLAUDE_CONFIG_DIR>`.

### WU2 live check (2026-09-27, account cccccccc, one `claude -p` session over stream-json input, each prompt sent after the previous result, session model Sonnet 5, active)

| Turn | Prompt kind | Decision (point, tier, conf → reason) | API `usage.model` | cache_read / cache_write |
|---|---|---|---|---|
| 1 | simple | start, simple 1.0 → Haiku (switch) | haiku-4-5-20251001 | 28,054 / 0 |
| 2 | standard | stage, standard 0.52 → Sonnet (floor-restore, low-confidence) | sonnet-5 | 18,652 / 26,846 |
| 3 | complex | stage, complex 0.96 → Opus (upgrade) | opus-5-5 | 24,050 / 21,339 |
| 4 | frontier | stage, standard 0.37 → stay Opus (held-by-guard, low-confidence) | opus-5-5 | 45,389 / 587 |
| 5 | simple | stage, simple 1.0 → stay Opus (hysteresis) | opus-5-5 | 45,976 / 421 |
| 6 | simple | stage, simple 0.99 → stay Opus (break-even: ctx 46,415, switch 0.0928, saving 0.0077/step × 5) | opus-5-5 | 46,397 / 81 |

The first run of this session exposed a bug: turn 2 stayed on Haiku (below the session's Sonnet) under a low-confidence guard. Fixed so ANY guard restores at least the session's own model (decision 11); the table above is the re-run.

### More decisions (WU2)

11. §6.2 read with §6.4: when the sticky model is below the session's own and ANY guard holds, the next stage restores at least the session's own (or the proposal, if stronger). The spec names only "the previous turn failed"; the §6.2 floor ("never below the configured model when ANY of these holds") covers the rest.
12. Same-rank proposals change nothing, effort included: an effort-only downgrade never passes break-even (same prices), and §6.4 says effort in practice changes only with a model change or at start.
13. An upgrade proposal under 0.70 with the session at or above its own model waits (reason `low-confidence`).
14. Turn-usage records carry no session id, so break-even's `contextTokens`, `avgOutput` and steps-per-turn come from the same numbers kept per session in `$.state` after every main step (see G5).

### WU3 live check (2026-09-27, account cccccccc, fresh session on Opus 5.5, active)

The installed 0.5.3 classic `agent-model.ts` PreToolUse:Agent hook is registered on this account, but its own switch in `models-catalog.json` is `active:false, ready:false`, so it only measures and never rewrites: neither hook was disabled for the test. From this commit on it also never rewrites while `routerMode` is `active` in the account settings (T8 reconciliation: the function hook owns subagent models).

| Step | Decision | API `usage.model` | cache_read / cache_write |
|---|---|---|---|
| main 1-2 | start: simple 1.0 → Haiku | haiku-4-5-20251001 | 12,821 / 10,434 ; 23,255 / 6,128 |
| subagent 1-2 | subagent: simple 1.0, parent opus-5-5 → claude-haiku-4-5-20251001 (full id) | haiku-4-5-20251001 | 0 / 14,231 ; 14,231 / 3,344 |
| main 3 | stage: simple 0.99 → same | haiku-4-5-20251001 | 29,383 / 635 |

Observation: when the subagent finished, the engine started a new main turn (index 0 of a new turnId), so point C ran again on the same last prompt and answered "same" (one extra Jev call per such turn).

### More decisions (WU3)

15. `agent.spawn`'s `parentModel` is the session's configured model even when the router rewrote the main loop's steps (the engine resolves it, not the hook), so a subagent's baseline is the configured model.
16. A fork is left alone (its `model` is ignored by the engine). An explicit `model: "inherit"` counts as no explicit model.
17. The classic hook reads `routerMode` from `$CLAUDE_CONFIG_DIR/settings.json` (else `~/.claude/settings.json`) under the plugin's name or any `<name>@<source>` key (G8).

### Gaps (need the owner or the reviewer)

- **G1 §5 fs-read grant.** The spec asks for an fs-read grant for `<CLAUDE_CONFIG_DIR>/settings.json` "the same class as 0da7c4c". 0da7c4c is a Node `--permission` grant for the worker's consumption sidecar. The hooks module reads through `$.fs`, which has no grant model in the 2.1.283 declarations; the live check read the vault settings.json with no grant. No grant was added. If the worker (T9 board) needs to read vault settings, that grant belongs to T9.
- **G2 §7 where `pluginConfigs` is stored: RESOLVED from the engine.** Claude Code 2.1.283's own plugin loader keys a plugin's options by its source id: `--plugin-dir` plugins (`<name>@inline`) read `pluginConfigs["<name>"]` or `["<name>@inline"]`; plugins auto-loaded from a skills folder (how the installer installs this one) read ONLY `pluginConfigs["orca-jev-mod-skills@skills-dir"]`. Read from user settings (`<CLAUDE_CONFIG_DIR>/settings.json` with an Orca account, so the switch is per account), `--settings` and managed settings; never project settings. The config menu writes `userSettings`. The panel (T9) writes `ROUTER_SETTINGS_KEY` = `orca-jev-mod-skills@skills-dir`.
- **G3 macOS isolation.** `computeHomePaths` ignores XDG on macOS by design, so a live check cannot sandbox `~/.cache/orca-supervisor` without changing HOME, and a changed HOME loses the keychain login. The live runs used the real HOME; the router's own hourly files they created were moved out of the real cache into the evidence folder. The skill/tool measurement logs gained real lines from these real prompts (40→41 and 46→47 lines after the first logged run).
- **G4 §6.5 pressure shift: SETTLED by the owner (2026-09-27).** At weekly >= 95%, `standard` may go to `simple` only when the previous turn edited no files and ran no failing tool (no tool error, no failing test), and no guard holds. Implemented in `shiftForPressure`; economy (80-94%) no longer shifts a tier and only relaxes hysteresis to 1 turn; with no previous turn (session start, subagents) nothing shifts.
- **G5 §6.4 `contextTokens` source.** The spec says "from the latest turn-usage record of this session", but turn-usage records have no session field (slice 1 schema). The router keeps the same numbers per session in `$.state` instead. Adding a session id to turn-usage would let the board join them; not done (schema change outside this slice).
- **G6 destination kind and policy guard wiring.** The pure guards support `client-site` and `requires_human` / `prohibits`; the hook passes `destinationKind: null, policyHit: false` because the mod has no catalog/policy lookup for the session's destination yet (the gate reads a catalog mirror for commands, not for a session). Needs a decision on which destination a session "is" (its Orca worktree's project?).
- **G7 live-check file hygiene.** My first live cleanup moved whole shared hourly files; one of them held another session's router lines (account bbbbbbbb, 02:05). Restored into `~/.cache/orca-supervisor` the same hour; the live scripts now only copy their own lines out.
- **G8 classic-hook visibility of routerMode.** The classic `agent-model.ts` sees `routerMode` only in the account's user settings.json. A value set through `--settings`, a project settings file or managed settings is invisible to it; if both the router and the classic hook's own `active` switch were on in such a setup, both could rewrite one spawn (the classic hook's rewrite happens at PreToolUse, before `agent.spawn`, which then sees the rewritten `model` as explicit intent and never downgrades it).
- **G9 §8 model identity note: no declared event fits.** Checked against the 2.1.283 declarations:
  - `turn.step` rewrites only `model` and `effort`; everything else on it is pinned, so it cannot add text to the request.
  - `prompt.section` (a system-prompt section) and `prompt.context` (the first message's context blocks) are cached for the session; `$.ui.invalidate` drops the cached answer only from the NEXT turn, and any change there rewrites the whole prompt cache. The switching turn's own requests would still carry the old model name, and the next turn would pay a second full cache write on top of the switch.
  - `prompt.submit`'s `context` adds a per-turn note at no cache cost, but it runs before `turn.step`, where §3 puts points A and C, so the decision for that turn does not exist yet.
  - Options for the owner: (a) move the point A/C decision from `turn.step` into `prompt.submit` (it has the prompt text directly, and would also stop the extra point-C Jev call on engine-started turns seen in WU3), then note via `context`; (b) accept a note that names the model of the PREVIOUS turn; (c) accept the extra cache write of a `prompt.section` rewrite. The status line already shows the person the real model.

### Tier question against the real Jev (2026-09-27, one-off, owner request)

12 prompts, 3 per tier, `buildTierState` + `buildTierQuestions` + `interpretTier` exactly as the hook sends them (no activity, normal band), budget 5 s. No eval file kept (not wired into an npm script).

| expected \ got | simple | standard | complex | frontier | fail |
|---|---|---|---|---|---|
| simple | 3 | 0 | 0 | 0 | 0 |
| standard | 0 | 3 | 0 | 0 | 0 |
| complex | 0 | 0 | 3 | 0 | 0 |
| frontier | 0 | 0 | 0 | 3 | 0 |

12/12 exact. Confidence 1.0 on simple/standard, 0.98-1.0 on complex, 0.81-0.96 on frontier; latency 202-318 ms. Caveat: these prompts are explicit about their difficulty. In the WU2 live session, shorter real prompts drew lower confidence (standard 0.52; a halting-problem proof judged standard at 0.37), which the low-confidence guard then held at the session's own model.


## 12. Pre-release fixes (round 2, 2026-09-27)

Source: the owner's brief `brief-060-fixes.md` and the independent review `060-review.md` (12 findings). All done with RED observed first where behavioural.

- [x] G6 destination and policy guard: `src/core/model_router_destination.ts` (reuses `parseMirroredCatalog`, `parseMirroredPolicies`, `matchDestination`, `filterPoliciesForDestination`), wired at A, B and C in `hooks/index.ts` — `1984d2d`. Live: cwd `client-site-c` (client-site), Opus session, simple prompt 1.0 → held-by-guard `client-site`, API `usage.model` `claude-opus-5-5`, cache 10,131 / 25,703.
  - **Disagreement (evidence):** the brief says "any `requires_human` or `prohibits` policy in scope". All 23 policies on the owner's machine are global, 11 of them `requires_human`/`prohibits`; counted literally, every session would hold its floor and the router could never downgrade. Implemented: only policies scoped to this destination count; global ones are command rules the Bash gate already applies per command. Owner to confirm.
  - Cross-repo targets are command-text scoped in the gate; a session has no command, so only cwd → linked-worktree main checkout is matched (the gate's own fallback, resolved through `git rev-parse --git-common-dir` since the hooks module has no Node fs).
- [x] Findings 1, 2, 3, 4, 7, 10, 11, 12 — `12c2d88`.
- [x] Findings 5, 6 — `c2d62d7`.
- [x] Findings 8, 9 — `cb01148` (9 by the copy route: the count says "global ~/.claude.json").
- [x] C tier question: bilingual short examples per tier — `e22942e`.

Tier question vs the real Jev, 12 short prompts (es/en), 3 per tier: 12/12. Confidences: simple 1.0/1.0/0.99; standard 0.40 ("arregla el test que falla en auth") /0.98/1.0; complex 0.99/1.0/1.0; frontier 1.0/1.0/1.0.

| expected \ got | simple | standard | complex | frontier | fail |
|---|---|---|---|---|---|
| simple | 3 | 0 | 0 | 0 | 0 |
| standard | 0 | 3 | 0 | 0 | 0 |
| complex | 0 | 0 | 3 | 0 | 0 |
| frontier | 0 | 0 | 0 | 3 | 0 |

## 13. Round 3 (2026-09-27): reviewer's N1, N2, N3

- [x] N1: a stage downgrade back to the session's own model returns its exact id (`[1m]` included) and its own effort; `floor-restore` uses `exactModelId` too — `eb825bb`.
- [x] N2: an engine-started turn asks Jev nothing but evaluates `previous-failure` / `sensitive-topic` over the work since the last real prompt (`summarizeSinceLastPrompt`, `decideEngineTurn`); below the floor it restores the session's own model and effort — `5f94097`.
- [x] N3: point C is keyed on the last real prompt's identity: `SessionMessage` rows carry no stable id (`handle` is absent on `$.session.messages()`), so the key is an FNV-1a hash of the text (the text is never stored) plus its position. A different text is new; the same text is new only further down the transcript (a /compact moving it up is not) — `5f94097`. Accepted limit: the very same text typed again right after a /compact, at or above its old position, is taken as the same prompt (it keeps the sticky choice, which is safe).

Checks: `npm test` 2025 pass, 0 fail; `npm run test:panels` 77 pass, 0 fail; hooks typecheck clean.
