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
- [x] T2 mod wiring: start, stage, subagent and teammate decisions read the pins in a game pane only.
- [x] T3 legacy Agent hook: no model rewrite under a model pin in a game pane (`rewriteReason: "orca-pin"`).
- [x] T4 env proof: the variables reach the hook processes.
- [x] T5 release 0.13.1: `orca-plugin.json` and `package.json` (the only files 0.12.1 and 0.13.0 bumped), README section, CHANGELOG entry.

## Evidence
- RED then GREEN: `orca_pins.test.ts` failed to load (module missing), then 17 of 23 failing against the parse-only module; GREEN 23/23. `hooks.test.ts`: 6 new tests failing (game + model pin start, effort pin, both, stage, subagent model pin, subagent effort pin), GREEN 287/287. The three "changes nothing" hook tests (no game, HUD off, value `true`) passed before the wiring as characterization; a mutation that ignored the game turned the first two red, and one that took any value as a pin turned the third red. Agent hook: 1 unit test and 1 subprocess test red, GREEN; `model_measurement` round trip red, GREEN.
- Env reaches the hooks: the Agent CLI subprocess test sets the pins in the child's process env and the rewrite stops; the real `claude plugin validate` lists `ORCA_GAME_MODE`, `ORCA_GAME_HUD`, `ORCA_AGENT_MODEL_PINNED` and `ORCA_AGENT_EFFORT_PINNED` among the mod's env reads (`mod_skills_validate.test.mjs`, red when one read is removed). Live: the mod in an Orca-launched session logs `account` from `$.env.get('CLAUDE_CONFIG_DIR')`, a variable Orca puts in the launch env.
- `npm run check`: typecheck clean, `npm test` 4500/4500, shots without overflow or script errors, `test:panels` 274/274.
- Visual: no panel changed. The new status text and band reason only appear in a game pane, where Jev draws neither and publishes `advisor` to orca-game (orca-oss); not photographed here.

## Acceptance criteria
- Strict TDD: RED observed, then GREEN, per case: game + model pin, game + effort pin, both, no game with pins, HUD off with pins, value other than `1`.
- `npm run typecheck` clean, `npm test` green.

## Checks
`npm run typecheck`, `npm test`, `npm run check` (needs Playwright's Chromium).
