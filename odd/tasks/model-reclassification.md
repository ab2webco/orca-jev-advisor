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
- [x] **T5** `adapters/claude/agent-model.ts` (PreToolUse + PostToolUse on
  Agent), fail-open with a logged reason. Route: delegated writer.
- [x] **T6** Installer entries (matcher `Agent`), integration list text,
  revert; worker mirror of the catalog to `<configDir>/models-catalog.json`,
  seed-once + notice in main.mjs. Route: same writer as T5.
- [x] **T7** config.html Models section (ladder editor, availability,
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
- T5: delegated writer (writer trigger: hook handler + CLI + mirror parser).
  Live check 2026-09-24 against the real Jev API with the shipped seed
  (Fable unavailable, so 3 levels), bypassPermissions, via
  handleAgentModelHook + real callJev:
  - "list model_ files" (requested opus) -> Haiku 4.5, score 0.07-0.09,
    confidence 0.86-0.90, complexity trivial; latency 545-561 ms.
  - "design a module split" (requested haiku) -> Sonnet 5, score 1.00-1.05,
    confidence 0.70-0.72, complexity advanced; latency 183-194 ms.
  - Measurement mode printed nothing; active mode printed updatedInput
    echoing every field with the new `model`.
  Not verified live: a real Claude Code PostToolUse(Agent) payload, so the
  `resolvedModel` spelling (follow-up R3-003) is still unobserved.
- T6a: installer entries (matcher Agent on PreToolUse, PostToolUse,
  PostToolUseFailure), same writer.
- T6b: worker mirror/seed/notice/readout sidecars (bounded writer, worktree
  fabolivark/models-07-worker). New files: adapters/orca/models-worker.mjs
  (+ .test.mjs, 15 tests), adapters/orca/read-model-measurements.mjs
  (+ .test.mjs, 4 tests). Edited: write-secret-mirror.mjs (new `models-save`
  mode, validated `{active, ready, models}` shape, written to
  models-catalog.json with ordinary permissions like catalog-save/
  policies-save) and its write-guard test (+3 tests, mirroring the
  catalog-save refuse/sanity pair plus one shape-rejection test); main.mjs
  (imports, a new runReadModelMeasurementsScript sidecar-spawn function +
  MODELS_WORKER_OPTIONS constant, activation chain
  seedModelsIfEmpty->mirrorModels->publishModelsSeedNotice after the policy
  chain, runSecretPoll steps attendModelsMirrorRequest/
  attendModelsSeedRequest, publishModelMeasurements at activation and on the
  measurements interval, and one added `agentModelHook` check in
  checkClaudeIntegration since install-claude-integration.mjs's status()
  already reports that field). Storage keys: `models`, `modelsConfig`,
  `modelsMirrorRequest`, `modelsSeedNotice`, `modelsSeedRequest`,
  `modelsSeedResult`, `modelMeasurements` (all exported from
  models-worker.mjs), plus MODEL_SEED_MARKER_KEY/MODEL_SEED_OFFERED_VERSION_KEY
  re-exported from model_seed_notice.ts. R3-003 satisfied: the offered
  version is stored as exactly `{ version }`. `npm test`: 903/903 (baseline
  was already above 762 from T3-T6a; this slice added 22 new tests: 15 + 4 +
  3). Not committed by this writer (bounded-writer instruction: no commit/
  push) -- changes are uncommitted in the worktree, ready for the
  coordinator's own commit/PR step.
  Decisions made while implementing (not previously specified):
  - `options.mirror`/`options.readSummary` have no default inside
    models-worker.mjs (unlike `options.seedPayload`/`options.now`, which do):
    both must cross the permission sandbox via a spawned sidecar, and that
    plumbing (PLUGIN_ROOT/CACHE_DIR/sidecarEnv/execFile) already lives in
    main.mjs; duplicating it in models-worker.mjs would be a second,
    driftable copy, and importing main.mjs from models-worker.mjs would be
    circular (main.mjs imports models-worker.mjs to wire it into
    activation/runSecretPoll). main.mjs now defines MODELS_WORKER_OPTIONS
    once and passes it at every call site instead.
  - `mirrorModels`'s `ready`: derived from the last published
    `modelMeasurements.summary.readiness.ready` unless the caller passes an
    explicit `options.ready` override (publishModelMeasurements uses the
    override to avoid reading back its own just-published value).
  - `seedModelsIfEmpty`'s "otherwise untouched" branch (marker not true, but
    the stored catalog is already non-empty) does not write a decline
    marker the way seedPoliciesIfEmpty does for the analogous case -- the
    spec text said "otherwise untouched" and the required test list only
    covers "never touches an existing catalog", so this was implemented
    literally. Edge case worth flagging for T7 or a follow-up: if that
    branch is hit (an install with its own catalog, never marked) and the
    person later empties the catalog entirely, shouldSeedModels would seed
    it again, since the marker was never set to `true` in that branch.
  - `publishModelsSeedNotice`'s `items` are always computed from the diff
    (even when `due` is false), so `items.length` always matches
    `added + differing`; the panel is expected to only render them when
    `due` is true. An added item's `fields` is always `[]` (nothing to
    compare against); a changed item's `label` is the SHIPPED entry's label.
- T6b: commit 9af2670 (delegated writer). Review granted, approved,
  acknowledged (lineage review-b69f0c4d8a38a92c). Advisory follow-ups:
  child.stdin in runReadModelMeasurementsScript has no 'error' listener (an
  early sidecar exit could raise an unhandled EPIPE in the worker); mirror
  writes are not serialized, so a stale `ready` can land last; the doctor
  check and the readout failure paths are untested.
- T7: delegated writer; parent ran `npm run check` and read the images.
  Found and fixed at 320px: the Haiku title overflowed (shared .entry-name is
  flex 0 0 auto), and the agreement figure was labelled "what actually ran"
  while it compares against the requested model. The integration hint now
  lists the model catalog mirror (seven things, not six).
  Screens looked at: ready 1440 light+dark (ladder, active switch, readout),
  768 light (integration list), 320 light+dark (ladder after the fix),
  models-empty 320 light (empty catalog + empty readout), baseline 390 dark
  (baseline notice). All 96 renders passed the overflow and script-error
  check.
