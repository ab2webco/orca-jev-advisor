# Feature modules: one plugin, each feature switched on or off

## Objective
The owner, 2026-10-10:
- "Me gustaria tener un plugin base que se encargue de la configuracion y autenticacion de proveedores y los demas sean addons o plugins que se complementen y que pueda instalar lo que necesite o activar y desactvar";
- "cual me recomiendas para mejorar el performance y que Orca no se ponga lento y ademas que sea algo que pueda ir agregando o quitando facilmente".

The decision was option B: one Orca plugin owns provider configuration and the key, and each feature is a module with its own switch in our settings page. Separate Orca plugins (option A) were rejected on evidence from `orca-oss/src`:
- No plugin dependencies. `shared/plugins/plugin-manifest.ts:104-167` has no such field, and an unknown top-level key is stripped. The marketplace entry is a strict object (`shared/plugins/plugin-marketplace.ts:76-86`).
- No plugin-to-plugin API (`shared/plugins/plugin-host-api.ts:122-263`).
- A per-plugin secret vault that no other plugin can read (`main/plugins/plugin-secrets-store.ts:31-32`). Addons would have to read the plaintext `~/.config/orca-supervisor/env` mirror.
- Remove runs no plugin code (`main/ipc/plugins.ts:230-245`), so each addon would leave its hooks in `~/.claude`.
- One forked process per plugin (`main/plugins/plugin-host-process.ts:78`), and at most 5 active workers (`shared/plugins/plugin-host-protocol.ts:114`). Workers start lazily and are reaped after 5 idle minutes, so the 5-slot limit only bites when several plugins keep a cadence awake. That is a cost of A, not a certainty.

## Scope
A module is a feature the owner can turn off so it costs nothing:
- no hook process;
- no Jev call;
- no worker timer or event handler.

The modules and what each one owns today, verified against the code in T1. The registry in `src/core/feature_modules.ts` is the source of truth.

| Module | settings.json hooks | Shared mod copy | Worker jobs | Existing modes (where stored) |
|---|---|---|---|---|
| `gate` | Bash: PreToolUse (`gate-bash.ts`); Bash: PostToolUse, PostToolUseFailure, PermissionDenied (`gate-outcome.ts`); Edit\|Write\|MultiEdit\|NotebookEdit: PreToolUse (`gate-files.mjs`) | none | 15 s: gate authorizations (own), measurements summary (shared with skill-selection). Activity summary (shared with model-router). Activation: deny-tier status, trusted programs, gate defaults. Poll: deny-tier, authorization-forget and trusted-program requests | 9 deny-tier switches (`<configDir>/deny-tier-config.json`), queue mode (`queue-mode.json`), trusted programs (`trusted-programs.json`). No measure mode, so no shadow |
| `model-router` | Agent: PreToolUse, PostToolUse, PostToolUseFailure (`agent-model.ts`) | router tier (`prompt.submit` origin stamp, `turn.step`); subagent routing (`agent.spawn`, teammate `turn.step`, `tool.call`); subagent status band (no Jev); turn-usage log on every step (no Jev) | 15 s: model measurements. 10 min (quota timer): account quota, router status (shared with steward), model docs check. Consumption summary (shared with steward). Activity summary (shared with gate). Activation: models catalog seed, mirror and notice. Poll: router config and models requests | `routerMode` off/measure/active, `workKindMode` off/measure/active (account settings.json `pluginConfigs["orca-jev-mod-skills@skills-dir"].options`); legacy model switch measurement/active (Orca storage `modelsConfig.active`, mirrored to `models-catalog.json`); explicit models judge/keep (`explicit-models.json`) |
| `steward` | none | context steward (`turn.start`, `turn.complete` timer) and its person-turn counter in `prompt.submit` | none of its own. Router status (its settings ride on each row) and consumption summary (its decisions) are shared with model-router. Poll: router config request (`steward-set`) | `stewardMode` off/measure/active, `stewardSoftMode` measure/active for the 400k tier (same `pluginConfigs` options) |
| `skill-selection` | none | skill selection (`prompt.submit`, `prompt.attachment`, `skill.prompt`); tool selection (`prompt.submit`, `tool.call`) | measurements summary (shared with gate). Activation: mod-skills status. Poll: mod-skills config request | `active`, `activeTools` (`<configDir>/mod-skills-config.json`); off means measurement |
| `board` | none | none | `agent.status.changed` (its 30 s `orca worktree list` / `orca repo list` cache runs inside this handler), `worktree.created` (no-op), `worktree.removed` | none, so no shadow |

Corrections to the T0 draft:
- **Board.** "Catalog refresh" was not a board job. Catalog refresh, catalog proposals and the catalog/policies mirror feed the gate and `advisor.decide`, so they stay in the base.
- **Skill-selection.** It does own worker work: the shared measurements summary, its status at activation, and its config request.
- **Steward.** No "compaction measurement" job exists. Its decisions reach the panel through the shared consumption summary, and its settings through the shared router status. T0 listed router status as model-router only.
- **Model-router.** The mod part is more than tier judgement. It also covers subagent routing, the subagent status band and the turn-usage log. The last two make no Jev call.
- **Base, not a module:** the poll loop and heartbeat; key mirror; Claude integration install and rescan; locale; catalog/policies mirror (which also mirrors `queue-mode.json` and `explicit-models.json`); the `advisor.*` commands. Orca's own plugin enable/disable switch (`src/core/orca_enablement.ts`) sits above every module.
- **Installer header.** It says "Seven hook entries", but `hookSpecs` installs eight (`gate-files.mjs` was added in 0.6.17). T3 fixes the comment.

What "off" means depends on the kind of artifact:
- **settings.json hooks:** the entries are uninstalled.
- **Shared mod copy:** it stays installed while any module that uses it is on. A module that is off returns before any Jev call.
- **Worker work:** the timer and the handler are never registered.

