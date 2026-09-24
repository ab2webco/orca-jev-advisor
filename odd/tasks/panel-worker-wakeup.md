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

- [x] T8 `deriveCatalogFromOrca` runs `execFile('orca', ...)` and depends on
      the CLI being on the worker's PATH. A macOS app launched from the Dock
      gets `/usr/bin:/bin:/usr/sbin:/sbin`, which does not contain
      `/usr/local/bin/orca`, so the spawn fails with ENOENT, the catch returns
      an empty list, and "Refresh from Orca" reports nothing wrong while adding
      nothing. Resolve the CLI from `process.execPath` (the worker runs inside
      the Orca install, so its own binary locates the bundled CLI without
      hardcoding an install path), fall back to PATH, and when it still cannot
      be found say so in the panel instead of returning an empty list.
- [x] T9 `seed/policies.json` ships with the plugin and `loadPolicies()` exists
      in core, but nothing can import them: the panel only ever mirrors
      policies OUT. Every developer therefore starts with an empty policy list
      and no way to adopt the shared baseline. Add an import action, through
      the same request/poll path the other panel actions use.

## Acceptance
- With no worker, saving a key writes no plaintext key anywhere on disk.
- With no worker, every panel surface states the cause and the remedy.
- A request attended after its TTL produces a visible `expired` result.
- No panel default contradicts the core constant it mirrors.
- A catalog refresh that cannot find the Orca CLI says so; it never reports
  success with an empty result.
- The shipped policy seeds can be adopted from the panel.
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

- T8 done: `src/core/orca_cli.ts` (new, pure, tested) resolves the bundled
  CLI's expected path by walking up from `process.execPath` one
  platform-specific hop (`Contents/Resources/bin/orca` on darwin,
  `resources/bin/<orca|orca.exe>` next to the executable on linux/win32),
  then falls back to bare `orca`/`orca.exe`/`orca.cmd`/`orca` on PATH (in that
  order on Windows, since `execFile` does not apply PATHEXT resolution to a
  bare command the way a real shell does). `deriveCatalogFromOrca` in
  `main.mjs` now tries every candidate in order and returns a typed result
  instead of a bare array: `{ok:true, destinations}` on success,
  `{ok:false, reason:'orca-cli-not-found'}` when every candidate ENOENTs, or
  `{ok:false, reason:'orca-cli-failed'}` when a candidate is found but errors
  (bad JSON, non-zero exit, etc) -- the two facts the task called out as
  needing to stay distinguishable. `cmdRefreshCatalog` forwards a `!derived.ok`
  result as-is instead of folding it into "0 added" (the exact silent-failure
  defect reported), and `deriveInitialCatalogIfEmpty` keeps its "only when
  empty" guard and stays non-throwing on either failure reason. Both gained
  an `options` parameter (`execPath`/`platform`/`runCommand`) purely for test
  injection; production call sites pass none and get the real
  `process.execPath`/`PLATFORM`/a real child process, unchanged. New reason
  codes `orca-cli-not-found`/`orca-cli-failed` added to `ERROR_REASON_KEYS`
  and both ES/EN catalogs in `config.html`.
  Tests: `src/core/orca_cli.test.ts` (7 tests, pure path resolution) and 6 new
  tests in `adapters/orca/main.test.mjs` (`deriveCatalogFromOrca` x3,
  `cmdRefreshCatalog` x1, `deriveInitialCatalogIfEmpty` x2), all hermetic via
  the injected `runCommand` -- no real subprocess is spawned by these tests.
  Learned mid-task: the very first version of these tests (before the
  `options.mirror` override below existed) DID spawn a real subprocess and
  overwrote this developer's actual `~/.config/orca-supervisor/catalog.json`
  and `policies.json` on this machine, because `mirrorCatalogAndPolicies`'s
  sidecar writes to the real, hardcoded `CONFIG_DIR` regardless of which
  storageHost (fake or real) is passed to it. Caught immediately, fixed
  before finishing the task -- see T9's note and the report for what was and
  wasn't recoverable.

