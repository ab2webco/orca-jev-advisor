# Jev reclassifies the model a subagent runs on, from a versioned model catalog

## Objective
When Claude Code calls the `Agent` tool, Jev reads the task (prompt,
description, subagent_type) and recommends which model it should run on,
chosen from a model catalog the user owns. Measurement first: by default the
recommendation is recorded next to what was requested and what actually ran,
and nothing changes. Active mode (off by default, gated by readiness) rewrites
`model` only when Jev is confident and disagrees.

## Problem
The orchestrator picks the subagent model by habit. There is no record of
which model a task needed versus which it got, and no user-owned list of
models to choose from.

## Documented mechanism (cite in code)
- PreToolUse on `Agent` may return `hookSpecificOutput.updatedInput`; it
  REPLACES the whole `tool_input` and needs `permissionDecision: "allow"`, so
  every original field is echoed. https://code.claude.com/docs/en/hooks#pretooluse-decision-control
- The per-invocation `model` is first in subagent model resolution; it accepts
  an alias (`sonnet`, `opus`, `haiku`, `fable`) or a full model ID.
  https://code.claude.com/docs/en/sub-agents#choose-a-model
- Alias resolution per provider (Anthropic API: `opus` -> Opus 5.5,
  `sonnet` -> Sonnet 5). https://code.claude.com/docs/en/model-config
- PostToolUse on `Agent` reports `resolvedModel` (plus usage/duration when
  present). https://code.claude.com/docs/en/hooks#agent
- Out of scope: per-call effort, the main session model.

## Catalog sources (baseline v1)
- Ladder order (Fable 5.1 > Opus 5.5 > Sonnet 5 > Haiku 4.5): the "Compare
  models" table, descriptions and comparative latency,
  https://platform.claude.com/docs/en/about-claude/models/overview, and base
  prices https://platform.claude.com/docs/en/about-claude/pricing (prices are
  not shown to the user; they only support the order).
- Other providers (OpenAI Codex, Gemini, GLM): not shipped. The Agent tool's
  `model` only takes Claude aliases/IDs (sub-agents doc above), so a non-Claude
  entry could never be applied. The user can still add entries by hand; an
  entry without a rank is "unranked" and never chosen.

## Scope
New files only where possible; config.html gets one self-contained Models
block. Not touched: gate-bash.ts, gate_cache.ts, command_shape.ts,
decisions.ts, gate-outcome.ts (PR 2), board.html, read-measurements.mjs,
panel_values.mjs (PR 3), the Team policies notice block (PR 4).

## Constraints
`src/core` pure (clock/randomness injected); `src/core/paths.ts` guard;
no fs.cp / fs.symlink; no invented numbers; no console.log; English artifacts.

## TDD
Mode: strict, ON (source: coordinator brief + odd/CHECKPOINT.md).
Runner: `npm test` (`node --test --experimental-strip-types`). Baseline 762/762.

## Delivery
Strategy: `auto-chain`, chain `stacked-to-main` (team policy large_pr ~400
authored lines per PR; coordinator brief). RDD on (global): after each
work-unit commit run `gentle-ai review assess --committed-only`; consent is
relayed through `orca orchestration ask`.

