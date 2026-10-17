# Router honors Orca's model and effort pins in game panes (JEVADV-105)

## Objective
Orca Lab sets `ORCA_AGENT_MODEL_PINNED=1` and/or `ORCA_AGENT_EFFORT_PINNED=1` in an agent's process env when its launch asked for a model or an effort and that value took effect (orca-oss `src/shared/agent-launch-pin-env.ts`). In the Agent Teams game the lead launches members with `orchestrator.model` / `orchestrator.effort`. Jev's router read neither, so it could switch a pinned member on its next prompt.

## Scope (the owner's rule: only when the game and Jev run together)
- Jev in an Orca game pane (`parseOrcaGameMode`, 0.12.0 / 0.12.1: `ORCA_GAME_MODE` `on`/`zen`, and `ORCA_GAME_HUD` `0`/`false` is no game) with a pin set to exactly `1`: the router does not switch that dimension. Model pinned: no model switch. Effort pinned: no effort switch. The other dimension still routes.
- Covers the main session (start, stage), its subagents and teammates (the mod's `agent.spawn` / teammate routing), and the legacy Agent PreToolUse hook's model rewrite.
- Outside a game pane, with no variable, or with any value other than `1`: routing unchanged.
- A held switch is visible: the decision row's `reason` is `held-by-orca-pin` when nothing else changed, and `orcaPin` names the held dimensions; the status line says "kept: pinned by Orca"; the board counts only applied switches, so it claims none.

## Design
- `src/core/orca_pins.ts`: `orcaPinsOf(game, model, effort)` and `modelPinnedTiers(tiers, model)` (every tier resolves to the pinned model, so a decision can only route its effort).
- `decideStart` / `decideStage` / `decideSubagent` take optional `pins`. With a model pin the decision is made again over `modelPinnedTiers`; with an effort pin the session's own effort is kept (none on a model that takes none). The row keeps Jev's tier and proposed model.
- The mod reads the four variables (literal names) at each decision; the Agent CLI reads `process.env`.

## Checklist
- [x] T1 core: pins parsing, pinned decisions, record field, status reason, subagent why.
- [ ] T2 mod wiring: start, stage, subagent and teammate decisions read the pins in a game pane only.
- [ ] T3 legacy Agent hook: no model rewrite under a model pin in a game pane (`rewriteReason: "orca-pin"`).
- [ ] T4 env proof: the variables reach the hook processes.
- [ ] T5 release 0.13.1: version, README, CHANGELOG.

## Acceptance criteria
- Strict TDD: RED observed, then GREEN, per case: game + model pin, game + effort pin, both, no game with pins, HUD off with pins, value other than `1`.
- `npm run typecheck` clean, `npm test` green.

## Checks
`npm run typecheck`, `npm test`, `npm run check` (needs Playwright's Chromium).
