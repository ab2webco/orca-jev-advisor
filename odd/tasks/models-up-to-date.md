# Models up to date (0.6.10)

## Objective

The router, the catalog and the panels use the current Anthropic lineup, with
its real prices, effort support and context windows, from one source of
truth. A daily check of Anthropic's public docs offers any change through the
existing catalog notice.

## Findings (2026-09-29, verified against platform.claude.com)

- Router standard tier is `claude-sonnet-5` (legacy). Current: `claude-sonnet-5-5`, $2 / $10.
- Fable 5.1 priced as 2x Opus ($8 / $40). Published: $10 / $50, cache read $0.25.
- Router ignores context windows: Haiku 4.5 is 200K, the rest 1M.
- Three copies of model data: `src/core/model_router_accounts.ts`, `seed/models.json`, `adapters/orca/panels/board.html`.

Sources: https://platform.claude.com/docs/en/about-claude/models/overview,
https://platform.claude.com/docs/en/about-claude/pricing

## Scope

- In: seed schema v2 (tier, prices, effort support, context window), router
  ladder read from the catalog, context-window floor, Board labels from the
  catalog, daily docs check feeding the existing seed notice, release 0.6.10.
- Out: gateway accounts (env-declared models stay as they are), Bedrock/Vertex pricing.

## Checklist

- [x] T1 Seed v2: `seed/models.json` version 2 with Sonnet 5.5 replacing Sonnet 5, and per model `tier`, `prices` (input, cacheWrite, cacheRead, output per MTok), `supportsEffort`, `contextWindow`. Parser and types accept the new fields; old rows without them still parse. Also `thinkingReadsFrom`, `defaultEffort`, `retiresNotBefore` (informational). Proof: model_catalog, model_seed_notice, config_html_models, models-worker tests green; npm test 2460/2460.
- [x] T2 Router ladder from the catalog: `resolveAccountTiers` takes tier model, label, prices and effort support from catalog rows; the hardcoded constants remain only as the fallback when the catalog lacks a field. Fable priced at its published $10/$20/$0.25/$50 (2x multiplier removed). Proof: model_router_accounts.test.ts 18/18; npm test 2464/2464.
- [x] T3b Thinking-loss guard: not needed. Main-loop routing decides only on a turn's first step (`e.index === 0` with a new turnId, hooks/index.ts routeMainStep); every later step replays the sticky model, so no switch ever lands mid-turn. `thinkingReadsFrom` is recorded in the seed as data.
- [x] T3 Context-window floor: a step or subagent is never routed to a model whose context window is smaller than the current context plus a margin; logged as a guard. Stage decisions (point C) only: point A and subagent spawns have no context yet. Proof: model_router_stage.test.ts context-floor tests (300K never Haiku), npm test 2470/2470.
- [ ] T3b Thinking-block compatibility: catalog field `thinkingReadsFrom`; on the main loop, a switch to a model that cannot read the current model's thinking blocks happens only on a turn's first step, never mid-turn (Sonnet 5.5 cannot read Opus 5.x / Fable blocks; the API drops them silently).
- [x] T4 Board labels read from the catalog instead of a hardcoded map. The Board reads the `models` storage key on every reload; an unknown id shows as itself. Proof: board_html_models.test.mjs 3/3; the two affected panels.spec board tests pass.
- [ ] T5 Daily docs check: the worker reads the public models and pricing pages once a day, parses them into seed rows, and on a difference offers them through the existing seed notice. Any failure keeps the last good data and logs one line.
- [ ] T6 Release 0.6.10: README section, versions, screenshots, PR, merge, release, catalog pointer.

## Acceptance criteria

- On an Anthropic account the standard tier resolves to `claude-sonnet-5-5`, labelled "Sonnet 5.5".
- Fable 5.1 prices are $10 / $50 / cache read $0.25.
- With 300K tokens of context the router never proposes Haiku 4.5.
- An existing install sees the catalog notice offering Sonnet 5.5 and accepts it.
- A docs page that fails or changes format leaves routing unchanged.

## Checks

`npm test`, `npm run test:panels`, `npm run shots:all` (looked at), CI green.