Slices (revised after the first slicing pass; one PR per work unit):
- PR 1 (#19): T1 catalog + seed. Base main.
- PR 2 (#20): T2 seed-once + notice. Base PR 1.
- PR 3: T3 Jev question + rewrite decision. Base PR 2.
- PR 4: T4 measurement records + readout + readiness. Base PR 3.
- PR 5: T5-T6a Agent hooks + installer entries. Base PR 4.
- PR 6: T6b worker mirror/seed/notice/readout sidecars. Base PR 5.
- PR 7: T7 config panel Models section + screenshots. Base PR 6.

## Decisions
- Question shape: an ordinal ScoreQuestion whose levels are the available
  ladder, smallest first (index 0 = smallest). The score rounds to a level,
  so "up / down" in the readout is a rank delta. Built from the catalog at
  call time; adding or reordering entries needs no code change.
- `agentModel` ships as the aliases `fable/opus/sonnet/haiku`: the Agent tool's
  own input schema enumerates aliases, and model-config documents what each
  resolves to per provider. Editable per entry.
- Fable ships `available: false`: model-config says the `fable` alias applies
  only "where Fable is available to you".
- Active mode needs `permissionDecision: "allow"` for `updatedInput` to apply,
  so an active rewrite also auto-allows that one Agent call. Measurement mode
  emits nothing on stdout, so permissions are untouched.
- Coordinator direction (after slice 1+2 consent): an active rewrite is only
  offered when the call would have been allowed anyway. Only
  `bypassPermissions` qualifies: per the permission-modes table it is the one
  mode that runs "Everything" without asking (`acceptEdits` covers edits, and
  `auto` classifies a subagent task before it starts). Any other mode measures
  only, with reason `permission-mode`.
- Coordinator decision B: decisions.ts's unwired four-tier complexity
  question is asked in the same Jev call and recorded (`complexity`) as a
  measurement-only, model-agnostic effort reading. The ladder question still
  decides (U5). decisions.ts is imported, never edited (PR 2 owns it).
- A request that names no model counts as "different" in active mode: Jev
  decides independently of what was requested (U1).
- `DEFAULT_MODEL_REWRITE_CONFIDENCE = 0.7`: our starting threshold, not a
  measurement; readiness reuses mod-skills' 1000 comparable / 0.7 match rate.
- Records never store the prompt or description, only `subagentType` and
  `promptChars` (same discipline as gate_measurement.ts).

## Follow-ups (advisory review findings, not new commits)
- R3-001: `applyModelSeedChoices` appends a repeated shipped id twice.
- R3-002: the notice does not compute ids removed from a newer baseline.
- R3-003: the offered-version marker must be stored as `{ version }` (slice 6).

## Tasks

- [x] **T1** `seed/models.json` v1 + `src/core/model_catalog.ts`: entry shape
  `{id, provider, label, rank|null, agentModel, source, available}`, tolerant
  row parsing, `parseModelSeedVersion`, ordered ladder (ranked by rank, then
  unranked), `availableLadder`. Route: inline (one module + data, understood).
  Checks: `src/core/model_catalog.test.ts`.
- [x] **T2** `src/core/model_seed_notice.ts`: seed-once marker, offered
  version, computed notice (added / changed / removed ids) and
  `applyModelSeedChoices` (only accepted ids replace user rows). Mirrors
  policy_seed_notice / policy_seed_import. Route: inline.
  Checks: `src/core/model_seed_notice.test.ts`.
- [x] **T3** `src/core/model_decisions.ts`: Jev ChoiceQuestion built from the
  available ladder (criteria = entry labels + legend), state from the Agent
  input, `interpretModelChoice`, `decideModelRewrite` (active + ready +
  confidence >= threshold + differs), `buildUpdatedAgentInput` (echo all
  fields). Route: delegated writer (2 non-trivial files with T4).
- [x] **T4** `src/core/model_measurement.ts` + readiness (reuse
  `evaluateModSkillsReadiness`): decision/outcome records, join by
  tool_use_id, readout (up / down / agreement, counts only). Route: same writer.
- [ ] **T5** `adapters/claude/agent-model.ts` (PreToolUse + PostToolUse on
  Agent), fail-open with a logged reason. Route: delegated writer.
- [ ] **T6** Installer entries (matcher `Agent`), integration list text,
  revert; worker mirror of the catalog to `<configDir>/models-catalog.json`,
  seed-once + notice in main.mjs. Route: same writer as T5.
- [ ] **T7** config.html Models section (ladder editor, availability,
  reorder/add/remove, baseline notice, measurement readout, empty states),
  screenshot fixtures incl. empty catalog, `npm run check`, read the images.
  Route: delegated writer; screenshots read by the parent.

## Progress
- T1: commit d3d7937 (inline). PR #19.
- T2: commit 928d3ab (inline). PR #20. Review of T1+T2: granted, approved,
  acknowledged (lineage review-333bd5b5c55fbf0d), 3 advisory findings above.
- T3/T4: delegated writer (writer trigger: 2 non-trivial modules). RED observed
  as ERR_MODULE_NOT_FOUND for each module before implementation.
- T3: commit e443024 (delegated writer).
- T4: see the commit that adds src/core/model_measurement.ts (delegated writer).