Rules:
- **One registry.** A pure list in `src/core/feature_modules.ts` says, for each module, its id, hooks, mod features, worker tasks and default. The installer, the worker, the mod and the panel all read it. Adding a module is one entry.
- **Three states per module: `off`, `shadow` and `active`.** Shadow runs the module and logs what it would do, with no effect on the turn; the pattern comes from jev-belay and Jev_steer_or_queue. A new module enters in shadow and becomes active only after a week of measurement. Where a module already has a measure mode, that mode is its shadow; a second shadow switch is not added.
- **One switch per feature.** `off` is a new top state in front of each module's existing modes:
  - the router's `off`/`measure`/`active`;
  - the steward's `measure`/`active` and its tier switch;
  - the skills mod's `active`/`activeTools`;
  - the legacy model switch;
  - the deny-tier switches.
  
  It is never a second boolean that can disagree with them. `off` is not `measure`: today the skills mod makes two Jev calls per prompt with both switches off, because that is measurement mode.
- **Upgrade keeps behaviour.** With no module file present, every module defaults to what runs today. An upgrade never turns a module off.
- **The gate protects its own switch.** The module state file is refused by `gate-files` and by the Bash gate, both by Edit/Write and by heredoc, `sed -i`, `cp`, `mv` or `rm` on it. Only the panel can change it.
- The provider key keeps its current home: Orca `secrets` (`typesafeApiKey`) plus the 0600 env mirror. This feature does not move it.

## Out of scope
Splitting into separate Orca plugins, or changing Orca. If Orca later gains manifest dependencies and shared secrets, each module can be extracted as its own plugin; that would be a new feature.

## Checklist
- [x] T0 measure: per module, from the gate log, the mod logs and the last 7 days of transcripts: hook spawns per tool call and their latency, Jev calls per prompt and per turn, and worker wakeups per hour. The result is the baseline for the acceptance criteria. Commits 21d050a, then a follow-up commit (advice-retry and fail-open rules, `--until`).
  - **Tooling.** The script is `scripts/measure-module-cost.mjs`, run as `npm run measure-module-cost -- --since 2026-10-04T22:00:00Z --until 2026-10-11T05:00:00Z`. The counting rules live in `src/core/module_cost.ts`, with 15 unit tests.
  - **Strict TDD.** RED: the module was missing. GREEN: 14/14. The follow-up was RED on 2 of 15, then GREEN 15/15.
  - **Window.** 2026-10-04T22:00Z to 2026-10-11T05:00Z, 6.3 days. That is the last 7 days minus the hours of the stale 0.6.10 install, when the gate and mod logs were not written. The gate log shows plugin 0.6.25 to 0.6.28.
  - **Transcript totals** (deduplicated by uuid and tool-use id, subagents included):
    - 1217 person prompts on the main thread;
    - 1455 completed turns;
    - 25630 tool calls.
  - **Sources:**
    - the plugin cache dir: `gate-decisions-*`, `mod-skills-measurements-*`, `mod-tools-measurements-*`, `model-router-decisions-*`, `model-reclassifications-*` and `context-steward-decisions-*`;
    - the Claude transcripts;
    - the 5 settings.json files Claude Code reads (home and 4 Orca accounts), all with the same 8 hooks of ours;
    - Orca's plugin audit log, `plugins-data/audit.log*`.

  | Module | Hook spawns (derived) | per matching tool call | Hook ms p50 / p90 (observed) | Jev calls (observed) | per prompt | per turn | Jev ms p50 / p90 (observed) | Jev failures (observed) |
  |---|---|---|---|---|---|---|---|---|
  | gate | 40899 | 1.93 | 597 / 720 (n=11271) | 11342 | 9.32 | 7.80 | 383 / 441 (n=11298) | 49: 44 unreachable, 5 hook timeouts |
  | model-router | 160 | 2 | not recorded | 1378: router 1298 (start 731, stage 490, subagent 77) plus agent-model 80 | 1.13 | 0.95 | 383 / 444, agent-model only (n=80); the router logs none | 11 |
  | steward | 0 | - | - | 573 | 0.47 | 0.39 | not logged | 1 |
  | skill-selection | 0 | - | - | 8959: skills 3454, tools 5505 | 7.36 | 6.16 | 327 / 593 (n=6550) | 41 |
  | board | 0 | - | - | 0 | 0 | 0 | - | 0 |

  - **Hook spawns.**
    - Derived: the transcripts' tool calls times the matchers installed today. Pre counts every call, Post every success, PostFailure every error. PermissionDenied is not observable and counts 0.
    - These derived spawns read today's settings.json across the whole window, so once T3 uninstalls a hook they show 0 by construction. The independent proof for T6 is the observed count of our hook records (`orca-jev-advisor:` hook_success/hook_cancelled) in the transcripts: 11271 timed PreToolUse:Bash runs and 5 cancelled in this window.
  - **Hook latency.**
    - Observed only for the gate's PreToolUse:Bash, on the runs Claude Code recorded: the ones that printed something, 11271 of the Bash calls.
    - The other hooks print nothing, so no transcript times them.
    - The mod (model-router, steward and skill-selection) runs inside Claude Code and spawns no process.
  - **Jev calls.** One count per log row, using the rule that row's writer follows:
    - **gate:** a `jev` row is one call. An `advice-retry` row with no latency is none: `tryAdviceRetryPass` passes it before any Jev call, and there were 896 of them. A `none`/`unreachable` row is one failed call.
    - **skills:** the wide stage is one call, plus one for fit when it ran.
    - **tools:** one wide call per batch of 255 (the roster held 114 to 643 tools), plus fit.
    - **router:** a row with a confidence, or one marked `jev-failed`.
    - **agent-model:** a `jev` decision, or a `none` decision that failed after asking.
    - **steward:** one call per row.
  - **Worker cadences.** Derived from `adapters/orca/main.mjs`. Rates are observed in the audit log as `storage.set` with outcome `ok`, from 2026-10-10T01:49Z to 2026-10-11T04:59Z. That is 27.2 h, the whole log after rotation.
    - The worker never idled in that time.
    - The worker has 3 intervals plus the poll loop. Each interval runs jobs for several modules.
  - **The 15 s interval** runs 3 jobs:

    | Job | Module | Observed |
    |---|---|---|
    | measurements summary | shared by gate and skill-selection | 239.8/h |
    | model measurements | model-router | 233.5/h |
    | gate authorizations | gate | 235.8/h |

    Each run spawns one node sidecar; that part is derived from the code, and model measurements spawns on every call. This comes to about 709 node processes an hour (observed runs times derived spawns).
  - **The 10 min interval** runs 3 jobs:
    - account quota mirror: model-router. Derived only, since it has no audit key; it spawns 1 sidecar plus `orca account list`.
    - router status: model-router, 5.9/h.
    - model docs check: model-router, gated to once a day.
  - **Two more 10 min intervals**, one job each:
    - consumption summary: shared by model-router and steward, 6/h, 1 sidecar.
    - activity summary: shared by gate and model-router, 6/h, 1 sidecar.
  - **Board.**
    - The `agent.status.changed` handler wrote the board 160 times an hour.
    - Its 30 s `orca` CLI cache was refreshed 18.8 times an hour. Each refresh runs `orca worktree list` and `orca repo list`, so about 38 CLI spawns an hour (derived).
    - `worktree.created` is a no-op handler.
    - `worktree.removed` writes nothing the audit log shows.
  - **Base, not a module:** the request poll and heartbeat ran 234.7 times an hour.
  - **Jobs per module:**
    - gate: 1 own job and 2 shared;
    - model-router: 4 own and 2 shared;
    - steward: 1 shared;
    - skill-selection: 1 shared;
    - board: 3 event handlers.
  - **Finding for T4.** No module owns a timer: the 15 s and 10 min intervals are each shared by several modules. "0 worker timers for an off module" can only hold if T4 either gives each module its own timer, or measures an off module as 0 jobs and 0 sidecar spawns while the shared timer still wakes.
  - **Findings:**
    - **Agent spawns.** Every Agent spawn costs 2 Jev calls: one from the agent-model hook and one from the router's subagent point (80 and 77 for 80 Agent calls). It also costs 2 hook processes.
    - **gate-files.** It makes no Jev call, although its status message says Jev checks the edit.
    - **Mod switches.**
      - Both mod switches ran `active` all window: 1768 skills and 1766 tools decisions, with 0 measurement rows.
      - That is 5.07 Jev calls per decision.
      - So the "two Jev calls per prompt with both switches off" under Rules could not be observed on this machine.
    - **Person prompts.** The router's start and stage points decided 1221 times, about one per person prompt (1217), which supports that count. The skills mod decided 1768 times. Its `prompt.submit` skips only empty and slash prompts and does not check the prompt's origin the way the router does, so it also decides on prompts that are not a person's own, such as notifications.
