# Release 0.6.14: every running agent on its own row

## Objective
The status line groups running subagents by model (`agentes: 1 en Opus 5.5
(pedido explícito), 1 en Sonnet 5.5 (Jev lo bajó), …`), so the person cannot
tell which agent runs which model, and an agent started before a plugin
reload disappears from the count (4 running, 3 counted, owner screenshot
2026-09-30). Show one row per running agent, with what it is, what it is
doing, its model, its effort and why, above the prompt.
Authorized by the owner 2026-09-30: "Esa es la próxima versión, me gustaría
que salga lo más pronto", then "si ya está listo lo demás sácalo junto". Of the
rest, only the two small items are included (T3, T4); JEVADV-83, 84, 86 and
87 are not built yet and move to 0.6.15 so this release is not held for days.

## Scope
- T1 The data. Each running subagent carries, from `agent.spawn` in
  `adapters/claude/mod-skills/hooks/index.ts` (`routeSubagent`): its agent
  type, its description (the row label the tasks list shows), the model
  label, the effort it runs at (what `turn.step` sends it, or null), and the
  reason (`SubagentWhy`). The running set survives a plugin reload in the
  same session (persisted per session, pruned by `$.agent.list()` as today);
  an agent `$.agent.list()` shows running that the plugin has no record of
  gets a row with its type and description and the reason "sin datos:
  empezó antes de recargar el plugin" (es/en), never dropped from the count.
- T2 The rows. A render hook on the `AbovePrompt` band draws, only while at
  least one subagent runs: a heading with the count, then one row per agent
  in start order: type (a prefix shared by every row, such as `cineco-`,
  dropped), description (truncated to fit), model, effort, reason. Sized to
  `bodyColumns`; narrow widths drop the columns in this order: effort,
  reason text shortened, description truncated harder. It yields to a
  survey (`hasSurvey`), passes when there is nothing to show, and never
  breaks another plugin's band (if one draws there, it passes). The one-line
  status keeps the main session's part and shows `agentes: N` only.
  Measure mode says what it would use, as the line does today.
- T3 N-09 (qa-0.6.13, a false refusal 0.6.13 introduced; reproduced twice
  in this session): the commands T5 reads out of a python/node/perl/ruby
  heredoc are only the ones the program calls, never the same text inside a
  string literal. A `python3 - <<'EOF'` that writes a file whose text quotes
  a force push inside `os.system(...)` is not refused; the same call as code
  still is.
- T4 JEVADV-85: the Models tab on a catalog that is empty and never seeded
  says the plugin's models load when its worker starts (with what to check if
  they do not), instead of only "add a model with the form below"; a person
  who emptied the catalog on purpose still sees today's text.
- T5 README, QA in `odd/qa/qa-0.6.14.md`, release 0.6.14, live check.

Out of scope, 0.6.15: JEVADV-83 (command position), 84 (requires_human on
effect), 86 (N-06..N-08), 87 (steward thresholds).

## Checklist
- [ ] T1 per-agent data and reload survival
- [ ] T2 AbovePrompt rows
- [ ] T3 N-09 string literals in interpreter heredocs are data
- [ ] T4 JEVADV-85 empty-catalog hint
- [ ] T5 README, QA, release, live check

## Acceptance criteria
- Every new behaviour is a regression test observed failing before its fix.
- With four agents running (two of the same type), four rows, each naming
  its own model, effort and reason; the two of the same type told apart by
  their description.
- An agent started before a plugin reload keeps its row (with its model when
  it was recorded before the reload; "sin datos" otherwise); the count
  matches `$.agent.list()`.
- The band disappears when no subagent runs, yields to a survey, and never
  replaces another plugin's band.
- Seen in screenshots of the band rendered at 200, 120, 80 and 40 columns,
  in both themes if the engine has two, each image looked at and kept under
  `odd/qa/shots-0.6.14/`; the terminal equivalent of the 1440/768/390/320
  rule. If a width cannot be rendered, the QA says so in those words.
- N-09: the doc-editing heredoc of qa-0.6.13 is allowed; K-py-heredoc-force
  and N28/N30 of qa-0.6.13 are still `REFUSED`.
- JEVADV-85: the hint shows on a never-seeded empty catalog and not on one
  the person emptied; seen in screenshots at 1440, 768, 390 and 320, both
  themes.
- `npm test` green; no existing test weakened or removed.

## Checks
`npm test`; the mod's own tests (`adapters/claude/mod-skills/*.test.ts`);
screenshots of the band; a live session with four real background agents.