- T9 done: `src/core/policy_seed_import.ts` (new, pure, tested) merges a
  seed policy list into an already-stored one, by id only -- an id already
  present, however that row looks (including one left incomplete, blank
  `kind`), is left exactly as it is; only genuinely new ids are appended.
  `main.mjs` gained `cmdImportPolicySeeds` (reads `seed/policies.json` via
  the existing `loadPolicies`, resolved from `PLUGIN_ROOT` -- never an
  absolute path -- reads the raw stored `policies` value directly, not
  through `getPolicies`, since that silently drops an invalid row instead of
  preserving it, merges, writes back only when something was actually added,
  then re-mirrors) and `attendPolicySeedImportRequest`/
  `POLICY_SEED_IMPORT_REQUEST_KEY`/`POLICY_SEED_IMPORT_RESULT_KEY`, wired into
  the same poll loop as the other panel actions, same TTL/expired handling as
  T3. `config.html`'s TEAM POLICIES section gained an "Import baseline
  policies" button using the same request/poll pattern as "Refresh from
  Orca" (`sendPolicySeedImportRequest`/`waitForPolicySeedImportResult`),
  reporting added/skipped counts, and a `seed-unavailable` reason code (both
  ES/EN catalogs) for a missing or malformed seed file.
  Tests: `src/core/policy_seed_import.test.ts` (4 tests) and 5 new tests in
  `adapters/orca/main.test.mjs` covering import-into-empty, never-overwrite,
  the `seed-unavailable` reason, and both branches of the attend wrapper.
  Learned mid-task (see T8's note): `cmdImportPolicySeeds`/
  `attendPolicySeedImportRequest` both take an `options.mirror` override for
  exactly this reason -- the real `mirrorCatalogAndPolicies` writes to disk
  outside any storageHost's control, so every test that can reach
  `added > 0` must inject a no-op mirror. Production (the real poll loop)
  passes no options and always re-mirrors for real, unchanged.
  Verified by inspection, not screenshot (T6/screenshots are out of scope
  for T8/T9): extracted `config.html`'s inline `<script>` and ran
  `node --check` on it after each edit -- no syntax break.

- T8/T9 superseded by integration (branch `integrate/pr3-cli-and-seeds`, off
  `main`): a teammate (jhonj182, PR #3, `origin/jhonj182/verify-worker-note`)
  independently fixed the same two problems and their T8 solution was judged
  better and taken wholesale. `src/core/orca_cli.ts`/`orca_cli.test.ts` above
  (candidate-path resolution via `process.execPath`, `orca-cli-not-found`/
  `orca-cli-failed` as distinct reasons, hermetic tests via an injected
  `runCommand`) are DELETED and replaced by the teammate's module of the same
  name: a single cross-platform helper (`orcaCliOptions`/`ORCA_CLI_ARGUMENTS`)
  that runs the real CLI through the platform shell on Windows ONLY (fixing
  the actual defect on that platform -- this session's own `.cmd` filename
  guess never worked there, since `execFile` never consults PATHEXT
  regardless of filename), with `cwd` required rather than inherited to close
  a second exposure (cmd.exe resolving a bare command from the current
  directory before PATH). All three call sites (catalog derivation, board
  project resolution, doctor's reachability probe) now go through it. The
  `orca-cli-not-found`/`orca-cli-failed` distinction is gone; both branches
  now report as `derivation-failed`. `deriveCatalogFromOrca` and
  `cmdRefreshCatalog` no longer take an `options` injection parameter --
  their tests instead force a deterministic ENOENT by clearing
  `process.env.PATH` for the call. Net effect on the suite: 261 tests on
  `main` before this integration, 275 after (`node --test
  --experimental-strip-types`) plus 4 more in the teammate's new
  `scripts/panels.spec.mjs` (Playwright, run via `npm run test:panels`,
  wired into `check`) -- no coverage lost, all passing.
  T9's `cmdImportPolicySeeds` (the panel's "Import baseline policies"
  button) survives unchanged in effect, composing with the teammate's new
  `seedPoliciesIfEmpty` (`src/core/policy_seed.ts`, plants the shipped seed
  automatically on first run behind a marker key, never touching a machine
  that already holds policies). `cmdImportPolicySeeds` was switched from
  `loadPolicies` (src/core/policies.ts) to `parseSeedPolicies` (the
  teammate's own seed reader) so the two seeding paths share one parser of
  `seed/policies.json` instead of two with different malformed-row
  behaviour; `loadPolicies` stays as-is for tools/decide.ts and
  tools/policy-gate.ts's own developer-authored policy files.
  Verified: full suite green, `npm run test:panels` green (including the new
  end-to-end check that a failed refresh says so in the panel, and that the
  auto-seeded policies are what a person actually sees), config.html's inline
  `<script>` extracted and `node --check`'d after every edit, real
  `~/.config/orca-supervisor/{policies,catalog}.json` shasums unchanged
  before and after every test run, `gate-bash.ts` loaded end-to-end
  (`echo '{}' | node --experimental-strip-types adapters/claude/gate-bash.ts`,
  exit 0) to confirm the `store.ts` `isPolicyRow` export change did not
  break the live command gate.

- Incident during T8/T9 (full disclosure): the first draft of the T9 tests
  called `cmdImportPolicySeeds`/`attendPolicySeedImportRequest` without an
  override, which reached the real `mirrorCatalogAndPolicies` and spawned
  `write-secret-mirror.mjs` for real. That sidecar's `CONFIG_DIR` is this
  actual machine's `~/.config/orca-supervisor`, independent of the fake
  `storageHost` the tests used, so it overwrote `catalog.json` (with an
  empty `{destinations: []}`) and `policies.json` (with just the 20 seed
  rows) on this developer's real machine. Caught immediately by noticing the
  tests took 150-180ms each (a real child-process spawn) instead of
  sub-millisecond. `catalog.json` was restored from
  `~/.config/orca-supervisor/catalog.json.test-pollution.bak`, which already
  existed on this machine before this session (evidence someone hit this
  same class of problem before and made a manual backup) -- verified
  content looks like a real, populated catalog, restored as-is.
  `policies.json` had NO backup and could not be safely restored: it is
  reported as unresolved in the final report, with a possible-but-unverified
  candidate noted (a `/tmp/policies.json` with different, Spanish-named ids,
  dated the day before) rather than silently overwritten with a guess. The
  fix: `cmdImportPolicySeeds`/`attendPolicySeedImportRequest` now take an
  `options.mirror` override (test-only; production always uses the real
  `mirrorCatalogAndPolicies`), and every test that can add a policy passes a
  `noopMirror`. Re-ran the full suite after the fix and confirmed both real
  files' mtimes are unchanged.