- [x] T1 core registry: `src/core/feature_modules.ts`. It holds the module list (verified against the code), `parseFeatureModules(content)` (never throws; missing or malformed input gives today's behaviour), and `moduleState(id)` combining `off` with the existing mode. Strict TDD: RED, then GREEN.
  - **Registry.** `FEATURE_MODULES` gives, per module:
    - `id`, `states`, `defaultState`;
    - `hooks`: event, matcher and script;
    - `modFeatures`: id, engine hooks, and whether it calls Jev;
    - `workerJobs`: id, function, triggers (activation, poll, one of the 4 intervals, or an Orca event) and sidecar;
    - `modes`: each existing switch, its values, default, store and `shadowValue`.

    The file is `FEATURE_MODULES_FILE = "feature-modules.json"` in the config dir, shaped `{ "modules": { "<id>": "off" | "shadow" | "active" } }`. The module is pure: no `node:` import, so the mod sandbox can load it.
  - **Defaults.** Every module defaults to `active`, which reproduces 0.6.28. The gate and the board offer only `off`/`active`: they have no measure mode, and a module offers shadow only when one of its modes has a measure value (a test asserts this).
  - **API.**
    - `parseFeatureModules` falls back per field: malformed input, unknown ids, wrong types and unsupported states.
    - `moduleState`.
    - `effectiveMode(state, own)`: `off` always gives off; `shadow` caps `active` at `measure` and never turns on an own `off`; `active` gives the own mode.
    - `switchMode(boolean)` maps the skills, tools and legacy model booleans to measure/active.
    - `hooksFor`, `modFeaturesOn`, `workerJobsOn` (a shared job is listed once, and runs while any owner is on), `modCopyNeeded`.
  - **Hook ownership.** The installer exports no list of its hooks, so the test holds a fixed list of the 8 that mirrors its header. It also parses the `hookSpecs` rows out of `install-claude-integration.mjs`'s source and checks them against that list, so a new hook with no owner fails.
  - **Strict TDD.** RED: `src/core/feature_modules.test.ts` failed with `ERR_MODULE_NOT_FOUND` (the module was missing). GREEN: 23/23. `npm run typecheck` reports 0 errors, and `npm test` passes 3607/3607.
  - **Findings for later tasks:**
    - **T2.** Add `FEATURE_MODULES_FILE` to `GATE_OWN_CONFIG_FILES` (`src/core/gate_own_paths.ts`). With the gate off, `gate-files` is uninstalled and nothing guards the file. That is acceptable, because the gate can only be turned off from the panel while it is on.
    - **T3.** `install()`, `uninstall()` and `status()` address `hookSpecs` by position (`specs[0..7]`, see its comments). Filtering it through `hooksFor` must not shift those indices. Match by event, matcher and script instead.
    - **T4, turn-usage and subagent band.** The turn-usage log and the subagent status band make no Jev call but belong to `model-router`. With the router off, the Consumption tab's usage, the turn-usage half of Activity and the subagent band stop. The alternative is a base mod feature, but that keeps the mod copy installed with every mod module off, so the router owns them.
    - **T4, other jobs.** The steward's person-turn counter runs in `prompt.submit` on every prompt. Activation jobs and poll request handlers also spawn sidecars, so "0 jobs" must cover them too. They are in the registry.
    - **T5.** The router's and steward's own `off` overlap with module `off`, though they never disagree, since off wins either way. The panel should hide the own `off` while the module switch is shown. The gate and the board show only off/on.
- [x] T2 gate protection: the module state file joins the gate's own-files refusal (`adapters/claude/gate-files.ts`, and the Bash gate's own-file rules). Subprocess tests for Edit, Write, heredoc, `sed -i`, `cp`, `mv` and `rm`. Done: `feature-modules.json` added to `GATE_OWN_CONFIG_FILES` (`src/core/gate_own_paths.ts`), as a literal so the file guard still loads nothing else; the unit test ties it to `FEATURE_MODULES_FILE`. RED: 1 unit (list and six write forms), 1 `gate-files` subprocess (Edit, Write), 1 `gate-bash` subprocess (heredoc, `sed -i`, `cp`, `mv`, `rm`; five local-rule deny records). GREEN: all three. Typecheck 0, `npm test` 3610/3610.
- [x] T3 installer: `install-claude-integration.mjs` installs only the hooks of the modules that are on, and uninstalls the hooks of the modules that are off. It stays idempotent and goes through the 0.6.26 never-go-back-a-version guard. The mod copy stays while any mod module is on. Verify whether a change to the mod copy needs a Claude Code reload; 0.6.24 showed that settings.json hooks do not. Write the answer here.
  - **Install.** `install()` reads `<configDir>/feature-modules.json` through `parseFeatureModules`, trying each config dir candidate like the locale (a missing, unreadable or corrupt file gives the defaults: all eight installed, byte for byte as before). Each of the eight `hookSpecs` rows goes through `applyHookSpec`: installed when it matches, by event, matcher and script, an entry of `hooksFor(modules)`, otherwise removed with the existing surgical `uninstallHookEntry` (only our entry; a group or event array install created goes with it, a pre-existing one stays). The positional `specs[0..7]` and every `changes` key are unchanged. The 0.6.26 guard runs first, as before: with a newer install present, a module change writes nothing (test). `uninstall()` is unchanged and removes everything whatever the module state. The worker sidecar can already read the config dir (`--allow-fs-read=${CONFIG_DIR}` in `main.mjs`).
  - **Results.** `install` adds `modules` (the state it followed) and `modCopyNeeded`. `status` adds `modules[id] = { state, hookCount, installed, removed, matchesState }` over every target, `targets[i].modules[id] = { state, present, total }`, and `modCopy.needed`. Every existing field keeps its meaning: it reports what is on disk, so with the gate off `hook.installed`, `outcomeHook.installed` and `fileGuardHook.installed` read false. T5 should read `modules[id].matchesState` for a module that is off rather than show those as missing.
  - **Decision: the mod copy is never removed by a module switch.** With every mod module off (`modCopyNeeded` false) the copy is still installed and refreshed. The 0.6.26 guard finds the installed version only through the copy's marker and generated manifest; removing them would let an older plugin root (an older marketplace copy, which also ignores `feature-modules.json`) reinstall all eight hooks over the owner's choice. So "off" for the mod side rests on T4: each mod feature returns before any Jev call. `uninstall` still removes the copy, symmetrical with before.
  - **Re-enable order.** Turning a module back on restores the same entries, but its matcher groups are appended after the ones still present, so settings.json is equal up to group order, not byte-identical to the first install. Claude Code runs every matching group, so order carries no meaning; a foreign hook keeps its place ahead of ours (test).
  - **Reload finding.** settings.json hooks: no reload; 0.6.24 (`odd/qa/qa-0.6.24.md`, "live in every session at once, with no restart") and the hook entries are read per tool call. The mod copy: **a change to its files needs a Claude Code restart in an already-open session.** Evidence: `odd/qa/qa-0.6.23.md` N-23, an open session showed "Update installed · Restart to update" and kept the previous mod until it restarted. A change of the mod's `pluginConfigs` options does reload the module (`odd/tasks/jev-060-router.md`, "a change reloads the module with the new options"). T3 never changes the copy on a module switch, so a switch needs no reload for hooks; for T4 this means the mod must read `feature-modules.json` on each hook call, not once at module load, or a switch would only take effect after a restart. Not verified live in this task.
  - **Also fixed.** The installer header and README said "Seven hook entries"; both now say eight, naming the file-tools guard.
  - **Strict TDD.** 11 new subprocess tests (throwaway HOME) in `adapters/orca/install-claude-integration.test.mjs`. RED: 8 of 11 failed: `result.modules` and `status.modules` undefined (TypeError), `modCopyNeeded`/`modCopy.needed` undefined, and the gate-off, router-off, idempotent-with-modules-off and back-on tests still found all eight hooks installed. The 3 that passed are characterization (an all-active file equals no file, uninstall with a module off, the newer-install guard with a module file). GREEN: 10 of 11 at once; the back-on test asked for byte identity and failed on matcher group order only, so it was changed to compare with groups sorted and to check the foreign hook keeps first place (see above). Installer tests 107/107, `npm run typecheck` 0 errors, `npm test` 3621/3621.
