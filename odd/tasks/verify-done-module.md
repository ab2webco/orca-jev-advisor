# Verify the "done" module (M1, from jev-belay)

Branch `feat/verify-done-module`, from `main` at 0.7.1. Candidate M1 of `odd/tasks/feature-modules.md`; idea in `odd/backlog.md`, "Candidate modules from similar tools", item 1.

## Objective

Measure, in shadow, how often the agent ends a turn claiming the work is done while the turn's own run facts show it was not verified: it edited files and no test, typecheck or build passed. Nothing is blocked and no answer changes; the result is a local log and a number the owner can read, so that a week of data can decide whether an Active (blocking) state is worth building. The failure it targets is the one Rule 7 exists for: "it said it was done and it was not".

## What the first check found (the "first thing to verify")

The run facts are already held. `summarizeStewardActivity` (`src/core/context_steward.ts`) turns the turn's `ActivityMessage`s into `toolCalls`, `filesEdited`, `testsRun`, `testsPassed`, `committed`, `pushed`, `openedPr`, counts and yes/no only, never text. M1 reuses it; it adds no transcript parsing.

The mod's `turn.complete` hook (`adapters/claude/mod-skills/hooks/index.ts`, where `stewardAfterTurn` is scheduled) can only observe: it cannot refuse the end of a turn. Blocking needs a `Stop` hook entry in settings.json, which this repo does not install and `HookEvent` does not list. So this module ships Off and Shadow only, with no new hook entry and no new process per tool call. An Active state is a later task, gated on the measurement.

## Scope

In:
- A pure core module `src/core/verify_done.ts`: candidate rule, Jev state and question, interpretation, decision, record, file name, summary. No I/O.
- One registry entry `verify-done` in `src/core/feature_modules.ts` with states `off` and `shadow` only (as gate and board offer only off and active), default `shadow`, one mod feature `verify-done` on `turn.complete`, no settings hook, no worker job.
- The mod wiring: after a main-loop turn that ended with `reason === 'answer'`, a timer like the steward's runs the job.
- The Modules card in the config panel (es and en), wired to the existing save path, with its measured-cost line.
- `scripts/measure-module-cost.mjs`: a row for the module and the count of unverified claims.
- README and CHANGELOG (disclosure of what is sent to Jev), QA report `odd/qa/qa-0.8.0.md`.

Out: blocking, a Stop hook, labelled-corpus replay, anything in the gate.

## Design decisions

- **Candidate turns only.** A turn is a candidate when `filesEdited > 0` and not (`testsRun > 0` and `testsPassed === true`). Every other turn makes no Jev call and writes no row, so the cost is one Jev call on a minority of turns, not on every turn.
- **One Jev question** (`claim`, a choice): does the assistant's final message say the work is finished, working or passing (`claimed-done`), say it is partial, blocked or only proposed (`not-claimed`), or is it not about work done (`no-claim`). Unsure leans `not-claimed`: a shadow measure must undercount, not overcount.
- **State sent to Jev:** the final message redacted first and cut second (`redactSecretsForJev`, then a character cap, as `promptExcerpt` does for the steward), plus the counts from `StewardActivity`. Never file contents, commands or paths.
- **Decision:** `would-block` when Jev says `claimed-done` with confidence at least a floor (start at the steward's `STEWARD_CONFIDENCE_FLOOR`, 0.7), `claimed-unverified-low-confidence` below it, `not-claimed`, `no-claim`, `jev-failed` for a failure or a malformed answer (a failure is never a guess).
- **Default `shadow`.** Every earlier module defaults to `active` to keep an upgrade's behaviour. A new module has no earlier behaviour to keep, and the week of data is the point, so it starts measuring; the cost is the Jev calls above, disclosed in the README and on the card. An owner who wants none sets it Off, which makes no call and writes no row.
- **Fail open.** Any error in the job is swallowed; the timer never touches the turn.

## Checklist

Strict TDD for each: RED observed, then GREEN, then a Conventional Commit on this branch.

- [x] V1 `src/core/verify_done.ts` and `src/core/verify_done.test.ts`: the candidate rule (edits and no passing test; each combination), state builder (redacted, cut, no text of commands), question, `interpretVerifyDone` (malformed is `null`), decision for each branch and each floor edge, record shape, hourly file name `verify-done-decisions-<YYYY-MM-DDTHH>.jsonl`, and the summary (claims, would-block, jev-failed, over a window).
- [x] V2 Registry: `verify-done` in `ModuleId`, `MODULE_IDS`, the state list per module (`off` and `shadow`), default `shadow`, the `verify-done` `ModFeatureId`; `feature_modules.test.ts` updated (each hook still has one owner; the defaults test now names this one default). Check every consumer of `MODULE_IDS` (installer status, panel, scheduler, `measure-module-cost`) still agrees.
- [x] V3 Mod wiring in `hooks/index.ts` (+ `hooks.test.ts`): off makes 0 Jev calls and 0 writes; shadow on a non-candidate turn makes 0 calls; on a candidate turn exactly 1 call and 1 row; a subagent's turn (`agentId` set) and `reason !== 'answer'` do nothing; a Jev failure writes a `jev-failed` row and the turn ends as it would have; the returned `next(e)` result is unchanged in every branch.
- [x] V4 Panel card (`adapters/orca/panels/config.html`, es and en) and worker save path: Off and Shadow only, state saved through `featureModulesSaveRequest` and shown after reload; the cost line from measured data (the Jev calls per turn it adds). `scripts/panels.spec.mjs` covers the card and the save. `npm run test:panels` writes its output to a file (it hung under a pipe before).
- [x] V5 `scripts/measure-module-cost.mjs`: a row for the module (Jev calls, per prompt, p50/p90) and the count of claimed-done-unverified turns in the window.
- [x] V6 README (what is sent to Jev, that it only measures, default shadow, how to turn it off), CHANGELOG 0.8.0, version 0.8.0 in `package.json` and `orca-plugin.json`, `odd/qa/qa-0.8.0.md` with scenarios and the live ones left PENDING.
- [x] V7 Shots of the Modules section at 1440, 768, 390 and 320, light and dark. **They go to the `qa-evidence` branch under `odd/qa/screens-0.8.0/`, never to `main`** (`odd/qa/README.md`; `scripts/install-size.test.mjs` fails the tree over 40 MiB). Say which were read.
- [x] V8 PR #52, merge, release 0.8.0, catalog pin, live check from the marketplace install (0.8.1, which contains it): a candidate turn writes one row, a verified turn none, Off none (`odd/qa/qa-0.8.0.md`, scenarios 14, 16, 17, 18 PASS). Open: scenario 15, the card seen in the real Orca window, needs the owner.

## Acceptance criteria

- Off: 0 Jev calls and 0 rows, measured the same way as T0 of the feature modules.
- Shadow: at most one Jev call per main-loop turn, only on a candidate turn; no answer, tool call or turn is changed or blocked.
- An upgrade with no module file reads `shadow` for this module and the five existing modules still read `active`.
- What is sent to Jev is only the redacted, cut final message and counts; a test pins that a secret in the message never reaches the call.
- `npm run typecheck` reports 0; `npm test`, `npm run test:panels` green; the tracked tree stays under 40 MiB.

## Checks

`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, `npm run measure-module-cost`, and a live check of the marketplace install.

## Memory

The Engram mirror `odd/verify-done-module/tasks` is pending: the Engram MCP server is not connected in this session.
