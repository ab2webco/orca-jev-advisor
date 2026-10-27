# JEVADV-117: the router escalates doubt and implementation work, and keeps a /model choice

## Objective
With `routerMode: active`, an orca-oss member stayed on Haiku 5.5 for a
TypeScript change with the status line `jev · modelo: Haiku 5.5 · esfuerzo
alto · se mantiene: poca confianza (Jev: consultar)`, and got the change
wrong. After the lead moved the session to Opus 5.5 with `/model`, the line
still read Haiku. The owner (2026-10-26): Jev raises the model when the work
needs it; implementation never stays on Haiku; a `/model` choice is not moved
back down.

## Scope
- T1 (PR 1): a low-confidence verdict raises Jev's tier to at least
  `complex` (Opus 5.5) at every router point (start, stage, subagent)
  instead of holding the model the session runs. A Jev failure still
  changes nothing.
- T2 (PR 2): a person's `/model` (or a mid-session model change) locks the
  model for the rest of the session: the router never moves it, in either
  direction, and the status line names it at once.
- T3 (PR 3): the main-loop Jev call also asks the work kind; an `implement`
  turn is floored at a named tier, `complex` (Opus 5.5) by default (lead,
  2026-10-26).

Out of scope: releases, tags, version bumps, tier prices, break-even.

## Tasks
- [x] T1: RED: the evidence row (Haiku session, `simple` at 0.53) upgrades
  to Opus; a low-confidence verdict on a Sonnet session upgrades; a Jev
  failure still changes nothing; an Orca pin still holds. GREEN. Commit.
- [ ] T2: RED: a `/model` back to the session's own model while the router
  had it on Haiku is not rewritten; after a person switch a light prompt
  does not move the model down; the status line names the person's model
  right after `/model`. GREEN. Commit.
- [ ] T3: RED: an `implement` turn judged `simple` or `standard` resolves
  to Opus 5.5, never Haiku or Sonnet. GREEN. Commit.

## Acceptance criteria
- RED-first tests for the routing decision on an implementation prompt and
  on a low-confidence verdict.
- The status line shows the model actually in use after a `/model` switch.
- `npm run check` green locally and in CI on each PR.

## Checks
`npm run check` (typecheck, unit tests, panel tests, screenshots).