- [x] T4 mod and worker: each mod feature returns before any Jev call when its module is off. For the worker, the acceptance measure is 0 jobs and 0 sidecar spawns for an off module, per T0's finding that the 15 s and 10 min timers are shared; a timer is removed only when every module using it is off. Tests: zero Jev calls, zero jobs and zero sidecar spawns for an off module. Two commits: `feat(mod): ... (T4)` and `feat(worker): ... (T4)`.
  - Classic Agent hook (`adapters/claude/agent-model.ts`, a separate process): it now reads `feature-modules.json` per call. `off` asks Jev nothing and records nothing (the hook is also uninstalled by T3); `shadow` caps the legacy switch at measurement through `effectiveMode(state, switchMode(mirror.active))`. RED: 2 of 21 in `agent-model-hook.test.ts` (shadow rewrote; off recorded), 1 subprocess in `agent-model.test.mjs` observed by disabling the read. GREEN: 21/21, 9/9. Typecheck 0, `npm test` 3665/3665.
  - **Mod.** `resolveFeatureModules($, file)` in `adapters/claude/mod-skills/hooks/index.ts` reads `<configDir>/feature-modules.json` on every hook call that has a feature to gate (a missing, unreadable or corrupt file is every module active). Cost per call: the path is worked out once per `register`, then one `$.fs.exists` plus, when the file is there, one `$.fs.read` of a few dozen bytes; no cache (an mtime check would be a `$.fs.stat`, the same host round trip). Not timed. Where it is read: `prompt.submit` (once, shared by the three features), `skill.prompt` (only with a pending decision), `turn.step`, `agent.spawn`, `ui.render` (after the survey early-out), `session.start`, `turn.complete` (and again in the steward's timer, since the switch may move during its delay), `tool.call`.
    - **Off:** `skill-selection` skips the sampling roll, the inventories, the orca lookup and both Jev stages, and stops writing observation rows (`skill.prompt`, `tool.call`) for a decision made before the switch. `steward` skips the person-turn counter and never schedules the timer. `model-router` makes `turn.step` and `agent.spawn` plain pass-throughs (no routing, no teammate judgement, no turn-usage line, no router stats), skips the origin stamp, the teammate task memory, the place tracking, the subagent status line, the `session.start` snapshot and the `ui.render` band.
    - **Shadow:** `effectiveMode(state, own)` caps the router mode, the work kind (`decideAgentRoute`), the steward mode and its soft tier, and the skills and tools switches (`switchMode`) at measure.
  - **Worker.** New `adapters/orca/module-scheduler.mjs`; `activate` in `main.mjs` now registers every module job through it (`buildModuleRunners` is the table of what each registry job runs). Base work (poll loop and heartbeat, key mirror, Claude integration install and rescan, locale, catalog/policies mirror, commands) stays outside it.
    - **Off module:** its activation jobs, interval ticks, poll requests (`scheduler.run`) and event handlers never start; a request is left unread in storage. A shared job runs while any owner is on.
    - **Timers and handlers:** each of the 4 intervals and 3 Orca events exists only while `workerTriggerOn` is true (new in `feature_modules.ts`, with `workerJobsFor`), so the shared 15 s timer goes only when gate, model-router and skill-selection are all off. The board handlers are unregistered, not left as no-ops.
    - **State, no restart:** one read-only sidecar at activation (`feature-modules-read` in `write-secret-mirror.mjs`; the worker's sandbox cannot read the config dir itself), then the installer `status` that the base rescan already spawns about once a minute now carries the module states (`followStatus` feeds `scheduler.apply`). That is zero extra spawns per tick; the latency of an out-of-band change is up to about a minute plus a poll turn. T5's request handler can call `apply` directly for no latency. A module turned on runs its activation jobs once; the docs check waits for the catalog seed (`after`).
    - **Registry fix:** `router-status` also gets the `poll` trigger (`attendModelRouterStatusRefresh` spawns the installer when the panel asks).
  - **Strict TDD.** Mod, RED: 11 of 13 new `hooks.test.ts` tests and 4 of 4 new `steward.test.ts` tests failed for the right reasons (Jev calls and measurement rows with the module off, a skill injected under shadow, a router step rewritten to Haiku, origin stamped, a steward timer scheduled, the work kind `active` under shadow); the 2 that passed are characterization (corrupt or missing file equals today, origin stamped by default). GREEN: mod tests 227/227, the real `claude plugin validate` test green. Worker, RED: the 2 new `feature_modules` tests (missing exports), 3 of 3 `feature-modules-read` tests (`unknown-mode`), `module-scheduler.test.mjs` (module missing, then 2 more once `followStatus`/`modulesFromRead` were asked for), `buildModuleRunners` in `main.test.mjs`, and `main.activate.test.mjs` run against the 0.6.28 `main.mjs`: 2 of 2 failed (with every module off it still published `gateDefaults`, `trustedProgramsStatus` and the rest). GREEN: 25 `feature_modules`, 3 sidecar, 16 scheduler, 162 `main`, 2 activation (real sidecars, throwaway HOME).
  - **Results.** `npm run typecheck` 0 errors; `npm test` 3662/3662 (3621 before T4).
  - **Not done / for later.** `agent-model.ts` (the classic Agent hook, a separate process) does not read the module file, so under `model-router: shadow` its legacy `modelsConfig.active` switch still applies; only `off` reaches it, by uninstalling it (T3). The activation test counts what each job publishes, not process spawns.
  - Mod read cost (2026-10-11). `resolveFeatureModules` runs on `prompt.submit`, `turn.step`, `agent.spawn`, `tool.call`, `turn.complete`, `session.start`, the steward timer and the `AbovePrompt` `ui.render` band. That band redraws when `runningSubagents` in `$.state` changes, not per frame, and already makes at least three host calls per redraw (`$.state.get`, `$.agent.list`, the locale). The `exists()` check before the read was dropped: a missing file is the read that throws, so a hook call costs one host round trip instead of two. No time-based cache: a change from the panel must reach the next hook call, and the mod has no free clock (`$.clock.now()` is itself a host call). Not timed live; T6 measures it.
- [x] T4b worker cadence (T0: the worker never rested in 27.2 h; the 15 s refresh spawns 3 node sidecars per tick, about 709 processes an hour, observed ticks times sidecars from the code). The display-only refreshes run once at activation and then only while a panel that shows them is open, so the sidecars stop when nobody looks. Measure before and after with the T0 script and Orca's plugin audit log: the live measurement is pending for T6 (it needs a released build; the numbers below are derived from the code).
  - **Classification of the interval jobs, by who reads each output** (marked `panelOnly` in `src/core/feature_modules.ts`; `workerJobIsPanelOnly`, `workerTriggerWanted`):

    | Job | Interval | Who reads its output | Class |
    |---|---|---|---|
    | measurements-summary | 15 s | storage `measurementsSummary`, read only by `board.html` and `config.html` | panel only: gated |
    | gate-authorizations | 15 s | storage `gateAuthorizationsStatus`, read only by `config.html` (the gate hook reads its own file) | panel only: gated |
    | model-measurements | 15 s | storage `modelMeasurements` for the panel, **and** on a readiness flip it re-mirrors the catalog whose `ready` flag the Agent hook reads (`models-worker.mjs` `publishModelMeasurements`) | decision input: keeps 15 s |
    | account-quota | 10 min | `quota.json`, read by the router mod for quota pressure (`mod-skills/hooks/index.ts`) | decision input: keeps 10 min |
    | router-status | 10 min (also activation and poll) | storage `modelRouterStatus`, read only by `config.html` | panel only: gated (the poll request still refreshes it on demand) |
    | model-docs-check | 10 min tick, due once a day | a docs seed the panel offers; it changes the stored catalog only when the person accepts | not gated: it spawns no process (an HTTP fetch inside the worker, once a day), so gating saves nothing |
    | consumption-summary | 10 min | storage `consumptionSummary`, read only by `board.html` | panel only: gated |
    | activity-summary | 10 min | storage `activityByProjectSummary`, read only by `board.html` | panel only: gated |

  - **Behaviour.** `module-scheduler.mjs` gets `setPanelOpen(open)`. Without a panel, a panel-only job's tick is skipped and a timer with nothing but panel-only jobs is cleared (with model-router off, the gate and skill-selection leave no timer at all; with it on, the 15 s and account-quota timers stay for the two decision inputs). Opening a panel creates the timers and runs at once every panel-only job whose last run is older than its period (a refresh younger than its period is not repeated). Closing clears what has nothing left to run. A module that is off still starts nothing, panel or not (T4 untouched).
  - **How a panel says it is open.** `main.mjs` `attendPanelSignals` runs first in every poll turn and reads two keys. `configPanelSeen` is written by `config.html` every 2 s while visible: open for 5 s after the last signal, the existing `PANEL_SEEN_FRESH_MS`, 2.5 periods; it also keeps quickening the poll to 1 s. `boardPanelSeen` is new: `board.html` writes it on every reload (every 8 s while visible, on focus, on manual refresh) in the background lane: open for 17 s, 2 periods plus 1 s. The board needed it because it shows `measurementsSummary`, `consumptionSummary` and `activityByProjectSummary` and sent the worker nothing. The refresh a newly opened panel triggers is not awaited, so a sidecar never holds the poll back.
  - **Latency, stated honestly.** The poll runs every 15 s when no config panel is open, so a panel that opens is noticed within one poll turn (up to 15 s), not instantly: a panel cannot wake or call the worker (`odd/tasks/panel-worker-wakeup.md`). While it was open the data was never more than 15 s old before; now the first paint shows the last stored value and the refresh lands within about one poll turn plus the sidecar run. After the last signal, the refreshes stop within the grace plus at most one poll turn.
  - **Expected effect, derived from the code (live measurement pending for T6).** Node sidecar processes per hour from the timers, with no panel open:

    | State | Before | After |
    |---|---|---|
    | All modules on (default) | 709 (15 s group, observed T0) + about 24 (four 10 min jobs, 6/h each) = about 733 | model-measurements 240 (observed 233.5) + account-quota 6 = about 240: 67 % fewer |
    | model-router off (gate, steward, skill-selection on) | 709 minus model-measurements (233.5) = about 475, plus about 18 | 0 |
    | A panel open | unchanged: about 733 | about 733 (the panel-only jobs run as before) |

    Every refresh younger than its period is skipped on open, so opening and closing a panel repeatedly costs at most one run per job per period.
  - **Finding for T5/T6, idle reap.** The worker still cannot be reaped by Orca. In `orca-oss/src/main/plugins/plugin-host-process.ts` (checked at commit bf9bda0e76; the installed Orca may differ) `lastActivityAt` is refreshed by every `hostCall` from the worker (lines 215-223), `commandResult` and `eventAck`; `reapIdle` (`plugin-worker-manager.ts:238-243`) reaps only a worker with no in-flight work and 5 minutes without any of them. The request poll writes the heartbeat (`storage.set`) and reads storage every 15 s even when idle, so the worker looks active forever. T4b removes the sidecar processes; it does not by itself make the worker reapable. T0's assumption ("no timers firing") is not the signal: no host call is. Making the worker reapable means slowing or stopping that poll when no panel is open, and that conflicts with the heartbeat (stale after 40 s: `WORKER_HEARTBEAT_STALE_MS`) and with how the panel tells a person the worker is not running (`panel-worker-wakeup.md`). It is a product decision, not done here. A smaller option inside the current design: model-measurements is the remaining 15 s sidecar; making its readiness mirror event-driven or slower when no panel is open would cut the remaining 240/h, at the cost of `ready` lagging.
  - **Decision (2026-10-11): the worker stays awake; the poll is not stopped.** A panel cannot wake a reaped worker (`panel-worker-wakeup.md`: all panel actions end in Electron's main process), so a reapable worker would leave Settings waiting on every request until an agent event or command wakes it. The idle poll costs two host IPC calls every 15 s and no process. The cost that slowed Orca was the sidecar processes, and T4b removes 67% of them with every module on, and 100% with model-router off. The remaining `model-measurements` 15 s sidecar (about 234/h) is kept for now: it re-mirrors the catalog the Agent hook reads when the `ready` verdict changes. Revisit with the live T6 measurement.
  - **Strict TDD.** RED: `feature_modules.test.ts` failed to load (`workerJobIsPanelOnly` missing); in `module-scheduler.test.mjs` 14 of 27 failed (most on `setPanelOpen is not a function`, the no-panel ones on the numbers: 241 runs of a panel-only job in an hour where 1 was expected, 4 live timers where 2 or 0 were expected); `main.test.mjs` 5 of 167 failed (`attendPanelSignals` missing); the 2 `board_html_panel_signal.test.mjs` tests failed (no signal in `board.html`); the activation test with `setPanelOpen` pinned shut failed 1 of 4, which proves the wiring through the real `activate`. GREEN afterwards. Fake clock: the scheduler's `timers` and `now` are injected, as in T4; no new library.
  - **Results.** `npm run typecheck` 0 errors; `npm test` 3685/3685 (3665 before T4b).
- [x] T5 panel: a Modules section at the top of the config page. Each module has a switch, one line on what it does, and what it costs from T0. The existing per-feature controls are hidden while their module is off. Strings in es and en. Turning a switch runs the installer through the worker's request/result channel, and the page shows the result. Screenshots at 1440, 768, 390 and 320 px in both themes, under `odd/qa/screens-<version>/`.
  - **Writer path.**
    - The panel writes `featureModulesSaveRequest` `{ id, at, modules }`, the whole map. The worker (`attendFeatureModulesSaveRequest` in `main.mjs`, polled after the Claude integration request, base work outside the scheduler so the switch works with every module off) checks the TTL and the shape, then spawns `write-secret-mirror.mjs feature-modules-save`.
    - That mode is the one writer of `feature-modules.json`: strict (`validateFeatureModulesInput` in `src/core/feature_modules.ts` refuses a map that is not every known module with a state it offers, unknown ids, wrong types, bad JSON: `invalid-shape` / `invalid-json`, nothing written) and atomic (temp file plus rename). Grants (`secretMirrorPermissionArgs`, now exported and pinned by a test): read on the plugin root and the config dir, write on the config dir only. The write grant is the directory, not the file, because the rename needs room for the temp file there; the 5 read-only modes get no write grant.
    - Then the installer runs under the 0.6.26 guard, with no force: a newer install is left alone and the result says `skipped: true, reason: newer-install-present`. Then `scheduler.apply(saved)` moves the worker at once, then `publishClaudeIntegrationStatus` publishes the refreshed status (it carries `modules[id].matchesState` and `newerInstall`), and the result goes last, so the panel never reads the old state after "Saved.". An install that fails answers `ok: false, reason: install-failed, saved: true`; the file and the scheduler still follow the choice.
  - **UI.**
    - Placement: first section of the General tab, ahead of the key and the integration. Why not its own tab: the key and the integration are the base, the switches say which features built on it run, and a first-opened tab shows them with no click; a seventh tab would also wrap to a second row at 390 and 320 px, where the tabbar already wraps. Cost: General grows (the cards are about 1.1k px tall at 390).
    - One card per module: name, a segmented control (the panel's `mode-buttons`, since native selects do not open reliably in Orca's Electron), description, cost, install line, and a said line. Off/shadow/active comes from the registry: gate and board offer only off/active. A switch is sent as soon as it is pressed; the whole row is disabled while it is in flight, and the page re-reads the status afterwards so the state, the install line and the hidden settings follow what the worker really did.
    - Cost: two lines. "In use" is the T0 per-prompt and per-call figures (gate 9.3 Jev calls per prompt and 1.9 hook processes per Bash or edit call at about 0.6 s; router 1.1 per prompt and 2 Jev plus 2 hook processes per subagent; steward 0.5; skills 7.4; board none). "Background" is the node processes an hour that only this module's own jobs start, with a panel open and with none (T4b): gate 236 and 0 (shown as two figures), router 240 and 240 (one figure, its model-measurements and account-quota are decision inputs), board 38 `orca` runs an hour (derived), steward and skills nothing of their own. A shared job (measurements, activity, consumption, router status) is counted in no card, since it keeps running while any owner is on; a footnote gives the all-on totals (about 730 an hour with a panel, about 240 without), and says the figures are one week of measured use.
    - Install line, from `status.modules[id]`: hooks installed or removed "as you chose" when `matchesState`; "Pending" when not and no newer install is known; "Skipped: a newer install (version x) keeps its own hooks" when `status.newerInstall` is set; a module with no hooks says it follows the switch directly. The integration list says "removed on purpose (the Gate module is off)" for the Bash hook, the edit guard and the Agent hooks of a module that is off and confirmed removed, instead of "not installed".
    - Hidden while off (`data-module`): the Rules tab (deny tier, remembered authorizations, trusted programs) and queue mode for the gate; the whole Models tab (catalog and legacy switch, router rows, explicit models) for the model router; the steward rows and hint for the steward; the Skills mod section for skill selection. A note replaces them ("The Gate module is off, so its settings are hidden. Switch it on in General, under Modules."). Policies, team owners, destinations and the key stay: they feed `advisor.decide` and the shared gate base. There are no board settings in the config page, so the board module hides nothing. In shadow the settings stay under a note that the module's own "Active" is capped at measuring (the gate and the board have no shadow). With the gate off a red line on its card says nothing checks commands or edits.
    - Own Off of the router and the steward: hidden (`hidden` on the button, so indices are kept), unless that target still holds `off`, which keeps its button so a stored choice is visible and changeable. Why hide rather than explain: the module's Off is the one place to turn them off, and two Offs that mean almost the same invite a state nobody can tell apart. Cost of the choice: the router's Off was per account and the module's is global; a person who wants it off for one account only no longer has that from the panel (the terminal `router-mode-set` still does). The work-kind switch keeps its Off, since it is a sub-feature of the router, not the router.
    - Reload: the intro says a choice needs no Claude Code reload (settings.json hooks and the mod, which reads the file on every hook call, T3/T4), and that a session opened before the plugin updated keeps its old mod until restarted (T3: a change to the mod copy needs a restart). Not verified live; T6 checks it.
    - Strings: es (tú, no voseo) and en, in the existing `CATALOG`; `modules.*` and three `integration.*ModuleOff` keys. New error reasons map through `ERROR_REASON_KEYS`.
  - **Side fixes.** `config_html_models.test.mjs` `catalogBlock` read the end of the Spanish block when asked for `en` (an unanchored `en: {` matched inside a Spanish string), so its `en` checks were really checking `es`; anchored. Four structural tests got the `data-module` attribute. The screenshot harness waits for the Rules sections to be attached, not visible (a module that is off hides them).
  - **Strict TDD.** RED: `validateFeatureModulesInput` missing (29 of 29 after GREEN); sidecar 8 of 12 (`unknown-mode`); `main.test.mjs` 8 of 175 (export missing); `panels.spec.mjs` run against the HEAD `config.html`: 11 of 12 new tests failed (the 320 px overflow one passes against the old page, by construction). GREEN afterwards. A cosmetic fix after the first photographs (the said line under a card sat flush against the line above) was checked with the Modules tests again (14 of 14).
  - **Results.** `npm run typecheck` 0 errors; `npm test` 3707/3707 (3685 before); `npm run test:panels` 219/219. Screenshots: `odd/qa/screens-0.7.0/`, 30 images, every one read: `ready` (all active), `modules-mixed` (gate off, router shadow) and `modules-skipped` (a newer install kept the gate's hooks, a switch answered "saved, skipped"), General at 1440, 768, 390 and 320 in light and dark, plus the mixed Rules, Models and Policies tabs at 1440 dark and 390 light. `fixture_shape.test.mjs` holds the fixtures' `modules` to the real installer's `status`.
  - **For T6.** Verify live: the switch from the real Settings page for each module; that an already-open Claude Code session honours a change with no reload once it runs the new mod; that the figures in the cost lines still match the T0 script on a released build; whether `README.md` and the version notes should name the Modules section.
- [x] T6 docs, version, release, catalog, and a live check of the marketplace install: turn each module off and on, confirm `~/.claude/settings.json` and the mod copy follow, and confirm a disabled module produces no Jev call in the logs.

### Next modules, after the registry ships
Each one is a registry entry that enters in `shadow`. Its own task file is written when it starts. The details and the first thing to verify are in `odd/backlog.md`, under "Candidate modules from similar tools".
- [ ] M1 Verify the "done" (jev-belay): a Stop hook that blocks an unverified "done".
- [ ] M2 Gate MCP tools against the goal (jev-browser's irreversible question). This could extend the `gate` module instead of being a new one; decide in its task file.
- [ ] M3 Browser steps judged by Jev (jev-browser).
- [ ] M4 Project rules on every edit (abide), turn level, shadow only.
- [ ] M5 Messages written mid-turn (Jev_steer_or_queue).
- [ ] M6 Cheap bulk classification (quicksilver).
- [ ] M7 Site audit (jev-seo).

Improvements to existing modules, from the same review (backlog, "Ideas from similar tools"):
- `gate`: the `authorized` mitigator from the task context; the write-then-run ledger.
- `steward`: the harm measure; staying inert outside interactive sessions.
- Base: the replay corpus with intervals; dead or noisy questions in `jev-health`; the doctor's hook check.

## Acceptance criteria
- Strict TDD per task: RED observed, then GREEN. `npm run typecheck` reports 0, and `npm test` and `npm run test:panels` are green.
- A module that is off causes 0 hook spawns, 0 Jev calls and 0 worker timers. This is measured the same way as T0.
- An upgrade with no module file behaves exactly as 0.6.28.
- An agent cannot turn the gate off: an edit of the module file by any tool or shell route is refused.
- Turning a module back on restores its hooks with no restart, or the panel says clearly that a reload is needed (per T3's finding).

## Checks
`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, the T0 measurement script, and a live check of the marketplace install.

## Memory
The Engram mirror `odd/feature-modules/tasks` is pending: the Engram MCP server failed to start in the 2026-10-10 session (ENOENT on `/opt/homebrew/Cellar/engram/1.20.0/bin/engram`).

T6 evidence (2026-10-11): 0.7.0 could not be installed (50 MiB limit, fixed in 0.7.1); the live check ran on the 0.7.1 marketplace install and is in `odd/qa/qa-0.7.1.md`: lock, hooks and mods on one root, Gate Off removes its 5 hooks from all 5 settings files and a new session follows with no reload, Gate Active restores them, about 240 node processes an hour with no panel (was about 730).
