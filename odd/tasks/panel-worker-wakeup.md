# Panel works when the worker is asleep

## Objective
The settings panel must never hang, never leak the API key, and must tell the
person exactly what to do when the plugin's worker is not running.

## Problem
Orca's plugin worker is lazy. It is forked by exactly two callers
(`plugin-service.ts:281` on command invocation, `plugin-event-delivery.ts:32`
on one of three manifest events) and reaped after five idle minutes
(`PLUGIN_WORKER_IDLE_REAP_MS`). A panel cannot wake it: all five panel-callable
actions terminate in the Electron main process and none reaches the worker.

Our panel is built on a request/poll pattern over `storage`, so with no worker
awake every operation waits out its deadline. On a fresh install the person
opens Settings before creating a worktree or running an agent, so the worker has
never started and nothing works. It appears healthy on a machine where agents
run constantly, because `agent.status.changed` keeps waking the worker.

Three defects follow from this:

1. **The API key is written in plaintext to `storage.json`** under
   `secretRequest` and only moves to the encrypted store when a worker attends
   it. If no worker ever runs, it stays on disk in the clear.
2. **A request older than `SECRET_REQUEST_TTL_MS` (10 min) is discarded in
   silence.** The person was already told it failed; the save is simply lost.
3. **"Checking…" never resolves** when the status mirror was never written, and
   `common.workerSilent` blames permissions and the plugin toggle, neither of
   which is involved.

## Why
Every Orca developer installing this from the marketplace hits all three on
first run. The first is a security defect against a stated constraint: the key
must be stored securely.

## Scope
`adapters/orca/panels/config.html`, `adapters/orca/panels/board.html`,
`adapters/orca/main.mjs`, plus a screenshot harness. No change to `src/core`
decision logic.

## Out of scope
Waking the worker from the panel. It is not possible with the current Orca
plugin API, and inventing a way is Orca's decision, not this plugin's.

## Constraints
- Panels may call only `notifications.show`, `storage.get`, `storage.set`,
  `terminal.sendText`, `workspace.readContext`. No `storage.delete`.
- Artifacts in English; user-facing strings live in the ES/EN catalogs.
- No `any`. No debug statements. No backup files.

## Delivery
Strategy: `ask-on-risk`. Forecast ~350 authored changed lines.
TDD: strict (from CLAUDE.md). Runner: `node --test --experimental-strip-types`.

## Tasks
- [ ] T1 Worker publishes a heartbeat into `storage` on every poll tick; panel
      reads it and refuses to send the key when it is missing or stale.
      Route: delegated. Trigger: writer (2+ non-trivial files).
- [ ] T2 Panel overwrites the pending request with a redacted tombstone when it
      gives up, so the key never lingers in `storage.json`.
- [ ] T3 Worker writes an `expired` result instead of discarding a stale
      request in silence.
- [ ] T4 Panel renders "the worker has not run yet" plus the exact command that
      starts it, instead of an endless "Checking…", when the mirror is absent.
- [ ] T5 Rewrite `common.workerSilent` in both catalogs to name that command.
- [ ] T6 Playwright screenshot harness wired into a `check` script; shots at
      1440/768/390/320 in both themes.
- [ ] T7 The panel's fallback `consequenceCeiling` is a hardcoded 1.5
      (`config.html:1121`) while the ceiling in force is 1.78
      (`decisions.ts:377`). On a fresh install the panel states a threshold
      that is not the one the gate uses, and "Save configuration" writes that
      wrong number as the person's ceiling -- silently downgrading a calibrated
      threshold to the value that was measured wrong. Every panel default must
      come from the core constant, not a literal, and nothing may re-introduce
      a second copy of it.

## Acceptance
- With no worker, saving a key writes no plaintext key anywhere on disk.
- With no worker, every panel surface states the cause and the remedy.
- A request attended after its TTL produces a visible `expired` result.
- No panel default contradicts the core constant it mirrors.
- All tests pass; screenshots read at all four widths.

## Progress
- T6 done: `scripts/screenshot-panels.mjs` + `npm run check`. Verified: 16 shots
  in the `fresh` scenario, no overflow and no script errors at 1440/768/390/320
  in both themes. Read `fresh-config-light-1440.png`: it reproduces the reported
  failure exactly -- "Checking..." permanent under both the key and the Claude
  integration. That reading is also what surfaced T7.
- T1-T5 in progress.
