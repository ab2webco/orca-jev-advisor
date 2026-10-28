# Tool selection can be turned off, and starts off

## Objective
`odd/qa/native-runtime-verification.md` (2026-10-28) measured tool selection over a week, per plan:
- The advised tool matched the first tool used in **27.2%** of 1,984 decisions (Team 24.8%, Personal 34.0%).
- Always guessing "Bash" matches 69.2%.
- MCP advice, the part native tool search covers, matched 2.5%.

The owner approved turning it off ("Si dale", 2026-10-28). Today it cannot be turned off on its own:
- `activeTools` is a boolean, `measurement` or `active`, and both modes call Jev on every sampled prompt.
- The only way to stop those calls is to set the whole `skill-selection` module off, which also stops skill selection.

## Scope
- **T1 (core):** `src/core/mod_skills_config.ts` gives tool selection a three-way mode, `off | measure | active`. It is stored as a new `toolsMode` field.
  - A legacy `activeTools` boolean is still read when `toolsMode` is absent: `true` maps to `active`, `false` to `measure`, so an explicit past choice is kept.
  - With neither field, the mode is `off`.
  - A wrong-typed field falls back field by field, as today.
- **T2 (mod):** `adapters/claude/mod-skills/hooks/index.ts`: in `off`, the tool path makes **no** Jev call, injects nothing, and writes no decision row. Its `tool.call` observation also stops. The skill path is untouched. `options.activeTools` precedence keeps working: a boolean there maps as above.
- **T3 (Orca side):** `adapters/orca/main.mjs` publishes and accepts the three-way value through the mod-skills status and config request. `src/core/feature_modules.ts` lists `off` among the `activeTools (tools)` values, with `off` as the default.
- **T4 (panel):** `adapters/orca/panels/config.html` replaces the tool checkbox with the panel's existing three-way `<select>` (the model router rows' control), in English and Spanish. Covers `panels.spec` and the screenshot fixtures.
- **T5:** README, CHANGELOG (unreleased section) and the module docs that describe the tool switch.

## Checklist
- [ ] T1 core three-way mode with legacy mapping
- [ ] T2 mod skips the tool path entirely when off
- [ ] T3 Orca status, config request and module table
- [ ] T4 config panel select, both languages, shots looked at
- [ ] T5 docs

## Acceptance criteria
- Strict TDD: RED observed for each rule, then GREEN.
- Off proven by a test: zero Jev calls and zero tool decision rows for a prompt while skill selection still runs.
- Checks: `npm run typecheck`, the touched unit tests, `npm run test:panels`, and `npm run shots`. Shots looked at in 1440, 768, 390 and 320, both themes.
- No change to the owner's live config: after release, the owner's `activeTools: true` stays `active` until it is switched to Off in the panel.

## Checks
`npm run typecheck`, `npm test` (or the touched files), `npm run test:panels`, `npm run shots`.
