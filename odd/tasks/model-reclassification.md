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

Slices:
- PR A: T1-T2 (catalog core + seed)
- PR B: T3-T4 (decision + measurement core)
- PR C: T5-T6 (hooks + installer + worker mirror)
- PR D: T7 (panel Models section + readout + screenshots)

## Tasks

- [ ] **T1** `seed/models.json` v1 + `src/core/model_catalog.ts`: entry shape
  `{id, provider, label, rank|null, agentModel, source, available}`, tolerant
  row parsing, `parseModelSeedVersion`, ordered ladder (ranked by rank, then
  unranked), `availableLadder`. Route: inline (one module + data, understood).
  Checks: `src/core/model_catalog.test.ts`.
- [ ] **T2** `src/core/model_seed_notice.ts`: seed-once marker, offered
  version, computed notice (added / changed / removed ids) and
  `applyModelSeedChoices` (only accepted ids replace user rows). Mirrors
  policy_seed_notice / policy_seed_import. Route: inline.
  Checks: `src/core/model_seed_notice.test.ts`.
- [ ] **T3** `src/core/model_decisions.ts`: Jev ChoiceQuestion built from the
  available ladder (criteria = entry labels + legend), state from the Agent
  input, `interpretModelChoice`, `decideModelRewrite` (active + ready +
  confidence >= threshold + differs), `buildUpdatedAgentInput` (echo all
  fields). Route: delegated writer (2 non-trivial files with T4).
- [ ] **T4** `src/core/model_measurement.ts` + readiness (reuse
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
(none yet)
