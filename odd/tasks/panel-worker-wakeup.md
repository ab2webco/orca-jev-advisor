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
- [x] T1 Worker publishes a heartbeat into `storage` on every poll tick; panel
      reads it and refuses to send the key when it is missing or stale.
      Route: delegated. Trigger: writer (2+ non-trivial files).
- [x] T2 Panel overwrites the pending request with a redacted tombstone when it
      gives up, so the key never lingers in `storage.json`.
- [x] T3 Worker writes an `expired` result instead of discarding a stale
      request in silence.
- [x] T4 Panel renders "the worker has not run yet" plus the exact command that
      starts it, instead of an endless "Checking…", when the mirror is absent.
- [x] T5 Rewrite `common.workerSilent` in both catalogs to name that command.
- [ ] T6 Playwright screenshot harness wired into a `check` script; shots at
      1440/768/390/320 in both themes.
- [x] T7 The panel's fallback `consequenceCeiling` is a hardcoded 1.5
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
- T1 done: `main.mjs` publishes `workerHeartbeat` ({at: ISO}) once at
  activation and on every `runSecretPoll` tick. `sendSecretRequest` in
  `config.html` reads it first and refuses to write the request (shows the
  T5 message) when missing or older than 40s (`WORKER_HEARTBEAT_STALE_MS`,
  chosen above the worker's 15s idle-poll interval). The other three
  request senders (Claude integration, locale, catalog refresh) stay
  optimistic, unguarded, as specified. Pure logic (`isHeartbeatFresh`,
  `buildSecretTombstone`) extracted to `adapters/orca/panels/worker-status.mjs`
  and unit-tested; the panel copy is hand-duplicated (single-file HTML, no
  module graph) and cross-referenced by comment.
- T2 done: `sendSecretRequest` overwrites `secretRequest` with a redacted
  `{id, at, tombstone: true}` on every non-success exit from the wait
  (write failure, an `ok:false` result, and the timeout), not only the
  timeout. `attendSecretRequest` treats `tombstone: true` as "no request"
  and never attends it, even though the shape otherwise matches a live one.
- T3 done: the TTL branch in `attendSecretRequest`,
  `attendClaudeIntegrationRequest`, `attendLocaleRequest` and
  `attendCatalogRefreshRequest` (the only sibling `attend*` functions with
  this request/result/TTL shape -- `attendCatalogPolicyMirrorRequest` has no
  result key and was left alone) now publishes its result key with reason
  `'expired'` before returning, instead of a silent discard. `config.html`
  learns the code (`ERROR_REASON_KEYS.expired` -> `error.expired`, both
  catalogs).
- T4 done: `renderSecretStatus` (previously had no fallback at all -- an
  unconditional forever-spinner on a fresh install) and
  `renderClaudeIntegrationStatus` (previously a fixed 20s `setTimeout`
  guess, which could misreport a worker that just hadn't published yet) now
  both decide from the same heartbeat: fresh -> keep "Checking…", stale or
  missing -> `common.workerSilent`. The very first synchronous paint (before
  `load()`'s own storage reads return) passes `heartbeat === undefined` and
  is treated as "still finding out," so the transient flash stays a real
  "Checking…" rather than a premature claim.
- T5 done: rewrote `common.workerSilent` in `config.html`'s ES/EN catalogs
  to name the real cause (worker starts on the first Advisor command) and
  remedy (open the command palette, run "Advisor: Check configuration"
  once). Added the same key/copy to `board.html`'s ES/EN catalogs for the
  first time, plus a `renderWorkerNote` using its existing `noteEl`, driven
  by the same heartbeat -- the board's own "No data yet" states were
  already honest but never said why.
- T7 done: `main.mjs` now imports the already-exported
  `GATE_CONSEQUENCE_CEILING` from `decisions.ts` and publishes it once at
  activation into a new `gateDefaults` storage key (`GATE_DEFAULTS_KEY`).
  `fillThresholds` in `config.html` renders `consequenceCeiling` from that
  mirror when nothing is saved, instead of the stale `1.5` literal; when
  the mirror has never been published (fresh install, worker never ran),
  the field stays blank rather than guess, and "Save configuration" refuses
  to persist a blank field as `0` (`Number('')` is `0`, not `NaN`).
  Regression test `publishGateDefaults mirrors the real
  GATE_CONSEQUENCE_CEILING, not a hardcoded literal` in `main.test.mjs`
  fails if main.mjs ever reverts to a hardcoded literal.
  Audit of the other four Thresholds fields, as requested: `reversibleGate`
  (panel default 0.7) matches `decisions.ts`'s internal `GATE_REVERSIBLE_GATE`
  (0.7) -- no drift. `externalGate` (panel default 0.35) disagrees with
  `decisions.ts`'s internal `GATE_EXTERNAL_GATE` (0.5) -- but that constant
  is not exported, so mirroring it the same way would require exporting it
  from `src/core/decisions.ts`, which was not done (out of scope per this
  task's own instruction to stop and report rather than edit `src/core`).
  `actThreshold` (0.9) and `confirmThreshold` (0.6) match `src/core/store.ts`'s
  own `DEFAULT_CONFIG`, which is what `getConfig()` already falls back to;
  no `decisions.ts` constant of that name exists at this level to drift
  against (the identically-named fields in `catalog.ts`/`worktree_catalog.ts`
  are a different, per-destination concept with different defaults, 0.85/0.65
  -- not a fair comparison). `logMaxEntries` (500) also matches
  `store.ts`'s `DEFAULT_CONFIG` and is the one field of the five actually
  read back by real code (`log.ts`).
  Separate, more significant finding surfaced while tracing this: none of
  `config.thresholds.{actThreshold,confirmThreshold,reversibleGate,
  externalGate,consequenceCeiling}` is read by any real decision function
  anywhere in the codebase (`cmdDecide` in `main.mjs` calls `decideDestination`
  without forwarding `config.thresholds` at all, and no other call site reads
  `config.thresholds` either -- verified by grep). The Thresholds section of
  the config panel is presently inert: editing and saving it changes nothing
  about what the gate actually allows, asks, or blocks. This fix makes the
  *displayed* default honest; it does not make the field functional, which
  would mean touching `gate-bash.ts`'s decision call sites (and possibly
  `src/core`) and is a separate, unrequested change.
